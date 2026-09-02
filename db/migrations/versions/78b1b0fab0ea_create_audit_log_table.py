"""create audit log table

Revision ID: 78b1b0fab0ea
Revises: 43c7e59b942d
Create Date: 2026-09-01 20:28:32.875931

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '78b1b0fab0ea'
down_revision: Union[str, Sequence[str], None] = '43c7e59b942d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Per docs/prd.md §08 ("Audit log table for any manual write/override,
    with actor + timestamp"). No manual-override feature exists in this
    codebase yet, so this table is provisioned ahead of that need — see the
    `AuditLog` model docstring in db/src/db/models.py.
    """
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("detail", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # PROVISIONAL: audit_log is append-only, same INSERT+SELECT-only shape
    # as the other Bronze/Meta tables granted to ingestion_writer in
    # c4fede563f2b/43c7e59b942d. Granted to ingestion_writer rather than
    # api_reader as the more privileged of the two existing roles, since no
    # manual-override feature exists yet to know the real actor identity
    # that would write here — revisit this grant once that feature (and its
    # actual writing process) exists, and scope it to whatever role that
    # process actually runs as instead of borrowing ingestion_writer's.
    op.execute(
        "GRANT INSERT, SELECT ON audit_log TO ingestion_writer"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO ingestion_writer"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        "REVOKE USAGE, SELECT ON SEQUENCE audit_log_id_seq FROM ingestion_writer"
    )
    op.execute(
        "REVOKE INSERT, SELECT ON audit_log FROM ingestion_writer"
    )
    op.drop_table("audit_log")
