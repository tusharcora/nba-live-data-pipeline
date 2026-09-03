"""grant ingestion writer select on gold tables

Revision ID: 20a909ed3f0d
Revises: 84681f65c10a
Create Date: 2026-09-03 15:16:06.185737

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20a909ed3f0d'
down_revision: Union[str, Sequence[str], None] = '84681f65c10a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# dbt-managed Gold tables that already exist as of this migration. Listed
# explicitly because GRANT only applies to tables that exist at the time it
# runs -- ALTER DEFAULT PRIVILEGES below covers tables dbt creates later.
_EXISTING_GOLD_TABLES = ("games", "player_game_stats")


def upgrade() -> None:
    """Grant ingestion_writer read access to dbt's Gold tables.

    c4fede563f2b only wired ALTER DEFAULT PRIVILEGES for api_reader, since at
    the time no ingestion flow read a Gold/dbt-owned table. That changed with
    backfill_nba_stats_flow, which reads the Gold `games` table to match
    NBA.com games onto balldontlie's existing ones -- the first ingestion
    flow to ever read dbt-owned output rather than only writing Bronze.
    Discovered live: `permission denied for table games` when running the
    new flow for real against a live Postgres.
    """
    op.execute(f"GRANT SELECT ON {', '.join(_EXISTING_GOLD_TABLES)} TO ingestion_writer")
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE nba IN SCHEMA public "
        "GRANT SELECT ON TABLES TO ingestion_writer"
    )


def downgrade() -> None:
    """Revoke ingestion_writer's read access to Gold tables."""
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE nba IN SCHEMA public "
        "REVOKE SELECT ON TABLES FROM ingestion_writer"
    )
    op.execute(f"REVOKE SELECT ON {', '.join(_EXISTING_GOLD_TABLES)} FROM ingestion_writer")
