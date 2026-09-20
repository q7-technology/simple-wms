"""Deliveries: allocate, pick, pack, ship. The document follows its tasks."""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import Delivery, DeliveryLine, Location, Package, Product, Task, Warehouse, Zone
from wms.services import reservations, tasks
from wms.services.events import emit
from wms.services.qty import qstr
from wms.services.stock import RuleError


def staging_location(db: Session, warehouse: Warehouse) -> Location | None:
    """Where picked stock waits for its carton: the packing bench if there is
    one, otherwise any staging area. A receiving dock is a staging zone too,
    so packing wins when both exist."""
    for kind in ("packing", "staging"):
        found = db.execute(
            select(Location).join(Zone, Zone.id == Location.zone_id)
            .where(Location.warehouse_id == warehouse.id, Location.active.is_(True),
                   Zone.kind == kind, Zone.active.is_(True))
            .order_by(Location.pick_sequence, Location.code)
        ).scalars().first()
        if found is not None:
            return found
    return None


def delivery_for_task(db: Session, task: Task) -> Delivery | None:
    return db.execute(
        select(Delivery).where((Delivery.pick_task_id == task.id) | (Delivery.pack_task_id == task.id))
    ).scalars().first()


def line_summary(db: Session, delivery: Delivery, qty_field: str) -> list[dict]:
    out = []
    for l in delivery.lines:
        product = db.get(Product, l.product_id)
        row = {"delivery_line": l.line_no, "sku": product.sku, "batch": l.batch,
               "qty_ordered": qstr(l.qty_ordered), qty_field: qstr(getattr(l, qty_field)), "uom": l.uom}
        if qty_field == "qty_picked":
            row["short_reason"] = l.short_reason
        out.append(row)
    return out


def package_summary(delivery: Delivery) -> list[dict]:
    return [{"package_no": p.package_no, "weight_kg": qstr(p.weight_kg), "sscc": p.sscc}
            for p in delivery.packages]


def allocate(db: Session, delivery: Delivery, warehouse: Warehouse, created_by: str) -> list[dict]:
    """Hold stock for every line, oldest first, and raise the pick task in walk
    order. Returns what was held, line by line."""
    staging = staging_location(db, warehouse)
    if staging is None:
        raise RuleError("warehouse", f"{warehouse.code} has no packing or staging zone for picked stock; add one on the Locations screen")
    delivery.staging_location_id = staging.id

    summary: list[dict] = []
    specs: list[tuple[int, tasks.LineSpec]] = []
    for line in delivery.lines:
        product = db.get(Product, line.product_id)
        held = reservations.allocate(db, warehouse=warehouse, product=product, qty=line.qty_ordered,
                                     uom=line.uom, owner=delivery.owner, batch=line.batch)
        allocated = sum((r.qty for r in held), Decimal(0))
        line.qty_allocated = allocated
        summary.append({"delivery_line": line.line_no, "sku": product.sku,
                        "qty_ordered": qstr(line.qty_ordered), "qty_allocated": qstr(allocated),
                        "uom": line.uom, "short": qstr(line.qty_ordered - allocated)})
        for r in held:
            specs.append((r.location.pick_sequence, tasks.LineSpec(
                product=product, expected_qty=r.qty, uom=line.uom, batch=r.batch,
                from_location=r.location, to_location=staging, source_line=line.line_no)))

    specs.sort(key=lambda pair: (pair[0], pair[1].from_location.code))
    task = tasks.create(db, type="pick", warehouse=warehouse, owner=delivery.owner,
                        lines=[spec for _, spec in specs], source_type="delivery",
                        source_ref=delivery.external_ref, priority=delivery.priority,
                        created_by=created_by, note=(delivery.ship_to or {}).get("name"))
    delivery.pick_task_id = task.id
    delivery.status = "allocated"
    delivery.allocated_at = datetime.now(UTC)
    delivery.short = any(Decimal(row["short"]) > 0 for row in summary)
    db.flush()

    emit(db, "delivery.allocated", warehouse=warehouse.code, owner=delivery.owner,
         external_ref=delivery.external_ref, data={
             "delivery_ref": delivery.external_ref, "complete": not delivery.short,
             "lines": [{"delivery_line": row["delivery_line"], "sku": row["sku"],
                        "batch": next(l.batch for l in delivery.lines if l.line_no == row["delivery_line"]),
                        "qty_ordered": row["qty_ordered"], "qty_allocated": row["qty_allocated"],
                        "uom": row["uom"]} for row in summary]})
    return summary


@tasks.on_complete("pick.confirmed")
def _picking_started(db: Session, task: Task, reason: str | None) -> None:
    """The first line off a shelf means the order is being picked."""
    delivery = delivery_for_task(db, task)
    if delivery is not None and delivery.status == "allocated":
        delivery.status = "picking"
        db.flush()


@tasks.on_complete("pick")
def _pick_finished(db: Session, task: Task, reason: str | None) -> None:
    delivery = delivery_for_task(db, task)
    if delivery is None or delivery.status in ("shipped", "cancelled"):
        return
    wh = db.get(Warehouse, task.warehouse_id)
    if task.status == "cancelled":
        delivery.status = "cancelled"
        delivery.cancelled_at = datetime.now(UTC)
        db.flush()
        emit(db, "delivery.cancelled", warehouse=wh.code, owner=delivery.owner,
             external_ref=delivery.external_ref,
             data={"delivery_ref": delivery.external_ref, "reason": reason})
        return

    by_line: dict[int, Decimal] = {}
    reasons: dict[int, str] = {}
    for l in task.lines:
        key = l.source_line or l.line_no
        by_line[key] = by_line.get(key, Decimal(0)) + (l.actual_qty or Decimal(0))
        if l.status == "short" and l.reason and key not in reasons:
            reasons[key] = l.reason
    for line in delivery.lines:
        line.qty_picked = by_line.get(line.line_no, Decimal(0))
        line.short_reason = reasons.get(line.line_no)
    delivery.short = any(l.qty_picked < l.qty_ordered for l in delivery.lines)
    delivery.status = "picked"
    delivery.picked_at = datetime.now(UTC)
    db.flush()

    emit(db, "delivery.picked", warehouse=wh.code, owner=delivery.owner,
         external_ref=delivery.external_ref, data={
             "delivery_ref": delivery.external_ref, "complete": not delivery.short,
             "lines": line_summary(db, delivery, "qty_picked")})

    if any(l.qty_picked > 0 for l in delivery.lines):
        pack = tasks.create(db, type="pack", warehouse=wh, owner=delivery.owner, lines=[],
                            source_type="delivery", source_ref=delivery.external_ref,
                            priority=delivery.priority, created_by="wms",
                            note=(delivery.ship_to or {}).get("name"))
        delivery.pack_task_id = pack.id
        db.flush()


def picked_qty(delivery: Delivery, line_no: int) -> Decimal:
    for l in delivery.lines:
        if l.line_no == line_no:
            return l.qty_picked
    return Decimal(0)


def packed_qty(delivery: Delivery, line_no: int) -> Decimal:
    total = Decimal(0)
    for package in delivery.packages:
        for pl in package.lines:
            if pl.delivery_line == line_no:
                total += pl.qty
    return total


def to_pack(db: Session, delivery: Delivery, line_no: int) -> list[tuple[str | None, Decimal]]:
    """What is still on the bench for this delivery line, batch by batch, in
    the order it was picked. A carton must carry the batch that was picked,
    not the one the order asked for."""
    picked: dict[str | None, Decimal] = {}
    task = db.get(Task, delivery.pick_task_id) if delivery.pick_task_id else None
    for l in (task.lines if task else []):
        if (l.source_line or l.line_no) == line_no and l.actual_qty:
            picked[l.batch] = picked.get(l.batch, Decimal(0)) + l.actual_qty
    for package in delivery.packages:
        for pl in package.lines:
            if pl.delivery_line == line_no and pl.batch in picked:
                picked[pl.batch] -= pl.qty
    return [(batch, qty) for batch, qty in picked.items() if qty > 0]


def finish_packing(db: Session, delivery: Delivery, wh: Warehouse) -> None:
    delivery.status = "packed"
    delivery.packed_at = datetime.now(UTC)
    if delivery.pack_task_id:
        task = db.get(Task, delivery.pack_task_id)
        if task and task.status not in ("done", "cancelled"):
            task.status = "done"
            task.completed_at = datetime.now(UTC)
    db.flush()
    emit(db, "delivery.packed", warehouse=wh.code, owner=delivery.owner,
         external_ref=delivery.external_ref, data={
             "delivery_ref": delivery.external_ref,
             "packages": [{
                 "package_no": p.package_no, "type": p.type, "weight_kg": qstr(p.weight_kg),
                 "length_cm": qstr(p.length_cm), "width_cm": qstr(p.width_cm), "height_cm": qstr(p.height_cm),
                 "sscc": p.sscc, "container_id": p.container_id,
                 "contents": [{"delivery_line": pl.delivery_line, "sku": db.get(Product, pl.product_id).sku,
                               "batch": pl.batch, "qty": qstr(pl.qty), "uom": pl.uom} for pl in p.lines],
             } for p in delivery.packages]})


def ship(db: Session, delivery: Delivery, wh: Warehouse, *, carrier: str | None, tracking_no: str | None,
         actor: tasks.Actor) -> None:
    """The stock leaves the building: one ledger line out of staging per package line."""
    from datetime import date

    from wms.services.ledger import LedgerLine, post

    if delivery.status == "shipped":
        raise tasks.TaskError("already_shipped", f"{delivery.external_ref} has already shipped")
    if delivery.status == "cancelled":
        raise tasks.TaskError("cancelled", f"{delivery.external_ref} was cancelled")
    if not delivery.packages:
        raise tasks.TaskError("not_packed", "nothing is packed yet")
    if delivery.short and not delivery.allow_short:
        raise tasks.TaskError("short_not_allowed", f"{delivery.external_ref} is short and does not allow a short shipment")

    staging_id = delivery.staging_location_id
    lines = []
    for package in delivery.packages:
        for pl in package.lines:
            lines.append(LedgerLine(
                product_id=pl.product_id, location_id=staging_id, qty_change=-pl.qty, uom=pl.uom,
                batch=pl.batch, owner=delivery.owner, container_id=package.container_id,
                movement_type="ship", task_id=delivery.pack_task_id, received_at=date.today(),
                actor=actor.name, device=actor.device, api_client_id=actor.api_client_id,
                external_ref=delivery.external_ref, note=f"package {package.package_no}"))
    post(db, lines)

    for line in delivery.lines:
        line.qty_shipped = packed_qty(delivery, line.line_no)
    delivery.carrier = carrier or delivery.carrier or delivery.carrier_hint
    delivery.tracking_no = tracking_no
    delivery.status = "shipped"
    delivery.shipped_at = datetime.now(UTC)
    delivery.short = any(l.qty_shipped < l.qty_ordered for l in delivery.lines)
    db.flush()

    emit(db, "delivery.shipped", warehouse=wh.code, owner=delivery.owner,
         external_ref=delivery.external_ref, data={
             "delivery_ref": delivery.external_ref, "carrier": delivery.carrier,
             "tracking_no": delivery.tracking_no, "short": delivery.short,
             "lines": line_summary(db, delivery, "qty_shipped"),
             "packages": package_summary(delivery)})


def stranded_at_staging(db: Session, delivery: Delivery) -> list[tuple[Product, str | None, Decimal, str]]:
    """What this delivery has sitting on the packing bench: picked, not shipped."""
    out: dict[tuple[int, str | None], tuple[Decimal, str]] = {}
    task = db.get(Task, delivery.pick_task_id) if delivery.pick_task_id else None
    for l in (task.lines if task else []):
        if l.actual_qty:
            key = (l.product_id, l.batch)
            qty, uom = out.get(key, (Decimal(0), l.uom))
            out[key] = (qty + l.actual_qty, uom)
    if delivery.status == "shipped":
        return []
    return [(db.get(Product, product_id), batch, qty, uom)
            for (product_id, batch), (qty, uom) in out.items() if qty > 0]


def putaway_stranded_stock(db: Session, delivery: Delivery, wh: Warehouse, reason: str) -> Task | None:
    """Stock on the bench for a cancelled order needs a home. Raise a put-away
    task so it goes back on a shelf instead of sitting there."""
    stranded = stranded_at_staging(db, delivery)
    if not stranded:
        return None
    staging = db.get(Location, delivery.staging_location_id)
    task = tasks.create(
        db, type="putaway", warehouse=wh, owner=delivery.owner, source_type="delivery",
        source_ref=delivery.external_ref, priority="high", created_by="wms",
        note=f"Back on a shelf: {delivery.external_ref} was cancelled ({reason})" if reason
        else f"Back on a shelf: {delivery.external_ref} was cancelled",
        lines=[tasks.LineSpec(product=product, expected_qty=qty, uom=uom, batch=batch,
                              from_location=staging) for product, batch, qty, uom in stranded])
    db.flush()
    return task


def cancel(db: Session, delivery: Delivery, wh: Warehouse, reason: str | None, actor: tasks.Actor) -> None:
    if delivery.status == "shipped":
        raise tasks.TaskError("already_shipped", f"{delivery.external_ref} has already shipped; it cannot be cancelled")
    if delivery.status == "cancelled":
        raise tasks.TaskError("already_cancelled", f"{delivery.external_ref} is already cancelled")
    # mark it first so the pick task's completion hook does not announce it twice
    delivery.status = "cancelled"
    delivery.cancelled_at = datetime.now(UTC)
    db.flush()
    for task_id in (delivery.pick_task_id, delivery.pack_task_id):
        task = db.get(Task, task_id) if task_id else None
        if task and task.status not in ("done", "cancelled"):
            tasks.cancel(db, task, reason, actor)
    putaway_stranded_stock(db, delivery, wh, reason or "")
    db.flush()
    emit(db, "delivery.cancelled", warehouse=wh.code, owner=delivery.owner,
         external_ref=delivery.external_ref,
         data={"delivery_ref": delivery.external_ref, "reason": reason})
