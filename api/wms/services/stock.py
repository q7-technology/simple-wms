"""Read helpers over stock_balance, and the shelf rules a movement must obey."""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import Location, Product, StockBalance


class RuleError(Exception):
    def __init__(self, field: str, message: str):
        self.field = field
        self.message = message
        super().__init__(f"{field}: {message}")


def balances_at(db: Session, location_id: int) -> list[StockBalance]:
    return db.execute(
        select(StockBalance).where(StockBalance.location_id == location_id, StockBalance.on_hand != 0)
    ).scalars().all()


def balance(db: Session, location_id: int, product_id: int, batch: str | None, owner: str) -> StockBalance | None:
    return db.execute(
        select(StockBalance).where(
            StockBalance.location_id == location_id, StockBalance.product_id == product_id,
            StockBalance.batch.is_not_distinct_from(batch), StockBalance.owner == owner,
        )
    ).scalar_one_or_none()


def on_hand_total(db: Session, location_id: int, product_id: int, owner: str) -> Decimal:
    rows = db.execute(
        select(StockBalance).where(
            StockBalance.location_id == location_id, StockBalance.product_id == product_id,
            StockBalance.owner == owner)
    ).scalars().all()
    return sum((r.on_hand for r in rows), Decimal(0))


def check_mixing(db: Session, location: Location, product: Product, batch: str | None,
                 field: str = "to_location") -> None:
    """single_sku: only this product may sit here; single_batch: only this product and batch."""
    if location.mixing == "mixed":
        return
    for b in balances_at(db, location.id):
        if b.product_id != product.id:
            other = db.get(Product, b.product_id)
            raise RuleError(field, f"{location.code} holds {other.sku if other else 'another product'} and allows one product only")
        if location.mixing == "single_batch" and b.batch != batch:
            raise RuleError(field, f"{location.code} holds batch {b.batch} and allows one batch only")


def has_space(db: Session, location: Location, product: Product, qty: Decimal, uom: str) -> bool:
    """True unless a capacity in the same unit says otherwise."""
    if location.capacity is None or not location.capacity_uom or location.capacity_uom != uom:
        return True
    used = sum((b.on_hand for b in balances_at(db, location.id)), Decimal(0))
    return used + qty <= location.capacity
