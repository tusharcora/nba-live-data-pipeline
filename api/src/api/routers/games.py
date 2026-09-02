"""`GET /games` — reconciled games from the dbt-owned Gold `games` table
(docs/prd.md §06, §11).

Follows the read-only-table-we-don't-own pattern established in Week 2 by
`quality/src/quality/volumetric.py`'s `SQLAlchemyGoldReader`: the Gold
`games` table is owned by dbt (see `dbt/models/marts/games.sql`), so this
module reflects it via SQLAlchemy Core (`Table(..., autoload_with=engine)`)
rather than adding a new ORM model, and pushes all DB access behind a small
`GamesReader` DI seam so the route can be tested with a fake reader and no
live Postgres.
"""

from __future__ import annotations

from datetime import date as date_type
from typing import Protocol, runtime_checkable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import MetaData, Table, select
from sqlalchemy.engine import Engine

from api.core.cache import cached_json
from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key

router = APIRouter(prefix="/games", tags=["games"], dependencies=[Depends(require_api_key)])

# Data changes as slowly as the backfill/live flows run (docs/prd.md §09) —
# a short TTL is enough to absorb request bursts without serving stale data.
CACHE_TTL_SECONDS = 15


@runtime_checkable
class GamesReader(Protocol):
    """Injectable read path for the Gold `games` table.

    Kept `@runtime_checkable` for the same structural-consistency reason as
    `quality.volumetric.GoldReader` — this isn't a Prefect flow parameter,
    but the DI shape matches the rest of the codebase.
    """

    def list_games(self, filter_date: date_type | None) -> list[dict]: ...


class SQLAlchemyGamesReader:
    """Production `GamesReader`, backed by the dbt-owned Gold `games` table.

    `list_games(None)` returns the `DEFAULT_LIMIT` most recent games ordered
    by `game_date` descending (ties broken by `game_id` descending for a
    stable order). `list_games(some_date)` returns every game on that date
    (no limit applied), also ordered by `game_id` descending.
    """

    DEFAULT_LIMIT = 20

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def list_games(self, filter_date: date_type | None) -> list[dict]:
        metadata = MetaData()
        games = Table("games", metadata, autoload_with=self._engine)

        stmt = select(games).order_by(games.c.game_date.desc(), games.c.game_id.desc())
        if filter_date is not None:
            stmt = stmt.where(games.c.game_date == filter_date)
        else:
            stmt = stmt.limit(self.DEFAULT_LIMIT)

        with self._engine.connect() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings().all()]


def get_games_reader() -> GamesReader:
    """FastAPI dependency factory — overridden in tests via
    `app.dependency_overrides[get_games_reader]` to inject a fake reader.
    """
    return SQLAlchemyGamesReader()


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def list_games(
    request: Request,
    date: str | None = Query(
        default=None, description="Filter to a single date, YYYY-MM-DD."
    ),
    reader: GamesReader = Depends(get_games_reader),
) -> dict:
    """Reconciled games from Gold (docs/prd.md §06, §11).

    - `?date=YYYY-MM-DD` — return every game on that date.
    - No `date` param — return the most recent 20 games, ordered by
      `game_date` descending (see `SQLAlchemyGamesReader.DEFAULT_LIMIT`).

    Response shape:
        {"data": [<game row as a dict, Gold `games` columns>, ...], "count": <int>}
    """
    filter_date: date_type | None = None
    if date is not None:
        try:
            filter_date = date_type.fromisoformat(date)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "date must be in YYYY-MM-DD format"
            ) from exc

    def _compute() -> dict:
        rows = reader.list_games(filter_date)
        return {"data": rows, "count": len(rows)}

    # Cache key incorporates the raw `?date=` value (not just "some date is
    # set") so a filtered response and the unfiltered/"recent" response
    # never collide in the cache.
    cache_key = f"games:{date or 'recent'}"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)
