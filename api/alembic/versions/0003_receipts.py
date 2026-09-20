"""Receipts: expected inbound documents and their lines

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-20 10:57:53.585079
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0003'
down_revision: Union[str, None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('receipt',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('external_ref', sa.String(length=64), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('supplier', sa.String(length=120), nullable=True),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('expected_at', sa.Date(), nullable=True),
    sa.Column('dock', sa.String(length=64), nullable=True),
    sa.Column('carrier', sa.String(length=64), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('task_id', sa.Integer(), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('arrived_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['task_id'], ['task.id'], name=op.f('fk_receipt_task_id_task')),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_receipt_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_receipt')),
    sa.UniqueConstraint('owner', 'external_ref', name=op.f('uq_receipt_owner_external_ref'))
    )
    op.create_index(op.f('ix_receipt_status'), 'receipt', ['status'], unique=False)
    op.create_index(op.f('ix_receipt_warehouse_id'), 'receipt', ['warehouse_id'], unique=False)
    op.create_table('receipt_line',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('receipt_id', sa.Integer(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('expected_qty', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('received_qty', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_receipt_line_product_id_product')),
    sa.ForeignKeyConstraint(['receipt_id'], ['receipt.id'], name=op.f('fk_receipt_line_receipt_id_receipt')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_receipt_line')),
    sa.UniqueConstraint('receipt_id', 'line_no', name=op.f('uq_receipt_line_receipt_id_line_no'))
    )
    op.create_index(op.f('ix_receipt_line_receipt_id'), 'receipt_line', ['receipt_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_receipt_line_receipt_id'), table_name='receipt_line')
    op.drop_table('receipt_line')
    op.drop_index(op.f('ix_receipt_warehouse_id'), table_name='receipt')
    op.drop_index(op.f('ix_receipt_status'), table_name='receipt')
    op.drop_table('receipt')
