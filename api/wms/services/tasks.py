"""The one task engine. Receive, put away, pick, pack, ship, move, count,
replenish, transfer, production issue and receipt all go through here.
Confirming a line performs its movement and writes the ledger."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from wms.models import Location, Product, Task, TaskLine, Warehouse
from wms.services import stock
from wms.services.events import emit
from wms.services.qty import qstr
from wms.services.ledger import LedgerLine, post
from wms.services.settings import effective

OPEN_LINE = ("open", "variance")
FINISHED_LINE = ("done", "short", "cancelled")

TITLES = {
    "receive": "Receive", "putaway": "Put away", "pick": "Pick", "pack": "Pack", "ship": "Ship",
    "move": "Move", "count": "Count", "replenish": "Replenish", "transfer_pick": "Transfer pick",
    "transfer_receive": "Receive transfer", "production_issue": "Issue", "production_receipt": "Production receipt",
}


def priority_order(column):
    """Sort high, then normal, then low. Alphabetical order would say otherwise."""
    from sqlalchemy import case

    return case({"high": 0, "normal": 1, "low": 2}, value=column, else_=1)


class TaskError(Exception):
    """A state problem: 409 with a code."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class NeedsSupervisor(TaskError):
    def __init__(self, message: str):
        super().__init__("needs_supervisor", message)


@dataclass(slots=True)
class Actor:
    name: str
    device: str | None = None
    api_client_id: int | None = None
    supervisor: str | None = None  # operator code of the badge that approved


@dataclass(slots=True)
class LineSpec:
    product: Product
    expected_qty: Decimal
    uom: str
    batch: str | None = None
    from_location: Location | None = None
    to_location: Location | None = None
    source_line: int | None = None
    container_id: str | None = None


# Hooks other modules register: called when a task reaches done.
COMPLETION_HOOKS: dict[str, list[Callable[[Session, Task, str | None], None]]] = {}


def on_complete(task_type: str):
    def register(fn):
        COMPLETION_HOOKS.setdefault(task_type, []).append(fn)
        return fn
    return register


def title(task: Task) -> str:
    base = TITLES.get(task.type, task.type.replace("_", " ").capitalize())
    return f"{base} {task.source_ref}" if task.source_ref else base


def progress(task: Task) -> dict:
    total = len(task.lines)
    done = sum(1 for l in task.lines if l.status in FINISHED_LINE)
    return {"done": done, "total": total}


def create(db: Session, *, type: str, warehouse: Warehouse, owner: str, lines: list[LineSpec],
           source_type: str | None = None, source_ref: str | None = None, priority: str = "normal",
           created_by: str | None = None, note: str | None = None, status: str = "waiting") -> Task:
    task = Task(type=type, status=status, warehouse_id=warehouse.id, owner=owner, priority=priority,
                source_type=source_type, source_ref=source_ref, created_by=created_by, note=note)
    for n, spec in enumerate(lines, start=1):
        task.lines.append(TaskLine(
            line_no=n, product_id=spec.product.id, batch=spec.batch, expected_qty=spec.expected_qty,
            uom=spec.uom, from_location_id=spec.from_location.id if spec.from_location else None,
            to_location_id=spec.to_location.id if spec.to_location else None,
            source_line=spec.source_line, container_id=spec.container_id,
        ))
    db.add(task)
    db.flush()
    return task


def _must_be_open(task: Task) -> None:
    if task.status in ("done", "cancelled"):
        raise TaskError("task_not_open", f"task {task.id} is {task.status}")


def start(db: Session, task: Task, actor: Actor) -> None:
    _must_be_open(task)
    if task.status == "waiting":
        task.status = "in_progress"
        task.started_at = datetime.now(UTC)
    task.assigned_to = task.assigned_to or actor.name
    task.device = actor.device or task.device
    db.flush()


def assign(db: Session, task: Task, assigned_to: str | None) -> None:
    _must_be_open(task)
    task.assigned_to = assigned_to
    db.flush()


def cancel(db: Session, task: Task, reason: str | None, actor: Actor) -> None:
    from wms.services import reservations

    _must_be_open(task)
    reservations.release_task(db, task)
    task.status = "cancelled"
    task.cancelled_at = datetime.now(UTC)
    task.note = reason or task.note
    for line in task.lines:
        if line.status not in FINISHED_LINE:
            line.status = "cancelled"
            line.reason = reason
    db.flush()
    _run_hooks(db, task, reason)


def close_short(db: Session, task: Task, reason: str | None, actor: Actor) -> None:
    """Stop here: what is not done is short. Used for receipts the supplier under-delivered."""
    from wms.services import reservations

    _must_be_open(task)
    reservations.release_task(db, task)
    for line in task.lines:
        if line.status not in FINISHED_LINE:
            line.status = "short"
            line.reason = reason
            line.completed_at = datetime.now(UTC)
    _finish(db, task, reason)


def _finish(db: Session, task: Task, reason: str | None = None) -> None:
    if all(l.status in FINISHED_LINE for l in task.lines):
        task.status = "done"
        task.needs_supervisor = False
        task.completed_at = datetime.now(UTC)
        db.flush()
        _run_hooks(db, task, reason)
    elif any(l.status == "variance" for l in task.lines):
        task.status = "needs_supervisor"
        task.needs_supervisor = True
    else:
        task.status = "in_progress"
        task.needs_supervisor = False
    db.flush()


def _run_hooks(db: Session, task: Task, reason: str | None) -> None:
    for fn in COMPLETION_HOOKS.get(task.type, []):
        fn(db, task, reason)


def _warehouse(db: Session, task: Task) -> Warehouse:
    return db.get(Warehouse, task.warehouse_id)


def _location(db: Session, task: Task, code: str | None, field: str) -> Location | None:
    if not code:
        return None
    from sqlalchemy import select
    loc = db.execute(select(Location).where(Location.warehouse_id == task.warehouse_id, Location.code == code)).scalar_one_or_none()
    if loc is None:
        raise stock.RuleError(field, f"unknown location {code} in this warehouse")
    if not loc.active:
        raise stock.RuleError(field, f"{code} is not active")
    return loc


def confirm(db: Session, task: Task, line: TaskLine, *, qty: Decimal, uom: str | None, actor: Actor,
            batch: str | None = None, to_location: str | None = None, from_location: str | None = None,
            container_id: str | None = None, reason: str | None = None, note: str | None = None,
            received_at: date | None = None) -> None:
    """Do this line (or part of it). Raises RuleError (422), TaskError (409)."""
    _must_be_open(task)
    if line.status in FINISHED_LINE:
        raise TaskError("line_finished", f"line {line.line_no} is already {line.status}")
    if qty < 0:
        raise stock.RuleError("qty", "quantity cannot be negative")
    if task.status == "waiting":
        start(db, task, actor)
    uom = uom or line.uom
    if uom != line.uom:
        raise stock.RuleError("uom", f"this line is in {line.uom}")
    product = line.product
    if task.type == "receive":
        _confirm_receive(db, task, line, product, qty, batch, to_location, container_id, actor, note, received_at)
    elif task.type in ("move", "replenish", "putaway"):
        _confirm_move(db, task, line, product, qty, batch, from_location, to_location, container_id, actor, reason, note)
    elif task.type in ("pick", "transfer_pick"):
        _confirm_pick(db, task, line, product, qty, batch, from_location, to_location, container_id, actor, reason, note)
    elif task.type == "count":
        _confirm_count(db, task, line, product, qty, actor, reason, note)
    else:
        raise TaskError("not_supported", f"{task.type} tasks arrive with a later build step")
    _finish(db, task)


def _confirm_receive(db, task, line, product, qty, batch, to_code, container_id, actor, note, received_at):
    to = _location(db, task, to_code, "location")
    if to is None:
        raise stock.RuleError("location", "say which shelf it went on")
    if line.batch and batch and batch != line.batch:
        raise stock.RuleError("batch", f"this line expects batch {line.batch}, not {batch}")
    batch = batch or line.batch
    if product.batch_tracked and not batch:
        raise stock.RuleError("batch", f"{product.sku} is batch tracked; scan the batch")
    if qty <= 0:
        raise stock.RuleError("qty", "received quantity must be above zero")
    stock.check_mixing(db, to, product, batch, field="location")
    total = (line.actual_qty or Decimal(0)) + qty
    settings = effective(_warehouse(db, task).settings)
    tolerance = Decimal(str(settings["receipt_tolerance_pct"])) / 100
    allowed = line.expected_qty * (1 + tolerance)
    if total > allowed and not actor.supervisor:
        raise NeedsSupervisor(
            f"{qstr(total)} {line.uom} is over the {settings['receipt_tolerance_pct']:g} % tolerance on "
            f"{qstr(line.expected_qty)}; a supervisor badge is needed")
    rows = post(db, [LedgerLine(
        product_id=product.id, location_id=to.id, qty_change=qty, uom=line.uom, batch=batch,
        owner=task.owner, container_id=container_id, movement_type="receipt", task_id=task.id,
        task_line_id=line.id, received_at=received_at or date.today(), actor=actor.name,
        device=actor.device, api_client_id=actor.api_client_id, external_ref=task.source_ref, note=note,
        reason="supervisor_override" if total > allowed else None,
    )])
    line.actual_qty = total
    line.batch = batch
    line.to_location_id = to.id
    if total >= line.expected_qty:
        line.status = "done"
        line.completed_at = datetime.now(UTC)
    emit(db, "receipt.confirmed", warehouse=_warehouse(db, task).code, owner=task.owner,
         external_ref=task.source_ref, data={
             "sku": product.sku, "batch": batch, "qty": qstr(qty), "uom": line.uom, "location": to.code,
             "receipt_ref": task.source_ref, "line": line.source_line or line.line_no,
             "operator": actor.name, "device": actor.device,
         })
    for fn in COMPLETION_HOOKS.get("receive.confirmed", []):
        fn(db, task, None)
    return rows


def _confirm_move(db, task, line, product, qty, batch, from_code, to_code, container_id, actor, reason, note):
    src = _location(db, task, from_code, "from_location") or line.from_location
    dst = _location(db, task, to_code, "to_location") or line.to_location
    if src is None:
        raise stock.RuleError("from_location", "say where it is coming from")
    if dst is None:
        raise stock.RuleError("to_location", "say where it is going")
    if src.id == dst.id:
        raise stock.RuleError("to_location", "that is the same shelf")
    if qty <= 0:
        raise stock.RuleError("qty", "quantity must be above zero")
    batch = batch or line.batch
    bal = stock.balance(db, src.id, product.id, batch, task.owner)
    if bal is None and batch is None:
        # untracked batch on a batch-tracked product: take the oldest batch there
        candidates = [b for b in stock.balances_at(db, src.id) if b.product_id == product.id and b.owner == task.owner]
        candidates.sort(key=lambda b: (b.received_at is None, b.received_at))
        bal = candidates[0] if candidates else None
        batch = bal.batch if bal else None
    available = (bal.on_hand - bal.reserved) if bal else Decimal(0)
    if qty > available:
        raise stock.RuleError("qty", f"only {qstr(available)} {line.uom} of {product.sku} available at {src.code}")
    stock.check_mixing(db, dst, product, batch)
    received_at = bal.received_at or date.today()
    common = dict(product_id=product.id, uom=line.uom, batch=batch, owner=task.owner, container_id=container_id,
                  movement_type="replenish" if task.type == "replenish" else task.type, task_id=task.id,
                  task_line_id=line.id, received_at=received_at, actor=actor.name, device=actor.device,
                  api_client_id=actor.api_client_id, external_ref=task.source_ref, reason=reason, note=note)
    post(db, [LedgerLine(location_id=src.id, qty_change=-qty, **common),
              LedgerLine(location_id=dst.id, qty_change=qty, **common)])
    line.actual_qty = (line.actual_qty or Decimal(0)) + qty
    line.batch = batch
    line.from_location_id = src.id
    line.to_location_id = dst.id
    line.reason = reason or line.reason
    if line.actual_qty >= line.expected_qty:
        line.status = "done"
        line.completed_at = datetime.now(UTC)
    if task.type == "move":
        emit(db, "stock.moved", warehouse=_warehouse(db, task).code, owner=task.owner, external_ref=task.source_ref,
             data={"sku": product.sku, "batch": batch, "qty": qstr(qty), "uom": line.uom, "from": src.code,
                   "to": dst.code, "reason": reason, "operator": actor.name})


def _confirm_pick(db, task, line, product, qty, batch, from_code, to_code, container_id, actor, reason, note):
    """Pick moves stock off the shelf to the staging area. It leaves the
    building at ship, so the ledger always knows where it is."""
    from wms.services import reservations

    src = _location(db, task, from_code, "from_location") or line.from_location
    dst = _location(db, task, to_code, "to_location") or line.to_location
    if src is None or dst is None:
        raise stock.RuleError("from_location", "this line has no shelf to pick from")
    if line.from_location_id and src.id != line.from_location_id:
        raise stock.RuleError("from_location", f"this line is at {line.from_location.code}, not {src.code}")
    if qty <= 0:
        raise stock.RuleError("qty", "picked quantity must be above zero")
    outstanding = line.expected_qty - (line.actual_qty or Decimal(0))
    if qty > outstanding:
        raise stock.RuleError("qty", f"this line wants {qstr(outstanding)} {line.uom} more, not {qstr(qty)}")
    batch = batch or line.batch
    bal = stock.balance(db, src.id, product.id, batch, task.owner)
    if bal is None or bal.on_hand < qty:
        raise stock.RuleError("qty", f"only {qstr(bal.on_hand if bal else Decimal(0))} {line.uom} of {product.sku} at {src.code}")
    received_at = bal.received_at or date.today()
    # the reservation is spent as the stock moves
    reservations.release(db, location_id=src.id, product_id=product.id, batch=batch,
                         owner=task.owner, qty=qty)
    common = dict(product_id=product.id, uom=line.uom, batch=batch, owner=task.owner,
                  container_id=container_id or line.container_id, movement_type="pick", task_id=task.id,
                  task_line_id=line.id, received_at=received_at, actor=actor.name, device=actor.device,
                  api_client_id=actor.api_client_id, external_ref=task.source_ref, reason=reason, note=note)
    post(db, [LedgerLine(location_id=src.id, qty_change=-qty, **common),
              LedgerLine(location_id=dst.id, qty_change=qty, **common)])
    line.actual_qty = (line.actual_qty or Decimal(0)) + qty
    line.batch = batch
    line.to_location_id = dst.id
    if line.actual_qty >= line.expected_qty:
        line.status = "done"
        line.completed_at = datetime.now(UTC)
    for fn in COMPLETION_HOOKS.get("pick.confirmed", []):
        fn(db, task, None)


# Short-pick reasons that mean the shelf quantity is wrong, so it gets counted.
COUNT_WORTHY = ("not_found", "short_on_shelf", "damaged")


def short_pick(db: Session, task: Task, line: TaskLine, *, qty: Decimal, reason: str, actor: Actor,
               note: str | None = None) -> None:
    """Take what is there and close the line short. Needs a supervisor badge,
    and raises a count task for that shelf when the quantity looks wrong."""
    from wms.services import reservations

    _must_be_open(task)
    if line.status in FINISHED_LINE:
        raise TaskError("line_finished", f"line {line.line_no} is already {line.status}")
    if task.type not in ("pick", "transfer_pick"):
        raise TaskError("not_supported", "only a pick line can be short")
    if not actor.supervisor:
        raise NeedsSupervisor("a short pick needs a supervisor badge")
    if not reason:
        raise stock.RuleError("reason", "say why it is short")
    if task.status == "waiting":
        start(db, task, actor)
    if qty > 0:
        _confirm_pick(db, task, line, line.product, qty, line.batch, None, None, None, actor, reason, note)
    reservations.release_line(db, line, task.owner)
    line.status = "short"
    line.reason = reason
    line.completed_at = datetime.now(UTC)
    db.flush()
    if reason in COUNT_WORTHY and line.from_location_id:
        _raise_count(db, task, line, reason)
    _finish(db, task, reason)


def _raise_count(db: Session, task: Task, line: TaskLine, reason: str) -> None:
    """A short pick means the shelf and the system disagree. Count it."""
    wh = _warehouse(db, task)
    count = create(db, type="count", warehouse=wh, owner=task.owner, source_type="short_pick",
                   created_by=task.assigned_to or "wms", priority="high",
                   note=f"Raised by a short pick on {task.source_ref} ({reason.replace('_', ' ')})",
                   lines=[LineSpec(product=line.product, expected_qty=Decimal(0), uom=line.uom,
                                   batch=line.batch, from_location=line.from_location)])
    count.source_ref = f"CNT-{count.id:04d}"
    db.flush()


def _confirm_count(db, task, line, product, counted, actor, reason, note):
    loc = line.from_location
    bal = stock.balance(db, loc.id, product.id, line.batch, task.owner)
    on_hand = bal.on_hand if bal else Decimal(0)
    line.expected_qty = on_hand  # what the shelf says right now
    line.actual_qty = counted
    line.note = note if hasattr(line, "note") else None
    if counted == on_hand:
        line.status = "done"
        line.completed_at = datetime.now(UTC)
        return
    if actor.supervisor and reason:
        line.status = "variance"
        approve_variance(db, task, line, reason=reason, note=note, actor=actor, finish=False)
        return
    line.status = "variance"
    line.reason = None


def approve_variance(db: Session, task: Task, line: TaskLine, *, reason: str, note: str | None,
                     actor: Actor, finish: bool = True) -> int:
    """A supervisor accepts the counted quantity: one adjustment ledger line and stock.adjusted."""
    _must_be_open(task)
    if line.status != "variance":
        raise TaskError("no_variance", f"line {line.line_no} has no variance to approve")
    loc = line.from_location
    product = line.product
    bal = stock.balance(db, loc.id, product.id, line.batch, task.owner)
    on_hand = bal.on_hand if bal else Decimal(0)
    change = line.actual_qty - on_hand
    if change == 0:
        line.status = "done"
        line.completed_at = datetime.now(UTC)
        if finish:
            _finish(db, task)
        return 0
    rows = post(db, [LedgerLine(
        product_id=product.id, location_id=loc.id, qty_change=change, uom=line.uom, batch=line.batch,
        owner=task.owner, movement_type="adjustment", reason=reason, task_id=task.id, task_line_id=line.id,
        received_at=(bal.received_at if bal and bal.received_at else date.today()), actor=actor.name,
        device=actor.device, api_client_id=actor.api_client_id, external_ref=task.source_ref, note=note,
    )])
    line.status = "done"
    line.reason = reason
    line.completed_at = datetime.now(UTC)
    emit(db, "stock.adjusted", warehouse=_warehouse(db, task).code, owner=task.owner, external_ref=task.source_ref,
         data={"sku": product.sku, "batch": line.batch, "location": loc.code, "qty_change": qstr(change),
               "uom": line.uom, "reason": reason, "ledger_id": str(rows[0].id), "approved_by": actor.supervisor or actor.name})
    if finish:
        _finish(db, task)
    return rows[0].id


def recount(db: Session, task: Task, line: TaskLine) -> None:
    _must_be_open(task)
    if line.status != "variance":
        raise TaskError("no_variance", f"line {line.line_no} is not waiting on a recount")
    line.status = "open"
    line.actual_qty = None
    _finish(db, task)
