from datetime import datetime, timezone
from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import LiveGameState, QualityMetric, RawPull
from ingestion.config import Settings
from ingestion.flows.backfill_flow import (
    GamesPageSource,
    RawPullSink,
    SQLAlchemyRawPullSink,
)
from ingestion.sources.balldontlie import BallDontLieClient
from ingestion.sources.public_feed import PublicFeedClient


@runtime_checkable
class ScoreboardSource(Protocol):
    """Injectable secondary-source client — matches
    `PublicFeedClient.get_scoreboard(date: str) -> dict` per the plan doc's
    assumed ESPN shape (docs/superpowers/plans/2026-09-01-week2-live-ingestion-quality-gate.md,
    Employee A1's `public_feed.py`).

    As of this writing, Employee A1's PR (`get_scoreboard`) had not yet
    merged into `week2/live-ingestion` — `public_feed.py` still only has the
    week-1 `get_games` stub. This flow is written against the documented
    method signature/shape regardless, per the plan's explicit instruction
    not to block on the sibling PR. Once A1 merges, `PublicFeedClient`
    satisfies this protocol structurally with no changes needed here.
    """

    def get_scoreboard(self, date: str) -> dict: ...


@runtime_checkable
class RowSink(Protocol):
    """Injectable write path for a single ORM row — `LiveGameState` or
    `QualityMetric` alike.

    One generic protocol (and one `SQLAlchemyRowSink` implementation below)
    rather than two near-identical sink classes, since "persist this one
    row" is the entire contract either table needs. `RawPullSink` (imported
    from `backfill_flow`, not redefined) is kept as the dedicated type for
    Bronze `RawPull` writes per this flow's plan — but note it is
    structurally identical to this protocol (`write(self, x) -> None`), so
    `SQLAlchemyRowSink` instances also satisfy `isinstance(_, RawPullSink)`
    if ever needed; the two names exist for readability at call sites, not
    because the runtime contracts differ.
    """

    def write(self, row: object) -> None: ...


class SQLAlchemyRowSink:
    """Production `RowSink`: one session per write, committed immediately.

    Mirrors `backfill_flow.SQLAlchemyRawPullSink`'s per-write-commit
    behavior (see that class's docstring for the rationale) but is untyped
    on the row so the same implementation backs both the `LiveGameState`
    and `QualityMetric` sinks below.
    """

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def write(self, row: object) -> None:
        with self._session_factory() as session:
            session.add(row)
            session.commit()


def extract_balldontlie_live_states(payload: dict) -> list[LiveGameState]:
    """Extract one `LiveGameState` per game from a balldontlie `GET /games` page.

    ASSUMED payload shape, extending the fields already documented/assumed
    in `dbt/models/staging/stg_games.sql` (`id`, `status`, `home_team_score`,
    `visitor_team_score`) with `period` (int) and `time` (str clock) —
    fields balldontlie's real `/games` response carries for in-progress
    games but which `stg_games.sql` didn't need for its Gold-layer
    concerns. NOT yet verified against real ingested data, same caveat as
    `stg_games.sql`. Missing optional fields extract as `None` rather than
    raising; a missing `status` string defaults to `"unknown"` since the
    column is not nullable but a genuinely-missing source field shouldn't
    crash the poll.
    """
    return [
        LiveGameState(
            game_id=game["id"],
            source="balldontlie",
            home_score=game.get("home_team_score"),
            away_score=game.get("visitor_team_score"),
            period=game.get("period"),
            clock=game.get("time"),
            status=game.get("status") or "unknown",
        )
        for game in payload.get("data", [])
    ]


def extract_public_feed_live_states(payload: dict) -> list[LiveGameState]:
    """Extract one `LiveGameState` per event from a `PublicFeedClient.get_scoreboard()` response.

    ASSUMED shape per the plan doc (Employee A1's `public_feed.py` spec —
    see `ScoreboardSource`'s docstring for merge status):
    ``{"events": [{"id": ..., "competitions": [{"competitors": [
    {"homeAway": "home"|"away", "team": {...}, "score": "..."}],
    "status": {"type": {"name": "STATUS_FINAL"|"STATUS_IN_PROGRESS"|...}}}]}]}``.

    The plan doc's shape doesn't call out period/clock fields, but real
    ESPN scoreboard responses carry them on the same `status` object
    alongside `type` (`status.period`: int, `status.displayClock`: str) —
    assumed present here too since `LiveGameState` needs them; unverified
    like the rest of this shape. `score` arrives as a string (ESPN
    convention) and is cast to `int`, treating `None`/`""` as "no score
    yet" rather than raising. Only the first competition per event is used
    (ESPN's scoreboard nests exactly one competition per game in practice).
    """
    states = []
    for event in payload.get("events", []):
        competitions = event.get("competitions") or [{}]
        competition = competitions[0]
        home_score = None
        away_score = None
        for competitor in competition.get("competitors", []):
            raw_score = competitor.get("score")
            score = int(raw_score) if raw_score not in (None, "") else None
            if competitor.get("homeAway") == "home":
                home_score = score
            elif competitor.get("homeAway") == "away":
                away_score = score

        status_obj = competition.get("status") or {}
        status_name = (status_obj.get("type") or {}).get("name") or "unknown"

        states.append(
            LiveGameState(
                game_id=int(event["id"]),
                source="public_feed",
                home_score=home_score,
                away_score=away_score,
                period=status_obj.get("period"),
                clock=status_obj.get("displayClock"),
                status=status_name,
            )
        )
    return states


_NBA_STATS_STATUS_BY_CODE = {1: "scheduled", 2: "in_progress", 3: "final"}

_POSTPONEMENT_KEYWORDS = ("postpon", "cancel", "suspend", "delay")


def _normalize_nba_stats_status(game_status: int, game_status_text: str) -> str:
    """gameStatus (1/2/3) maps to scheduled/in_progress/final, but a
    postponement/cancellation is signaled through `gameStatusText`
    regardless of the numeric code (ASSUMED — see module docstring in
    `nba_live.py`), so that keyword check runs first and overrides the
    numeric mapping. Matches the substring-based detection style already
    used by `web/lib/live-status.ts`'s retiring `getStatusPresentation`.
    """
    lowered = game_status_text.lower()
    if any(keyword in lowered for keyword in _POSTPONEMENT_KEYWORDS):
        return "postponed"
    return _NBA_STATS_STATUS_BY_CODE.get(game_status, "scheduled")


def extract_nba_stats_live_states(payload: dict) -> list[LiveGameState]:
    """Extract one `LiveGameState` per game from nba_api's live scoreboard
    payload. ASSUMED shape — see `nba_live.py`'s module docstring; NOT yet
    verified against a real response.

    `status` is normalized to exactly one of "scheduled" / "in_progress" /
    "final" / "postponed" (not nba_api's raw `gameStatusText`) so
    `api/src/api/routers/board.py`'s status derivation is a direct 1:1
    lookup rather than a second round of substring matching.

    `game_id` strips leading zeros from nba_api's own string game id
    (e.g. "0022500123" -> 22500123) via a plain `int()` cast — this is a
    *different* id space from balldontlie's/public_feed's own native ids;
    see `match_game_ids_by_team_overlap` for how those get reconciled onto
    this one.
    """
    games = payload.get("scoreboard", {}).get("games", [])
    states = []
    for game in games:
        home = game.get("homeTeam", {})
        away = game.get("awayTeam", {})
        status = _normalize_nba_stats_status(
            game.get("gameStatus", 1), game.get("gameStatusText", "")
        )
        game_time = game.get("gameTimeUTC")
        states.append(
            LiveGameState(
                game_id=int(game["gameId"]),
                source="nba_stats",
                home_score=home.get("score"),
                away_score=away.get("score"),
                period=game.get("period"),
                clock=game.get("gameClock") or None,
                status=status,
                home_team=f"{home['teamCity']} {home['teamName']}" if home else None,
                away_team=f"{away['teamCity']} {away['teamName']}" if away else None,
                scheduled_start=(
                    datetime.fromisoformat(game_time) if game_time else None
                ),
            )
        )
    return states


def extract_balldontlie_team_names(payload: dict) -> dict[int, set[str]]:
    """`{game_id: {home_full_name, away_full_name}}` from a balldontlie
    `/games` page — used only for cross-source game matching
    (`match_game_ids_by_team_overlap`), not persisted. ASSUMED shape per
    `dbt/models/staging/stg_games.sql`'s documented `home_team.full_name`/
    `visitor_team.full_name` fields, not yet verified against real data.
    A game missing team data contributes an empty set, never crashes.
    """
    result: dict[int, set[str]] = {}
    for game in payload.get("data", []):
        names = set()
        home_name = game.get("home_team", {}).get("full_name")
        away_name = game.get("visitor_team", {}).get("full_name")
        if home_name:
            names.add(home_name)
        if away_name:
            names.add(away_name)
        result[game["id"]] = names
    return result


def extract_public_feed_team_names(payload: dict) -> dict[int, set[str]]:
    """`{game_id: {home_displayName, away_displayName}}` from a
    `PublicFeedClient.get_scoreboard()` response — same competition-parsing
    shape as `extract_public_feed_live_states`, used only for cross-source
    game matching, not persisted.
    """
    result: dict[int, set[str]] = {}
    for event in payload.get("events", []):
        competitions = event.get("competitions") or [{}]
        competitors = competitions[0].get("competitors", [])
        names = {
            c["team"]["displayName"]
            for c in competitors
            if c.get("team", {}).get("displayName")
        }
        result[int(event["id"])] = names
    return result


def match_game_ids_by_team_overlap(
    canonical_teams: dict[int, set[str]], other_teams: dict[int, set[str]]
) -> dict[int, int]:
    """Match each `other`-source game_id to the canonical (nba_stats)
    game_id whose team-name set it overlaps, so cross-source rows for the
    same real game can be written under one shared `game_id`.

    Team-name-set overlap, not exact full-game match, so a naming variant
    on one team (e.g. "LA Clippers" vs "Los Angeles Clippers") still
    matches as long as the other team's name is spelled identically by
    both sources — same heuristic and caveats as
    `quality.reconciliation.match_games_by_team_overlap`, reimplemented
    here (rather than reused) because that function returns matched field
    *values*, not the secondary game's own id, which is exactly what
    remapping needs. A canonical game is claimed by at most one `other`
    game.
    """
    matches: dict[int, int] = {}
    claimed_canonical: set[int] = set()

    for other_id, other_names in other_teams.items():
        for canonical_id, canonical_names in canonical_teams.items():
            if canonical_id in claimed_canonical:
                continue
            if other_names & canonical_names:
                matches[other_id] = canonical_id
                claimed_canonical.add(canonical_id)
                break

    return matches


def remap_game_ids(
    states: list[LiveGameState], id_map: dict[int, int]
) -> list[LiveGameState]:
    """Rewrite each state's `game_id` to its matched canonical id, in
    place. A state whose `game_id` has no entry in `id_map` (this source
    reported a game nba_stats didn't cover this poll) keeps its own
    native id — orphaned but harmless: it simply won't be picked up by
    any board row's merge, rather than being dropped or written under a
    wrong game.
    """
    for state in states:
        state.game_id = id_map.get(state.game_id, state.game_id)
    return states


@flow(name="live-game-flow")
def live_game_flow(
    date: str,
    raw_pull_sink: RawPullSink | None = None,
    live_game_state_sink: RowSink | None = None,
    quality_metric_sink: RowSink | None = None,
    balldontlie_client: GamesPageSource | None = None,
    public_feed_client: ScoreboardSource | None = None,
) -> dict:
    """One live-poll cycle against both data sources (docs/prd.md §12, Week 2).

    A single pass, not a real-time loop — repeated polling during game
    windows is a Prefect deployment-scheduling concern, out of scope for the
    flow body itself (see plan doc). For the given `date`:

    1. Pulls every page of balldontlie's `/games` response and ESPN's
       (`PublicFeedClient`) scoreboard response, writing each as its own
       Bronze `RawPull` row via `raw_pull_sink` (reusing
       `backfill_flow.RawPullSink`/`SQLAlchemyRawPullSink` rather than
       redefining a second Bronze sink).
    2. Extracts one Silver `LiveGameState` row per game from each source's
       payload and writes it via `live_game_state_sink`.
    3. Writes exactly one freshness `QualityMetric`
       (`check_name="live_poll_lag_seconds"`) measuring the wall-clock gap
       between the start of this poll and the moment the metric is
       recorded, via `quality_metric_sink`.

    All three sinks and both source clients are injected so the flow body
    never opens a DB connection or makes an HTTP call itself — production
    code gets real SQLAlchemy/HTTP-backed implementations by default; tests
    pass in-memory fakes (see `ingestion/tests/test_live_game_flow.py`).
    """
    logger = get_run_logger()
    poll_started_at = datetime.now(timezone.utc)

    session_factory: sessionmaker[Session] | None = None
    if raw_pull_sink is None or live_game_state_sink is None or quality_metric_sink is None:
        session_factory = sessionmaker(bind=create_engine(Settings().runtime_database_url))
    raw_pull_sink = raw_pull_sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    live_game_state_sink = live_game_state_sink or SQLAlchemyRowSink(session_factory)  # type: ignore[arg-type]
    quality_metric_sink = quality_metric_sink or SQLAlchemyRowSink(session_factory)  # type: ignore[arg-type]
    balldontlie_client = balldontlie_client or BallDontLieClient(
        api_key=Settings().balldontlie_api_key
    )
    public_feed_client = public_feed_client or PublicFeedClient(
        base_url=Settings().public_feed_base_url
    )

    raw_pulls_written = 0
    live_game_states_written = 0

    for page in balldontlie_client.get_games_pages(date):
        raw_pull_sink.write(RawPull(source="balldontlie", endpoint="games", payload=page))
        raw_pulls_written += 1
        for state in extract_balldontlie_live_states(page):
            live_game_state_sink.write(state)
            live_game_states_written += 1

    scoreboard = public_feed_client.get_scoreboard(date)
    raw_pull_sink.write(
        RawPull(source="public_feed", endpoint="scoreboard", payload=scoreboard)
    )
    raw_pulls_written += 1
    for state in extract_public_feed_live_states(scoreboard):
        live_game_state_sink.write(state)
        live_game_states_written += 1

    poll_lag_seconds = (datetime.now(timezone.utc) - poll_started_at).total_seconds()
    quality_metric_sink.write(
        QualityMetric(
            check_name="live_poll_lag_seconds",
            metric_value=poll_lag_seconds,
            metadata_json={"date": date},
        )
    )

    logger.info(
        "live_game_flow: %s (%d raw_pulls, %d live_game_state rows, poll_lag=%.3fs)",
        date,
        raw_pulls_written,
        live_game_states_written,
        poll_lag_seconds,
    )

    return {
        "raw_pulls_written": raw_pulls_written,
        "live_game_states_written": live_game_states_written,
    }
