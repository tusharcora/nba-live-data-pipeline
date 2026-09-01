from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from db.models import BackfillCheckpoint, RawPull
from ingestion.config import Settings
from ingestion.sources.balldontlie import BallDontLieClient

# Identifies this flow's row in `backfill_checkpoints`. Deliberately distinct
# from the Prefect flow name ("backfill-flow") — this is a data-model key,
# not a display name.
CHECKPOINT_FLOW_NAME = "backfill_flow"


@runtime_checkable
class RawPullSink(Protocol):
    """Injectable write path for Bronze rows — keeps the flow body DB-free and testable.

    `@runtime_checkable` is required here (not for our own use — the protocol
    is structural everywhere in this module) because Prefect builds a Pydantic
    parameter schema from the flow's type hints at decoration time, and
    Pydantic's `isinstance`-based schema for a `Protocol` annotation raises
    unless the protocol supports `isinstance()` checks.
    """

    def write(self, raw_pull: RawPull) -> None: ...


@runtime_checkable
class CheckpointStore(Protocol):
    """Injectable resumability marker — one logical row per flow_name."""

    def get_last_pulled_date(self, flow_name: str) -> date | None: ...

    def advance(self, flow_name: str, pulled_date: date) -> None: ...


@runtime_checkable
class GamesPageSource(Protocol):
    """Injectable box-score source — matches `BallDontLieClient.get_games_pages`.

    Typed as a protocol (rather than the concrete `BallDontLieClient`) so
    tests can pass a fake client without needing to be an instance of the
    real class — Prefect's Pydantic-backed parameter validation enforces
    `isinstance()` against the flow's declared parameter types.
    """

    def get_games_pages(self, date: str) -> Iterator[dict]: ...


class SQLAlchemyRawPullSink:
    """Production `RawPullSink`: one session per write, committed immediately.

    Committing per-write (rather than holding one long session open for the
    whole backfill) keeps each Bronze insert atomic and independently safe to
    retry if a later date in the run fails.
    """

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def write(self, raw_pull: RawPull) -> None:
        with self._session_factory() as session:
            session.add(raw_pull)
            session.commit()


class SQLAlchemyCheckpointStore:
    """Production `CheckpointStore`, backed by the `backfill_checkpoints` table."""

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def get_last_pulled_date(self, flow_name: str) -> date | None:
        with self._session_factory() as session:
            checkpoint = session.scalar(
                select(BackfillCheckpoint).where(
                    BackfillCheckpoint.flow_name == flow_name
                )
            )
            return checkpoint.last_pulled_date if checkpoint else None

    def advance(self, flow_name: str, pulled_date: date) -> None:
        with self._session_factory() as session:
            checkpoint = session.scalar(
                select(BackfillCheckpoint).where(
                    BackfillCheckpoint.flow_name == flow_name
                )
            )
            if checkpoint is None:
                session.add(
                    BackfillCheckpoint(
                        flow_name=flow_name, last_pulled_date=pulled_date
                    )
                )
            else:
                checkpoint.last_pulled_date = pulled_date
                checkpoint.updated_at = datetime.now(timezone.utc)
            session.commit()


@flow(name="backfill-flow")
def backfill_flow(
    start_date: str | None = None,
    end_date: str | None = None,
    sink: RawPullSink | None = None,
    checkpoint_store: CheckpointStore | None = None,
    client: GamesPageSource | None = None,
) -> dict:
    """Historical box-score backfill (docs/prd.md §12, Week 1).

    Resumable: at the start of a run, the checkpoint row for
    `flow_name="backfill_flow"` is consulted. If one exists, the run resumes
    from `last_pulled_date + 1 day`, ignoring `start_date`. `start_date` is
    only required (and only used) on the very first run, before any
    checkpoint exists.

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

    last_checkpoint = checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME)
    if last_checkpoint is not None:
        resolved_start = last_checkpoint + timedelta(days=1)
    elif start_date is not None:
        resolved_start = date.fromisoformat(start_date)
    else:
        raise ValueError(
            "start_date is required on the first backfill_flow run — no "
            f"checkpoint found for flow_name={CHECKPOINT_FLOW_NAME!r}"
        )

    dates_processed = 0
    raw_pulls_written = 0

    current = resolved_start
    while current <= resolved_end:
        date_str = current.isoformat()
        pages_written = 0
        for page in client.get_games_pages(date_str):
            sink.write(RawPull(source="balldontlie", endpoint="games", payload=page))
            pages_written += 1

        checkpoint_store.advance(CHECKPOINT_FLOW_NAME, current)
        dates_processed += 1
        raw_pulls_written += pages_written
        logger.info(
            "backfill_flow: processed %s (%d raw_pulls row(s) written)",
            date_str,
            pages_written,
        )
        current += timedelta(days=1)

    return {"dates_processed": dates_processed, "raw_pulls_written": raw_pulls_written}
