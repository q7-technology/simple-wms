"""Reserved stock. A reservation is an open pick task line: it holds stock at
one shelf so nothing else is promised twice. `stock_balance.reserved` is the
running total, and it can always be rebuilt from the open pick lines."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session

from wms.models import Batch, Location, Product, StockBalance, Task, TaskLine, Warehouse
from wms.services import stock

RESERVING_TYPES = ("pick", "transfer_pick", "production_issue")
OPEN_STATUSES = ("open", "variance")

# Stock in these zones is on hand somewhere real, but it is not free to
# promise: it is on a bench, at the line, or on its way to another warehouse.
HELD_ZONE_KINDS = ("packing", "staging", "in_transit", "line_side")


def promisable(zone_kind: str) -> bool:
    return zone_kind not in HELD_ZONE_KINDS


@dataclass(slots=True)
class Reservation:
    location: Location
    batch: str | None
    qty: Decimal
    received_at: object | None


def allocate(db: Session, *, warehouse: Warehouse, product: Product, qty: Decimal, uom: str,
             owner: str = "DEFAULT", batch: str | None = None) -> list[Reservation]:
    """Hold `qty` of this product: earliest expiry first where one is known,
    otherwise oldest received first, then walk order. Quarantined batches are
    skipped. Returns what could be held; the caller reports the shortfall."""
    # The batch master is joined in, not required: a batch nobody has
    # described is ordinary stock. Where there is a record, it decides two
    # things. Quarantined stock is never promised, and a known expiry date
    # beats the received date, because the older pallet is no use if it
    # outlives the one behind it.
    q = (
        select(StockBalance, Location)
        .join(Location, Location.id == StockBalance.location_id)
        .outerjoin(Batch, and_(Batch.product_id == StockBalance.product_id,
                               Batch.code == StockBalance.batch))
        .where(StockBalance.warehouse_id == warehouse.id, StockBalance.product_id == product.id,
               StockBalance.owner == owner, StockBalance.on_hand > StockBalance.reserved,
               Location.active.is_(True),
               or_(Batch.id.is_(None), Batch.status != "quarantined"))
        .order_by(Batch.expiry_date.asc().nulls_last(), StockBalance.received_at.nulls_last(),
                  Location.pick_sequence, Location.code)
        .with_for_update(of=StockBalance)
    )
    if batch:
        q = q.where(StockBalance.batch == batch)

    left = qty
    out: list[Reservation] = []
    for balance, location in db.execute(q).all():
        if left <= 0:
            break
        if not promisable(location.zone.kind):
            continue  # on a bench, at the line, or on its way somewhere
        available = balance.on_hand - balance.reserved
        take = min(available, left)
        if take <= 0:
            continue
        balance.reserved += take
        left -= take
        out.append(Reservation(location=location, batch=balance.batch, qty=take,
                               received_at=balance.received_at))
    db.flush()
    return out


def release(db: Session, *, location_id: int, product_id: int, batch: str | None, owner: str,
            qty: Decimal) -> None:
    """Give held stock back. Never goes below zero, so a double release is safe."""
    if qty <= 0:
        return
    balance = stock.balance(db, location_id, product_id, batch, owner)
    if balance is None:
        return
    balance.reserved = max(Decimal(0), balance.reserved - qty)
    db.flush()


def release_line(db: Session, line: TaskLine, owner: str) -> None:
    """Release whatever this pick line still holds."""
    if line.from_location_id is None:
        return
    held = line.expected_qty - (line.actual_qty or Decimal(0))
    release(db, location_id=line.from_location_id, product_id=line.product_id, batch=line.batch,
            owner=owner, qty=held)


def release_task(db: Session, task: Task) -> None:
    for line in task.lines:
        if line.status in OPEN_STATUSES:
            release_line(db, line, task.owner)


def rebuild_reservations(db: Session) -> int:
    """Recompute every reserved quantity from the open pick lines. Returns how
    many balance rows now hold stock."""
    db.execute(update(StockBalance).values(reserved=Decimal(0)))
    rows = db.execute(
        select(TaskLine, Task)
        .join(Task, Task.id == TaskLine.task_id)
        .where(Task.type.in_(RESERVING_TYPES), Task.status.in_(("waiting", "in_progress", "needs_supervisor")),
               TaskLine.status.in_(OPEN_STATUSES), TaskLine.from_location_id.is_not(None))
    ).all()
    held = 0
    for line, task in rows:
        balance = stock.balance(db, line.from_location_id, line.product_id, line.batch, task.owner)
        if balance is None:
            continue
        outstanding = line.expected_qty - (line.actual_qty or Decimal(0))
        if outstanding <= 0:
            continue
        if balance.reserved == 0:
            held += 1
        balance.reserved += outstanding
    db.flush()
    return held
