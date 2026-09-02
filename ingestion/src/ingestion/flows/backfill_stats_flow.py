from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import RawPull
from ingestion.config import Settings
from ingestion.flows.backfill_flow import (
    CheckpointStore,
    RawPullSink,
    SQLAlchemyCheckpointStore,
    SQLAlchemyRawPullSink,
)
from ingestion.sources.balldontlie import BallDontLieClient

# Identifies this flow's row in `backfill_checkpoints`. Deliberately distinct
# from `backfill_flow.CHECKPOINT_FLOW_NAME` ("backfill_flow") — the games and
# stats backfills must be independently resumable, so they never share a
# checkpoint row.
STATS_CHECKPOINT_FLOW_NAME = "backfill_stats"


@runtime_checkable
class StatsPageSource(Protocol):
    """Injectable stats source — matches `BallDontLieClient.get_stats_pages`.

    Typed as a protocol (rather than the concrete `BallDontLieClient`) so
    tests can pass a fake client without needing to be an instance of the
    real class — Prefect's Pydantic-backed parameter validation enforces
    `isinstance()` against the flow's declared parameter types.
    """

    def get_stats_pages(self, date: str) -> Iterator[dict]: ...


@flow(name="backfill-stats-flow")
def backfill_stats_flow(
    start_date: str | None = None,
    end_date: str | None = None,
    sink: RawPullSink | None = None,
    checkpoint_store: CheckpointStore | None = None,
    client: StatsPageSource | None = None,
) -> dict:
    """Historical player box-score stats backfill (docs/prd.md §12, Week 5).

    Mirrors `backfill_flow`'s structure exactly, against balldontlie's
    `/stats` endpoint instead of `/games`. Resumable: at the start of a run,
    the checkpoint row for `flow_name="backfill_stats"` is consulted. If one
    exists, the run resumes from `last_pulled_date + 1 day`, ignoring
    `start_date`. `start_date` is only required (and only used) on the very
    first run, before any checkpoint exists. This checkpoint is entirely
    independent of the games backfill's `"backfill_flow"` checkpoint row.

    `sink` and `checkpoint_store` are injected so the flow body never opens a
    DB connection itself — production code gets real SQLAlchemy-backed
    implementations by default; tests pass in-memory fakes.
    """
    logger = get_run_logger()

    session_factory: sessionmaker[Session] | None = None
    if sink is None or checkpoint_store is None:
        session_factory = sessionmaker(bind=create_engine(Settings().runtime_database_url))
    sink = sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    checkpoint_store = checkpoint_store or SQLAlchemyCheckpointStore(session_factory)  # type: ignore[arg-type]
    client = client or BallDontLieClient(api_key=Settings().balldontlie_api_key)

    resolved_end = (
        date.fromisoformat(end_date)
        if end_date
        else datetime.now(timezone.utc).date() - timedelta(days=1)
    )

    last_checkpoint = checkpoint_store.get_last_pulled_date(STATS_CHECKPOINT_FLOW_NAME)
    if last_checkpoint is not None:
        resolved_start = last_checkpoint + timedelta(days=1)
    elif start_date is not None:
        resolved_start = date.fromisoformat(start_date)
    else:
        raise ValueError(
            "start_date is required on the first backfill_stats_flow run — "
            f"no checkpoint found for flow_name={STATS_CHECKPOINT_FLOW_NAME!r}"
        )

    dates_processed = 0
    raw_pulls_written = 0

    current = resolved_start
    while current <= resolved_end:
        date_str = current.isoformat()
        pages_written = 0
        for page in client.get_stats_pages(date_str):
            sink.write(RawPull(source="balldontlie", endpoint="stats", payload=page))
            pages_written += 1

        checkpoint_store.advance(STATS_CHECKPOINT_FLOW_NAME, current)
        dates_processed += 1
        raw_pulls_written += pages_written
        logger.info(
            "backfill_stats_flow: processed %s (%d raw_pulls row(s) written)",
            date_str,
            pages_written,
        )
        current += timedelta(days=1)

    return {"dates_processed": dates_processed, "raw_pulls_written": raw_pulls_written}
