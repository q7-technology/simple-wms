"""Site-wide settings, editable from the Settings screen, with .env as the fallback

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-15 09:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0016'
down_revision: Union[str, None] = '0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('system_setting',
    sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
    sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()),
              server_default='{}', nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
              nullable=False),
    sa.CheckConstraint('id = 1', name=op.f('ck_system_setting_single_row')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_system_setting'))
    )
    # The warehouse duplicate window was never read: dedup is per message_id
    # across the whole site. Keep the longest one anybody set as the site's.
    op.execute("""
        insert into system_setting (id, settings, updated_at)
        select 1,
               coalesce((select jsonb_build_object('message_ttl_hours',
                                                   max((settings->>'duplicate_window_hours')::int))
                         from warehouse where settings ? 'duplicate_window_hours'
                         having count(*) > 0), '{}'::jsonb),
               now()
    """)
    op.execute("update warehouse set settings = settings - 'duplicate_window_hours' "
               "where settings ? 'duplicate_window_hours'")


def downgrade() -> None:
    op.drop_table('system_setting')
