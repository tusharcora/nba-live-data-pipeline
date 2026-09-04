"""`GET /player-stats` — per-player, per-game box-score lines from the
dbt-owned Gold `player_game_stats` table (docs/prd.md §06, §11).

Follows the exact same read-only-table-we-don't-own pattern as
`api/src/api/routers/games.py`: `player_game_stats` is owned by dbt (see
`dbt/models/marts/player_game_stats.sql`), so this module reflects it via
SQLAlchemy Core (`Table(..., autoload_with=engine)`) rather than adding a new
ORM model, and pushes all DB access behind a small `PlayerStatsReader` DI
seam so the route can be tested with a fake reader and no live Postgres.

Each row also carries its game's `game_date`, `home_team`, `away_team`,
`home_score`, and `away_score` (joined in from the Gold `games` table) —
without this, a player-name search spanning many games would have no way
to tell which game each stat line belongs to.

An empty result set (e.g. a name with no matches, or before the backfill
covers a given era) is a normal `{"data": [], "count": 0}` 200 response,
not an error (see `test_list_player_stats_empty_result_is_a_normal_200` in
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

    def list_player_stats(
        self, game_id: list[int] | None, player_name: str | None, player_id: int | None = None
    ) -> list[dict]: ...


class SQLAlchemyPlayerStatsReader:
    """Production `PlayerStatsReader`, backed by the dbt-owned Gold
    `player_game_stats` table.

    `game_id` (one or more, matched via `IN`) and `player_id` filter on
    exact equality. `player_name` filters on a case-insensitive partial
    match against the combined `player_first_name || ' ' || player_last_name`.
    Any combination may be supplied; rows are ordered by `stat_id`
    descending (most recently loaded first) with no limit -- a single game
    or player is small by construction, and even a full season's worth of
    `game_id`s (the team detail page's roster view, up to ~100 games) is
    still small enough that a `DEFAULT_LIMIT`-style cap isn't needed the
    way `/games`'s unfiltered case needs one. `player_id` is the
    exact-identity filter the player detail page uses (nba_api's own id,
    stable across a player's whole career) -- `player_name` alone can't
    disambiguate two players who share a name, and isn't guaranteed to
    return every game for one player if their name was ever recorded
    inconsistently.

    Joined against the Gold `games` table (inner join -- every real
    `player_game_stats` row's `game_id` always has a matching `games` row
    by construction, from either source's ingestion path) to carry each
    row's `game_date`/`home_team`/`away_team`/`home_score`/`away_score`
    alongside the player's own stat line, so a player-name search spanning
    many games shows which game each line came from.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def list_player_stats(
        self, game_id: list[int] | None, player_name: str | None, player_id: int | None = None
    ) -> list[dict]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        games = Table("games", metadata, autoload_with=self._engine)

        stmt = (
            select(
                player_game_stats,
                games.c.game_date,
                games.c.home_team,
                games.c.away_team,
                games.c.home_score,
                games.c.away_score,
            )
            .join(games, player_game_stats.c.game_id == games.c.game_id)
            .order_by(player_game_stats.c.stat_id.desc())
        )
        if game_id:
            stmt = stmt.where(player_game_stats.c.game_id.in_(game_id))
        if player_id is not None:
            stmt = stmt.where(player_game_stats.c.player_id == player_id)
        if player_name is not None:
            full_name = func.concat(
                player_game_stats.c.player_first_name,
                " ",
                player_game_stats.c.player_last_name,
            )
            stmt = stmt.where(full_name.ilike(f"%{player_name}%"))

        with self._engine.connect() as conn:
            rows = [dict(row) for row in conn.execute(stmt).mappings().all()]
        # stat_id = game_id * 10_000_000 + player_id can reach ~10^18 for
        # nba_stats-sourced rows (offset game_id space), well past JS's
        # Number.MAX_SAFE_INTEGER (2^53-1 ~= 9.007e15) -- serialize as a
        # string here so JSON round-tripping through a JS client can't lose
        # precision or collide two distinct stat_ids.
        for row in rows:
            row["stat_id"] = str(row["stat_id"])
        return rows


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
    game_id: list[int] | None = Query(
        default=None,
        description="Filter to one or more exact game_ids (repeat the param for "
        "more than one, e.g. ?game_id=1&game_id=2 -- the team detail page's "
        "roster view passes every game_id in a season this way).",
    ),
    player_name: str | None = Query(
        default=None,
        description="Case-insensitive partial match on the player's combined "
        "first + last name.",
    ),
    player_id: int | None = Query(
        default=None,
        description="Filter to an exact player_id -- every game for one specific "
        "player, disambiguated by id rather than name. Used by the player detail page.",
    ),
    reader: PlayerStatsReader = Depends(get_player_stats_reader),
) -> dict:
    """Per-player, per-game box-score lines from Gold `player_game_stats`.

    - `?game_id=<int>` (repeatable) — return every player line for those
      game(s). A single value returns one game's box score; repeating the
      param returns every player line across all of them (the team detail
      page's roster view, one season's worth of game_ids at once).
    - `?player_name=<text>` — case-insensitive partial match against the
      combined first + last name (e.g. `"lebron"` or `"james"` both match
      "LeBron James").
    - `?player_id=<int>` — every game for one exact player (nba_api's own
      id, stable across their whole career).
    - Any combination may be supplied; none is required (unfiltered returns
      every row in the table).

    Response shape:
        {"data": [<player_game_stats row as a dict>, ...], "count": <int>}

    `player_game_stats` is empty in real Postgres today (see module
    docstring) so `{"data": [], "count": 0}` is the realistic near-term
    response — a normal 200, not an error.
    """

    def _compute() -> dict:
        rows = reader.list_player_stats(game_id, player_name, player_id)
        # Belt-and-suspenders alongside SQLAlchemyPlayerStatsReader's own
        # stringification: applied here too so *every* PlayerStatsReader
        # implementation injected via DI (including test fakes) returns a
        # JS-safe string stat_id, not just the production SQLAlchemy path.
        for row in rows:
            row["stat_id"] = str(row["stat_id"])
        return {"data": rows, "count": len(rows)}

    # Cache key incorporates every filter param's raw value so filtered and
    # unfiltered responses never collide in the cache. game_id is sorted so
    # the same set of ids in a different request order still hits the same
    # cache entry.
    cache_key = (
        f"player-stats:game_id={','.join(map(str, sorted(game_id))) if game_id else ''}"
        f":player_name={(player_name or '').lower()}"
        f":player_id={player_id if player_id is not None else ''}"
    )
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)
