"""add live game state team/schedule columns and source conflicts game index

Revision ID: e1047f40b490
Revises: 20a909ed3f0d
Create Date: 2026-09-08 14:19:02.012308

`db/src/db/models.py` already declares both of these (a prior change added
them to the ORM model directly without a migration to match — caught by
code review on PR #74):

- `live_game_state.home_team`/`away_team`/`scheduled_start` — only ever
  populated by `source="nba_stats"` rows (nba_api's live scoreboard);
  balldontlie/public_feed rows leave these NULL, hence nullable.
- `ix_source_conflicts_game_id_detected_at` on
  `source_conflicts(game_id, detected_at DESC)` — a per-game lookup index
  alongside the table's existing `detected_at DESC`-only index from
  fca5b54cdf40, for a per-live-game query pattern.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e1047f40b490'
down_revision: Union[str, Sequence[str], None] = '20a909ed3f0d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("live_game_state", sa.Column("home_team", sa.String(), nullable=True))
    op.add_column("live_game_state", sa.Column("away_team", sa.String(), nullable=True))
    op.add_column(
        "live_game_state",
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_source_conflicts_game_id_detected_at",
        "source_conflicts",
        ["game_id", sa.text("detected_at DESC")],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_source_conflicts_game_id_detected_at", table_name="source_conflicts"
    )
    op.drop_column("live_game_state", "scheduled_start")
    op.drop_column("live_game_state", "away_team")
    op.drop_column("live_game_state", "home_team")
