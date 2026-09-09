"""Resolves whether a Gold `games` row has a known score disagreement in
`source_conflicts`, for use by `query_tools.py`'s `get_game_result`/
`get_player_stats` (docs/superpowers/specs/2026-09-08-bettor-trust-pivot-design.md §4/§9).

`source_conflicts.game_id` is always nba_stats's own raw (unoffset) id --
written by `ingestion/flows/live_game_flow.py::reconcile_live_states`,
which only ever compares `home_score`/`away_score` (see that function's
own docstring -- no other field_name can appear in production).

Gold `games.game_id` is one of two disjoint id spaces with no `source`
column to distinguish them: balldontlie's native id, or an nba_api id
offset by `NBA_GAME_ID_OFFSET`. This module bridges Gold's id back to
nba_stats's raw id space so a conflict lookup is possible at all --
deterministic for nba_api-sourced games (subtract the offset, matching
`board.py`'s existing convention), team-overlap-matched for
balldontlie-sourced games (there is no persisted mapping for those; see
`quality.reconciliation.match_games_by_team_overlap`, the same heuristic
already used to match nba_api games onto balldontlie's Gold rows during
backfill).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from api.routers.board import NBA_GAME_ID_OFFSET
from quality.reconciliation import match_games_by_team_overlap

ET_ZONE = ZoneInfo("America/New_York")

# The only two field_names reconcile_live_states can ever write -- see
# this module's docstring. A row with any other field_name would be a
# bug elsewhere, not a case this function needs to handle.
SCORE_FIELDS = ("home_score", "away_score")


@dataclass(frozen=True)
class DataConfidence:
    field: str
    note: str
    primary_source: str
    primary_value: str | None
    secondary_source: str
    secondary_value: str | None

    def to_dict(self) -> dict:
        return {
            "field": self.field,
            "note": self.note,
            "primary_source": self.primary_source,
            "primary_value": self.primary_value,
            "secondary_source": self.secondary_source,
            "secondary_value": self.secondary_value,
        }


class _NbaStatsCandidateLike(Protocol):
    game_id: int
    home_team: str | None
    away_team: str | None


class _ConflictLike(Protocol):
    field_name: str
    primary_source: str
    primary_value: str | None
    secondary_source: str
    secondary_value: str | None


def et_day_bounds(day: date) -> tuple[datetime, datetime]:
    """UTC `[start, end)` bounds for one ET calendar day. Parallels
    `board.py`'s `et_today_bounds`, parameterized by an explicit date
    instead of "now" -- `get_game_result`/`get_player_stats` resolve
    historical games, not just today's, so "today" isn't the right frame.
    """
    start_et = datetime(day.year, day.month, day.day, tzinfo=ET_ZONE)
    end_et = start_et + timedelta(days=1)
    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)


def resolve_nba_stats_game_id(
    gold_game_id: int,
    home_team: str,
    away_team: str,
    nba_stats_candidates: Sequence[_NbaStatsCandidateLike],
) -> int | None:
    """Gold `games.game_id` -> nba_stats's raw id space, or `None` if
    there's no reliable match. `nba_stats_candidates` should already be
    scoped by the caller to the game's own date (see `load_score_conflict`)
    -- this function does no date filtering itself, matching
    `match_games_by_team_overlap`'s own existing convention.
    """
    if gold_game_id >= NBA_GAME_ID_OFFSET:
        return gold_game_id - NBA_GAME_ID_OFFSET

    secondary_games = [
        (str(c.game_id), {c.home_team, c.away_team}, {"game_id": c.game_id})
        for c in nba_stats_candidates
        if c.home_team is not None and c.away_team is not None
    ]
    matches = match_games_by_team_overlap(
        primary_games=[(str(gold_game_id), {home_team, away_team}, {})],
        secondary_games=secondary_games,
    )
    if len(matches) != 1:
        return None
    _, _, secondary_fields = matches[0]
    return secondary_fields["game_id"]


def select_score_conflict(conflicts: Sequence[_ConflictLike]) -> DataConfidence | None:
    """The first conflict in `conflicts` scoped to a real score field, or
    `None`. `conflicts` is expected to already be scoped to one resolved
    nba_stats `game_id` by the caller, ordered most-recent-first (see
    `load_score_conflict`) -- this stays a pure, DB-free function so the
    display-copy logic is unit-testable without a database (see Task 1's
    tests).

    The note deliberately does NOT claim which source's number is
    currently displayed: `conflict.primary_source` only records which
    source was "primary" during *live* reconciliation
    (`ingestion/flows/live_game_flow.py::reconcile_live_states` always
    hardcodes `primary_source="nba_stats"`), but the value actually shown
    on a historical/Gold-derived answer can come from a different source
    entirely (e.g. balldontlie, for a balldontlie-sourced Gold game). This
    module has no way to verify which source's number is actually being
    displayed, so it states only the disagreement itself and both values,
    which the data does support.
    """
    for conflict in conflicts:
        if conflict.field_name not in SCORE_FIELDS:
            continue
        readable_field = conflict.field_name.replace("_", " ")
        return DataConfidence(
            field=conflict.field_name,
            note=(
                f"{conflict.primary_source} and {conflict.secondary_source} "
                f"disagreed on {readable_field} during live play "
                f"({conflict.primary_source}: {conflict.primary_value}, "
                f"{conflict.secondary_source}: {conflict.secondary_value})."
            ),
            primary_source=conflict.primary_source,
            primary_value=conflict.primary_value,
            secondary_source=conflict.secondary_source,
            secondary_value=conflict.secondary_value,
        )
    return None


def load_score_conflict(
    engine: Engine,
    game_id: int,
    game_date: date,
    home_team: str,
    away_team: str,
) -> dict | None:
    """Full DB-backed resolution: Gold game -> nba_stats id ->
    `source_conflicts` -> a `data_confidence` dict, or `None`. Shared by
    both `GameResultToolReader` and `PlayerStatsToolReader`'s SQLAlchemy
    implementations (Task 2) so this query logic exists exactly once.

    Uses ORM models (`LiveGameState`, `SourceConflict`) via a `Session`,
    same as `board.py`/`quality.py` -- `query_tools.py`'s own Core-based
    reflection is only used for the dbt-owned `games`/`player_game_stats`
    tables, not these ORM-modeled Meta/Silver ones.

    Not directly unit-tested here (no live-DB unit tests exist anywhere
    in this codebase per CLAUDE.md's testing philosophy) -- the tricky
    logic it calls (`resolve_nba_stats_game_id`, `select_score_conflict`)
    is covered by Task 1's pure-function tests; this function's own thin
    SQLAlchemy glue is exercised at the route level via
    `GameResultToolReader`/`PlayerStatsToolReader` fakes (Task 2) and,
    ultimately, only fully proven by a real run (spec §9 step 3).
    """
    from db.models import LiveGameState, SourceConflict  # local: avoids a hard

    # import-time dependency on `db` for callers that only need the pure
    # functions above (e.g. Task 1's tests).

    # The nba_api-offset branch is pure arithmetic and needs no query at
    # all -- short-circuit before ever touching `LiveGameState`. Without
    # this, every nba_api-sourced game call (the majority of them) paid
    # for a real DB round-trip it never uses the result of, and
    # get_player_stats calls this once per row (up to 500 rows/call).
    if game_id >= NBA_GAME_ID_OFFSET:
        nba_stats_id: int | None = game_id - NBA_GAME_ID_OFFSET
    else:
        start_utc, end_utc = et_day_bounds(game_date)
        with Session(engine) as session:
            candidates = session.scalars(
                select(LiveGameState).where(
                    LiveGameState.source == "nba_stats",
                    LiveGameState.pulled_at >= start_utc,
                    LiveGameState.pulled_at < end_utc,
                )
            ).all()
        nba_stats_id = resolve_nba_stats_game_id(game_id, home_team, away_team, candidates)
        if nba_stats_id is None:
            return None

    with Session(engine) as session:
        conflicts = session.scalars(
            select(SourceConflict)
            .where(SourceConflict.game_id == str(nba_stats_id))
            .order_by(SourceConflict.detected_at.desc())
        ).all()

    result = select_score_conflict(conflicts)
    return result.to_dict() if result is not None else None
