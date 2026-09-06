"""`GET /board/` — the unified live/scheduled/final-today + historical
board (docs/superpowers/specs/2026-09-06-recent-games-board-and-
commentator-design.md §5.1). Replaces both `GET /games`'s "always final"
homepage usage and `GET /live` (retired — see api/src/api/main.py).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from api.core.cache import cached_json
from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key
from api.routers.board_commentary import CONFLICT_DISPLAY_WINDOW_SECONDS, compute_commentary
from api.routers.games import GamesReader, get_games_reader
from api.routers.quality import QualityReader, get_quality_reader
from db.models import LiveGameState

router = APIRouter(prefix="/board", tags=["board"], dependencies=[Depends(require_api_key)])

CACHE_TTL_SECONDS = 15
CACHE_KEY = "board:today"

# How many recent nba_stats rows to fetch per live game for run detection
# (§6.2) — a generous window given polls are infrequent relative to game
# length; bounding it keeps the query and the walk-backward loop cheap.
BOARD_HISTORY_LIMIT = 20

ET_ZONE = ZoneInfo("America/New_York")

# Normalized nba_stats status (Task 3) -> the board's 4-bucket status.
_STATUS_MAP = {
    "scheduled": "scheduled",
    "in_progress": "live",
    "final": "final",
    "postponed": "postponed",
}

_SORT_ORDER = {"live": 0, "final": 1, "scheduled": 2, "postponed": 3}

# Matches ingestion/src/ingestion/sources/nba_stats.py's NBA_GAME_ID_OFFSET.
# Duplicated here rather than imported -- `api` has no dependency on
# `ingestion` -- so this must stay in sync if that constant ever changes.
NBA_GAME_ID_OFFSET = 100_000_000_000

# Fallback-row (no nba_stats coverage today) status classification —
# mirrors live_game_flow.py's `_normalize_nba_stats_status` postponement
# keywords, applied to whatever raw status string a secondary source uses
# since none of them share nba_stats's normalized vocabulary.
_FALLBACK_POSTPONED_KEYWORDS = ("postpon", "cancel", "suspend", "delay")


def et_today_bounds(now_utc: datetime) -> tuple[datetime, datetime]:
    """UTC `[start, end)` bounds for "today" in America/New_York, given
    the current UTC instant. NBA scheduling is ET-native — a 10pm ET
    tip-off (7am UTC the next day) must group under the ET day it's
    scheduled in, not whichever UTC day the wall clock lands on.
    """
    now_et = now_utc.astimezone(ET_ZONE)
    start_et = datetime(now_et.year, now_et.month, now_et.day, tzinfo=ET_ZONE)
    end_et = start_et + timedelta(days=1)
    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)


@runtime_checkable
class BoardReader(Protocol):
    """Injectable read path for `live_game_state`'s "today" slice."""

    def latest_per_source_today(
        self, start_utc: datetime, end_utc: datetime
    ) -> Sequence[LiveGameState]:
        """Latest row per `(game_id, source)` with `pulled_at` in
        `[start_utc, end_utc)`."""
        ...

    def nba_stats_history_today(
        self, game_id: int, start_utc: datetime, end_utc: datetime, limit: int
    ) -> Sequence[LiveGameState]:
        """Up to `limit` `source="nba_stats"` rows for `game_id` in
        `[start_utc, end_utc)`, newest first — backs run detection."""
        ...


class SQLAlchemyBoardReader:
    """Production `BoardReader`, backed by `db.models.LiveGameState`."""

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()
        self._session_factory = sessionmaker(bind=self._engine)

    def latest_per_source_today(
        self, start_utc: datetime, end_utc: datetime
    ) -> list[LiveGameState]:
        with self._session_factory() as session:
            ranked = (
                select(
                    LiveGameState.id,
                    func.row_number()
                    .over(
                        partition_by=(LiveGameState.game_id, LiveGameState.source),
                        order_by=LiveGameState.pulled_at.desc(),
                    )
                    .label("rn"),
                )
                .where(
                    LiveGameState.pulled_at >= start_utc,
                    LiveGameState.pulled_at < end_utc,
                )
                .subquery()
            )
            stmt = (
                select(LiveGameState)
                .join(ranked, LiveGameState.id == ranked.c.id)
                .where(ranked.c.rn == 1)
            )
            return list(session.scalars(stmt).all())

    def nba_stats_history_today(
        self, game_id: int, start_utc: datetime, end_utc: datetime, limit: int
    ) -> list[LiveGameState]:
        with self._session_factory() as session:
            stmt = (
                select(LiveGameState)
                .where(
                    LiveGameState.game_id == game_id,
                    LiveGameState.source == "nba_stats",
                    LiveGameState.pulled_at >= start_utc,
                    LiveGameState.pulled_at < end_utc,
                )
                .order_by(LiveGameState.pulled_at.desc())
                .limit(limit)
            )
            return list(session.scalars(stmt).all())


def get_board_reader() -> BoardReader:
    """FastAPI dependency seam — overridden with a fake in tests."""
    return SQLAlchemyBoardReader()


def _derive_status(nba_stats_latest: LiveGameState | None) -> str:
    if nba_stats_latest is None:
        return "final"
    return _STATUS_MAP.get(nba_stats_latest.status, "scheduled")


def _serialize_live_row(
    game_id: int, nba_stats_latest: LiveGameState, commentary
) -> dict:
    status = _derive_status(nba_stats_latest)
    return {
        "game_id": game_id,
        "status": status,
        "home_team": nba_stats_latest.home_team,
        "away_team": nba_stats_latest.away_team,
        "home_score": nba_stats_latest.home_score,
        "away_score": nba_stats_latest.away_score,
        "period": nba_stats_latest.period,
        "clock": nba_stats_latest.clock,
        "scheduled_start": (
            nba_stats_latest.scheduled_start.isoformat()
            if nba_stats_latest.scheduled_start
            else None
        ),
        # nba_stats_latest.pulled_at, not the freshest of any source —
        # every other field on this row comes from nba_stats, so the "as of"
        # timestamp must reflect that same row's actual freshness. Using the
        # freshest of any source would show a stale score next to a fresh
        # timestamp exactly when a "Feed stale" commentary line is firing.
        "source_pulled_at": nba_stats_latest.pulled_at.isoformat(),
        "commentary": (
            {"text": commentary.text, "kind": commentary.kind} if commentary else None
        )
        if status == "live"
        else None,
    }


def _derive_fallback_status(fallback: LiveGameState) -> str:
    """Keyword-based status classification for a fallback (no nba_stats
    coverage) row — secondary sources don't share nba_stats's normalized
    status vocabulary, so this can't reuse `_STATUS_MAP`/`_derive_status`.
    """
    lowered = (fallback.status or "").lower()
    if any(keyword in lowered for keyword in _FALLBACK_POSTPONED_KEYWORDS):
        return "postponed"
    if "final" in lowered:
        return "final"
    if fallback.home_score is None and fallback.away_score is None:
        return "scheduled"
    return "live"


def _serialize_fallback_row(game_id: int, fallback: LiveGameState) -> dict:
    """A game with no nba_stats coverage today — a genuine coverage gap
    (§5.1.1), not a stale poll. Renders with whatever a secondary source
    has, no team names/schedule/commentary.
    """
    return {
        "game_id": game_id,
        "status": _derive_fallback_status(fallback),
        "home_team": None,
        "away_team": None,
        "home_score": fallback.home_score,
        "away_score": fallback.away_score,
        "period": fallback.period,
        "clock": fallback.clock,
        "scheduled_start": None,
        "source_pulled_at": fallback.pulled_at.isoformat(),
        "commentary": None,
    }


def _normalize_historical_row(row: dict) -> dict:
    """A Gold `games` row (the fallback for anything not in today's live
    set, §5.1.2) -> the same unified shape the live rows above produce,
    so the frontend renders every row through one component. Always
    `status: "final"` — everything reaching this fallback is, by
    construction, not in today's live/scheduled/postponed set.
    """
    pulled_at = row.get("source_pulled_at")
    return {
        "game_id": row["game_id"],
        "status": "final",
        "home_team": row["home_team"],
        "away_team": row["away_team"],
        "home_score": row["home_score"],
        "away_score": row["away_score"],
        "period": None,
        "clock": None,
        "scheduled_start": None,
        "source_pulled_at": pulled_at.isoformat() if pulled_at is not None else None,
        "commentary": None,
    }


def _board_row_for_group(
    game_id: int,
    sources: dict[str, LiveGameState],
    board_reader: BoardReader,
    quality_reader: QualityReader,
    start_utc: datetime,
    end_utc: datetime,
    now: datetime,
) -> dict:
    """One board row from a game's per-source latest rows this poll —
    shared by `compute_board` (`GET /board/`) and the stream generator
    (Task 10) so the merge/commentary logic is written exactly once.
    """
    nba_stats_latest = sources.get("nba_stats")
    if nba_stats_latest is None:
        fallback = max(sources.values(), key=lambda s: s.pulled_at)
        return _serialize_fallback_row(game_id, fallback)

    commentary = None
    if _derive_status(nba_stats_latest) == "live":
        history = board_reader.nba_stats_history_today(
            game_id, start_utc, end_utc, BOARD_HISTORY_LIMIT
        )
        conflicts = quality_reader.recent_conflicts_for_game(
            str(game_id), CONFLICT_DISPLAY_WINDOW_SECONDS
        )
        other_latest = {s: state for s, state in sources.items() if s != "nba_stats"}
        commentary = compute_commentary(history, other_latest, conflicts, now)

    return _serialize_live_row(game_id, nba_stats_latest, commentary)


def _group_by_game(states: Sequence[LiveGameState]) -> dict[int, dict[str, LiveGameState]]:
    by_game: dict[int, dict[str, LiveGameState]] = defaultdict(dict)
    for state in states:
        by_game[state.game_id][state.source] = state
    return by_game


def _sort_key(row: dict) -> int:
    return _SORT_ORDER.get(row.get("status", "final"), 4)


def compute_board(
    board_reader: BoardReader,
    games_reader: GamesReader,
    quality_reader: QualityReader,
    now: datetime,
) -> list[dict]:
    start_utc, end_utc = et_today_bounds(now)
    today_states = board_reader.latest_per_source_today(start_utc, end_utc)
    by_game = _group_by_game(today_states)

    today_rows = [
        _board_row_for_group(game_id, sources, board_reader, quality_reader, start_utc, end_utc, now)
        for game_id, sources in by_game.items()
    ]
    today_rows.sort(key=_sort_key)

    # Exclusion set must live in Gold's id space, not live_game_state's.
    # `LiveGameState.game_id` for an nba_stats row is the unoffset nba_api
    # id (e.g. 22500123); the Gold `games` table's id for that same game is
    # offset by NBA_GAME_ID_OFFSET (e.g. 100022500123 — see
    # ingestion/src/ingestion/sources/nba_stats.py's `offset_game_id`).
    # Comparing them directly (the pre-fix behavior) never matched, so a
    # same-day dbt run could duplicate a finished game on the board: once
    # from today's live/final set, once again from the Gold fallback.
    # Games without an nba_stats row (fallback-only, e.g. balldontlie) use
    # their native id unchanged — balldontlie's id space already matches
    # Gold directly, and public_feed/ESPN's id space never appears in Gold
    # at all, so passing it through unoffset is harmless (it just never
    # excludes anything, which is correct).
    today_gold_ids = {
        (NBA_GAME_ID_OFFSET + game_id) if "nba_stats" in sources else game_id
        for game_id, sources in by_game.items()
    }
    historical_rows = [
        _normalize_historical_row(row)
        for row in games_reader.list_games(None)
        if row["game_id"] not in today_gold_ids
    ]

    return today_rows + historical_rows


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_board(
    request: Request,
    board_reader: BoardReader = Depends(get_board_reader),
    games_reader: GamesReader = Depends(get_games_reader),
    quality_reader: QualityReader = Depends(get_quality_reader),
) -> dict:
    """Unified live/scheduled/final-today + historical board.

    Response shape:
        {"data": [<board row>, ...], "count": <int>}

    Each row: `{game_id, status ("scheduled"|"live"|"final"|"postponed"),
    home_team, away_team, home_score, away_score, period, clock,
    scheduled_start, source_pulled_at, commentary ({text, kind} | null)}`.
    `commentary` is only ever non-null for `status: "live"` rows.
    """

    def _compute() -> dict:
        rows = compute_board(board_reader, games_reader, quality_reader, datetime.now(timezone.utc))
        return {"data": rows, "count": len(rows)}

    return cached_json(CACHE_KEY, CACHE_TTL_SECONDS, _compute)
