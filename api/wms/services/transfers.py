"""Transfers: one order, two legs, an in-transit bucket between them.

Leg one is an ordinary pick at the sender. Shipping takes the stock off the
sender's bench and puts it in the receiver's in-transit bucket, which is a
real location, so the ledger always knows where the stock is. Leg two is a
put-away out of that bucket. Anything that never turns up stays in the
bucket until a human closes it with a reason."""
from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import (
    Location, Product, Receipt, ReceiptLine, StockBalance, Task, Transfer, TransferLine,
    Warehouse, Zone,
)
from wms.services import reservations, tasks
from wms.services.events import emit
from wms.services.ledger import LedgerLine, post
from wms.services.outbound import staging_location
from wms.services.qty import qstr
from wms.services.stock import RuleError, balance


def in_transit_location(db: Session, warehouse: Warehouse) -> Location | None:
    """The bucket stock sits in on its way to this warehouse."""
    return db.execute(
        select(Location).join(Zone, Zone.id == Location.zone_id)
        .where(Location.warehouse_id == warehouse.id, Location.active.is_(True),
               Zone.kind == "in_transit", Zone.active.is_(True))
        .order_by(Location.pick_sequence, Location.code)
    ).scalars().first()


def transfer_for_task(db: Session, task: Task) -> Transfer | None:
    return db.execute(
        select(Transfer).where((Transfer.pick_task_id == task.id) | (Transfer.receive_task_id == task.id))
    ).scalars().first()


def line_rows(db: Session, transfer: Transfer, *fields: str) -> list[dict]:
    out = []
    for l in transfer.lines:
        product = db.get(Product, l.product_id)
        row = {"line": l.line_no, "sku": product.sku, "batch": l.batch}
        for f in fields:
            row[f] = qstr(getattr(l, f) if f != "variance" else l.qty_received - l.qty_shipped)
        row["uom"] = l.uom
        out.append(row)
    return out


def allocate(db: Session, transfer: Transfer, sender: Warehouse, receiver: Warehouse,
             created_by: str) -> list[dict]:
    bench = staging_location(db, sender)
    if bench is None:
        raise RuleError("from_warehouse", f"{sender.code} has no packing or staging zone; add one on the Locations screen")
    bucket = in_transit_location(db, receiver)
    if bucket is None:
        raise RuleError("to_warehouse", f"{receiver.code} has no in transit zone for stock on its way; add one on the Locations screen")
    transfer.staging_location_id = bench.id
    transfer.in_transit_location_id = bucket.id

    summary: list[dict] = []
    specs: list[tuple[int, tasks.LineSpec]] = []
    for line in transfer.lines:
        product = db.get(Product, line.product_id)
        held = reservations.allocate(db, warehouse=sender, product=product, qty=line.qty_requested,
                                     uom=line.uom, owner=transfer.owner, batch=line.batch)
        allocated = sum((r.qty for r in held), Decimal(0))
        line.qty_allocated = allocated
        summary.append({"line": line.line_no, "sku": product.sku,
                        "qty_requested": qstr(line.qty_requested), "qty_allocated": qstr(allocated),
                        "uom": line.uom, "short": qstr(line.qty_requested - allocated)})
        for r in held:
            specs.append((r.location.pick_sequence, tasks.LineSpec(
                product=product, expected_qty=r.qty, uom=line.uom, batch=r.batch,
                from_location=r.location, to_location=bench, source_line=line.line_no)))

    specs.sort(key=lambda pair: (pair[0], pair[1].from_location.code))
    task = tasks.create(db, type="transfer_pick", warehouse=sender, owner=transfer.owner,
                        lines=[spec for _, spec in specs], source_type="transfer",
                        source_ref=transfer.external_ref, priority=transfer.priority,
                        created_by=created_by, note=f"To {receiver.code}")
    transfer.pick_task_id = task.id
    transfer.status = "allocated"
    transfer.allocated_at = datetime.now(UTC)
    db.flush()
    return summary


@tasks.on_complete("pick.confirmed")
def _picking_started(db: Session, task: Task, reason: str | None) -> None:
    if task.type != "transfer_pick":
        return
    transfer = transfer_for_task(db, task)
    if transfer is not None and transfer.status == "allocated":
        transfer.status = "picking"
        db.flush()


@tasks.on_complete("transfer_pick")
def _pick_finished(db: Session, task: Task, reason: str | None) -> None:
    transfer = transfer_for_task(db, task)
    if transfer is None or transfer.status in ("in_transit", "received", "closed", "cancelled"):
        return
    if task.status == "cancelled":
        transfer.status = "cancelled"
        transfer.cancelled_at = datetime.now(UTC)
        db.flush()
        return
    picked: dict[int, Decimal] = {}
    for l in task.lines:
        key = l.source_line or l.line_no
        picked[key] = picked.get(key, Decimal(0)) + (l.actual_qty or Decimal(0))
    for line in transfer.lines:
        line.qty_picked = picked.get(line.line_no, Decimal(0))
    transfer.status = "picked"
    db.flush()


def _on_bench(db: Session, transfer: Transfer, line: TransferLine) -> list[tuple[str | None, Decimal, date]]:
    """What this line has on the sender's bench, batch by batch, with the date
    that travels with it."""
    task = db.get(Task, transfer.pick_task_id) if transfer.pick_task_id else None
    out: list[tuple[str | None, Decimal, date]] = []
    for l in (task.lines if task else []):
        if (l.source_line or l.line_no) != line.line_no or not l.actual_qty:
            continue
        bal = balance(db, transfer.staging_location_id, l.product_id, l.batch, transfer.owner)
        out.append((l.batch, l.actual_qty, (bal.received_at if bal else None) or date.today()))
    return out


def to_pack(db: Session, transfer: Transfer, line_no: int) -> Decimal:
    """What is still on the bench for this transfer line."""
    picked = next((l.qty_picked for l in transfer.lines if l.line_no == line_no), Decimal(0))
    packed = sum((pl.qty for p in transfer.packages for pl in p.lines
                  if pl.delivery_line == line_no), Decimal(0))
    return picked - packed


def package_rows(transfer: Transfer) -> list[dict]:
    return [{"package_no": p.package_no, "weight_kg": qstr(p.weight_kg), "sscc": p.sscc}
            for p in transfer.packages]


def ship(db: Session, transfer: Transfer, sender: Warehouse, receiver: Warehouse,
         *, carrier: str | None, tracking_no: str | None, actor: tasks.Actor) -> None:
    if transfer.status in ("in_transit", "receiving", "received", "closed"):
        raise tasks.TaskError("already_shipped", f"{transfer.external_ref} has already left")
    if transfer.status == "cancelled":
        raise tasks.TaskError("cancelled", f"{transfer.external_ref} was cancelled")
    if not any(l.qty_picked > 0 for l in transfer.lines):
        raise tasks.TaskError("nothing_picked", "nothing has been picked for this transfer yet")

    bucket = db.get(Location, transfer.in_transit_location_id)
    rows: list[LedgerLine] = []
    specs: list[tasks.LineSpec] = []
    for line in transfer.lines:
        shipped = Decimal(0)
        for batch, qty, received in _on_bench(db, transfer, line):
            common = dict(product_id=line.product_id, uom=line.uom, batch=batch, owner=transfer.owner,
                          movement_type="transfer_out", task_id=transfer.pick_task_id,
                          received_at=received, actor=actor.name, device=actor.device,
                          api_client_id=actor.api_client_id, external_ref=transfer.external_ref,
                          note=f"to {receiver.code}")
            rows.append(LedgerLine(location_id=transfer.staging_location_id, qty_change=-qty, **common))
            rows.append(LedgerLine(location_id=bucket.id, qty_change=qty, **common))
            shipped += qty
            specs.append(tasks.LineSpec(product=db.get(Product, line.product_id), expected_qty=qty,
                                        uom=line.uom, batch=batch, from_location=bucket,
                                        source_line=line.line_no))
        line.qty_shipped = shipped
    post(db, rows)

    transfer.carrier = carrier or transfer.carrier_hint
    transfer.tracking_no = tracking_no
    transfer.status = "in_transit"
    transfer.shipped_at = datetime.now(UTC)

    # the far end gets an expected receipt and the work to put it away
    receive_task = tasks.create(db, type="transfer_receive", warehouse=receiver, owner=transfer.owner,
                                lines=specs, source_type="transfer", source_ref=transfer.external_ref,
                                priority=transfer.priority, created_by="wms",
                                note=f"From {sender.code}")
    transfer.receive_task_id = receive_task.id
    receipt = Receipt(owner=transfer.owner, external_ref=transfer.external_ref,
                      warehouse_id=receiver.id, supplier=sender.code, kind="transfer",
                      expected_at=transfer.required_by, status="expected",
                      task_id=receive_task.id, note=f"Transfer from {sender.code}")
    for line in transfer.lines:
        if line.qty_shipped > 0:
            receipt.lines.append(ReceiptLine(line_no=line.line_no, product_id=line.product_id,
                                             batch=line.batch, expected_qty=line.qty_shipped,
                                             received_qty=Decimal(0), uom=line.uom))
    db.add(receipt)
    db.flush()
    transfer.receipt_id = receipt.id
    db.flush()

    emit(db, "transfer.shipped", warehouse=sender.code, owner=transfer.owner,
         external_ref=transfer.external_ref, data={
             "transfer_ref": transfer.external_ref, "from_warehouse": sender.code,
             "to_warehouse": receiver.code, "carrier": transfer.carrier,
             "tracking_no": transfer.tracking_no,
             "lines": line_rows(db, transfer, "qty_requested", "qty_shipped"),
             "packages": package_rows(transfer)})


@tasks.on_complete("transfer_receive")
def _receive_finished(db: Session, task: Task, reason: str | None) -> None:
    transfer = transfer_for_task(db, task)
    if transfer is None or transfer.status in ("received", "closed", "cancelled"):
        return
    received: dict[int, Decimal] = {}
    for l in task.lines:
        key = l.source_line or l.line_no
        received[key] = received.get(key, Decimal(0)) + (l.actual_qty or Decimal(0))
    for line in transfer.lines:
        line.qty_received = received.get(line.line_no, Decimal(0))
    short = any(l.qty_received < l.qty_shipped for l in transfer.lines)
    transfer.status = "variance" if short else "received"
    transfer.received_at = datetime.now(UTC)
    if not short:
        transfer.closed_at = datetime.now(UTC)
    db.flush()

    receipt = db.get(Receipt, transfer.receipt_id) if transfer.receipt_id else None
    if receipt is not None:
        for rl in receipt.lines:
            rl.received_qty = received.get(rl.line_no, Decimal(0))
        receipt.status = "closed_short" if short else "complete"
        receipt.closed_at = datetime.now(UTC)
        db.flush()

    receiver = db.get(Warehouse, task.warehouse_id)
    emit(db, "transfer.received", warehouse=receiver.code, owner=transfer.owner,
         external_ref=transfer.external_ref, data={
             "transfer_ref": transfer.external_ref, "complete": not short,
             "lines": line_rows(db, transfer, "qty_shipped", "qty_received", "variance")})


def close_variance(db: Session, transfer: Transfer, receiver: Warehouse, *, reason: str,
                   note: str | None, actor: tasks.Actor) -> None:
    """Whatever never turned up is written off the bucket, with a reason."""
    if transfer.status != "variance":
        raise tasks.TaskError("no_variance", f"{transfer.external_ref} has nothing left in transit")
    bucket = db.get(Location, transfer.in_transit_location_id)
    rows = []
    for line in transfer.lines:
        missing = line.qty_shipped - line.qty_received
        if missing <= 0:
            continue
        for bal in db.execute(
            select(StockBalance).where(StockBalance.location_id == bucket.id,
                                       StockBalance.product_id == line.product_id,
                                       StockBalance.owner == transfer.owner)
        ).scalars().all():
            if bal.on_hand <= 0 or missing <= 0:
                continue
            take = min(bal.on_hand, missing)
            rows.append(LedgerLine(
                product_id=line.product_id, location_id=bucket.id, qty_change=-take, uom=line.uom,
                batch=bal.batch, owner=transfer.owner, movement_type="adjustment", reason=reason,
                task_id=transfer.receive_task_id, received_at=bal.received_at or date.today(),
                actor=actor.name, device=actor.device, api_client_id=actor.api_client_id,
                external_ref=transfer.external_ref, note=note))
            missing -= take
    written = post(db, rows) if rows else []
    transfer.status = "closed"
    transfer.variance_reason = reason
    transfer.closed_at = datetime.now(UTC)
    db.flush()
    for row in written:
        product = db.get(Product, row.product_id)
        emit(db, "stock.adjusted", warehouse=receiver.code, owner=transfer.owner,
             external_ref=transfer.external_ref, data={
                 "sku": product.sku, "batch": row.batch, "location": bucket.code,
                 "qty_change": qstr(row.qty_change), "uom": row.uom, "reason": reason,
                 "ledger_id": str(row.id), "approved_by": actor.name})


def cancel(db: Session, transfer: Transfer, reason: str | None, actor: tasks.Actor) -> None:
    if transfer.status in ("in_transit", "receiving", "received", "closed"):
        raise tasks.TaskError("already_shipped", f"{transfer.external_ref} has already left; it cannot be cancelled")
    if transfer.status == "cancelled":
        raise tasks.TaskError("already_cancelled", f"{transfer.external_ref} is already cancelled")
    transfer.status = "cancelled"
    transfer.cancelled_at = datetime.now(UTC)
    transfer.note = reason or transfer.note
    db.flush()
    task = db.get(Task, transfer.pick_task_id) if transfer.pick_task_id else None
    if task and task.status not in ("done", "cancelled"):
        tasks.cancel(db, task, reason, actor)
    db.flush()
