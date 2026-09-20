from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, Qty, QtyOpt, created_at_column


class Task(Base):
    """All work. Receive, put away, pick, pack, ship, move, count, replenish,
    transfer, production issue and receipt all go through here."""

    __tablename__ = "task"

    id: Mapped[int] = mapped_column(primary_key=True)
    # receive, putaway, pick, pack, ship, move, count, replenish,
    # transfer_pick, transfer_receive, production_issue, production_receipt
    type: Mapped[str] = mapped_column(String(32), index=True)
    # waiting, in_progress, needs_supervisor, done, cancelled
    status: Mapped[str] = mapped_column(String(32), default="waiting", index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    # low, normal, high
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    # delivery, receipt, production_order, transfer, replenishment, manual
    source_type: Mapped[str | None] = mapped_column(String(32))
    source_ref: Mapped[str | None] = mapped_column(String(64), index=True)
    assigned_to: Mapped[str | None] = mapped_column(String(64))
    device: Mapped[str | None] = mapped_column(String(64))
    needs_supervisor: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at_column()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lines: Mapped[list[TaskLine]] = relationship(
        back_populates="task", cascade="all, delete-orphan", order_by="TaskLine.line_no"
    )


class TaskLine(Base):
    __tablename__ = "task_line"
    __table_args__ = (UniqueConstraint("task_id", "line_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    expected_qty: Mapped[Qty]
    actual_qty: Mapped[QtyOpt]
    uom: Mapped[str] = mapped_column(String(16))
    from_location_id: Mapped[int | None] = mapped_column(ForeignKey("location.id"))
    to_location_id: Mapped[int | None] = mapped_column(ForeignKey("location.id"))
    container_id: Mapped[str | None] = mapped_column(String(64))
    # open, done, short, skipped, cancelled
    status: Mapped[str] = mapped_column(String(16), default="open")
    reason: Mapped[str | None] = mapped_column(String(64))
    # reference back to the source document line (delivery_line, receipt line)
    source_line: Mapped[int | None] = mapped_column(Integer)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    task: Mapped[Task] = relationship(back_populates="lines")
    product: Mapped["Product"] = relationship()  # noqa: F821
    from_location: Mapped["Location | None"] = relationship(foreign_keys=[from_location_id])  # noqa: F821
    to_location: Mapped["Location | None"] = relationship(foreign_keys=[to_location_id])  # noqa: F821
