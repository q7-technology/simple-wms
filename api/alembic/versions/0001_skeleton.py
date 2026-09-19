"""Skeleton: structure, products, ledger, tasks, access, integration

Revision ID: 0001
Revises: 
Create Date: 2026-09-19 21:33:54.897250
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('api_client',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('key_prefix', sa.String(length=12), nullable=False),
    sa.Column('key_hash', sa.String(length=64), nullable=False),
    sa.Column('scopes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('warehouses', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('ip_allowlist', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('rotated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_api_client')),
    sa.UniqueConstraint('key_hash', name=op.f('uq_api_client_key_hash')),
    sa.UniqueConstraint('name', name=op.f('uq_api_client_name'))
    )
    op.create_table('audit_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('actor_type', sa.String(length=16), nullable=False),
    sa.Column('actor', sa.String(length=64), nullable=False),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('target_type', sa.String(length=32), nullable=True),
    sa.Column('target', sa.String(length=64), nullable=True),
    sa.Column('device', sa.String(length=64), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_log'))
    )
    op.create_index(op.f('ix_audit_log_action'), 'audit_log', ['action'], unique=False)
    op.create_index(op.f('ix_audit_log_actor'), 'audit_log', ['actor'], unique=False)
    op.create_table('product',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('sku', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('decimals_allowed', sa.Boolean(), nullable=False),
    sa.Column('batch_tracked', sa.Boolean(), nullable=False),
    sa.Column('preferred_zone', sa.String(length=32), nullable=True),
    sa.Column('pickface_min', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('pickface_max', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_product')),
    sa.UniqueConstraint('owner', 'sku', name=op.f('uq_product_owner_sku'))
    )
    op.create_table('site',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('timezone', sa.String(length=64), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_site')),
    sa.UniqueConstraint('code', name=op.f('uq_site_code'))
    )
    op.create_table('subscriber',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('url', sa.String(length=500), nullable=False),
    sa.Column('secret', sa.String(length=128), nullable=False),
    sa.Column('event_types', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('warehouses', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_subscriber')),
    sa.UniqueConstraint('name', name=op.f('uq_subscriber_name'))
    )
    op.create_table('user',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('email', sa.String(length=200), nullable=True),
    sa.Column('display_name', sa.String(length=120), nullable=False),
    sa.Column('password_hash', sa.String(length=200), nullable=True),
    sa.Column('role', sa.String(length=32), nullable=False),
    sa.Column('warehouses', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('totp_secret', sa.String(length=64), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user')),
    sa.UniqueConstraint('username', name=op.f('uq_user_username'))
    )
    op.create_table('inbound_message',
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('api_client_id', sa.Integer(), nullable=True),
    sa.Column('path', sa.String(length=200), nullable=False),
    sa.Column('status_code', sa.Integer(), nullable=False),
    sa.Column('response', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('received_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['api_client_id'], ['api_client.id'], name=op.f('fk_inbound_message_api_client_id_api_client')),
    sa.PrimaryKeyConstraint('message_id', name=op.f('pk_inbound_message'))
    )
    op.create_table('operator',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('pin_hash', sa.String(length=200), nullable=True),
    sa.Column('badge', sa.String(length=128), nullable=True),
    sa.Column('role', sa.String(length=32), nullable=False),
    sa.Column('warehouses', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('failed_attempts', sa.Integer(), nullable=False),
    sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], name=op.f('fk_operator_user_id_user')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_operator')),
    sa.UniqueConstraint('badge', name=op.f('uq_operator_badge')),
    sa.UniqueConstraint('code', name=op.f('uq_operator_code'))
    )
    op.create_table('outbound_event',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('subscriber_id', sa.Integer(), nullable=False),
    sa.Column('event_type', sa.String(length=64), nullable=False),
    sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('warehouse', sa.String(length=32), nullable=True),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('external_ref', sa.String(length=64), nullable=True),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('next_attempt_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_error', sa.String(length=500), nullable=True),
    sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['subscriber_id'], ['subscriber.id'], name=op.f('fk_outbound_event_subscriber_id_subscriber')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_outbound_event'))
    )
    op.create_index('ix_outbound_event_due', 'outbound_event', ['status', 'next_attempt_at'], unique=False)
    op.create_index(op.f('ix_outbound_event_event_id'), 'outbound_event', ['event_id'], unique=False)
    op.create_index(op.f('ix_outbound_event_external_ref'), 'outbound_event', ['external_ref'], unique=False)
    op.create_table('product_barcode',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('barcode', sa.String(length=128), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('qty_per', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_product_barcode_product_id_product')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_product_barcode')),
    sa.UniqueConstraint('barcode', name=op.f('uq_product_barcode_barcode'))
    )
    op.create_index(op.f('ix_product_barcode_product_id'), 'product_barcode', ['product_id'], unique=False)
    op.create_table('warehouse',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('site_id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['site_id'], ['site.id'], name=op.f('fk_warehouse_site_id_site')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_warehouse')),
    sa.UniqueConstraint('code', name=op.f('uq_warehouse_code'))
    )
    op.create_table('device',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_device_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_device')),
    sa.UniqueConstraint('code', name=op.f('uq_device_code'))
    )
    op.create_table('task',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('priority', sa.String(length=16), nullable=False),
    sa.Column('source_type', sa.String(length=32), nullable=True),
    sa.Column('source_ref', sa.String(length=64), nullable=True),
    sa.Column('assigned_to', sa.String(length=64), nullable=True),
    sa.Column('device', sa.String(length=64), nullable=True),
    sa.Column('needs_supervisor', sa.Boolean(), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_task_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_task'))
    )
    op.create_index(op.f('ix_task_source_ref'), 'task', ['source_ref'], unique=False)
    op.create_index(op.f('ix_task_status'), 'task', ['status'], unique=False)
    op.create_index(op.f('ix_task_type'), 'task', ['type'], unique=False)
    op.create_index(op.f('ix_task_warehouse_id'), 'task', ['warehouse_id'], unique=False)
    op.create_table('zone',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_zone_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_zone')),
    sa.UniqueConstraint('warehouse_id', 'code', name=op.f('uq_zone_warehouse_id_code'))
    )
    op.create_table('location',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('zone_id', sa.Integer(), nullable=False),
    sa.Column('code', sa.String(length=64), nullable=False),
    sa.Column('barcode', sa.String(length=128), nullable=True),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('access', sa.String(length=16), nullable=False),
    sa.Column('mixing', sa.String(length=16), nullable=False),
    sa.Column('capacity', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('capacity_uom', sa.String(length=16), nullable=True),
    sa.Column('pick_sequence', sa.Integer(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_location_warehouse_id_warehouse')),
    sa.ForeignKeyConstraint(['zone_id'], ['zone.id'], name=op.f('fk_location_zone_id_zone')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_location')),
    sa.UniqueConstraint('barcode', name=op.f('uq_location_barcode')),
    sa.UniqueConstraint('warehouse_id', 'code', name=op.f('uq_location_warehouse_id_code'))
    )
    op.create_index(op.f('ix_location_warehouse_id'), 'location', ['warehouse_id'], unique=False)
    op.create_index(op.f('ix_location_zone_id'), 'location', ['zone_id'], unique=False)
    op.create_table('print_job',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('job_id', sa.Uuid(), nullable=False),
    sa.Column('template', sa.String(length=64), nullable=False),
    sa.Column('version', sa.String(length=16), nullable=False),
    sa.Column('printer', sa.String(length=64), nullable=False),
    sa.Column('copies', sa.Integer(), nullable=False),
    sa.Column('reference', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('task_id', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('next_attempt_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_error', sa.String(length=500), nullable=True),
    sa.Column('printed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['task_id'], ['task.id'], name=op.f('fk_print_job_task_id_task')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_print_job')),
    sa.UniqueConstraint('job_id', name=op.f('uq_print_job_job_id'))
    )
    op.create_index('ix_print_job_due', 'print_job', ['status', 'next_attempt_at'], unique=False)
    op.create_table('stock_balance',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('location_id', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('on_hand', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('reserved', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('received_at', sa.Date(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['location_id'], ['location.id'], name=op.f('fk_stock_balance_location_id_location')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_stock_balance_product_id_product')),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_stock_balance_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_stock_balance')),
    sa.UniqueConstraint('location_id', 'product_id', 'batch', 'owner', name=op.f('uq_stock_balance_location_id_product_id_batch_owner'), postgresql_nulls_not_distinct=True)
    )
    op.create_index('ix_stock_balance_product', 'stock_balance', ['product_id', 'warehouse_id'], unique=False)
    op.create_table('task_line',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('task_id', sa.Integer(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('expected_qty', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('actual_qty', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('from_location_id', sa.Integer(), nullable=True),
    sa.Column('to_location_id', sa.Integer(), nullable=True),
    sa.Column('container_id', sa.String(length=64), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('reason', sa.String(length=64), nullable=True),
    sa.Column('source_line', sa.Integer(), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['from_location_id'], ['location.id'], name=op.f('fk_task_line_from_location_id_location')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_task_line_product_id_product')),
    sa.ForeignKeyConstraint(['task_id'], ['task.id'], name=op.f('fk_task_line_task_id_task')),
    sa.ForeignKeyConstraint(['to_location_id'], ['location.id'], name=op.f('fk_task_line_to_location_id_location')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_task_line')),
    sa.UniqueConstraint('task_id', 'line_no', name=op.f('uq_task_line_task_id_line_no'))
    )
    op.create_index(op.f('ix_task_line_task_id'), 'task_line', ['task_id'], unique=False)
    op.create_table('stock_ledger',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('warehouse_id', sa.Integer(), nullable=False),
    sa.Column('location_id', sa.Integer(), nullable=False),
    sa.Column('product_id', sa.Integer(), nullable=False),
    sa.Column('batch', sa.String(length=64), nullable=True),
    sa.Column('owner', sa.String(length=32), nullable=False),
    sa.Column('container_id', sa.String(length=64), nullable=True),
    sa.Column('qty_change', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('uom', sa.String(length=16), nullable=False),
    sa.Column('movement_type', sa.String(length=32), nullable=False),
    sa.Column('reason', sa.String(length=64), nullable=True),
    sa.Column('task_id', sa.Integer(), nullable=True),
    sa.Column('task_line_id', sa.Integer(), nullable=True),
    sa.Column('received_at', sa.Date(), nullable=False),
    sa.Column('actor', sa.String(length=64), nullable=False),
    sa.Column('device', sa.String(length=64), nullable=True),
    sa.Column('api_client_id', sa.Integer(), nullable=True),
    sa.Column('external_ref', sa.String(length=64), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.ForeignKeyConstraint(['api_client_id'], ['api_client.id'], name=op.f('fk_stock_ledger_api_client_id_api_client')),
    sa.ForeignKeyConstraint(['location_id'], ['location.id'], name=op.f('fk_stock_ledger_location_id_location')),
    sa.ForeignKeyConstraint(['product_id'], ['product.id'], name=op.f('fk_stock_ledger_product_id_product')),
    sa.ForeignKeyConstraint(['task_id'], ['task.id'], name=op.f('fk_stock_ledger_task_id_task')),
    sa.ForeignKeyConstraint(['task_line_id'], ['task_line.id'], name=op.f('fk_stock_ledger_task_line_id_task_line')),
    sa.ForeignKeyConstraint(['warehouse_id'], ['warehouse.id'], name=op.f('fk_stock_ledger_warehouse_id_warehouse')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_stock_ledger'))
    )
    op.create_index('ix_stock_ledger_key', 'stock_ledger', ['location_id', 'product_id', 'batch', 'owner'], unique=False)
    op.create_index('ix_stock_ledger_product_at', 'stock_ledger', ['product_id', 'at'], unique=False)
    op.create_index(op.f('ix_stock_ledger_task_id'), 'stock_ledger', ['task_id'], unique=False)
    op.create_index(op.f('ix_stock_ledger_warehouse_id'), 'stock_ledger', ['warehouse_id'], unique=False)

    # The stock ledger is append-only. A mistake is corrected by a new row.
    op.execute("""
        create or replace function block_change() returns trigger
        language plpgsql as $$
        begin
            raise exception '% is append-only: rows cannot be updated or deleted', tg_table_name
                using errcode = 'restrict_violation';
        end
        $$
    """)
    for table in ("stock_ledger", "audit_log"):
        op.execute(
            f"create trigger {table}_append_only before update or delete on {table} "
            f"for each row execute function block_change()"
        )


def downgrade() -> None:
    for table in ("stock_ledger", "audit_log"):
        op.execute(f"drop trigger if exists {table}_append_only on {table}")
    op.execute("drop function if exists block_change()")
    op.drop_index(op.f('ix_stock_ledger_warehouse_id'), table_name='stock_ledger')
    op.drop_index(op.f('ix_stock_ledger_task_id'), table_name='stock_ledger')
    op.drop_index('ix_stock_ledger_product_at', table_name='stock_ledger')
    op.drop_index('ix_stock_ledger_key', table_name='stock_ledger')
    op.drop_table('stock_ledger')
    op.drop_index(op.f('ix_task_line_task_id'), table_name='task_line')
    op.drop_table('task_line')
    op.drop_index('ix_stock_balance_product', table_name='stock_balance')
    op.drop_table('stock_balance')
    op.drop_index('ix_print_job_due', table_name='print_job')
    op.drop_table('print_job')
    op.drop_index(op.f('ix_location_zone_id'), table_name='location')
    op.drop_index(op.f('ix_location_warehouse_id'), table_name='location')
    op.drop_table('location')
    op.drop_table('zone')
    op.drop_index(op.f('ix_task_warehouse_id'), table_name='task')
    op.drop_index(op.f('ix_task_type'), table_name='task')
    op.drop_index(op.f('ix_task_status'), table_name='task')
    op.drop_index(op.f('ix_task_source_ref'), table_name='task')
    op.drop_table('task')
    op.drop_table('device')
    op.drop_table('warehouse')
    op.drop_index(op.f('ix_product_barcode_product_id'), table_name='product_barcode')
    op.drop_table('product_barcode')
    op.drop_index(op.f('ix_outbound_event_external_ref'), table_name='outbound_event')
    op.drop_index(op.f('ix_outbound_event_event_id'), table_name='outbound_event')
    op.drop_index('ix_outbound_event_due', table_name='outbound_event')
    op.drop_table('outbound_event')
    op.drop_table('operator')
    op.drop_table('inbound_message')
    op.drop_table('user')
    op.drop_table('subscriber')
    op.drop_table('site')
    op.drop_table('product')
    op.drop_index(op.f('ix_audit_log_actor'), table_name='audit_log')
    op.drop_index(op.f('ix_audit_log_action'), table_name='audit_log')
    op.drop_table('audit_log')
    op.drop_table('api_client')
