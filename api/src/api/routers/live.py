from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Protocol, runtime_checkable

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key
from db.models import LiveGameState

router = APIRouter(prefix="/live", tags=["live"], dependencies=[Depends(require_api_key)])

# Sane default poll interval (docs/prd.md §04/§09) — a live game's clock/score
# doesn't meaningfully change faster than this, and it keeps per-connection
# DB load bounded. Overridable per call via `live_event_generator`'s
# `interval_seconds` param (e.g. for tests, which pass a fake instant sleep).
DEFAULT_POLL_INTERVAL_SECONDS = 5.0

# Hard safety cutoff per streaming connection. An NBA game plus overtime plus
# broadcast/stoppage buffer never approaches 4 hours, so this only ever fires
# for a connection that *should* have disconnected but didn't signal it (a
# dead proxy that swallows the TCP FIN, a client that hung without closing)
# — it bounds worst-case server-side resource usage per connection rather
# than reflecting any real game-length expectation.
MAX_STREAM_DURATION_SECONDS = 4 * 60 * 60


@runtime_checkable
class LiveStateReader(Protocol):
    """Injectable read path for the latest `live_game_state` row per game_id.

    Keeps `live_event_generator` free of any hardcoded DB call, matching the
    DI seam pattern established in `quality/src/quality/volumetric.py`
    (`GoldReader`/`QualityMetricSink`) — a test drives the generator with an
    in-memory fake, no live Postgres required.
    """

    def get_latest_states(self) -> Sequence[LiveGameState]: ...


def serialize_live_state(row: LiveGameState) -> dict:
    """One `live_game_state`-shaped row -> the JSON an SSE consumer sees."""
    pulled_at = row.pulled_at
    return {
        "game_id": row.game_id,
        "source": row.source,
        "pulled_at": pulled_at.isoformat() if pulled_at is not None else None,
        "home_score": row.home_score,
        "away_score": row.away_score,
        "period": row.period,
        "clock": row.clock,
        "status": row.status,
    }


def format_sse_event(rows: Sequence[LiveGameState]) -> str:
    """Latest-state rows for every live game -> one SSE `data:` event."""
    payload = {"data": [serialize_live_state(row) for row in rows]}
    return f"data: {json.dumps(payload)}\n\n"


async def live_event_generator(
    reader: LiveStateReader,
    is_disconnected: Callable[[], Awaitable[bool]],
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    max_duration_seconds: float = MAX_STREAM_DURATION_SECONDS,
) -> AsyncIterator[str]:
    """The testable core of `GET /live`: poll -> format -> yield -> sleep.

    `reader`, `is_disconnected`, and `sleep` are all injected — a test drives
    this generator directly with fakes for all three (no real DB, no real
    multi-second wait) and asserts on the exact yielded SSE strings.

    Each iteration checks `is_disconnected()` *before* querying/yielding, so
    a disconnect is noticed promptly rather than after one more wasted poll.
    The loop also ends once `max_duration_seconds` of (interval-counted)
    elapsed time is reached, regardless of disconnect state — see
    `MAX_STREAM_DURATION_SECONDS` for why that cutoff exists.
    """
    elapsed = 0.0
    while elapsed < max_duration_seconds:
        if await is_disconnected():
            return
        rows = reader.get_latest_states()
        yield format_sse_event(rows)
        await sleep(interval_seconds)
        elapsed += interval_seconds


class SQLAlchemyLiveStateReader:
    """Production `LiveStateReader`: latest `live_game_state` row per game_id.

    `live_game_state` is a `db`-owned ORM model (`db.models.LiveGameState`),
    not a dbt-owned Gold table `api` merely reflects — so this uses the ORM
    directly rather than the `Table(..., autoload_with=engine)` reflection
    pattern `quality/volumetric.py` uses for Gold tables it doesn't own.

    "Latest per game_id" is computed with a `row_number() over (partition by
    game_id order by pulled_at desc)` window, filtered to rank 1 — the same
    de-dup shape the dbt staging models use for `raw_pulls` (see
    `CLAUDE.md`), applied here in SQL instead of dbt.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()
        self._session_factory = sessionmaker(bind=self._engine)

    def get_latest_states(self) -> list[LiveGameState]:
        with self._session_factory() as session:
            latest_ids = select(
                LiveGameState.id,
                func.row_number()
                .over(
                    partition_by=LiveGameState.game_id,
                    order_by=LiveGameState.pulled_at.desc(),
                )
                .label("rn"),
            ).subquery()

            stmt = (
                select(LiveGameState)
                .join(latest_ids, LiveGameState.id == latest_ids.c.id)
                .where(latest_ids.c.rn == 1)
                .order_by(LiveGameState.game_id)
            )
            return list(session.scalars(stmt).all())


def get_live_state_reader() -> LiveStateReader:
    """FastAPI dependency seam — overridden with a fake in tests."""
    return SQLAlchemyLiveStateReader()


def get_stream_interval_seconds() -> float:
    """FastAPI dependency seam for the poll interval — same purpose as
    `get_live_state_reader`: production uses the default, a route-level test
    can override it (e.g. to force a fast/zero-length stream so it can
    inspect headers without the ASGI test transport blocking on a
    real multi-hour drain — see `MAX_STREAM_DURATION_SECONDS` and
    `tests/test_live.py` for why that matters here).
    """
    return DEFAULT_POLL_INTERVAL_SECONDS


def get_stream_max_duration_seconds() -> float:
    """FastAPI dependency seam for the safety cutoff — see
    `get_stream_interval_seconds`."""
    return MAX_STREAM_DURATION_SECONDS


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
async def stream_live_state(
    request: Request,
    reader: LiveStateReader = Depends(get_live_state_reader),
    interval_seconds: float = Depends(get_stream_interval_seconds),
    max_duration_seconds: float = Depends(get_stream_max_duration_seconds),
) -> StreamingResponse:
    """SSE stream of live game state (docs/prd.md §04, §06, §13).

    Rate-limited once per connection (not per poll iteration) — the
    `@limiter.limit` decorator only runs when the route handler itself is
    invoked to open the stream, not on each loop iteration inside it.

    `Cache-Control: no-cache` is set per the Vercel-SSE-gotcha awareness in
    docs/prd.md §13 (the BFF re-streaming this response is what actually
    faces Vercel's buffering behavior; getting FastAPI's own header right is
    still required so the gotcha isn't reintroduced upstream of the BFF).
    """
    generator = live_event_generator(
        reader=reader,
        is_disconnected=request.is_disconnected,
        interval_seconds=interval_seconds,
        max_duration_seconds=max_duration_seconds,
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )
