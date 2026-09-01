"""create backfill checkpoints table

Revision ID: a02795c40cbe
Revises: c4fede563f2b
Create Date: 2026-08-31 23:03:21.276938

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a02795c40cbe'
down_revision: Union[str, Sequence[str], None] = 'c4fede563f2b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "backfill_checkpoints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("flow_name", sa.String(), nullable=False),
        sa.Column("last_pulled_date", sa.Date(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ingestion_writer needs to both create and advance its own checkpoint row
    # (unlike raw_pulls/etc, which are append-only INSERT+SELECT — see
    # c4fede563f2b), so UPDATE is also required here.
    op.execute(
        "GRANT INSERT, SELECT, UPDATE ON backfill_checkpoints TO ingestion_writer"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE backfill_checkpoints_id_seq TO ingestion_writer"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        "REVOKE USAGE, SELECT ON SEQUENCE backfill_checkpoints_id_seq FROM ingestion_writer"
    )
    op.execute(
        "REVOKE INSERT, SELECT, UPDATE ON backfill_checkpoints FROM ingestion_writer"
    )
    op.drop_table("backfill_checkpoints")
