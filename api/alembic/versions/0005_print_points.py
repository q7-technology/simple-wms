"""Print points, and print jobs that know their warehouse and origin

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-20 16:08:17.615591
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0005'
down_revision: Union[str, None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('print_point',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=True),
    sa.Column('event_type', sa.String(length=64), nullable=False),
    sa.Column('template', sa.String(length=64), nullable=False),
    sa.Column('version', sa.String(length=16), nullable=False),
    sa.Column('printer', sa.String(length=64), nullable=False),
    sa.Column('copies', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_print_point_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_print_point')),
    sa.UniqueConstraint('warehouse_id', 'event_type', 'template', 'printer', name=op.f('uq_print_point_warehouse_id_event_type_template_printer'), postgresql_nulls_not_distinct=True)
    )
    op.create_index(op.f('ix_print_point_event_type'), 'print_point', ['event_type'], unique=False)
    op.create_index(op.f('ix_print_point_warehouse_id'), 'print_point', ['warehouse_id'], unique=False)
    op.add_column('print_job', sa.Column('warehouse_id', sa.Integer(), nullable=True))
    op.add_column('print_job', sa.Column('owner', sa.String(length=32), nullable=False))
    op.add_column('print_job', sa.Column('print_point_id', sa.Integer(), nullable=True))
    op.add_column('print_job', sa.Column('reprint_of_id', sa.Integer(), nullable=True))
    op.add_column('print_job', sa.Column('external_ref', sa.String(length=64), nullable=True))
    op.add_column('print_job', sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f('ix_print_job_external_ref'), 'print_job', ['external_ref'], unique=False)
    op.create_index(op.f('ix_print_job_template'), 'print_job', ['template'], unique=False)
    op.create_index(op.f('ix_print_job_warehouse_id'), 'print_job', ['warehouse_id'], unique=False)
    op.create_foreign_key(op.f('fk_print_job_warehouse_id_warehouse'), 'print_job', 'warehouse', ['warehouse_id'], ['id'])
    op.create_foreign_key(op.f('fk_print_job_reprint_of_id_print_job'), 'print_job', 'print_job', ['reprint_of_id'], ['id'])
    op.create_foreign_key(op.f('fk_print_job_print_point_id_print_point'), 'print_job', 'print_point', ['print_point_id'], ['id'])


def downgrade() -> None:
    op.drop_constraint(op.f('fk_print_job_print_point_id_print_point'), 'print_job', type_='foreignkey')
    op.drop_constraint(op.f('fk_print_job_reprint_of_id_print_job'), 'print_job', type_='foreignkey')
    op.drop_constraint(op.f('fk_print_job_warehouse_id_warehouse'), 'print_job', type_='foreignkey')
    op.drop_index(op.f('ix_print_job_warehouse_id'), table_name='print_job')
    op.drop_index(op.f('ix_print_job_template'), table_name='print_job')
    op.drop_index(op.f('ix_print_job_external_ref'), table_name='print_job')
    op.drop_column('print_job', 'sent_at')
    op.drop_column('print_job', 'external_ref')
    op.drop_column('print_job', 'reprint_of_id')
    op.drop_column('print_job', 'print_point_id')
    op.drop_column('print_job', 'owner')
    op.drop_column('print_job', 'warehouse_id')
    op.drop_index(op.f('ix_print_point_warehouse_id'), table_name='print_point')
    op.drop_index(op.f('ix_print_point_event_type'), table_name='print_point')
    op.drop_table('print_point')
