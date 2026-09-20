"""Transfers: one order, two legs, an in-transit bucket between them

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-20 16:38:53.913167
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0006'
down_revision: Union[str, None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('transfer',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('external_ref', sa.String(length=64), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('from_warehouse_id', sa.Integer(), nullable=False),
    sa.Column('to_warehouse_id', sa.Integer(), nullable=False),
    sa.Column('required_by', sa.Date(), nullable=True),
    sa.Column('priority', sa.String(length=16), nullable=False),
    sa.Column('carrier_hint', sa.String(length=64), nullable=True),
    sa.Column('carrier', sa.String(length=64), nullable=True),
    sa.Column('tracking_no', sa.String(length=64), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('staging_location_id', sa.Integer(), nullable=True),
    sa.Column('in_transit_location_id', sa.Integer(), nullable=True),
    sa.Column('pick_task_id', sa.Integer(), nullable=True),
    sa.Column('receive_task_id', sa.Integer(), nullable=True),
    sa.Column('receipt_id', sa.Integer(), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('variance_reason', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('allocated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('shipped_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('received_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['from_warehouse_id'], ['warehouse.id'], name=op.f('fk_transfer_from_warehouse_id_warehouse')),
    sa.ForeignKeyConstraint(['in_transit_location_id'], ['location.id'], name=op.f('fk_transfer_in_transit_location_id_location')),
    sa.ForeignKeyConstraint(['pick_task_id'], ['task.id'], name=op.f('fk_transfer_pick_task_id_task')),
    sa.ForeignKeyConstraint(['receipt_id'], ['receipt.id'], name=op.f('fk_transfer_receipt_id_receipt')),
    sa.ForeignKeyConstraint(['receive_task_id'], ['task.id'], name=op.f('fk_transfer_receive_task_id_task')),
    sa.ForeignKeyConstraint(['staging_location_id'], ['location.id'], name=op.f('fk_transfer_staging_location_id_location')),
    sa.ForeignKeyConstraint(['to_warehouse_id'], ['warehouse.id'], name=op.f('fk_transfer_to_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_transfer')),
    sa.UniqueConstraint('owner', 'external_ref', name=op.f('uq_transfer_owner_external_ref'))
    )
    op.create_index(op.f('ix_transfer_from_warehouse_id'), 'transfer', ['from_warehouse_id'], unique=False)
    op.create_index(op.f('ix_transfer_status'), 'transfer', ['status'], unique=False)
    op.create_index(op.f('ix_transfer_to_warehouse_id'), 'transfer', ['to_warehouse_id'], unique=False)
    op.create_table('transfer_line',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('transfer_id', sa.Integer(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('qty_requested', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_allocated', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_picked', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_shipped', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_received', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_transfer_line_product_id_product')),
    sa.ForeignKeyConstraint(['transfer_id'], ['transfer.id'], name=op.f('fk_transfer_line_transfer_id_transfer')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_transfer_line')),
    sa.UniqueConstraint('transfer_id', 'line_no', name=op.f('uq_transfer_line_transfer_id_line_no'))
    )
    op.create_index(op.f('ix_transfer_line_transfer_id'), 'transfer_line', ['transfer_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_transfer_line_transfer_id'), table_name='transfer_line')
    op.drop_table('transfer_line')
    op.drop_index(op.f('ix_transfer_to_warehouse_id'), table_name='transfer')
    op.drop_index(op.f('ix_transfer_status'), table_name='transfer')
    op.drop_index(op.f('ix_transfer_from_warehouse_id'), table_name='transfer')
    op.drop_table('transfer')
