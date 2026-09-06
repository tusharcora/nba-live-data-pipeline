from datetime import date as date_type
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    desc,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class RawPull(Base):
    """Bronze layer: one immutable row per raw API response. Append-only."""

    __tablename__ = "raw_pulls"
    __table_args__ = (Index("ix_raw_pulls_source_pulled_at", "source", "pulled_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String, nullable=False)
    endpoint: Mapped[str] = mapped_column(String, nullable=False)
    pulled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)


class SchemaChangeLog(Base):
    """Meta layer: one row per detected schema drift event (field add/remove/type change)."""

    __tablename__ = "schema_change_log"
    # Matches `recent_schema_changes`'s `ORDER BY detected_at DESC LIMIT N`
    # in api/src/api/routers/quality.py (db/migrations/versions/
    # fca5b54cdf40_add_meta_table_indexes_for_hot_query_.py creates this).
    __table_args__ = (Index("ix_schema_change_log_detected_at", desc("detected_at")),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String, nullable=False)
    endpoint: Mapped[str] = mapped_column(String, nullable=False)
    field_name: Mapped[str] = mapped_column(String, nullable=False)
    change_type: Mapped[str] = mapped_column(String, nullable=False)
    old_type: Mapped[str | None] = mapped_column(String, nullable=True)
    new_type: Mapped[str | None] = mapped_column(String, nullable=True)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class QualityMetric(Base):
    """Meta layer: one row per quality check per run (null rate, PSI, agreement rate, etc.)."""

    __tablename__ = "quality_metrics"
    # Supports the "latest row per check_name" access pattern used by
    # api/src/api/routers/quality.py's `_latest_per_check` (db/migrations/
    # versions/fca5b54cdf40_add_meta_table_indexes_for_hot_query_.py
    # creates this).
    __table_args__ = (Index("ix_quality_metrics_check_name_run_at", "check_name", "run_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    check_name: Mapped[str] = mapped_column(String, nullable=False)
    run_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    metric_value: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    # `metadata` is reserved on DeclarativeBase instances (schema-reflection object),
    # so the Python attribute is named `metadata_json` and mapped to the DB column `metadata`.
    metadata_json: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True
    )


class LiveGameState(Base):
    """Silver layer: one row per poll per game while a game is live.

    Time-series score/clock state, per source — `source` distinguishes which
    of the (now three) data sources a given snapshot came from, since each
    is polled independently and none overwrites another (reconciliation
    across sources happens downstream, not here).
    """

    __tablename__ = "live_game_state"
    __table_args__ = (
        Index("ix_live_game_state_game_id_pulled_at", "game_id", "pulled_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)
    pulled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    home_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    away_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    period: Mapped[int | None] = mapped_column(Integer, nullable=True)
    clock: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False)
    # Only ever populated by source="nba_stats" rows (nba_api's live
    # scoreboard) -- balldontlie/public_feed rows leave these NULL. See
    # docs/superpowers/specs/2026-09-06-recent-games-board-and-commentator-design.md
    # §4.2.
    home_team: Mapped[str | None] = mapped_column(String, nullable=True)
    away_team: Mapped[str | None] = mapped_column(String, nullable=True)
    scheduled_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class BackfillCheckpoint(Base):
    """Meta layer: resumability marker — last successfully-processed date per flow."""

    __tablename__ = "backfill_checkpoints"

    id: Mapped[int] = mapped_column(primary_key=True)
    # unique: exactly one checkpoint row per flow — SQLAlchemyCheckpointStore
    # relies on this invariant to select/upsert a single row per flow_name.
    flow_name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    last_pulled_date: Mapped[date_type] = mapped_column(Date, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AuditLog(Base):
    """Meta layer: one row per manual write/override against live data
    (docs/prd.md §08: "Audit log table for any manual write/override, with
    actor + timestamp").

    No feature that performs a manual override exists yet in this codebase
    — this table is provisioned ahead of that need, per the Week 4 security
    pass. `actor` is a free-text identifier (a username, a service name, an
    operator's email) rather than a foreign key, since there's no unified
    identity system across the pipeline's processes yet. `detail` is
    unstructured, nullable JSONB for whatever context a given override
    wants to record (before/after values, a reason string, etc.) —
    deliberately not modeled further until a real caller exists to tell us
    its actual shape.
    """

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SourceConflict(Base):
    """Meta layer: one row per field-level disagreement between two data sources."""

    __tablename__ = "source_conflicts"
    __table_args__ = (
        # Matches `recent_conflicts`'s `ORDER BY detected_at DESC LIMIT N` in
        # api/src/api/routers/quality.py.
        Index("ix_source_conflicts_detected_at", desc("detected_at")),
        # Backs `QualityReader.recent_conflicts_for_game` (api/src/api/
        # routers/quality.py) at the per-poll, per-live-game cadence the
        # board commentary engine needs it at.
        Index("ix_source_conflicts_game_id_detected_at", "game_id", desc("detected_at")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[str] = mapped_column(String, nullable=False)
    field_name: Mapped[str] = mapped_column(String, nullable=False)
    primary_source: Mapped[str] = mapped_column(String, nullable=False)
    primary_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    secondary_source: Mapped[str] = mapped_column(String, nullable=False)
    secondary_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolution: Mapped[str] = mapped_column(String, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
