"""Volumetric completeness checks for completed games (docs/prd.md §07).

"Each completed game should produce exactly two teams and a bounded,
non-zero range of player rows. Deviations flag before reaching Silver."

This module is pure-function-first: `check_game_volumetrics` takes plain
dicts/sets in and returns a typed `QualityMetric` row, with all DB access
pushed to the `GoldReader`/`QualityMetricSink` DI seam at the edge (same
pattern as `ingestion.flows.backfill_flow`'s `RawPullSink`/`CheckpointStore`)
so the check logic is testable without a live Postgres.

NOTE on team identity: the Gold `games`/`player_game_stats` tables (owned by
dbt, not this package — see dbt/models/marts/games.sql and
.../player_game_stats.sql) only carry team *names* as text
(`games.home_team`/`games.away_team`, `player_game_stats.team`). There is no
integer `team_id` column anywhere in the Gold layer today. Since this
module's spec calls for `team_ids: set[int]`, the production
`SQLAlchemyGoldReader` below derives a stable synthetic id per team name via
`zlib.crc32` so results are reproducible run-to-run (not just process-local,
unlike Python's salted `hash()`). This is a deliberate compromise flagged
for boss review — a real `teams` dimension table with a stable numeric id
would be a cleaner fix in a future week, at which point this shim goes away.
"""

from __future__ import annotations

import zlib
from datetime import date
from typing import Protocol, runtime_checkable

from sqlalchemy import MetaData, Table, create_engine, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import QualityMetric
from quality.config import Settings

CHECK_NAME = "volumetric_game_check"


def check_game_volumetrics(
    game_id: int,
    team_ids: set[int],
    player_row_count_by_team: dict[int, int],
    min_players_per_team: int = 8,
    max_players_per_team: int = 15,
) -> QualityMetric:
    """Pure boundary check: exactly 2 teams, each with a bounded player-row count.

    Fails (`metric_value=0.0`) if `len(team_ids) != 2`, or if any team's
    player-row count falls outside `[min_players_per_team,
    max_players_per_team]` (a team missing entirely from
    `player_row_count_by_team` counts as 0 rows). Passes (`metric_value=1.0`)
    otherwise. Always returns exactly one `QualityMetric` whose
    `metadata_json["failure_reason"]` explains *why* it failed (or is `None`
    when it passed) — never just "failed".
    """
    failure_reason: str | None = None

    if len(team_ids) != 2:
        failure_reason = (
            f"expected exactly 2 teams, found {len(team_ids)}: {sorted(team_ids)}"
        )
    else:
        out_of_bounds = [
            (team_id, player_row_count_by_team.get(team_id, 0))
            for team_id in sorted(team_ids)
            if not (
                min_players_per_team
                <= player_row_count_by_team.get(team_id, 0)
                <= max_players_per_team
            )
        ]
        if out_of_bounds:
            details = "; ".join(
                f"team {team_id} has {count} player rows (expected "
                f"{min_players_per_team}-{max_players_per_team})"
                for team_id, count in out_of_bounds
            )
            failure_reason = f"player count out of bounds: {details}"

    return QualityMetric(
        check_name=CHECK_NAME,
        metric_value=0.0 if failure_reason is not None else 1.0,
        metadata_json={
            "game_id": game_id,
            "team_ids": list(team_ids),
            "player_counts": player_row_count_by_team,
            "failure_reason": failure_reason,
        },
    )


@runtime_checkable
class GoldReader(Protocol):
    """Injectable read path for the dbt-owned Gold `games`/`player_game_stats`
    tables — keeps `check_completed_games` DB-free and testable.

    `@runtime_checkable` for the same reason as `ingestion`'s flow protocols:
    a bare `Protocol` isn't required here (this isn't a Prefect flow
    parameter today) but is kept structurally consistent in case this
    orchestration function is later wrapped in one.
    """

    def get_completed_games_with_player_counts(
        self, as_of: date
    ) -> list[tuple[int, set[int], dict[int, int]]]: ...


@runtime_checkable
class QualityMetricSink(Protocol):
    """Injectable write path for `quality_metrics` rows."""

    def write_many(self, metrics: list[QualityMetric]) -> None: ...


def _stable_team_id(team_name: str) -> int:
    """Deterministic synthetic int id for a team name (see module docstring)."""
    return zlib.crc32(team_name.encode("utf-8"))


class SQLAlchemyGoldReader:
    """Production `GoldReader`: read-only SQLAlchemy Core queries against the
    dbt-owned `games`/`player_game_stats` Gold tables.

    Reflects both tables via `Table(..., autoload_with=engine)` rather than
    adding new ORM models — `quality` doesn't own these tables' schemas,
    dbt does (see `dbt/models/marts/games.sql`,
    `.../player_game_stats.sql`).

    "Completed" is defined as `games.status == "Final"` — the only game
    status value the current staging model documents with confidence (see
    `dbt/models/staging/stg_games.yml`: in-progress/scheduled games can carry
    other free-form status/clock text that hasn't been fully enumerated
    against real ingested data yet).

    Team identity (and therefore player-row counts) is derived from
    `player_game_stats.team` — the actual teams that produced stat lines for
    a game — rather than from `games.home_team`/`away_team`, since the
    entire point of this check is to catch cases where those two disagree
    (e.g. a stray third team name, or a team missing its lines).
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or create_engine(Settings().runtime_database_url)

    def get_completed_games_with_player_counts(
        self, as_of: date
    ) -> list[tuple[int, set[int], dict[int, int]]]:
        metadata = MetaData()
        games = Table("games", metadata, autoload_with=self._engine)
        player_game_stats = Table(
            "player_game_stats", metadata, autoload_with=self._engine
        )

        stmt = (
            select(
                player_game_stats.c.game_id,
                player_game_stats.c.team,
                func.count(func.distinct(player_game_stats.c.player_id)).label(
                    "player_count"
                ),
            )
            .select_from(
                player_game_stats.join(
                    games, player_game_stats.c.game_id == games.c.game_id
                )
            )
            .where(games.c.status == "Final", games.c.game_date <= as_of)
            .group_by(player_game_stats.c.game_id, player_game_stats.c.team)
        )

        counts_by_game: dict[int, dict[int, int]] = {}
        with self._engine.connect() as conn:
            for game_id, team_name, player_count in conn.execute(stmt):
                team_id = _stable_team_id(team_name)
                counts_by_game.setdefault(game_id, {})[team_id] = player_count

        return [
            (game_id, set(counts.keys()), counts)
            for game_id, counts in counts_by_game.items()
        ]


class SQLAlchemyQualityMetricSink:
    """Production `QualityMetricSink`, backed by the `quality_metrics` table."""

    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self._session_factory = session_factory or sessionmaker(
            bind=create_engine(Settings().runtime_database_url)
        )

    def write_many(self, metrics: list[QualityMetric]) -> None:
        with self._session_factory() as session:
            session.add_all(metrics)
            session.commit()


def check_completed_games(
    reader: GoldReader, sink: QualityMetricSink, as_of: date
) -> list[QualityMetric]:
    """Runs `check_game_volumetrics` for every completed game as of `as_of`,
    writes the resulting metrics via `sink` in one batch, and returns them.
    """
    metrics = [
        check_game_volumetrics(game_id, team_ids, player_row_count_by_team)
        for game_id, team_ids, player_row_count_by_team in (
            reader.get_completed_games_with_player_counts(as_of)
        )
    ]
    sink.write_many(metrics)
    return metrics
