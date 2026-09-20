"""The batch master.

A batch code on the ledger is a plain string and always will be. This is the
record of what that string means: when the batch expires, when it was made,
whose lot it came from, and whether it may be sold. Nothing already written
depends on a row here existing, so the table is free to fill in behind the
ledger as batches are handled."""
from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from wms.models import Batch, Product, StockBalance

RELEASED = "released"
QUARANTINED = "quarantined"
STATUSES = (RELEASED, QUARANTINED)


def find(db: Session, product: Product, code: str) -> Batch | None:
    return db.execute(
        select(Batch).where(Batch.product_id == product.id, Batch.code == code)
    ).scalar_one_or_none()


def ensure(db: Session, product: Product, code: str | None) -> Batch | None:
    """The row for a batch that has just been handled, created if it is new.
    Nothing is invented: a batch nobody has described has no expiry and is
    released, because a warehouse cannot hold stock it was never told about."""
    if not code:
        return None
    row = find(db, product, code)
    if row is None:
        row = Batch(product_id=product.id, code=code, status=RELEASED)
        db.add(row)
        db.flush()
    return row


def upsert(db: Session, product: Product, code: str, **fields) -> tuple[Batch, str]:
    """Create or update by product and code. Fields left out keep their value,
    the same rule the rest of the master data follows."""
    row = find(db, product, code)
    status = "updated" if row else "created"
    if row is None:
        row = Batch(product_id=product.id, code=code, status=RELEASED)
        db.add(row)
    for name, value in fields.items():
        if value is not None:
            setattr(row, name, value)
    row.updated_at = datetime.now(UTC)
    db.flush()
    return row, status


def set_status(db: Session, batch: Batch, status: str, *, reason: str | None,
               note: str | None) -> Batch:
    """Quarantine or release. The stock does not move and the balances do not
    change: quarantined stock is still on the shelf, it is simply never
    promised to anyone."""
    batch.status = status
    batch.reason = reason if status == QUARANTINED else None
    if note is not None:
        batch.note = note
    batch.updated_at = datetime.now(UTC)
    db.flush()
    return batch


def quarantined_codes(db: Session, product_id: int) -> set[str]:
    rows = db.execute(
        select(Batch.code).where(Batch.product_id == product_id, Batch.status == QUARANTINED)
    ).scalars().all()
    return set(rows)


def on_hand(db: Session, product_id: int, code: str) -> Decimal:
    """Across every warehouse and owner: a batch is a thing in the world, not
    a thing in one building."""
    total = db.execute(
        select(func.sum(StockBalance.on_hand))
        .where(StockBalance.product_id == product_id, StockBalance.batch == code)
    ).scalar_one_or_none()
    return total or Decimal(0)


def listing(db: Session, *, product: Product | None = None, status: str | None = None,
            expires_before: date | None = None, limit: int = 50, offset: int = 0):
    """Earliest expiry first, because that is the one somebody has to act on.
    A batch with no expiry date sorts last rather than first."""
    q = select(Batch)
    if product is not None:
        q = q.where(Batch.product_id == product.id)
    if status:
        q = q.where(Batch.status == status)
    if expires_before:
        q = q.where(Batch.expiry_date.is_not(None), Batch.expiry_date <= expires_before)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(Batch.expiry_date.asc().nulls_last(), Batch.code).limit(limit).offset(offset)
    ).scalars().all()
    return rows, total
