from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, Qty, created_at_column


class StockLedger(Base):
    """Every movement. Append-only: a database trigger blocks UPDATE and DELETE."""

    __tablename__ = "stock_ledger"
    __table_args__ = (
        Index("ix_stock_ledger_key", "location_id", "product_id", "batch", "owner"),
        Index("ix_stock_ledger_product_at", "product_id", "at"),
        Index("ix_stock_ledger_container", "container_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = created_at_column()
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("location.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    container_id: Mapped[str | None] = mapped_column(String(64))
    # signed: positive into this location, negative out of it
    qty_change: Mapped[Qty]
    uom: Mapped[str] = mapped_column(String(16))
    # receipt, putaway, move, pick, ship, adjustment, count, replenish,
    # transfer_out, transfer_in, production_issue, production_receipt
    movement_type: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(String(64))
    task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"), index=True)
    task_line_id: Mapped[int | None] = mapped_column(ForeignKey("task_line.id"))
    # FIFO date. Travels with the stock on moves and transfers.
    received_at: Mapped[date] = mapped_column(Date)
    actor: Mapped[str] = mapped_column(String(64))
    device: Mapped[str | None] = mapped_column(String(64))
    api_client_id: Mapped[int | None] = mapped_column(ForeignKey("api_client.id"))
    external_ref: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(String(500))


class StockBalance(Base):
    """Materialised on hand per location, product, batch and owner. Rebuilt from the ledger."""

    __tablename__ = "stock_balance"
    __table_args__ = (
        UniqueConstraint(
            "location_id", "product_id", "batch", "owner",
            postgresql_nulls_not_distinct=True,
        ),
        Index("ix_stock_balance_product", "product_id", "warehouse_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouse.id"))
    location_id: Mapped[int] = mapped_column(ForeignKey("location.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))
    batch: Mapped[str | None] = mapped_column(String(64))
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    on_hand: Mapped[Qty] = mapped_column(default=Decimal(0))
    # derived from open task lines; step 3 fills it in
    reserved: Mapped[Qty] = mapped_column(default=Decimal(0))
    uom: Mapped[str] = mapped_column(String(16))
    # oldest receipt still counted at this key; FIFO order
    received_at: Mapped[date | None] = mapped_column(Date)
    updated_at: Mapped[datetime] = created_at_column()

    location: Mapped["Location"] = relationship()  # noqa: F821
    product: Mapped["Product"] = relationship()  # noqa: F821
