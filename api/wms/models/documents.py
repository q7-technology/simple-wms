"""Documents that create tasks. external_ref is unique per owner and type."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, Qty, QtyOpt, created_at_column


class Receipt(Base):
    __tablename__ = "receipt"
    __table_args__ = (UniqueConstraint("owner", "external_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    external_ref: Mapped[str] = mapped_column(String(64))
    message_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    supplier: Mapped[str | None] = mapped_column(String(120))
    # supplier, transfer, production, return
    kind: Mapped[str] = mapped_column(String(16), default="supplier")
    expected_at: Mapped[date | None] = mapped_column(Date)
    dock: Mapped[str | None] = mapped_column(String(64))
    carrier: Mapped[str | None] = mapped_column(String(64))
    # expected, arrived, receiving, complete, closed_short, cancelled
    status: Mapped[str] = mapped_column(String(16), default="expected", index=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = created_at_column()
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lines: Mapped[list[ReceiptLine]] = relationship(
        back_populates="receipt", cascade="all, delete-orphan", order_by="ReceiptLine.line_no")


class ReceiptLine(Base):
    __tablename__ = "receipt_line"
    __table_args__ = (UniqueConstraint("receipt_id", "line_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    receipt_id: Mapped[int] = mapped_column(ForeignKey("receipt.id"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    expected_qty: Mapped[Qty]
    received_qty: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))

    receipt: Mapped[Receipt] = relationship(back_populates="lines")


class Delivery(Base):
    """A pick order: what leaves, for whom."""

    __tablename__ = "delivery"
    __table_args__ = (UniqueConstraint("owner", "external_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    external_ref: Mapped[str] = mapped_column(String(64))
    message_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    # single, batch or auto. Batch picking arrives with build step 5.
    pick_mode: Mapped[str] = mapped_column(String(16), default="single")
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    required_by: Mapped[date | None] = mapped_column(Date)
    ship_to: Mapped[dict] = mapped_column(JSONB, default=dict)
    carrier_hint: Mapped[str | None] = mapped_column(String(64))
    carrier: Mapped[str | None] = mapped_column(String(64))
    tracking_no: Mapped[str | None] = mapped_column(String(64))
    allow_short: Mapped[bool] = mapped_column(Boolean, default=True)
    # new, allocated, picking, picked, packing, packed, shipped, cancelled
    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    short: Mapped[bool] = mapped_column(Boolean, default=False)
    # where picked stock waits until it is shipped
    staging_location_id: Mapped[int | None] = mapped_column(ForeignKey("location.id"))
    pick_task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    pack_task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = created_at_column()
    allocated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    picked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    packed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lines: Mapped[list[DeliveryLine]] = relationship(
        back_populates="delivery", cascade="all, delete-orphan", order_by="DeliveryLine.line_no")
    packages: Mapped[list[Package]] = relationship(
        back_populates="delivery", cascade="all, delete-orphan", order_by="Package.package_no")


class DeliveryLine(Base):
    __tablename__ = "delivery_line"
    __table_args__ = (UniqueConstraint("delivery_id", "line_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    delivery_id: Mapped[int] = mapped_column(ForeignKey("delivery.id"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    # set to force a batch; null lets the WMS pick by FIFO
    batch: Mapped[str | None] = mapped_column(String(64))
    qty_ordered: Mapped[Qty]
    qty_allocated: Mapped[Qty]
    qty_picked: Mapped[Qty]
    qty_shipped: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))
    short_reason: Mapped[str | None] = mapped_column(String(64))

    delivery: Mapped[Delivery] = relationship(back_populates="lines")


class Package(Base):
    """A carton, pallet or tote that leaves the building."""

    __tablename__ = "package"
    __table_args__ = (UniqueConstraint("delivery_id", "package_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    delivery_id: Mapped[int] = mapped_column(ForeignKey("delivery.id"), index=True)
    package_no: Mapped[int] = mapped_column(Integer)
    # carton, pallet, tote, satchel
    type: Mapped[str] = mapped_column(String(16), default="carton")
    container_id: Mapped[str | None] = mapped_column(String(64))
    sscc: Mapped[str | None] = mapped_column(String(18))
    weight_kg: Mapped[QtyOpt]
    length_cm: Mapped[QtyOpt]
    width_cm: Mapped[QtyOpt]
    height_cm: Mapped[QtyOpt]
    packed_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at_column()

    delivery: Mapped[Delivery] = relationship(back_populates="packages")
    lines: Mapped[list[PackageLine]] = relationship(
        back_populates="package", cascade="all, delete-orphan", order_by="PackageLine.id")


class PackageLine(Base):
    __tablename__ = "package_line"

    id: Mapped[int] = mapped_column(primary_key=True)
    package_id: Mapped[int] = mapped_column(ForeignKey("package.id"), index=True)
    delivery_line: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    qty: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))

    package: Mapped[Package] = relationship(back_populates="lines")
