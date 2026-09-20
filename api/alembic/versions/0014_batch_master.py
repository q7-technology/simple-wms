"""Batches: what a batch code means, and whether it may be sold

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-21 01:40:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0014'
down_revision: Union[str, None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'batch',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('product_id', sa.Integer(), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('expiry_date', sa.Date(), nullable=True),
        sa.Column('manufactured_on', sa.Date(), nullable=True),
        sa.Column('supplier_lot', sa.String(length=64), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='released'),
        sa.Column('reason', sa.String(length=64), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['product_id'], ['product.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('product_id', 'code', name=op.f('uq_batch_product_id_code')),
    )
    op.create_index(op.f('ix_batch_product_id'), 'batch', ['product_id'], unique=False)
    # Picking asks for the earliest expiry that is still released, over and
    # over, so give it an index rather than a scan of every batch.
    op.create_index(op.f('ix_batch_expiry_date'), 'batch', ['expiry_date'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_batch_expiry_date'), table_name='batch')
    op.drop_index(op.f('ix_batch_product_id'), table_name='batch')
    op.drop_table('batch')
