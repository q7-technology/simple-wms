"""A carton can leave on a transfer, not only on a delivery

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-20 21:20:18.002390
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0013'
down_revision: Union[str, None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('package', sa.Column('transfer_id', sa.Integer(), nullable=True))
    op.alter_column('package', 'delivery_id',
               existing_type=sa.INTEGER(),
               nullable=True)
    op.create_index(op.f('ix_package_transfer_id'), 'package', ['transfer_id'], unique=False)
    op.create_unique_constraint(op.f('uq_package_transfer_id_package_no'), 'package', ['transfer_id', 'package_no'])
    op.create_foreign_key(op.f('fk_package_transfer_id_transfer'), 'package', 'transfer', ['transfer_id'], ['id'])


def downgrade() -> None:
    op.drop_constraint(op.f('fk_package_transfer_id_transfer'), 'package', type_='foreignkey')
    op.drop_constraint(op.f('uq_package_transfer_id_package_no'), 'package', type_='unique')
    op.drop_index(op.f('ix_package_transfer_id'), table_name='package')
    op.alter_column('package', 'delivery_id',
               existing_type=sa.INTEGER(),
               nullable=False)
    op.drop_column('package', 'transfer_id')
