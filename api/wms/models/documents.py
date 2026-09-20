"""Documents that create tasks. external_ref is unique per owner and type."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, Qty, created_at_column


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
