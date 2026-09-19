"""The one place that writes the stock ledger.

Each ledger row is one signed change at one location. A move is two rows,
one out of the source and one into the destination. The materialised
`stock_balance` table is kept in step inside the same transaction, and
`rebuild_balances` proves it can always be recomputed from the ledger alone.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from wms.models import Location, StockBalance, StockLedger


class InsufficientStock(Exception):
    def __init__(self, location_id: int, product_id: int, batch: str | None,
                 on_hand: Decimal, wanted: Decimal):
        self.location_id = location_id
        self.product_id = product_id
        self.batch = batch
        self.on_hand = on_hand
        self.wanted = wanted
        super().__init__(
            f"location {location_id} product {product_id} batch {batch!r} "
            f"has {on_hand} on hand, cannot remove {wanted}"
        )


@dataclass(slots=True)
class LedgerLine:
    product_id: int
    location_id: int
    qty_change: Decimal
    uom: str
    movement_type: str
    actor: str
    received_at: date
    batch: str | None = None
    owner: str = "DEFAULT"
    container_id: str | None = None
    reason: str | None = None
    task_id: int | None = None
    task_line_id: int | None = None
    device: str | None = None
    api_client_id: int | None = None
    external_ref: str | None = None
    note: str | None = None


def post(session: Session, lines: list[LedgerLine]) -> list[StockLedger]:
    """Append ledger rows and update balances. Raises InsufficientStock and
    leaves nothing written if any line would take a balance below zero."""
    rows: list[StockLedger] = []
    for line in lines:
        if line.qty_change == 0:
            raise ValueError("a ledger line must change the quantity")
        location = session.get(Location, line.location_id)
        if location is None:
            raise ValueError(f"unknown location {line.location_id}")

        balance = session.execute(
            select(StockBalance)
            .where(
                StockBalance.location_id == line.location_id,
                StockBalance.product_id == line.product_id,
                StockBalance.batch.is_not_distinct_from(line.batch),
                StockBalance.owner == line.owner,
            )
            .with_for_update()
        ).scalar_one_or_none()

        on_hand = balance.on_hand if balance else Decimal(0)
        new_on_hand = on_hand + line.qty_change
        if new_on_hand < 0:
            session.rollback()
            raise InsufficientStock(
                line.location_id, line.product_id, line.batch, on_hand, -line.qty_change
            )

        row = StockLedger(
            warehouse_id=location.warehouse_id,
            location_id=line.location_id,
            product_id=line.product_id,
            batch=line.batch,
            owner=line.owner,
            container_id=line.container_id,
            qty_change=line.qty_change,
            uom=line.uom,
            movement_type=line.movement_type,
            reason=line.reason,
            task_id=line.task_id,
            task_line_id=line.task_line_id,
            received_at=line.received_at,
            actor=line.actor,
            device=line.device,
            api_client_id=line.api_client_id,
            external_ref=line.external_ref,
            note=line.note,
        )
        session.add(row)
        rows.append(row)

        if balance is None:
            balance = StockBalance(
                warehouse_id=location.warehouse_id,
                location_id=line.location_id,
                product_id=line.product_id,
                batch=line.batch,
                owner=line.owner,
                on_hand=Decimal(0),
                reserved=Decimal(0),
                uom=line.uom,
                received_at=None,
            )
            session.add(balance)
        balance.on_hand = new_on_hand
        balance.updated_at = func.now()
        if line.qty_change > 0 and (
            balance.received_at is None or line.received_at < balance.received_at
        ):
            balance.received_at = line.received_at
    session.flush()
    return rows


def rebuild_balances(session: Session) -> int:
    """Recompute every stock_balance row from the ledger. Returns the row count.

    on_hand is the sum of every change at the key. received_at is the oldest
    receipt date among the inbound rows at that key, which is the FIFO date.
    reserved comes from open task lines and is recomputed by the task engine
    (step 3); here it is carried over so a rebuild never loses it.
    """
    reserved = {
        (r.location_id, r.product_id, r.batch, r.owner): r.reserved
        for r in session.execute(select(StockBalance)).scalars()
        if r.reserved
    }
    session.execute(delete(StockBalance))
    key = (
        StockLedger.warehouse_id, StockLedger.location_id, StockLedger.product_id,
        StockLedger.batch, StockLedger.owner,
    )
    sums = session.execute(
        select(
            *key,
            func.sum(StockLedger.qty_change).label("on_hand"),
            func.min(StockLedger.uom).label("uom"),
            func.min(StockLedger.received_at)
            .filter(StockLedger.qty_change > 0)
            .label("received_at"),
        ).group_by(*key)
    ).all()
    for s in sums:
        session.add(StockBalance(
            warehouse_id=s.warehouse_id,
            location_id=s.location_id,
            product_id=s.product_id,
            batch=s.batch,
            owner=s.owner,
            on_hand=s.on_hand,
            reserved=reserved.get((s.location_id, s.product_id, s.batch, s.owner), Decimal(0)),
            uom=s.uom,
            received_at=s.received_at,
        ))
    session.flush()
    return len(sums)
