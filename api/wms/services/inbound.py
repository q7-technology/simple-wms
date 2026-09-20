"""Receipts: the document behind a receive task."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import Receipt, ReceiptLine, Task, Warehouse
from wms.services import tasks
from wms.services.events import emit
from wms.services.qty import qstr


def receipt_for_task(db: Session, task: Task) -> Receipt | None:
    return db.execute(select(Receipt).where(Receipt.task_id == task.id)).scalar_one_or_none()


@tasks.on_complete("receive.confirmed")
def _on_confirmed(db: Session, task: Task, reason: str | None) -> None:
    receipt = receipt_for_task(db, task)
    if receipt is None:
        return
    if receipt.status in ("expected", "arrived"):
        receipt.status = "receiving"
    by_line = {l.source_line or l.line_no: l for l in task.lines}
    for rl in receipt.lines:
        tl = by_line.get(rl.line_no)
        if tl is not None and tl.actual_qty is not None:
            rl.received_qty = tl.actual_qty
    db.flush()


@tasks.on_complete("receive")
def _on_done(db: Session, task: Task, reason: str | None) -> None:
    receipt = receipt_for_task(db, task)
    if receipt is None:
        return
    if task.status == "cancelled":
        receipt.status = "cancelled"
        receipt.closed_at = datetime.now(UTC)
        db.flush()
        return
    short = any(l.status == "short" for l in task.lines)
    receipt.status = "closed_short" if short else "complete"
    receipt.closed_at = datetime.now(UTC)
    db.flush()
    wh = db.get(Warehouse, task.warehouse_id)
    emit(db, "receipt.closed", warehouse=wh.code, owner=task.owner, external_ref=receipt.external_ref, data={
        "receipt_ref": receipt.external_ref, "complete": not short, "reason": reason,
        "lines": [{
            "line": rl.line_no, "sku": rl_sku(db, rl), "batch": rl.batch, "qty_expected": qstr(rl.expected_qty),
            "qty_received": qstr(rl.received_qty), "uom": rl.uom,
        } for rl in receipt.lines],
    })


def rl_sku(db: Session, rl: ReceiptLine) -> str:
    from wms.models import Product
    return db.get(Product, rl.product_id).sku


@tasks.on_complete("replenish")
def _on_replenished(db: Session, task: Task, reason: str | None) -> None:
    if task.status != "done":
        return
    wh = db.get(Warehouse, task.warehouse_id)
    emit(db, "replenishment.completed", warehouse=wh.code, owner=task.owner, external_ref=task.source_ref, data={
        "replen_ref": task.source_ref,
        "lines": [{
            "line": l.source_line or l.line_no, "sku": l.product.sku, "batch": l.batch,
            "qty_requested": qstr(l.expected_qty), "qty_moved": qstr(l.actual_qty or 0), "uom": l.uom,
            "from": l.from_location.code if l.from_location else None,
            "to": l.to_location.code if l.to_location else None, "status": l.status,
        } for l in task.lines],
    })
