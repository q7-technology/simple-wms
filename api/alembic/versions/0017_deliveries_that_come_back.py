"""A delivery can come back: when, and the returns dock it waits at

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-15 09:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0017'
down_revision: Union[str, None] = '0016'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('delivery', sa.Column('return_location_id', sa.Integer(), nullable=True))
    op.add_column('delivery', sa.Column('returned_at', sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key(op.f('fk_delivery_return_location_id_location'), 'delivery', 'location',
                          ['return_location_id'], ['id'])


def downgrade() -> None:
    op.drop_constraint(op.f('fk_delivery_return_location_id_location'), 'delivery', type_='foreignkey')
    op.drop_column('delivery', 'returned_at')
    op.drop_column('delivery', 'return_location_id')
