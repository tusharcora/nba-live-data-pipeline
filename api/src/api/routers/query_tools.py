"""LLM-callable query tools for the Statmuse-style NL stats search feature
(SPEC-nl-stats-search, `query-tools.md`) -- `get_player_stats`,
`get_team_games`, `get_leaders`, `get_game_result`, `get_player_stat_aggregate`,
`get_player_streak`.

These six read-only GET endpoints are the *entire* surface the BFF's LLM
loop is allowed to call against Gold Postgres: no raw/arbitrary SQL tool
exists anywhere, and every route here is SELECT-only against the
`api_reader`-scoped engine (`api.core.db.get_engine`), same as
`games.py`/`player_stats.py`.

Response envelope
-----------------
Every route returns exactly one of three shapes, never a bare
`{"data": [], "count": 0}`-style empty result (SPEC's CAP-5: the model must
never be handed a shape it can paper over as "zero of something" vs "I
don't know" -- see the story's Design Notes for why this router departs
from the `/games`/`/player-stats` browsing convention):

    {"status": "ok", "data": <payload>, "candidates": None, "message": None}
    {"status": "no_match", "data": None, "candidates": None, "message": <str>}
    {"status": "ambiguous", "data": None, "candidates": [<candidate>, ...], "message": <str>}

Name resolution
---------------
Player/team names are resolved via `_resolve_name`: exact case-insensitive,
diacritic-insensitive match first (via `_normalize_name` -- real ingested
data includes names like "Dončić"/"Jokić", and a plain-ASCII query must
still resolve); if none, fuzzy match (`difflib.get_close_matches`, cutoff
0.6) against the distinct names actually present in the relevant Gold table
(not some fixed roster) -- 0 fuzzy hits is `no_match`, exactly 1 is treated
as resolved, 2+ is `ambiguous` with those names as candidates. Shared by
both player and team resolution so the exact/fuzzy/ambiguous decision tree
isn't duplicated four times.

Tables reflected via SQLAlchemy Core (`Table(..., autoload_with=engine)`),
same as `games.py`/`player_stats.py` -- no new ORM models, dbt owns
`games`/`player_game_stats`. Per the story's Never list, `get_leaders`
ranks **players only** (summed stat over the range, from
`player_game_stats`'s numeric columns) -- team-level aggregate leaders are
out of scope this story; see the PR description for the deviation from
query-tools.md's literal "players or teams" wording.
"""

from __future__ import annotations

import difflib
import unicodedata
from dataclasses import dataclass
from datetime import date as date_type
from typing import Literal, Protocol, runtime_checkable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import MetaData, Table, and_, func, or_, select
from sqlalchemy.engine import Engine

from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key
from api.routers.game_conflict import load_score_conflict

router = APIRouter(prefix="/tools", tags=["tools"], dependencies=[Depends(require_api_key)])

# `get_leaders`' allowed stat columns -- the numeric columns actually present
# on the Gold `player_game_stats` table (dbt/models/marts/player_game_stats.sql).
# An unsupported `stat` (e.g. "fouls", a column that doesn't exist) is a
# caller error, not a data gap -- 400, not a tool-result envelope.
ALLOWED_LEADER_STATS = {"points", "rebounds", "assists", "steals", "blocks", "turnovers"}

DEFAULT_LEADERS_LIMIT = 10

# Fuzzy-match cutoff and max candidates surfaced on an ambiguous match --
# both are implementation choices (no spec document pins a specific number),
# picked empirically: 0.6 is difflib's own suggested default cutoff and
# catches common typos without over-matching; the candidate cap is a
# defensive bound so a very loose name doesn't dump the entire roster back
# at the model.
FUZZY_CUTOFF = 0.6
MAX_FUZZY_CANDIDATES = 10

# get_player_stat_aggregate's allowed `operation` values -- count_* need a
# threshold, sum/avg/max/min never do (see the route's own validation).
ALLOWED_AGGREGATE_OPERATIONS = {
    "count_over_threshold",
    "count_under_threshold",
    "sum",
    "avg",
    "max",
    "min",
}
COUNT_AGGREGATE_OPERATIONS = {"count_over_threshold", "count_under_threshold"}

# Row-count cap on the `matching_games` drill-down list for a count
# operation -- `value` itself is never affected by this cap (see
# nl-search-aggregate-queries-design.md's "Truncation contract").
MAX_AGGREGATE_MATCHING_GAMES = 20

# Row-count cap for get_player_stats/get_team_games -- unlike get_leaders
# (which is inherently bounded by its own `limit` param), these two return
# every matching row with no cap by default, so a wide/unbounded date range
# for a long-career player or an old franchise could return an very large
# result back into the LLM tool-calling loop. Default keeps the common case
# (a season or so) uncapped in practice; MAX_ROWS_LIMIT bounds the Query
# param itself so a caller can't request an unbounded result on purpose.
DEFAULT_ROWS_LIMIT = 200
MAX_ROWS_LIMIT = 500


# --------------------------------------------------------------------------
# Envelope builders
# --------------------------------------------------------------------------


def _ok(data: object) -> dict:
    return {"status": "ok", "data": data, "candidates": None, "message": None}


def _no_match(message: str) -> dict:
    return {"status": "no_match", "data": None, "candidates": None, "message": message}


def _ambiguous(candidates: list[dict], message: str) -> dict:
    return {"status": "ambiguous", "data": None, "candidates": candidates, "message": message}


# --------------------------------------------------------------------------
# Shared name resolution
# --------------------------------------------------------------------------


@dataclass
class ResolvedName:
    status: Literal["ok", "no_match", "ambiguous"]
    name: str | None = None
    candidates: list[str] | None = None


def _normalize_name(text: str) -> str:
    """Case-fold and strip diacritics for name comparison -- this project's
    real ingested data includes names like "Luka Dončić" and "Nikola
    Jokić", and a caller (or the LLM relaying a user's plain-ASCII typing)
    typing "Doncic"/"Jokic" must still resolve. `NFKD` decomposes each
    accented character into its base letter plus a separate combining mark
    (`unicodedata.combining` is true only for the mark), so dropping
    combining characters after decomposition leaves the plain base letters.
    """
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.strip().lower()


def _resolve_name(candidates: list[str], query: str) -> ResolvedName:
    """Exact case-insensitive, diacritic-insensitive match first; else fuzzy
    match (`difflib`, cutoff `FUZZY_CUTOFF`) against `candidates` (the
    distinct names actually present in the relevant Gold table). 0 fuzzy
    hits -> no_match. 1 fuzzy hit -> resolved. 2+ fuzzy hits -> ambiguous.

    Both the exact and fuzzy comparisons normalize the query first (via
    `_normalize_name`: strip/lowercase plus diacritic-folding), and the
    fuzzy comparison also normalizes the candidate side (mapping back to
    each candidate's original casing/diacritics for the result) -- so a
    plain-ASCII query like "Doncic" matches Gold data spelled "Dončić", and
    incidental leading/trailing whitespace or casing never spuriously
    depresses the difflib similarity ratio below the cutoff.
    """
    normalized_query = _normalize_name(query)
    exact = [name for name in candidates if _normalize_name(name) == normalized_query]
    if exact:
        return ResolvedName(status="ok", name=exact[0])

    normalized_to_original: dict[str, str] = {
        _normalize_name(name): name for name in candidates
    }
    fuzzy_normalized = difflib.get_close_matches(
        normalized_query,
        list(normalized_to_original.keys()),
        n=MAX_FUZZY_CANDIDATES,
        cutoff=FUZZY_CUTOFF,
    )
    fuzzy = [normalized_to_original[name] for name in fuzzy_normalized]
    if not fuzzy:
        return ResolvedName(status="no_match")
    if len(fuzzy) == 1:
        return ResolvedName(status="ok", name=fuzzy[0])
    return ResolvedName(status="ambiguous", candidates=fuzzy)


def _name_candidates(names: list[str]) -> list[dict]:
    return [{"name": name} for name in names]


def _parse_query_date(value: str | None, param_name: str) -> date_type | None:
    """Shared `YYYY-MM-DD` parsing/validation, duplicated from
    `games.py::_parse_query_date` rather than imported -- it's one tiny
    function, and duplicating it avoids coupling this router to an
    unrelated router's internals.
    """
    if value is None:
        return None
    try:
        return date_type.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"{param_name} must be in YYYY-MM-DD format"
        ) from exc


def _reject_reversed_range(start_date: date_type | None, end_date: date_type | None) -> None:
    """Shared `start_date > end_date` guard -- used by every route that
    accepts a `start_date`/`end_date` pair (`get_player_stats`,
    `get_team_games` via `_reject_date_and_range_combo` below, and
    `get_leaders` directly, since it has no single `date` param and so
    doesn't need the rest of that function's combo check).
    """
    if start_date is not None and end_date is not None and start_date > end_date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "start_date must not be after end_date")


def _reject_date_and_range_combo(
    filter_date: date_type | None, start_date: date_type | None, end_date: date_type | None
) -> None:
    if filter_date is not None and (start_date is not None or end_date is not None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "date cannot be combined with start_date/end_date -- use one filter mode",
        )
    _reject_reversed_range(start_date, end_date)


def _player_full_name_expr(player_game_stats: Table):
    return func.concat(
        player_game_stats.c.player_first_name, " ", player_game_stats.c.player_last_name
    )


def _query_distinct_team_names(engine: Engine) -> list[str]:
    """Distinct team names actually present in the Gold `games` table
    (`home_team` union `away_team`) -- shared by `get_team_games` and
    `get_game_result`, both of which resolve a team name the same way.
    """
    metadata = MetaData()
    games = Table("games", metadata, autoload_with=engine)
    stmt = select(games.c.home_team.label("name")).distinct().union(
        select(games.c.away_team.label("name")).distinct()
    )
    with engine.connect() as conn:
        return sorted({row.name for row in conn.execute(stmt) if row.name is not None})


# --------------------------------------------------------------------------
# get_player_stats
# --------------------------------------------------------------------------


@runtime_checkable
class PlayerStatsToolReader(Protocol):
    def distinct_player_names(self) -> list[str]: ...

    def get_player_stats(
        self,
        player_name: str,
        start_date: date_type | None,
        end_date: date_type | None,
        limit: int,
    ) -> list[dict]: ...

    def find_score_conflict(
        self, game_id: int, game_date: date_type, home_team: str, away_team: str
    ) -> dict | None: ...


class SQLAlchemyPlayerStatsToolReader:
    """Production `PlayerStatsToolReader`, backed by the dbt-owned Gold
    `player_game_stats` table joined to `games` for date context, same join
    pattern as `player_stats.py::SQLAlchemyPlayerStatsReader`.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def distinct_player_names(self) -> list[str]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        full_name = _player_full_name_expr(player_game_stats)
        stmt = select(full_name.label("name")).distinct()
        with self._engine.connect() as conn:
            return sorted({row.name for row in conn.execute(stmt) if row.name is not None})

    def get_player_stats(
        self,
        player_name: str,
        start_date: date_type | None,
        end_date: date_type | None,
        limit: int,
    ) -> list[dict]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        games = Table("games", metadata, autoload_with=self._engine)
        full_name = _player_full_name_expr(player_game_stats)

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
            .where(func.lower(full_name) == player_name.lower())
            .order_by(games.c.game_date.desc())
            .limit(limit)
        )
        if start_date is not None:
            stmt = stmt.where(games.c.game_date >= start_date)
        if end_date is not None:
            stmt = stmt.where(games.c.game_date <= end_date)

        with self._engine.connect() as conn:
            rows = [dict(row) for row in conn.execute(stmt).mappings().all()]
        # Same JS-safe-bigint concern as player_stats.py: stat_id can exceed
        # Number.MAX_SAFE_INTEGER for nba_stats-sourced rows.
        for row in rows:
            row["stat_id"] = str(row["stat_id"])
        return rows

    def find_score_conflict(
        self, game_id: int, game_date: date_type, home_team: str, away_team: str
    ) -> dict | None:
        return load_score_conflict(self._engine, game_id, game_date, home_team, away_team)


def get_player_stats_tool_reader() -> PlayerStatsToolReader:
    """FastAPI dependency factory -- overridden in tests via
    `app.dependency_overrides` to inject a fake reader.
    """
    return SQLAlchemyPlayerStatsToolReader()


@router.get("/player-stats")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_player_stats(
    request: Request,
    player_name: str = Query(..., description="Player name -- exact or fuzzy match."),
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
    limit: int = Query(
        default=DEFAULT_ROWS_LIMIT,
        gt=0,
        le=MAX_ROWS_LIMIT,
        description=f"Max number of game rows to return (1-{MAX_ROWS_LIMIT}), "
        "most recent first.",
    ),
    reader: PlayerStatsToolReader = Depends(get_player_stats_tool_reader),
) -> dict:
    """Per-game stat lines for one player, resolved by (fuzzy) name.

    Tool-result envelope (see module docstring) -- `ok`/`no_match`/`ambiguous`,
    never a bare empty list.
    """
    filter_date = _parse_query_date(date, "date")
    parsed_start_date = _parse_query_date(start_date, "start_date")
    parsed_end_date = _parse_query_date(end_date, "end_date")
    _reject_date_and_range_combo(filter_date, parsed_start_date, parsed_end_date)

    effective_start = filter_date or parsed_start_date
    effective_end = filter_date or parsed_end_date

    names = reader.distinct_player_names()
    resolved = _resolve_name(names, player_name)

    if resolved.status == "ambiguous":
        return _ambiguous(
            _name_candidates(resolved.candidates or []),
            f"Multiple players match '{player_name}' -- please clarify which one.",
        )
    if resolved.status == "no_match":
        return _no_match(f"No player found matching '{player_name}'.")

    rows = reader.get_player_stats(resolved.name, effective_start, effective_end, limit)
    if not rows:
        return _no_match(
            f"No stats found for {resolved.name} in the given date range."
        )

    # Belt-and-suspenders alongside SQLAlchemyPlayerStatsToolReader's own
    # stringification (see player_stats.py's list_player_stats for the same
    # pattern): applied here too so *every* PlayerStatsToolReader
    # implementation injected via DI -- including test fakes -- returns a
    # JS-safe string stat_id, not just the production SQLAlchemy path.
    for row in rows:
        row["stat_id"] = str(row["stat_id"])
        confidence = reader.find_score_conflict(
            row["game_id"], row["game_date"], row["home_team"], row["away_team"]
        )
        if confidence is not None:
            row["data_confidence"] = confidence

    return _ok({"player_name": resolved.name, "games": rows})


# --------------------------------------------------------------------------
# get_team_games
# --------------------------------------------------------------------------


@runtime_checkable
class TeamGamesToolReader(Protocol):
    def distinct_team_names(self) -> list[str]: ...

    def get_team_games(
        self,
        team_name: str,
        start_date: date_type | None,
        end_date: date_type | None,
        limit: int,
    ) -> list[dict]: ...


class SQLAlchemyTeamGamesToolReader:
    """Production `TeamGamesToolReader`, backed by the dbt-owned Gold
    `games` table. Matches `home_team` OR `away_team` against the resolved
    team name, same shape as `games.py`'s `team_names` filter.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def distinct_team_names(self) -> list[str]:
        return _query_distinct_team_names(self._engine)

    def get_team_games(
        self,
        team_name: str,
        start_date: date_type | None,
        end_date: date_type | None,
        limit: int,
    ) -> list[dict]:
        metadata = MetaData()
        games = Table("games", metadata, autoload_with=self._engine)

        stmt = (
            select(games)
            .where(or_(games.c.home_team == team_name, games.c.away_team == team_name))
            .order_by(games.c.game_date.desc())
            .limit(limit)
        )
        if start_date is not None:
            stmt = stmt.where(games.c.game_date >= start_date)
        if end_date is not None:
            stmt = stmt.where(games.c.game_date <= end_date)

        with self._engine.connect() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings().all()]


def get_team_games_tool_reader() -> TeamGamesToolReader:
    return SQLAlchemyTeamGamesToolReader()


def _team_game_view(row: dict, team_name: str) -> dict:
    """Reshape a raw `games` row into the team's point of view -- opponent,
    the team's own score vs. the opponent's, whether they were home/away --
    since `get_team_games`' caller only knows the one team it asked about.
    """
    is_home = row["home_team"] == team_name
    opponent = row["away_team"] if is_home else row["home_team"]
    team_score = row["home_score"] if is_home else row["away_score"]
    opponent_score = row["away_score"] if is_home else row["home_score"]
    return {
        "game_id": row["game_id"],
        "game_date": row["game_date"],
        "team": team_name,
        "opponent": opponent,
        "team_score": team_score,
        "opponent_score": opponent_score,
        "is_home": is_home,
        "status": row.get("status"),
        "postseason": row.get("postseason"),
        "season": row.get("season"),
    }


@router.get("/team-games")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_team_games(
    request: Request,
    team: str = Query(..., description="Team name -- exact or fuzzy match."),
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
    limit: int = Query(
        default=DEFAULT_ROWS_LIMIT,
        gt=0,
        le=MAX_ROWS_LIMIT,
        description=f"Max number of game rows to return (1-{MAX_ROWS_LIMIT}), "
        "most recent first.",
    ),
    reader: TeamGamesToolReader = Depends(get_team_games_tool_reader),
) -> dict:
    """Game rows (opponent, score, date) for one team, resolved by (fuzzy) name.

    Tool-result envelope (see module docstring) -- `ok`/`no_match`/`ambiguous`,
    never a bare empty list.
    """
    filter_date = _parse_query_date(date, "date")
    parsed_start_date = _parse_query_date(start_date, "start_date")
    parsed_end_date = _parse_query_date(end_date, "end_date")
    _reject_date_and_range_combo(filter_date, parsed_start_date, parsed_end_date)

    effective_start = filter_date or parsed_start_date
    effective_end = filter_date or parsed_end_date

    names = reader.distinct_team_names()
    resolved = _resolve_name(names, team)

    if resolved.status == "ambiguous":
        return _ambiguous(
            _name_candidates(resolved.candidates or []),
            f"Multiple teams match '{team}' -- please clarify which one.",
        )
    if resolved.status == "no_match":
        return _no_match(f"No team found matching '{team}'.")

    rows = reader.get_team_games(resolved.name, effective_start, effective_end, limit)
    if not rows:
        return _no_match(f"No games found for {resolved.name} in the given date range.")

    return _ok(
        {
            "team": resolved.name,
            "games": [_team_game_view(row, resolved.name) for row in rows],
        }
    )


# --------------------------------------------------------------------------
# get_leaders
# --------------------------------------------------------------------------


@runtime_checkable
class LeadersToolReader(Protocol):
    def get_leaders(
        self,
        stat_column: str,
        start_date: date_type | None,
        end_date: date_type | None,
        limit: int,
    ) -> dict: ...


class SQLAlchemyLeadersToolReader:
    """Production `LeadersToolReader`, backed by the dbt-owned Gold
    `player_game_stats` table joined to `games` for date filtering.

    Ranks players only (see module docstring / story's Never list) by the
    sum of the requested numeric column over the (optional) date range.
    Also computes the *effective* date range and distinct game count over
    the full matching population (not just the top `limit` rows) so
    `get_leaders`' payload discloses what the ranking was actually computed
    over, per query-tools.md / CAP-2.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def get_leaders(
        self,
        stat_column: str,
        start_date: date_type | None,
        end_date: date_type | None,
        limit: int,
    ) -> dict:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        games = Table("games", metadata, autoload_with=self._engine)
        if stat_column not in player_game_stats.c:
            # Should be unreachable -- the route only ever passes a
            # pre-validated member of ALLOWED_LEADER_STATS -- but if that
            # allowlist ever drifts out of sync with the real Gold schema,
            # fail loudly and cleanly rather than raising a raw KeyError.
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"'{stat_column}' is an allowed leader stat but has no matching column "
                "on player_game_stats -- ALLOWED_LEADER_STATS is out of sync with the "
                "Gold schema.",
            )
        stat_col = player_game_stats.c[stat_column]

        joined = player_game_stats.join(games, player_game_stats.c.game_id == games.c.game_id)

        def _apply_date_filters(stmt):
            if start_date is not None:
                stmt = stmt.where(games.c.game_date >= start_date)
            if end_date is not None:
                stmt = stmt.where(games.c.game_date <= end_date)
            return stmt

        summary_stmt = _apply_date_filters(
            select(
                func.min(games.c.game_date).label("min_date"),
                func.max(games.c.game_date).label("max_date"),
                func.count(func.distinct(player_game_stats.c.game_id)).label("game_count"),
            ).select_from(joined)
        )

        leaders_stmt = _apply_date_filters(
            select(
                player_game_stats.c.player_id,
                player_game_stats.c.player_first_name,
                player_game_stats.c.player_last_name,
                func.sum(stat_col).label("total"),
            )
            .select_from(joined)
            .group_by(
                player_game_stats.c.player_id,
                player_game_stats.c.player_first_name,
                player_game_stats.c.player_last_name,
            )
            # Secondary sort key on player_id makes a tie between two
            # players' summed totals deterministic (otherwise the DB is
            # free to return tied rows in an arbitrary/unstable order, so
            # the same request could rank two tied players differently
            # from one call to the next).
            .order_by(func.sum(stat_col).desc().nulls_last(), player_game_stats.c.player_id.asc())
            .limit(limit)
        )

        with self._engine.connect() as conn:
            summary = conn.execute(summary_stmt).mappings().one()
            leader_rows = [dict(row) for row in conn.execute(leaders_stmt).mappings().all()]

        return {
            "leaders": leader_rows,
            "start_date": summary["min_date"],
            "end_date": summary["max_date"],
            "game_count": summary["game_count"] or 0,
        }


def get_leaders_tool_reader() -> LeadersToolReader:
    return SQLAlchemyLeadersToolReader()


@router.get("/leaders")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_leaders(
    request: Request,
    stat: str = Query(
        ...,
        description=(
            "Stat to rank players by -- one of: "
            + ", ".join(sorted(ALLOWED_LEADER_STATS))
        ),
    ),
    start_date: str | None = Query(
        default=None, description="Filter to games on or after this date, YYYY-MM-DD."
    ),
    end_date: str | None = Query(
        default=None, description="Filter to games on or before this date, YYYY-MM-DD."
    ),
    limit: int = Query(
        default=DEFAULT_LEADERS_LIMIT,
        gt=0,
        le=100,
        description="Max number of ranked players to return (1-100).",
    ),
    reader: LeadersToolReader = Depends(get_leaders_tool_reader),
) -> dict:
    """Ranked players by summed stat over a date range (players only --
    see the story's Never list for why team-level leaders are out of scope).

    `data.date_range` and `data.game_count` are always the *effective*
    range/count the ranking was actually computed over, embedded directly
    in the payload rather than left for the caller to derive (CAP-2).

    Tool-result envelope (see module docstring) -- `ok`/`no_match`, never a
    bare empty list. `stat` outside `ALLOWED_LEADER_STATS` is a 400 (a
    caller error, not a data gap).
    """
    # Case-insensitive, matching the fuzzy name matching elsewhere in this
    # module -- a caller/LLM shouldn't need to get "assists" vs "Assists"
    # exactly right for a fixed, small enum-like param.
    stat_key = stat.strip().lower()
    if stat_key not in ALLOWED_LEADER_STATS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"stat must be one of: {', '.join(sorted(ALLOWED_LEADER_STATS))}",
        )

    parsed_start_date = _parse_query_date(start_date, "start_date")
    parsed_end_date = _parse_query_date(end_date, "end_date")
    _reject_reversed_range(parsed_start_date, parsed_end_date)

    result = reader.get_leaders(stat_key, parsed_start_date, parsed_end_date, limit)

    if not result["leaders"]:
        return _no_match(f"No {stat_key} data found for the given date range.")

    leaders = [
        {
            "player_id": row["player_id"],
            "player_name": f"{row['player_first_name']} {row['player_last_name']}",
            "value": row["total"],
        }
        for row in result["leaders"]
    ]

    return _ok(
        {
            "stat": stat_key,
            "date_range": {
                "start_date": result["start_date"],
                "end_date": result["end_date"],
            },
            "game_count": result["game_count"],
            "leaders": leaders,
        }
    )


# --------------------------------------------------------------------------
# get_player_stat_aggregate
# --------------------------------------------------------------------------


@runtime_checkable
class PlayerStatAggregateToolReader(Protocol):
    def distinct_player_names(self) -> list[str]: ...

    def get_aggregate(
        self,
        player_name: str,
        stat_column: str,
        operation: str,
        threshold: int | None,
        start_date: date_type | None,
        end_date: date_type | None,
    ) -> dict: ...


class SQLAlchemyPlayerStatAggregateToolReader:
    """Production `PlayerStatAggregateToolReader`. `sum`/`avg` compute a
    single SQL aggregate; `max`/`min` order by the aggregated value then
    `game_date DESC` and take one row, which gives both the extreme value
    and its deterministic tie-break (most recent of ties) from a single
    query; `count_over_threshold`/`count_under_threshold` run a `COUNT(*)`
    for the true `value` and a separate, capped `LIMIT`ed query for the
    `matching_games` drill-down list, so the cap never affects the count.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def distinct_player_names(self) -> list[str]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        full_name = _player_full_name_expr(player_game_stats)
        stmt = select(full_name.label("name")).distinct()
        with self._engine.connect() as conn:
            return sorted({row.name for row in conn.execute(stmt) if row.name is not None})

    def get_aggregate(
        self,
        player_name: str,
        stat_column: str,
        operation: str,
        threshold: int | None,
        start_date: date_type | None,
        end_date: date_type | None,
    ) -> dict:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        games = Table("games", metadata, autoload_with=self._engine)
        full_name = _player_full_name_expr(player_game_stats)
        stat_col = player_game_stats.c[stat_column]
        joined = player_game_stats.join(games, player_game_stats.c.game_id == games.c.game_id)

        def _scoped(stmt):
            stmt = stmt.select_from(joined).where(func.lower(full_name) == player_name.lower())
            if start_date is not None:
                stmt = stmt.where(games.c.game_date >= start_date)
            if end_date is not None:
                stmt = stmt.where(games.c.game_date <= end_date)
            return stmt

        summary_stmt = _scoped(
            select(
                func.min(games.c.game_date).label("min_date"),
                func.max(games.c.game_date).label("max_date"),
                func.count(func.distinct(player_game_stats.c.game_id)).label("game_count"),
            )
        )
        with self._engine.connect() as conn:
            summary = conn.execute(summary_stmt).mappings().one()

        game_count_considered = summary["game_count"] or 0
        if game_count_considered == 0:
            return {
                "game_count_considered": 0,
                "value": None,
                "matching_games": None,
                "extreme_game": None,
                "date_range": None,
            }

        date_range = {"start_date": summary["min_date"], "end_date": summary["max_date"]}

        def _row_dict(row: dict) -> dict:
            out = dict(row)
            out["stat_id"] = str(out["stat_id"])
            return out

        if operation in ("sum", "avg"):
            agg_fn = func.sum if operation == "sum" else func.avg
            value_stmt = _scoped(select(agg_fn(stat_col)))
            with self._engine.connect() as conn:
                raw_value = conn.execute(value_stmt).scalar()
            # A non-empty range (game_count_considered > 0) can still sum/avg
            # to SQL NULL if every game in range has a NULL stat value (e.g.
            # a run of DNP rows) -- func.sum/func.avg over an all-NULL column
            # return NULL, not 0. Treated as a real `0`, not a crash or a
            # no_match: same "real zero, not a gap" principle this tool
            # already applies to threshold-counts.
            if raw_value is None:
                value = 0
            else:
                value = float(raw_value) if operation == "avg" else int(raw_value)
            return {
                "game_count_considered": game_count_considered,
                "value": value,
                "matching_games": None,
                "extreme_game": None,
                "date_range": date_range,
            }

        row_columns = select(
            player_game_stats,
            games.c.game_date,
            games.c.home_team,
            games.c.away_team,
            games.c.home_score,
            games.c.away_score,
        )

        if operation in ("max", "min"):
            # nulls_last() matches SQLAlchemyLeadersToolReader's own ordering
            # convention (see its leaders_stmt above): without it, Postgres's
            # default NULLS-FIRST-on-DESC behavior would let a NULL stat
            # value (a real possibility for a DNP row) sort first and win
            # `max`, returning value: None and citing the wrong game.
            order = (
                stat_col.desc().nulls_last() if operation == "max" else stat_col.asc().nulls_last()
            )
            extreme_stmt = (
                _scoped(row_columns).order_by(order, games.c.game_date.desc()).limit(1)
            )
            with self._engine.connect() as conn:
                row = conn.execute(extreme_stmt).mappings().one()
            return {
                "game_count_considered": game_count_considered,
                "value": row[stat_column],
                "matching_games": None,
                "extreme_game": _row_dict(dict(row)),
                "date_range": date_range,
            }

        # count_over_threshold / count_under_threshold
        comparator = (
            stat_col >= threshold if operation == "count_over_threshold" else stat_col <= threshold
        )
        count_stmt = _scoped(select(func.count())).where(comparator)
        with self._engine.connect() as conn:
            value = conn.execute(count_stmt).scalar() or 0

            matching_stmt = (
                _scoped(row_columns)
                .where(comparator)
                .order_by(games.c.game_date.desc())
                .limit(MAX_AGGREGATE_MATCHING_GAMES)
            )
            matching_rows = [_row_dict(dict(r)) for r in conn.execute(matching_stmt).mappings().all()]

        return {
            "game_count_considered": game_count_considered,
            "value": value,
            "matching_games": matching_rows,
            "extreme_game": None,
            "date_range": date_range,
        }


def get_player_stat_aggregate_tool_reader() -> PlayerStatAggregateToolReader:
    return SQLAlchemyPlayerStatAggregateToolReader()


@router.get("/player-stat-aggregate")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_player_stat_aggregate(
    request: Request,
    player_name: str = Query(..., description="Player name -- exact or fuzzy match."),
    stat: str = Query(
        ..., description="Stat to aggregate -- one of: " + ", ".join(sorted(ALLOWED_LEADER_STATS))
    ),
    operation: str = Query(
        ...,
        description="One of: " + ", ".join(sorted(ALLOWED_AGGREGATE_OPERATIONS)),
    ),
    threshold: int | None = Query(
        default=None,
        description="Required for count_over_threshold/count_under_threshold; "
        "must not be supplied for sum/avg/max/min.",
    ),
    date: str | None = Query(default=None, description="Filter to a single date, YYYY-MM-DD."),
    start_date: str | None = Query(
        default=None,
        description="Filter to games on or after this date, YYYY-MM-DD. "
        "Omitted along with end_date/date means full ingested history.",
    ),
    end_date: str | None = Query(
        default=None, description="Filter to games on or before this date, YYYY-MM-DD."
    ),
    reader: PlayerStatAggregateToolReader = Depends(get_player_stat_aggregate_tool_reader),
) -> dict:
    """A single player's threshold-count, sum, avg, max, or min over a date
    range (default: full ingested history).

    `no_match` fires only when the player has zero games in the requested
    range at all (`game_count_considered == 0`) -- a computed `value` of
    `0` with real games present (e.g. "how many 50-point games" for a
    player who never hit 50) is a valid `ok` response, not a gap. See this
    tool's design doc for why that distinction matters.
    """
    stat_key = stat.strip().lower()
    if stat_key not in ALLOWED_LEADER_STATS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"stat must be one of: {', '.join(sorted(ALLOWED_LEADER_STATS))}",
        )

    operation_key = operation.strip().lower()
    if operation_key not in ALLOWED_AGGREGATE_OPERATIONS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"operation must be one of: {', '.join(sorted(ALLOWED_AGGREGATE_OPERATIONS))}",
        )

    is_count_operation = operation_key in COUNT_AGGREGATE_OPERATIONS
    if is_count_operation and threshold is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"threshold is required for operation '{operation_key}'"
        )
    if not is_count_operation and threshold is not None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"threshold must not be supplied for operation '{operation_key}'",
        )

    filter_date = _parse_query_date(date, "date")
    parsed_start_date = _parse_query_date(start_date, "start_date")
    parsed_end_date = _parse_query_date(end_date, "end_date")
    _reject_date_and_range_combo(filter_date, parsed_start_date, parsed_end_date)
    effective_start = filter_date or parsed_start_date
    effective_end = filter_date or parsed_end_date

    names = reader.distinct_player_names()
    resolved = _resolve_name(names, player_name)
    if resolved.status == "ambiguous":
        return _ambiguous(
            _name_candidates(resolved.candidates or []),
            f"Multiple players match '{player_name}' -- please clarify which one.",
        )
    if resolved.status == "no_match":
        return _no_match(f"No player found matching '{player_name}'.")

    result = reader.get_aggregate(
        resolved.name, stat_key, operation_key, threshold, effective_start, effective_end
    )

    if result["game_count_considered"] == 0:
        return _no_match(f"No games found for {resolved.name} in the given date range.")

    matching_games = result["matching_games"]
    matching_games_truncated = (
        matching_games is not None and len(matching_games) < result["value"]
    )

    return _ok(
        {
            "player_name": resolved.name,
            "stat": stat_key,
            "operation": operation_key,
            "threshold": threshold,
            "value": result["value"],
            "extreme_game": result["extreme_game"],
            "matching_games": matching_games,
            "matching_games_truncated": matching_games_truncated,
            "game_count_considered": result["game_count_considered"],
            "date_range": result["date_range"],
        }
    )


# --------------------------------------------------------------------------
# get_player_streak
# --------------------------------------------------------------------------


@runtime_checkable
class PlayerStreakToolReader(Protocol):
    def distinct_player_names(self) -> list[str]: ...

    def get_streak(
        self,
        player_name: str,
        stat_column: str,
        threshold: int,
        start_date: date_type | None,
        end_date: date_type | None,
    ) -> dict: ...


class SQLAlchemyPlayerStreakToolReader:
    """Production `PlayerStreakToolReader`. Classic gaps-and-islands over
    date-ordered rows: `rn_all - rn_hit` (two `ROW_NUMBER()` window
    functions, one over every row, one partitioned by whether the row
    clears `threshold`) is constant within one consecutive run of the same
    hit/miss state -- grouping by that difference isolates each run, and
    the longest `hit` run (ties broken by the most recent end date) is the
    reported streak. `is_active` compares the winning streak's end date to
    the player's actual most recent game in range.
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def distinct_player_names(self) -> list[str]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        full_name = _player_full_name_expr(player_game_stats)
        stmt = select(full_name.label("name")).distinct()
        with self._engine.connect() as conn:
            return sorted({row.name for row in conn.execute(stmt) if row.name is not None})

    def get_streak(
        self,
        player_name: str,
        stat_column: str,
        threshold: int,
        start_date: date_type | None,
        end_date: date_type | None,
    ) -> dict:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        games = Table("games", metadata, autoload_with=self._engine)
        full_name = _player_full_name_expr(player_game_stats)
        stat_col = player_game_stats.c[stat_column]
        joined = player_game_stats.join(games, player_game_stats.c.game_id == games.c.game_id)

        base = (
            select(
                player_game_stats,
                games.c.game_date,
                games.c.home_team,
                games.c.away_team,
                games.c.home_score,
                games.c.away_score,
                (stat_col >= threshold).label("hit"),
            )
            .select_from(joined)
            .where(func.lower(full_name) == player_name.lower())
        )
        if start_date is not None:
            base = base.where(games.c.game_date >= start_date)
        if end_date is not None:
            base = base.where(games.c.game_date <= end_date)
        base_cte = base.cte("base")

        numbered = select(
            base_cte,
            # Secondary sort key on game_id makes the two window functions'
            # ordering deterministic when two rows share the same
            # game_date -- otherwise rn_all and rn_hit could break ties
            # inconsistently with each other, corrupting the grp
            # computation below (same deterministic-ordering discipline
            # get_leaders applies to its own tie-break).
            func.row_number()
            .over(order_by=[base_cte.c.game_date, base_cte.c.game_id])
            .label("rn_all"),
            func.row_number()
            .over(partition_by=base_cte.c.hit, order_by=[base_cte.c.game_date, base_cte.c.game_id])
            .label("rn_hit"),
        ).cte("numbered")

        grouped = select(
            numbered, (numbered.c.rn_all - numbered.c.rn_hit).label("grp")
        ).cte("grouped")

        with self._engine.connect() as conn:
            overall = conn.execute(
                select(
                    # count(distinct game_id), not a bare count() -- matches
                    # SQLAlchemyPlayerStatAggregateToolReader's own
                    # game_count_considered convention (consistency between
                    # the two aggregate-style tools).
                    func.count(func.distinct(base_cte.c.game_id)).label("game_count"),
                    func.min(base_cte.c.game_date).label("min_date"),
                    func.max(base_cte.c.game_date).label("max_date"),
                ).select_from(base_cte)
            ).mappings().one()

            game_count_considered = overall["game_count"] or 0
            if game_count_considered == 0:
                return {
                    "game_count_considered": 0,
                    "longest_streak": None,
                    "streak_date_range": None,
                    "is_active": None,
                    "games": None,
                    "date_range": None,
                }

            date_range = {"start_date": overall["min_date"], "end_date": overall["max_date"]}

            streak_summary = (
                select(
                    grouped.c.grp,
                    func.count().label("streak_length"),
                    func.min(grouped.c.game_date).label("streak_start"),
                    func.max(grouped.c.game_date).label("streak_end"),
                )
                .where(grouped.c.hit.is_(True))
                .group_by(grouped.c.grp)
                # Longest streak first; ties broken by the more recent end
                # date (this tool's tie-break rule, matching
                # get_player_stat_aggregate's extreme_game rule).
                .order_by(func.count().desc(), func.max(grouped.c.game_date).desc())
                .limit(1)
            )
            streak_row = conn.execute(streak_summary).mappings().first()

            if streak_row is None:
                return {
                    "game_count_considered": game_count_considered,
                    "longest_streak": 0,
                    "streak_date_range": None,
                    "is_active": False,
                    "games": [],
                    "date_range": date_range,
                }

            streak_games_stmt = (
                select(grouped)
                .where(grouped.c.grp == streak_row["grp"], grouped.c.hit.is_(True))
                .order_by(grouped.c.game_date)
            )
            streak_rows = [dict(r) for r in conn.execute(streak_games_stmt).mappings().all()]

        for row in streak_rows:
            row["stat_id"] = str(row["stat_id"])
            row.pop("hit", None)
            row.pop("rn_all", None)
            row.pop("rn_hit", None)
            row.pop("grp", None)

        is_active = streak_row["streak_end"] == overall["max_date"]

        return {
            "game_count_considered": game_count_considered,
            "longest_streak": streak_row["streak_length"],
            "streak_date_range": {
                "start_date": streak_row["streak_start"],
                "end_date": streak_row["streak_end"],
            },
            "is_active": is_active,
            "games": streak_rows,
            "date_range": date_range,
        }


def get_player_streak_tool_reader() -> PlayerStreakToolReader:
    return SQLAlchemyPlayerStreakToolReader()


@router.get("/player-streak")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_player_streak(
    request: Request,
    player_name: str = Query(..., description="Player name -- exact or fuzzy match."),
    stat: str = Query(
        ..., description="Stat to track -- one of: " + ", ".join(sorted(ALLOWED_LEADER_STATS))
    ),
    threshold: int = Query(..., description="A game counts toward the streak if stat >= threshold."),
    start_date: str | None = Query(
        default=None,
        description="Filter to games on or after this date, YYYY-MM-DD. "
        "Omitted along with end_date means full ingested history.",
    ),
    end_date: str | None = Query(
        default=None, description="Filter to games on or before this date, YYYY-MM-DD."
    ),
    reader: PlayerStreakToolReader = Depends(get_player_streak_tool_reader),
) -> dict:
    """A player's longest consecutive run of games meeting a stat threshold
    over a date range (default: full ingested history).

    `no_match` fires only when the player has zero games in the requested
    range at all -- `longest_streak: 0` with real games present (none of
    which ever cleared the threshold) is a valid `ok` response, same
    correctness distinction as `get_player_stat_aggregate`. Ties between
    equal-length streaks resolve to the more recent one, and `is_active`
    is true only when the reported streak's last game is also the most
    recent game in range.
    """
    stat_key = stat.strip().lower()
    if stat_key not in ALLOWED_LEADER_STATS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"stat must be one of: {', '.join(sorted(ALLOWED_LEADER_STATS))}",
        )

    parsed_start_date = _parse_query_date(start_date, "start_date")
    parsed_end_date = _parse_query_date(end_date, "end_date")
    _reject_reversed_range(parsed_start_date, parsed_end_date)

    names = reader.distinct_player_names()
    resolved = _resolve_name(names, player_name)
    if resolved.status == "ambiguous":
        return _ambiguous(
            _name_candidates(resolved.candidates or []),
            f"Multiple players match '{player_name}' -- please clarify which one.",
        )
    if resolved.status == "no_match":
        return _no_match(f"No player found matching '{player_name}'.")

    result = reader.get_streak(
        resolved.name, stat_key, threshold, parsed_start_date, parsed_end_date
    )

    if result["game_count_considered"] == 0:
        return _no_match(f"No games found for {resolved.name} in the given date range.")

    return _ok(
        {
            "player_name": resolved.name,
            "stat": stat_key,
            "threshold": threshold,
            "longest_streak": result["longest_streak"],
            "streak_date_range": result["streak_date_range"],
            "is_active": result["is_active"],
            "games": result["games"],
            "game_count_considered": result["game_count_considered"],
            "date_range": result["date_range"],
        }
    )


# --------------------------------------------------------------------------
# get_game_result
# --------------------------------------------------------------------------


@runtime_checkable
class GameResultToolReader(Protocol):
    def distinct_team_names(self) -> list[str]: ...

    def get_game_result(
        self, team_a: str, team_b: str, game_date: date_type
    ) -> dict | None: ...

    def get_box_score(self, game_id: int) -> list[dict]: ...

    def find_score_conflict(
        self, game_id: int, game_date: date_type, home_team: str, away_team: str
    ) -> dict | None: ...


class SQLAlchemyGameResultToolReader:
    """Production `GameResultToolReader`, backed by the dbt-owned Gold
    `games` table (the matchup) and `player_game_stats` (the box score,
    when available for that `game_id`).
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def distinct_team_names(self) -> list[str]:
        return _query_distinct_team_names(self._engine)

    def get_game_result(self, team_a: str, team_b: str, game_date: date_type) -> dict | None:
        metadata = MetaData()
        games = Table("games", metadata, autoload_with=self._engine)
        stmt = select(games).where(
            games.c.game_date == game_date,
            or_(
                and_(games.c.home_team == team_a, games.c.away_team == team_b),
                and_(games.c.home_team == team_b, games.c.away_team == team_a),
            ),
        )
        with self._engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        return dict(row) if row is not None else None

    def get_box_score(self, game_id: int) -> list[dict]:
        metadata = MetaData()
        player_game_stats = Table("player_game_stats", metadata, autoload_with=self._engine)
        stmt = select(player_game_stats).where(player_game_stats.c.game_id == game_id)
        with self._engine.connect() as conn:
            rows = [dict(row) for row in conn.execute(stmt).mappings().all()]
        for row in rows:
            row["stat_id"] = str(row["stat_id"])
        return rows

    def find_score_conflict(
        self, game_id: int, game_date: date_type, home_team: str, away_team: str
    ) -> dict | None:
        return load_score_conflict(self._engine, game_id, game_date, home_team, away_team)


def get_game_result_tool_reader() -> GameResultToolReader:
    return SQLAlchemyGameResultToolReader()


@router.get("/game-result")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_game_result(
    request: Request,
    team_a: str = Query(..., description="First team's name -- exact or fuzzy match."),
    team_b: str = Query(..., description="Second team's name -- exact or fuzzy match."),
    date: str = Query(..., description="Game date, YYYY-MM-DD."),
    reader: GameResultToolReader = Depends(get_game_result_tool_reader),
) -> dict:
    """The specific game's final score and, where available, its box score.

    Tool-result envelope (see module docstring) -- `ok`/`no_match`/`ambiguous`,
    never a guessed score.
    """
    game_date = _parse_query_date(date, "date")

    names = reader.distinct_team_names()

    resolved_a = _resolve_name(names, team_a)
    if resolved_a.status == "ambiguous":
        return _ambiguous(
            _name_candidates(resolved_a.candidates or []),
            f"Multiple teams match '{team_a}' -- please clarify which one.",
        )
    if resolved_a.status == "no_match":
        return _no_match(f"No team found matching '{team_a}'.")

    resolved_b = _resolve_name(names, team_b)
    if resolved_b.status == "ambiguous":
        return _ambiguous(
            _name_candidates(resolved_b.candidates or []),
            f"Multiple teams match '{team_b}' -- please clarify which one.",
        )
    if resolved_b.status == "no_match":
        return _no_match(f"No team found matching '{team_b}'.")

    if resolved_a.name == resolved_b.name:
        return _no_match(
            f"team_a and team_b both resolved to the same team "
            f"('{resolved_a.name}') -- a game needs two different teams."
        )

    row = reader.get_game_result(resolved_a.name, resolved_b.name, game_date)
    if row is None:
        return _no_match(
            f"No game found between {resolved_a.name} and {resolved_b.name} on {date}."
        )

    confidence = reader.find_score_conflict(
        row["game_id"], game_date, row["home_team"], row["away_team"]
    )
    if confidence is not None:
        row["data_confidence"] = confidence

    box_score = reader.get_box_score(row["game_id"])
    for stat_row in box_score:
        stat_row["stat_id"] = str(stat_row["stat_id"])

    return _ok({"game": row, "box_score": box_score})
