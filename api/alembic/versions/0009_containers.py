"""Containers: pallets, cartons and totes, with SSCC and nesting

Revision ID: 0009
Revises: 0008
Create Date: 2026-09-20 17:22:24.466015
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0009'
down_revision: Union[str, None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('container',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('container_id', sa.String(length=64), nullable=False),
    sa.Column('sscc', sa.String(length=18), nullable=True),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('type', sa.String(length=16), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('location_id', sa.Integer(), nullable=True),
    sa.Column('parent_id', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('weight_kg', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['location_id'], ['location.id'], name=op.f('fk_container_location_id_location')),
    sa.ForeignKeyConstraint(['parent_id'], ['container.id'], name=op.f('fk_container_parent_id_container')),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_container_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_container'))
    )
    op.create_index(op.f('ix_container_container_id'), 'container', ['container_id'], unique=True)
    op.create_index(op.f('ix_container_location_id'), 'container', ['location_id'], unique=False)
    op.create_index(op.f('ix_container_parent_id'), 'container', ['parent_id'], unique=False)
    op.create_index(op.f('ix_container_sscc'), 'container', ['sscc'], unique=True)
    op.create_index(op.f('ix_container_status'), 'container', ['status'], unique=False)
    op.create_index(op.f('ix_container_type'), 'container', ['type'], unique=False)
    op.create_index(op.f('ix_container_warehouse_id'), 'container', ['warehouse_id'], unique=False)
    op.create_index('ix_stock_ledger_container', 'stock_ledger', ['container_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_stock_ledger_container', table_name='stock_ledger')
    op.drop_index(op.f('ix_container_warehouse_id'), table_name='container')
    op.drop_index(op.f('ix_container_type'), table_name='container')
    op.drop_index(op.f('ix_container_status'), table_name='container')
    op.drop_index(op.f('ix_container_sscc'), table_name='container')
    op.drop_index(op.f('ix_container_parent_id'), table_name='container')
    op.drop_index(op.f('ix_container_location_id'), table_name='container')
    op.drop_index(op.f('ix_container_container_id'), table_name='container')
    op.drop_table('container')
