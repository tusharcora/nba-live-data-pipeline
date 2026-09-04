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
from sqlalchemy import MetaData, Table, or_, select
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

    def list_games(
        self,
        filter_date: date_type | None,
        start_date: date_type | None = None,
        end_date: date_type | None = None,
        game_id: int | None = None,
        team_names: list[str] | None = None,
    ) -> list[dict]: ...


class SQLAlchemyGamesReader:
    """Production `GamesReader`, backed by the dbt-owned Gold `games` table.

    `list_games(None)` returns the `DEFAULT_LIMIT` most recent games ordered
    by `game_date` descending (ties broken by `game_id` descending for a
    stable order). `list_games(some_date)` returns every game on that date
    (no limit applied), also ordered by `game_id` descending.

    `start_date`/`end_date` return every game with `game_date` in that
    inclusive range (either bound may be omitted for an open-ended range),
    no limit applied. The route layer guarantees `filter_date` and
    `start_date`/`end_date` are never both set on the same call (combining
    them is a 400 before it reaches this reader — see the route docstring),
    so `filter_date` always takes priority here as a defensive fallback
    only.

    `game_id` and `team_names` are independent, composable filters (ANDed
    with whichever date filter is also active, and with each other) rather
    than another mutually-exclusive mode -- `game_id` is an exact-identity
    lookup (the game detail page), `team_names` matches `home_team` OR
    `away_team` against any of the given values (the team detail page,
    which passes every historical full-name variant for one franchise --
    e.g. both "New Jersey Nets" and "Brooklyn Nets" -- since this table
    has no team-id column to key on directly; see
    `lib/box-score.tsx`'s `TEAM_NAME_TO_ABBREVIATION` for why a team can
    have more than one).
    """

    DEFAULT_LIMIT = 20

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def list_games(
        self,
        filter_date: date_type | None,
        start_date: date_type | None = None,
        end_date: date_type | None = None,
        game_id: int | None = None,
        team_names: list[str] | None = None,
    ) -> list[dict]:
        metadata = MetaData()
        games = Table("games", metadata, autoload_with=self._engine)

        stmt = select(games).order_by(games.c.game_date.desc(), games.c.game_id.desc())
        has_date_filter = False
        if filter_date is not None:
            stmt = stmt.where(games.c.game_date == filter_date)
            has_date_filter = True
        elif start_date is not None or end_date is not None:
            if start_date is not None:
                stmt = stmt.where(games.c.game_date >= start_date)
            if end_date is not None:
                stmt = stmt.where(games.c.game_date <= end_date)
            has_date_filter = True

        if game_id is not None:
            stmt = stmt.where(games.c.game_id == game_id)
        if team_names:
            stmt = stmt.where(
                or_(games.c.home_team.in_(team_names), games.c.away_team.in_(team_names))
            )

        if not has_date_filter and game_id is None and not team_names:
            stmt = stmt.limit(self.DEFAULT_LIMIT)

        with self._engine.connect() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings().all()]


def get_games_reader() -> GamesReader:
    """FastAPI dependency factory — overridden in tests via
    `app.dependency_overrides[get_games_reader]` to inject a fake reader.
    """
    return SQLAlchemyGamesReader()


def _parse_query_date(value: str | None, param_name: str) -> date_type | None:
    """Shared `YYYY-MM-DD` parsing/validation for every date-shaped query
    param on this route (`date`, `start_date`, `end_date`) — one validation
    pattern, reused rather than duplicated three times.
    """
    if value is None:
        return None
    try:
        return date_type.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"{param_name} must be in YYYY-MM-DD format"
        ) from exc


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def list_games(
    request: Request,
    date: str | None = Query(
        default=None, description="Filter to a single date, YYYY-MM-DD."
    ),
    start_date: str | None = Query(
        default=None,
        description="Filter to games on or after this date, YYYY-MM-DD. "
        "Mutually exclusive with `date`.",
    ),
    end_date: str | None = Query(
        default=None,
        description="Filter to games on or before this date, YYYY-MM-DD. "
        "Mutually exclusive with `date`.",
    ),
    game_id: int | None = Query(
        default=None, description="Filter to an exact game_id (the game detail page)."
    ),
    team: list[str] | None = Query(
        default=None,
        description="Filter to games where home_team or away_team matches any of the "
        "given full team names (repeat the param for a team's multiple historical "
        "names, e.g. ?team=New+Jersey+Nets&team=Brooklyn+Nets). Composable with the "
        "date filters and game_id.",
    ),
    reader: GamesReader = Depends(get_games_reader),
) -> dict:
    """Reconciled games from Gold (docs/prd.md §06, §11).

    - `?date=YYYY-MM-DD` — return every game on that date.
    - `?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` — return every game with
      `game_date` in that inclusive range. Either bound may be omitted for
      an open-ended range (e.g. `?start_date=...` alone means "on or after").
    - `?game_id=<int>` — return the one game with that id (the game detail
      page's lookup).
    - `?team=<name>` (repeatable) — return every game where either side
      matches any given full team name (the team detail page's lookup —
      pass every historical name variant for one franchise).
    - No params at all — return the most recent 20 games, ordered by
      `game_date` descending (see `SQLAlchemyGamesReader.DEFAULT_LIMIT`).
      Any filter above (date, game_id, or team) disables this default
      limit, composing with whichever others are also present.

    `date` and `start_date`/`end_date` are two distinct, mutually exclusive
    filter modes: combining `date` with either range bound is a 400 rather
    than one silently winning (a caller should never have to guess a
    precedence rule). `start_date > end_date` is also a 400 — treated as a
    caller-side bug (bad date arithmetic) worth surfacing loudly rather than
    quietly returning an empty result that could be mistaken for "no games
    on those dates". `game_id` and `team` carry no such restriction — they
    compose with the date filters and with each other.

    Response shape:
        {"data": [<game row as a dict, Gold `games` columns>, ...], "count": <int>}
    """
    filter_date = _parse_query_date(date, "date")
    parsed_start_date = _parse_query_date(start_date, "start_date")
    parsed_end_date = _parse_query_date(end_date, "end_date")

    if filter_date is not None and (parsed_start_date is not None or parsed_end_date is not None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "date cannot be combined with start_date/end_date — use one filter mode",
        )

    if (
        parsed_start_date is not None
        and parsed_end_date is not None
        and parsed_start_date > parsed_end_date
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "start_date must not be after end_date"
        )

    def _compute() -> dict:
        rows = reader.list_games(
            filter_date, parsed_start_date, parsed_end_date, game_id, team
        )
        return {"data": rows, "count": len(rows)}

    # Cache key incorporates every filter param's raw value (not just "some
    # filter is set") so single-date, range, game_id, team, and
    # unfiltered/"recent" responses never collide in the cache.
    if date is not None:
        cache_key = f"games:{date}"
    elif start_date is not None or end_date is not None:
        cache_key = f"games:range:{start_date or ''}:{end_date or ''}"
    elif game_id is not None:
        cache_key = f"games:game_id:{game_id}"
    elif team:
        cache_key = f"games:team:{','.join(sorted(team))}"
    else:
        cache_key = "games:recent"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)
