"""A subscriber can be reached by RFC, not only by HTTP

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-21 02:05:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0015'
down_revision: Union[str, None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('subscriber', sa.Column('transport', sa.String(length=16),
                                          nullable=False, server_default='http'))
    op.add_column('subscriber', sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()),
                                          nullable=False, server_default='{}'))


def downgrade() -> None:
    op.drop_column('subscriber', 'settings')
    op.drop_column('subscriber', 'transport')
