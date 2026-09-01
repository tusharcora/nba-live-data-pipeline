"""create live game state table

Revision ID: 43c7e59b942d
Revises: a02795c40cbe
Create Date: 2026-09-01 00:30:51.486201

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '43c7e59b942d'
down_revision: Union[str, Sequence[str], None] = 'a02795c40cbe'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "live_game_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("game_id", sa.BigInteger(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column(
            "pulled_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("home_score", sa.Integer(), nullable=True),
        sa.Column("away_score", sa.Integer(), nullable=True),
        sa.Column("period", sa.Integer(), nullable=True),
        sa.Column("clock", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
    )
    op.create_index(
        "ix_live_game_state_game_id_pulled_at",
        "live_game_state",
        ["game_id", "pulled_at"],
    )

    # live_game_state is append-only, same INSERT+SELECT-only shape as the
    # other Bronze/Meta tables granted to ingestion_writer in
    # c4fede563f2b — no UPDATE needed (unlike backfill_checkpoints, which
    # ingestion_writer mutates in place).
    op.execute(
        "GRANT INSERT, SELECT ON live_game_state TO ingestion_writer"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE live_game_state_id_seq TO ingestion_writer"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        "REVOKE USAGE, SELECT ON SEQUENCE live_game_state_id_seq FROM ingestion_writer"
    )
    op.execute(
        "REVOKE INSERT, SELECT ON live_game_state FROM ingestion_writer"
    )
    op.drop_index("ix_live_game_state_game_id_pulled_at", table_name="live_game_state")
    op.drop_table("live_game_state")
