"""create least privilege roles ingestion_writer api_reader

Revision ID: c4fede563f2b
Revises: 9dbeb50c688c
Create Date: 2026-08-31 22:41:25.746639

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4fede563f2b'
down_revision: Union[str, Sequence[str], None] = '9dbeb50c688c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Bronze/Meta tables managed by db/ migrations (excludes dbt-managed Gold tables).
_TABLES = ("raw_pulls", "schema_change_log", "quality_metrics", "source_conflicts")
_SEQUENCES = tuple(f"{table}_id_seq" for table in _TABLES)
# Tables the read-only API is allowed to serve. Never raw_pulls (Bronze) — the
# public-facing API only ever reads Meta/quality tables and (later) dbt's Gold marts.
_READER_TABLES = ("quality_metrics", "schema_change_log", "source_conflicts")

# NOTE: these are dev-only placeholder passwords for local/CI Postgres. In every
# non-local environment, per docs/prd.md §08 ("Secrets ... via a secrets manager"),
# these roles must be created with passwords sourced from the secrets manager
# (Railway/Render secrets or Doppler), never hardcoded — rotate before any shared
# or production deployment.
_INGESTION_WRITER_PW = "ingestion_writer_pw"
_API_READER_PW = "api_reader_pw"


def upgrade() -> None:
    """Create least-privilege Postgres roles and grant per docs/prd.md §08/§12."""
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ingestion_writer') THEN
                CREATE ROLE ingestion_writer LOGIN PASSWORD '{_INGESTION_WRITER_PW}';
            END IF;
        END
        $$"""
    )
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'api_reader') THEN
                CREATE ROLE api_reader LOGIN PASSWORD '{_API_READER_PW}';
            END IF;
        END
        $$"""
    )

    # ingestion_writer: write-only to Bronze/Meta — INSERT + SELECT on all four
    # tables (SELECT is needed so ingestion code can read back what it wrote,
    # e.g. dedup/checkpoint checks), plus USAGE/SELECT on their identity sequences.
    op.execute(f"GRANT INSERT, SELECT ON {', '.join(_TABLES)} TO ingestion_writer")
    op.execute(
        f"GRANT USAGE, SELECT ON SEQUENCE {', '.join(_SEQUENCES)} TO ingestion_writer"
    )

    # api_reader: read-only, and only on the tables the public API is allowed to
    # serve. Never raw_pulls, never write privileges of any kind.
    op.execute(f"GRANT SELECT ON {', '.join(_READER_TABLES)} TO api_reader")

    # Once dbt's Gold marts (games, player_game_stats) are created by the `nba`
    # superuser role, this makes them automatically readable by api_reader with
    # no further migration needed.
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE nba IN SCHEMA public "
        "GRANT SELECT ON TABLES TO api_reader"
    )


def downgrade() -> None:
    """Revoke grants and drop both roles."""
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE nba IN SCHEMA public "
        "REVOKE SELECT ON TABLES FROM api_reader"
    )
    op.execute(f"REVOKE SELECT ON {', '.join(_READER_TABLES)} FROM api_reader")
    op.execute(
        f"REVOKE USAGE, SELECT ON SEQUENCE {', '.join(_SEQUENCES)} FROM ingestion_writer"
    )
    op.execute(f"REVOKE INSERT, SELECT ON {', '.join(_TABLES)} FROM ingestion_writer")
    op.execute("DROP ROLE IF EXISTS api_reader")
    op.execute("DROP ROLE IF EXISTS ingestion_writer")
