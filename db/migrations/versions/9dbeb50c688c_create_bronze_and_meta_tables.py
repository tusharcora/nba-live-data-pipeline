"""create bronze and meta tables

Revision ID: 9dbeb50c688c
Revises:
Create Date: 2026-08-31 22:41:25.498729

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '9dbeb50c688c'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "raw_pulls",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("endpoint", sa.String(), nullable=False),
        sa.Column(
            "pulled_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
    )
    op.create_index(
        "ix_raw_pulls_source_pulled_at", "raw_pulls", ["source", "pulled_at"]
    )

    op.create_table(
        "schema_change_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("endpoint", sa.String(), nullable=False),
        sa.Column("field_name", sa.String(), nullable=False),
        sa.Column("change_type", sa.String(), nullable=False),
        sa.Column("old_type", sa.String(), nullable=True),
        sa.Column("new_type", sa.String(), nullable=True),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "quality_metrics",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("check_name", sa.String(), nullable=False),
        sa.Column(
            "run_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("metric_value", sa.Numeric(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
    )

    op.create_table(
        "source_conflicts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("game_id", sa.String(), nullable=False),
        sa.Column("field_name", sa.String(), nullable=False),
        sa.Column("primary_source", sa.String(), nullable=False),
        sa.Column("primary_value", sa.Text(), nullable=True),
        sa.Column("secondary_source", sa.String(), nullable=False),
        sa.Column("secondary_value", sa.Text(), nullable=True),
        sa.Column("resolution", sa.String(), nullable=False),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("source_conflicts")
    op.drop_table("quality_metrics")
    op.drop_table("schema_change_log")
    op.drop_index("ix_raw_pulls_source_pulled_at", table_name="raw_pulls")
    op.drop_table("raw_pulls")
