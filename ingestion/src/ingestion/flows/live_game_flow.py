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
