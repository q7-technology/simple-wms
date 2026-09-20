"""Scan patterns: the ones a site writes for its own labels

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-20 21:15:48.402999
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0012'
down_revision: Union[str, None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('scan_pattern',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=True),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('pattern', sa.String(length=500), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('order', sa.Integer(), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_scan_pattern_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_scan_pattern')),
    sa.UniqueConstraint('warehouse_id', 'name', name=op.f('uq_scan_pattern_warehouse_id_name'), postgresql_nulls_not_distinct=True)
    )
    op.create_index(op.f('ix_scan_pattern_warehouse_id'), 'scan_pattern', ['warehouse_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_scan_pattern_warehouse_id'), table_name='scan_pattern')
    op.drop_table('scan_pattern')
