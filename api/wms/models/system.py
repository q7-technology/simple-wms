from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from wms.models.base import Base


class SystemSetting(Base):
    """Site-wide settings changed from the Settings screen. One row, id 1.
    Anything not here falls back to `.env`, then to the default."""

    __tablename__ = "system_setting"
    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False, default=1)
    settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now())
