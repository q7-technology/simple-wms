from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint
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
