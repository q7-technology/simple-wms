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


class Transfer(Base):
    """One order, two legs. Stock sits in an in-transit bucket between them."""

    __tablename__ = "transfer"
    __table_args__ = (UniqueConstraint("owner", "external_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    external_ref: Mapped[str] = mapped_column(String(64))
    message_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    from_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    to_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    required_by: Mapped[date | None] = mapped_column(Date)
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    carrier_hint: Mapped[str | None] = mapped_column(String(64))
    carrier: Mapped[str | None] = mapped_column(String(64))
    tracking_no: Mapped[str | None] = mapped_column(String(64))
    # new, allocated, picking, picked, in_transit, receiving, received,
    # variance (something did not arrive), closed, cancelled
    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    # the sender's bench, and the bucket at the receiver
    staging_location_id: Mapped[int | None] = mapped_column(ForeignKey("location.id"))
    in_transit_location_id: Mapped[int | None] = mapped_column(ForeignKey("location.id"))
    pick_task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    receive_task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    # the expected receipt raised at the far end
    receipt_id: Mapped[int | None] = mapped_column(ForeignKey("receipt.id"))
    note: Mapped[str | None] = mapped_column(String(500))
    variance_reason: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at_column()
    allocated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lines: Mapped[list[TransferLine]] = relationship(
        back_populates="transfer", cascade="all, delete-orphan", order_by="TransferLine.line_no")


class TransferLine(Base):
    __tablename__ = "transfer_line"
    __table_args__ = (UniqueConstraint("transfer_id", "line_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    transfer_id: Mapped[int] = mapped_column(ForeignKey("transfer.id"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    qty_requested: Mapped[Qty]
    qty_allocated: Mapped[Qty]
    qty_picked: Mapped[Qty]
    qty_shipped: Mapped[Qty]
    qty_received: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))

    transfer: Mapped[Transfer] = relationship(back_populates="lines")


class ProductionOrder(Base):
    """Make something: issue the components, take the finished goods back."""

    __tablename__ = "production_order"
    __table_args__ = (UniqueConstraint("owner", "external_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    external_ref: Mapped[str] = mapped_column(String(64))
    message_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    required_by: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    # what comes out
    output_product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    output_batch: Mapped[str | None] = mapped_column(String(64))
    output_qty: Mapped[Qty]
    output_received: Mapped[Qty]
    output_uom: Mapped[str] = mapped_column(String(16))
    # new, issuing, in_production, complete, cancelled
    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    issue_task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = created_at_column()
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    components: Mapped[list[ProductionComponent]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="ProductionComponent.line_no")
    receipts: Mapped[list[ProductionReceipt]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="ProductionReceipt.id")


class ProductionComponent(Base):
    __tablename__ = "production_component"
    __table_args__ = (UniqueConstraint("order_id", "line_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("production_order.id"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    qty_requested: Mapped[Qty]
    qty_issued: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))
    # the line-side location the components are dropped at
    deliver_to_id: Mapped[int] = mapped_column(ForeignKey("location.id"))

    order: Mapped[ProductionOrder] = relationship(back_populates="components")


class ProductionReceipt(Base):
    """One pallet of finished goods coming back off the line."""

    __tablename__ = "production_receipt"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("production_order.id"), index=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    qty: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))
    location_id: Mapped[int] = mapped_column(ForeignKey("location.id"))
    container_id: Mapped[str | None] = mapped_column(String(64))
    ledger_id: Mapped[int | None] = mapped_column(ForeignKey("stock_ledger.id"))
    operator: Mapped[str | None] = mapped_column(String(64))
    device: Mapped[str | None] = mapped_column(String(64))
    supervisor: Mapped[str | None] = mapped_column(String(64))
    event_sent: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()

    order: Mapped[ProductionOrder] = relationship(back_populates="receipts")


class PickBatch(Base):
    """One walk for several orders. Stops collapse; totes keep them apart."""

    __tablename__ = "pick_batch"
    __table_args__ = (UniqueConstraint("owner", "external_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    external_ref: Mapped[str] = mapped_column(String(64))
    message_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    # new, picking, picked, cancelled
    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    assigned_to: Mapped[str | None] = mapped_column(String(64))
    device: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at_column()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    members: Mapped[list[PickBatchMember]] = relationship(
        back_populates="batch", cascade="all, delete-orphan", order_by="PickBatchMember.tote")


class PickBatchMember(Base):
    """One order in the batch, and the tote its items go in."""

    __tablename__ = "pick_batch_member"
    __table_args__ = (UniqueConstraint("batch_id", "delivery_id"),
                      UniqueConstraint("batch_id", "tote"))

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("pick_batch.id"), index=True)
    delivery_id: Mapped[int] = mapped_column(ForeignKey("delivery.id"), index=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"))
    tote: Mapped[str] = mapped_column(String(16))

    batch: Mapped[PickBatch] = relationship(back_populates="members")
