"""Deliveries, delivery lines, packages and package lines

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-20 15:37:15.983250
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0004'
down_revision: Union[str, None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('delivery',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('external_ref', sa.String(length=64), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('pick_mode', sa.String(length=16), nullable=False),
    sa.Column('priority', sa.String(length=16), nullable=False),
    sa.Column('required_by', sa.Date(), nullable=True),
    sa.Column('ship_to', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('carrier_hint', sa.String(length=64), nullable=True),
    sa.Column('carrier', sa.String(length=64), nullable=True),
    sa.Column('tracking_no', sa.String(length=64), nullable=True),
    sa.Column('allow_short', sa.Boolean(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('short', sa.Boolean(), nullable=False),
    sa.Column('staging_location_id', sa.Integer(), nullable=True),
    sa.Column('pick_task_id', sa.Integer(), nullable=True),
    sa.Column('pack_task_id', sa.Integer(), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('allocated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('picked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('packed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('shipped_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['pack_task_id'], ['task.id'], name=op.f('fk_delivery_pack_task_id_task')),
    sa.ForeignKeyConstraint(['pick_task_id'], ['task.id'], name=op.f('fk_delivery_pick_task_id_task')),
    sa.ForeignKeyConstraint(['staging_location_id'], ['location.id'], name=op.f('fk_delivery_staging_location_id_location')),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_delivery_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_delivery')),
    sa.UniqueConstraint('owner', 'external_ref', name=op.f('uq_delivery_owner_external_ref'))
    )
    op.create_index(op.f('ix_delivery_status'), 'delivery', ['status'], unique=False)
    op.create_index(op.f('ix_delivery_warehouse_id'), 'delivery', ['warehouse_id'], unique=False)
    op.create_table('delivery_line',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('delivery_id', sa.Integer(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('qty_ordered', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_allocated', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_picked', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_shipped', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('short_reason', sa.String(length=64), nullable=True),
    sa.ForeignKeyConstraint(['delivery_id'], ['delivery.id'], name=op.f('fk_delivery_line_delivery_id_delivery')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_delivery_line_product_id_product')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_delivery_line')),
    sa.UniqueConstraint('delivery_id', 'line_no', name=op.f('uq_delivery_line_delivery_id_line_no'))
    )
    op.create_index(op.f('ix_delivery_line_delivery_id'), 'delivery_line', ['delivery_id'], unique=False)
    op.create_table('package',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('delivery_id', sa.Integer(), nullable=False),
    sa.Column('package_no', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=16), nullable=False),
    sa.Column('container_id', sa.String(length=64), nullable=True),
    sa.Column('sscc', sa.String(length=18), nullable=True),
    sa.Column('weight_kg', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('length_cm', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('width_cm', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('height_cm', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('packed_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['delivery_id'], ['delivery.id'], name=op.f('fk_package_delivery_id_delivery')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_package')),
    sa.UniqueConstraint('delivery_id', 'package_no', name=op.f('uq_package_delivery_id_package_no'))
    )
    op.create_index(op.f('ix_package_delivery_id'), 'package', ['delivery_id'], unique=False)
    op.create_table('package_line',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('package_id', sa.Integer(), nullable=False),
    sa.Column('delivery_line', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('qty', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(['package_id'], ['package.id'], name=op.f('fk_package_line_package_id_package')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_package_line_product_id_product')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_package_line'))
    )
    op.create_index(op.f('ix_package_line_package_id'), 'package_line', ['package_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_package_line_package_id'), table_name='package_line')
    op.drop_table('package_line')
    op.drop_index(op.f('ix_package_delivery_id'), table_name='package')
    op.drop_table('package')
    op.drop_index(op.f('ix_delivery_line_delivery_id'), table_name='delivery_line')
    op.drop_table('delivery_line')
    op.drop_index(op.f('ix_delivery_warehouse_id'), table_name='delivery')
    op.drop_index(op.f('ix_delivery_status'), table_name='delivery')
    op.drop_table('delivery')
