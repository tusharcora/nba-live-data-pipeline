"""`GET /player-stats` — per-player, per-game box-score lines from the
dbt-owned Gold `player_game_stats` table (docs/prd.md §06, §11).

Follows the exact same read-only-table-we-don't-own pattern as
`api/src/api/routers/games.py`: `player_game_stats` is owned by dbt (see
`dbt/models/marts/player_game_stats.sql`), so this module reflects it via
SQLAlchemy Core (`Table(..., autoload_with=engine)`) rather than adding a new
ORM model, and pushes all DB access behind a small `PlayerStatsReader` DI
seam so the route can be tested with a fake reader and no live Postgres.

IMPORTANT: `player_game_stats` has zero rows in real Postgres today — a
separate Week 5 team is still building the ingestion path that populates it.
That's expected, not a bug this router needs to work around: an empty result
set is a normal `{"data": [], "count": 0}` 200 response, not an error (see
`test_list_player_stats_empty_result_is_a_normal_200` in
`api/tests/test_player_stats.py`).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import MetaData, Table, func, select
from sqlalchemy.engine import Engine

from api.core.cache import cached_json
from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key

router = APIRouter(
    prefix="/player-stats", tags=["player-stats"], dependencies=[Depends(require_api_key)]
)

# Same short TTL as /games (api/src/api/routers/games.py) — data changes as
# slowly as the backfill/live flows run (docs/prd.md §09), so a short TTL is
# enough to absorb request bursts without serving stale data.
CACHE_TTL_SECONDS = 15


@runtime_checkable
class PlayerStatsReader(Protocol):
    """Injectable read path for the Gold `player_game_stats` table.

    Kept `@runtime_checkable` for the same structural-consistency reason as
    `games.GamesReader` — the DI shape matches the rest of the codebase.
    """

    def list_player_stats(self, game_id: int | None, player_name: str | None) -> list[dict]: ...


class SQLAlchemyPlayerStatsReader:
    """Production `PlayerStatsReader`, backed by the dbt-owned Gold
    `player_game_stats` table.

    `game_id` filters on exact equality. `player_name` filters on a
    case-insensitive partial match against the combined
    `player_first_name || ' ' || player_last_name`. Either, both, or neither
    may be supplied; rows are ordered by `stat_id` descending (most recently
    loaded first) with no limit — this table is expected to be small enough
    per query (a handful of players per game, or matches on a name) that a
    `DEFAULT_LIMIT`-style cap isn't needed the way `/games`'s unfiltered
    case needs one.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def list_player_stats(self, game_id: int | None, player_name: str | None) -> list[dict]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)

        stmt = select(player_game_stats).order_by(player_game_stats.c.stat_id.desc())
        if game_id is not None:
            stmt = stmt.where(player_game_stats.c.game_id == game_id)
        if player_name is not None:
            full_name = func.concat(
                player_game_stats.c.player_first_name,
                " ",
                player_game_stats.c.player_last_name,
            )
            stmt = stmt.where(full_name.ilike(f"%{player_name}%"))

        with self._engine.connect() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings().all()]


def get_player_stats_reader() -> PlayerStatsReader:
    """FastAPI dependency factory — overridden in tests via
    `app.dependency_overrides[get_player_stats_reader]` to inject a fake
    reader.
    """
    return SQLAlchemyPlayerStatsReader()


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def list_player_stats(
    request: Request,
    game_id: int | None = Query(default=None, description="Filter to an exact game_id."),
    player_name: str | None = Query(
        default=None,
        description="Case-insensitive partial match on the player's combined "
        "first + last name.",
    ),
    reader: PlayerStatsReader = Depends(get_player_stats_reader),
) -> dict:
    """Per-player, per-game box-score lines from Gold `player_game_stats`.

    - `?game_id=<int>` — return every player line for that game.
    - `?player_name=<text>` — case-insensitive partial match against the
      combined first + last name (e.g. `"lebron"` or `"james"` both match
      "LeBron James").
    - Both params may be combined; neither is required (unfiltered returns
      every row in the table).

    Response shape:
        {"data": [<player_game_stats row as a dict>, ...], "count": <int>}

    `player_game_stats` is empty in real Postgres today (see module
    docstring) so `{"data": [], "count": 0}` is the realistic near-term
    response — a normal 200, not an error.
    """

    def _compute() -> dict:
        rows = reader.list_player_stats(game_id, player_name)
        return {"data": rows, "count": len(rows)}

    # Cache key incorporates both filter params' raw values so filtered and
    # unfiltered responses never collide in the cache.
    cache_key = f"player-stats:game_id={game_id if game_id is not None else ''}:player_name={(player_name or '').lower()}"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)
