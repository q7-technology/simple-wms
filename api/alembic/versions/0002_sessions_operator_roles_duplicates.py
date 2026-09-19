"""User sessions, operator roles as a list, duplicate message counts

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-19 21:49:19.511412
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('user_session',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('refresh_hash', sa.String(length=64), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('user_agent', sa.String(length=300), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], name=op.f('fk_user_session_user_id_user')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_session')),
    sa.UniqueConstraint('refresh_hash', name=op.f('uq_user_session_refresh_hash'))
    )
    op.create_index(op.f('ix_user_session_user_id'), 'user_session', ['user_id'], unique=False)
    op.add_column('inbound_message', sa.Column('duplicates', sa.Integer(), server_default='0', nullable=False))
    op.add_column('inbound_message', sa.Column('last_duplicate_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('operator', sa.Column('roles', postgresql.JSONB(astext_type=sa.Text()), nullable=False))
    op.drop_column('operator', 'role')


def downgrade() -> None:
    op.add_column('operator', sa.Column('role', sa.VARCHAR(length=32), autoincrement=False, nullable=False))
    op.drop_column('operator', 'roles')
    op.drop_column('inbound_message', 'last_duplicate_at')
    op.drop_column('inbound_message', 'duplicates')
    op.drop_index(op.f('ix_user_session_user_id'), table_name='user_session')
    op.drop_table('user_session')
