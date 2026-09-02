"""Shared SQLAlchemy `Engine` construction for every router.

Week 3 built `games.py`, `quality.py`, and `live.py` as three separate
employee tasks, and each ended up constructing its own `Engine` slightly
differently:

- `games.py`'s `SQLAlchemyGamesReader` called `create_engine(...)` in
  `__init__`, and `get_games_reader()` (the FastAPI dependency) constructed
  a brand-new `SQLAlchemyGamesReader()` on *every request* — meaning a new
  `Engine`, and a new connection pool underneath it, per request.
- `live.py`'s `SQLAlchemyLiveStateReader` did the same thing, which is worse
  here: `get_live_state_reader()` is re-invoked per SSE connection, so every
  browser tab watching the live board was opening its own pool for a
  connection that can stay open for hours (`MAX_STREAM_DURATION_SECONDS`).
- `quality.py` was the only one of the three that got this right on its
  own: a module-level `_engine` global, lazily constructed once via
  `_get_engine()`.

None of the three set explicit `pool_size`/`max_overflow`, so all three were
silently relying on SQLAlchemy's `QueuePool` defaults (`pool_size=5,
max_overflow=10`) *only when* an engine happened to live long enough to
matter — which, per above, wasn't reliably true for `games.py`/`live.py`.

This module consolidates engine construction into one place so pool sizing
is set once, deliberately, and can't drift across routers again.

Pool sizing rationale (`pool_size=5, max_overflow=10`):
This is a solo portfolio project's API, not a production system serving
real concurrent traffic — realistic load is "a handful of people looking at
a live-game dashboard at once," not thousands of concurrent users. 5
persistent connections plus a burst allowance of 10 more (15 total, well
under Postgres's default `max_connections=100`) comfortably covers the
"live game window" scenario in `docs/prd.md` §09 (concurrent `/games` and
`/quality` polls plus a few open `/live` SSE streams) without reserving a
large pool that mostly sits idle. These are the same numbers SQLAlchemy
already defaults to for `QueuePool` — the point of setting them explicitly
here isn't to change the behavior, it's to stop it being an accident of
"whichever router's engine happened to be long-lived enough for pooling to
apply" and make it one documented, intentional decision instead.

On `pgbouncer`: `docs/prd.md` §09 lists a pooling proxy alongside caching
and indexing as a performance nice-to-have, not a requirement. Recommend
against standing one up this week — it earns its keep when a Postgres
instance is fielding connections from many independent processes/pods that
would otherwise each hold their own pool (exactly the problem the
per-request engines above used to cause), or when you're up against
Postgres's real connection ceiling. Here, `api` is a single FastAPI process
with one shared `Engine` (this module) capped at 15 connections, `ingestion`
is a separate low-frequency writer, and Postgres's own default headroom
(100) covers both with room to spare. Adding pgbouncer now would be an
extra process to deploy, monitor, and debug for a connection-count problem
this project doesn't have.
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from api.core.config import Settings

# Deliberately small and explicit — see module docstring for the reasoning.
POOL_SIZE = 5
MAX_OVERFLOW = 10

_engine: Engine | None = None


def get_engine() -> Engine:
    """Return the process-wide `Engine`, constructing it on first use.

    Module-level-cached (not per-request, not per-connection) so every
    router shares one connection pool sized by `POOL_SIZE`/`MAX_OVERFLOW`
    instead of each opening its own.
    """
    global _engine
    if _engine is None:
        _engine = create_engine(
            Settings().runtime_database_url,
            pool_size=POOL_SIZE,
            max_overflow=MAX_OVERFLOW,
        )
    return _engine
