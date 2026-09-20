"""Owners: whose stock it is, with DEFAULT there from the start

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-20 17:26:26.947792
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0010'
down_revision: Union[str, None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('owner',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('contact', sa.String(length=120), nullable=True),
    sa.Column('email', sa.String(length=200), nullable=True),
    sa.Column('phone', sa.String(length=40), nullable=True),
    sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_owner'))
    )
    op.create_index(op.f('ix_owner_code'), 'owner', ['code'], unique=True)
    op.add_column('user', sa.Column('owner', sa.String(length=32), nullable=False,
                                    server_default='*'))
    op.alter_column('user', 'owner', server_default=None)
    # everything written so far belongs to DEFAULT, so DEFAULT has to exist
    op.execute("insert into owner (code, name, settings, active, created_at) "
               "values ('DEFAULT', 'Default owner', '{}', true, now())")


def downgrade() -> None:
    op.drop_column('user', 'owner')
    op.drop_index(op.f('ix_owner_code'), table_name='owner')
    op.drop_table('owner')
