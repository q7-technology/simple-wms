"""Production orders, their components and the pallets that come back

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-20 16:46:05.553462
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0007'
down_revision: Union[str, None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('production_order',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('external_ref', sa.String(length=64), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('required_by', sa.DateTime(timezone=True), nullable=True),
    sa.Column('priority', sa.String(length=16), nullable=False),
    sa.Column('output_product_id', sa.Integer(), nullable=False),
    sa.Column('output_batch', sa.String(length=64), nullable=True),
    sa.Column('output_qty', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('output_received', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('output_uom', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('issue_task_id', sa.Integer(), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('issued_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['issue_task_id'], ['task.id'], name=op.f('fk_production_order_issue_task_id_task')),
    sa.ForeignKeyConstraint(['output_product_id'], ['product.id'], name=op.f('fk_production_order_output_product_id_product')),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_production_order_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_production_order')),
    sa.UniqueConstraint('owner', 'external_ref', name=op.f('uq_production_order_owner_external_ref'))
    )
    op.create_index(op.f('ix_production_order_status'), 'production_order', ['status'], unique=False)
    op.create_index(op.f('ix_production_order_warehouse_id'), 'production_order', ['warehouse_id'], unique=False)
    op.create_table('production_component',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('order_id', sa.Integer(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('qty_requested', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('qty_issued', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('deliver_to_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['deliver_to_id'], ['location.id'], name=op.f('fk_production_component_deliver_to_id_location')),
    sa.ForeignKeyConstraint(['order_id'], ['production_order.id'], name=op.f('fk_production_component_order_id_production_order')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_production_component_product_id_product')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_production_component')),
    sa.UniqueConstraint('order_id', 'line_no', name=op.f('uq_production_component_order_id_line_no'))
    )
    op.create_index(op.f('ix_production_component_order_id'), 'production_component', ['order_id'], unique=False)
    op.create_table('production_receipt',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('order_id', sa.Integer(), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('qty', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('location_id', sa.Integer(), nullable=False),
    sa.Column('container_id', sa.String(length=64), nullable=True),
    sa.Column('ledger_id', sa.Integer(), nullable=True),
    sa.Column('operator', sa.String(length=64), nullable=True),
    sa.Column('device', sa.String(length=64), nullable=True),
    sa.Column('supervisor', sa.String(length=64), nullable=True),
    sa.Column('event_sent', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['ledger_id'], ['stock_ledger.id'], name=op.f('fk_production_receipt_ledger_id_stock_ledger')),
    sa.ForeignKeyConstraint(['location_id'], ['location.id'], name=op.f('fk_production_receipt_location_id_location')),
    sa.ForeignKeyConstraint(['order_id'], ['production_order.id'], name=op.f('fk_production_receipt_order_id_production_order')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_production_receipt_product_id_product')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_production_receipt'))
    )
    op.create_index(op.f('ix_production_receipt_order_id'), 'production_receipt', ['order_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_production_receipt_order_id'), table_name='production_receipt')
    op.drop_table('production_receipt')
    op.drop_index(op.f('ix_production_component_order_id'), table_name='production_component')
    op.drop_table('production_component')
    op.drop_index(op.f('ix_production_order_warehouse_id'), table_name='production_order')
    op.drop_index(op.f('ix_production_order_status'), table_name='production_order')
    op.drop_table('production_order')
