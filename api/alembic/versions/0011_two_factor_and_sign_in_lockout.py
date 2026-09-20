"""A second factor for people, and a lockout on the desktop sign in

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-20 17:59:13.409060
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0011'
down_revision: Union[str, None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('user', sa.Column('totp_pending', sa.String(length=64), nullable=True))
    op.add_column('user', sa.Column('totp_last_step', sa.BigInteger(), nullable=True))
    op.add_column('user', sa.Column('failed_attempts', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('user', sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('user', 'locked_until')
    op.drop_column('user', 'failed_attempts')
    op.drop_column('user', 'totp_last_step')
    op.drop_column('user', 'totp_pending')
