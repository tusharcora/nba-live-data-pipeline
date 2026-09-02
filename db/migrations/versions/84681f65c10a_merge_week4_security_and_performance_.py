"""merge week4 security and performance migration heads

Revision ID: 84681f65c10a
Revises: 78b1b0fab0ea, fca5b54cdf40
Create Date: 2026-09-01 22:33:29.435059

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '84681f65c10a'
down_revision: Union[str, Sequence[str], None] = ('78b1b0fab0ea', 'fca5b54cdf40')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
