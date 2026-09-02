"""add meta table indexes for hot query paths

Revision ID: fca5b54cdf40
Revises: 43c7e59b942d
Create Date: 2026-09-01 22:14:11.391883

Adds indexes matching the actual query patterns already in production code
(docs/superpowers/plans/2026-09-02-week4-security-and-performance.md,
Employee B1 — no DB indexes existed on any Meta table despite date-filtered
and "latest-N" query patterns already live):

- `quality_metrics(check_name, run_at)` — `api/src/api/routers/quality.py`'s
  `SqlAlchemyQualityReader.latest_metric_rows` reads the whole table and
  reduces to the latest row per `check_name` in Python (`_latest_per_check`);
  this composite index supports that "latest per check_name" access pattern
  if/when it's ever pushed down into SQL, and is cheap to maintain given the
  table's low write volume (one row per quality check per run).
- `schema_change_log(detected_at DESC)` — matches
  `recent_schema_changes`'s `ORDER BY detected_at DESC LIMIT
  RECENT_SCHEMA_CHANGES_LIMIT` exactly.
- `source_conflicts(detected_at DESC)` — matches `recent_conflicts`'s
  `ORDER BY detected_at DESC LIMIT RECENT_CONFLICTS_LIMIT` exactly.

Descending indexes are used for the two `ORDER BY ... DESC LIMIT N` cases
so Postgres can walk the index directly in the query's own order without a
separate sort step, per the plan's explicit callout.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fca5b54cdf40'
down_revision: Union[str, Sequence[str], None] = '43c7e59b942d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "ix_quality_metrics_check_name_run_at",
        "quality_metrics",
        ["check_name", "run_at"],
    )
    op.create_index(
        "ix_schema_change_log_detected_at",
        "schema_change_log",
        [sa.text("detected_at DESC")],
    )
    op.create_index(
        "ix_source_conflicts_detected_at",
        "source_conflicts",
        [sa.text("detected_at DESC")],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_source_conflicts_detected_at", table_name="source_conflicts")
    op.drop_index("ix_schema_change_log_detected_at", table_name="schema_change_log")
    op.drop_index("ix_quality_metrics_check_name_run_at", table_name="quality_metrics")
