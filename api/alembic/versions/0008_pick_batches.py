"""Pick batches: one walk for several orders, sorted into totes

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-20 16:53:40.634482
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0008'
down_revision: Union[str, None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('pick_batch',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('external_ref', sa.String(length=64), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('assigned_to', sa.String(length=64), nullable=True),
    sa.Column('device', sa.String(length=64), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_pick_batch_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_pick_batch')),
    sa.UniqueConstraint('owner', 'external_ref', name=op.f('uq_pick_batch_owner_external_ref'))
    )
    op.create_index(op.f('ix_pick_batch_status'), 'pick_batch', ['status'], unique=False)
    op.create_index(op.f('ix_pick_batch_warehouse_id'), 'pick_batch', ['warehouse_id'], unique=False)
    op.create_table('pick_batch_member',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('batch_id', sa.Integer(), nullable=False),
    sa.Column('delivery_id', sa.Integer(), nullable=False),
    sa.Column('task_id', sa.Integer(), nullable=False),
    sa.Column('tote', sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(['batch_id'], ['pick_batch.id'], name=op.f('fk_pick_batch_member_batch_id_pick_batch')),
    sa.ForeignKeyConstraint(['delivery_id'], ['delivery.id'], name=op.f('fk_pick_batch_member_delivery_id_delivery')),
    sa.ForeignKeyConstraint(['task_id'], ['task.id'], name=op.f('fk_pick_batch_member_task_id_task')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_pick_batch_member')),
    sa.UniqueConstraint('batch_id', 'delivery_id', name=op.f('uq_pick_batch_member_batch_id_delivery_id')),
    sa.UniqueConstraint('batch_id', 'tote', name=op.f('uq_pick_batch_member_batch_id_tote'))
    )
    op.create_index(op.f('ix_pick_batch_member_batch_id'), 'pick_batch_member', ['batch_id'], unique=False)
    op.create_index(op.f('ix_pick_batch_member_delivery_id'), 'pick_batch_member', ['delivery_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_pick_batch_member_delivery_id'), table_name='pick_batch_member')
    op.drop_index(op.f('ix_pick_batch_member_batch_id'), table_name='pick_batch_member')
    op.drop_table('pick_batch_member')
    op.drop_index(op.f('ix_pick_batch_warehouse_id'), table_name='pick_batch')
    op.drop_index(op.f('ix_pick_batch_status'), table_name='pick_batch')
    op.drop_table('pick_batch')
