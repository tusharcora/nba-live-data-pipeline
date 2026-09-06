"""add live_game_state team/schedule columns and source_conflicts game_id index

Revision ID: e17c4a92b6d1
Revises: 20a909ed3f0d
Create Date: 2026-09-06 12:00:00.000000

Adds the columns needed for the unified Recent Games board's live rows and
the index needed for its per-game conflict lookup (docs/superpowers/specs/
2026-09-06-recent-games-board-and-commentator-design.md §4.2, §5.2):

- `live_game_state.home_team` / `.away_team` / `.scheduled_start` — only
  ever populated by `source="nba_stats"` rows; every other source's rows
  leave these NULL.
- `source_conflicts(game_id, detected_at DESC)` — backs
  `QualityReader.recent_conflicts_for_game`'s per-game, per-poll lookup,
  alongside the existing `source_conflicts(detected_at DESC)` index that
  serves the unfiltered "most recent N" scorecard query.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e17c4a92b6d1'
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
