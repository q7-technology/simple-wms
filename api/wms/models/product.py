from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, Qty, QtyOpt, created_at_column


class Product(Base):
    __tablename__ = "product"
    __table_args__ = (UniqueConstraint("owner", "sku"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    sku: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    uom: Mapped[str] = mapped_column(String(16), default="EA")
    decimals_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    batch_tracked: Mapped[bool] = mapped_column(Boolean, default=False)
    preferred_zone: Mapped[str | None] = mapped_column(String(32))
    pickface_min: Mapped[QtyOpt]
    pickface_max: Mapped[QtyOpt]
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()

    barcodes: Mapped[list[ProductBarcode]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )


class ProductBarcode(Base):
    __tablename__ = "product_barcode"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"), index=True)
    barcode: Mapped[str] = mapped_column(String(128), unique=True)
    # gtin, carton, supplier, other
    kind: Mapped[str] = mapped_column(String(16), default="gtin")
    # how many base units one scan of this barcode represents
    qty_per: Mapped[Qty] = mapped_column(default=Decimal(1))

    product: Mapped[Product] = relationship(back_populates="barcodes")


class Batch(Base):
    """What a batch code actually means: when it expires, when it was made,
    whose lot it came from, and whether it may be sold.

    The ledger keeps the batch as a plain string, and always will, so nothing
    already written depends on a row existing here. This table fills in behind
    it: a receipt that names a batch creates the row if it is missing."""
    __tablename__ = "batch"
    __table_args__ = (UniqueConstraint("product_id", "code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"), index=True)
    code: Mapped[str] = mapped_column(String(64))
    # Picking asks for the earliest expiry still released, over and over.
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    manufactured_on: Mapped[date | None] = mapped_column(Date)
    supplier_lot: Mapped[str | None] = mapped_column(String(64))
    # released or quarantined. Quarantined stock stays on the shelf and stays
    # in the balances; it is simply never promised to anyone.
    status: Mapped[str] = mapped_column(String(16), default="released")
    reason: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_column()
    updated_at: Mapped[datetime] = created_at_column()

    product: Mapped[Product] = relationship()
