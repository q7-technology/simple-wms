"""Production: issue the components to the line, take the finished goods back.

The line itself is outside the WMS. Components are moved to a line-side
location and stay there until the line consumes them; the WMS never guesses
what was used. Finished goods come back pallet by pallet against the order's
expected quantity."""
from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import (
    Location, Product, ProductionComponent, ProductionOrder, ProductionReceipt, Task, Warehouse,
)
from wms.services import reservations, tasks
from wms.services.events import emit
from wms.services.ledger import LedgerLine, post
from wms.services.qty import qstr
from wms.services.settings import effective
from wms.services.stock import RuleError


def order_for_task(db: Session, task: Task) -> ProductionOrder | None:
    return db.execute(
        select(ProductionOrder).where(ProductionOrder.issue_task_id == task.id)
    ).scalars().first()


def allocate(db: Session, order: ProductionOrder, warehouse: Warehouse, created_by: str) -> list[dict]:
    """Hold the components and raise one issue task that walks the shelves and
    drops at the line."""
    summary: list[dict] = []
    specs: list[tuple[int, tasks.LineSpec]] = []
    for component in order.components:
        product = db.get(Product, component.product_id)
        deliver_to = db.get(Location, component.deliver_to_id)
        held = reservations.allocate(db, warehouse=warehouse, product=product,
                                     qty=component.qty_requested, uom=component.uom,
                                     owner=order.owner, batch=component.batch)
        allocated = sum((r.qty for r in held), Decimal(0))
        summary.append({"line": component.line_no, "sku": product.sku,
                        "qty_requested": qstr(component.qty_requested),
                        "qty_allocated": qstr(allocated), "uom": component.uom,
                        "short": qstr(component.qty_requested - allocated)})
        for r in held:
            specs.append((r.location.pick_sequence, tasks.LineSpec(
                product=product, expected_qty=r.qty, uom=component.uom, batch=r.batch,
                from_location=r.location, to_location=deliver_to, source_line=component.line_no)))

    specs.sort(key=lambda pair: (pair[0], pair[1].from_location.code))
    task = tasks.create(db, type="production_issue", warehouse=warehouse, owner=order.owner,
                        lines=[spec for _, spec in specs], source_type="production_order",
                        source_ref=order.external_ref, priority=order.priority,
                        created_by=created_by, note=f"For {order.external_ref}")
    order.issue_task_id = task.id
    order.status = "issuing"
    db.flush()
    return summary


@tasks.on_complete("production_issue")
def _issue_finished(db: Session, task: Task, reason: str | None) -> None:
    order = order_for_task(db, task)
    if order is None or order.status in ("complete", "cancelled"):
        return
    if task.status == "cancelled":
        order.status = "cancelled"
        order.cancelled_at = datetime.now(UTC)
        db.flush()
        return

    issued: dict[int, Decimal] = {}
    for l in task.lines:
        key = l.source_line or l.line_no
        issued[key] = issued.get(key, Decimal(0)) + (l.actual_qty or Decimal(0))
    for component in order.components:
        component.qty_issued = issued.get(component.line_no, Decimal(0))
    complete = all(c.qty_issued >= c.qty_requested for c in order.components)
    order.status = "in_production"
    order.issued_at = datetime.now(UTC)
    db.flush()

    wh = db.get(Warehouse, task.warehouse_id)
    emit(db, "production.components_issued", warehouse=wh.code, owner=order.owner,
         external_ref=order.external_ref, data={
             "po_ref": order.external_ref, "complete": complete,
             "lines": [{
                 "line": c.line_no, "sku": db.get(Product, c.product_id).sku, "batch": c.batch,
                 "qty_requested": qstr(c.qty_requested), "qty_issued": qstr(c.qty_issued),
                 "uom": c.uom, "deliver_to": db.get(Location, c.deliver_to_id).code,
             } for c in order.components]})


def receive(db: Session, order: ProductionOrder, warehouse: Warehouse, *, product: Product,
            batch: str | None, qty: Decimal, uom: str, location: Location,
            container_id: str | None, actor: tasks.Actor, message_id=None) -> ProductionReceipt:
    """One pallet back off the line."""
    if order.status == "cancelled":
        raise tasks.TaskError("cancelled", f"{order.external_ref} was cancelled")
    if product.id != order.output_product_id:
        raise RuleError("sku", f"{order.external_ref} makes "
                               f"{db.get(Product, order.output_product_id).sku}, not {product.sku}")
    if order.output_batch:
        if batch != order.output_batch:
            raise RuleError("batch", f"{order.external_ref} makes batch {order.output_batch}, "
                                     f"not {batch or 'an unmarked pallet'}")
    elif product.batch_tracked and not batch:
        raise RuleError("batch", f"{product.sku} is batch tracked; scan the batch")
    if qty <= 0:
        raise RuleError("qty", "a pallet must have something on it")

    settings = effective(warehouse.settings)
    tolerance = Decimal(str(settings["receipt_tolerance_pct"])) / 100
    total = order.output_received + qty
    if total > order.output_qty * (1 + tolerance) and not actor.supervisor:
        raise tasks.NeedsSupervisor(
            f"{qstr(total)} {uom} is over the {settings['receipt_tolerance_pct']:g} % tolerance on "
            f"{qstr(order.output_qty)}; a supervisor badge is needed")

    rows = post(db, [LedgerLine(
        product_id=product.id, location_id=location.id, qty_change=qty, uom=uom, batch=batch,
        owner=order.owner, container_id=container_id, movement_type="production_receipt",
        task_id=order.issue_task_id, received_at=date.today(), actor=actor.name, device=actor.device,
        api_client_id=actor.api_client_id, external_ref=order.external_ref,
        reason="supervisor_override" if actor.supervisor else None)])

    # the warehouse may say the ERP already counted this stock
    event_sent = not settings["erp_counts_gr"]
    receipt = ProductionReceipt(
        order_id=order.id, message_id=message_id, product_id=product.id, batch=batch, qty=qty,
        uom=uom, location_id=location.id, container_id=container_id, ledger_id=rows[0].id,
        operator=actor.name, device=actor.device, supervisor=actor.supervisor, event_sent=event_sent)
    db.add(receipt)
    order.output_received = total
    complete = total >= order.output_qty
    if complete:
        order.status = "complete"
        order.completed_at = datetime.now(UTC)
    elif order.status == "issuing":
        order.status = "in_production"
    db.flush()

    if event_sent:
        emit(db, "production.received", warehouse=warehouse.code, owner=order.owner,
             external_ref=order.external_ref, data={
                 "po_ref": order.external_ref, "sku": product.sku, "batch": batch, "qty": qstr(qty),
                 "uom": uom, "location": location.code, "container_id": container_id,
                 "operator": actor.name, "received_total": qstr(total),
                 "expected": qstr(order.output_qty), "complete": complete})
    return receipt


def cancel(db: Session, order: ProductionOrder, reason: str | None, actor: tasks.Actor) -> None:
    if order.status == "cancelled":
        raise tasks.TaskError("already_cancelled", f"{order.external_ref} is already cancelled")
    if order.output_received > 0:
        raise tasks.TaskError("already_received",
                              f"{order.external_ref} already has finished goods against it")
    order.status = "cancelled"
    order.cancelled_at = datetime.now(UTC)
    order.note = reason or order.note
    db.flush()
    task = db.get(Task, order.issue_task_id) if order.issue_task_id else None
    if task and task.status not in ("done", "cancelled"):
        tasks.cancel(db, task, reason, actor)
    db.flush()
