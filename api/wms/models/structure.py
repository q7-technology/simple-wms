from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, QtyOpt, created_at_column


class Site(Base):
    __tablename__ = "site"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    timezone: Mapped[str] = mapped_column(String(64), default="Australia/Melbourne")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()

    warehouses: Mapped[list[Warehouse]] = relationship(back_populates="site")


class Warehouse(Base):
    __tablename__ = "warehouse"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("site.id"))
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    # Per-warehouse switches: erp_counts_gr, allow_ship_short, blind_counts,
    # receipt_tolerance_pct, idle_logout_minutes. Read with defaults.
    settings: Mapped[dict] = mapped_column(JSONB, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()

    site: Mapped[Site] = relationship(back_populates="warehouses")
    zones: Mapped[list[Zone]] = relationship(back_populates="warehouse")


class Zone(Base):
    __tablename__ = "zone"
    __table_args__ = (UniqueConstraint("warehouse_id", "code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"))
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(120))
    # bulk, pickface, packing, staging, in_transit, overflow, line_side
    kind: Mapped[str] = mapped_column(String(32), default="bulk")
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    warehouse: Mapped[Warehouse] = relationship(back_populates="zones")
    locations: Mapped[list[Location]] = relationship(back_populates="zone")


class Location(Base):
    __tablename__ = "location"
    __table_args__ = (UniqueConstraint("warehouse_id", "code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zone.id"), index=True)
    code: Mapped[str] = mapped_column(String(64))
    barcode: Mapped[str | None] = mapped_column(String(128), unique=True)
    # shelf, floor, rack, dock, line_side, in_transit
    type: Mapped[str] = mapped_column(String(32), default="shelf")
    # ground, step, forklift
    access: Mapped[str] = mapped_column(String(16), default="ground")
    # mixed, single_sku, single_batch
    mixing: Mapped[str] = mapped_column(String(16), default="mixed")
    capacity: Mapped[QtyOpt]
    capacity_uom: Mapped[str | None] = mapped_column(String(16))
    pick_sequence: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()

    warehouse: Mapped[Warehouse] = relationship()
    zone: Mapped[Zone] = relationship(back_populates="locations")
