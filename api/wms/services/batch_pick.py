"""Batch picking: one walk for several orders.

Each order keeps its own pick task, its own reservations and its own ledger
lines, so nothing about a delivery changes because it was picked with others.
The batch is a view over those tasks: stops collapse into one walk, and a
tote keeps each order's items apart as they come off the shelf."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from wms.models import (
    Delivery, Location, PickBatch, PickBatchMember, Product, Task, TaskLine, Warehouse, Zone,
)
from wms.services import tasks
from wms.services.qty import qstr
from wms.services.settings import effective
from wms.services.stock import RuleError

OPEN_LINE = ("open",)


@dataclass(slots=True)
class Pick:
    tote: str
    delivery: str
    task_id: int
    line_no: int
    qty: Decimal


@dataclass(slots=True)
class Stop:
    location: Location
    zone: str
    product: Product
    batch: str | None
    uom: str
    picks: list[Pick] = field(default_factory=list)

    @property
    def qty(self) -> Decimal:
        return sum((p.qty for p in self.picks), Decimal(0))


def member_tasks(db: Session, batch: PickBatch) -> dict[int, PickBatchMember]:
    return {m.task_id: m for m in batch.members}


def stops(db: Session, batch: PickBatch) -> list[Stop]:
    """The walk that is left: one stop per shelf, product and batch, in pick
    sequence, with the split per tote."""
    by_task = member_tasks(db, batch)
    refs = {m.task_id: db.get(Delivery, m.delivery_id).external_ref for m in batch.members}
    rows = db.execute(
        select(TaskLine, Task).join(Task, Task.id == TaskLine.task_id)
        .options(selectinload(TaskLine.from_location).selectinload(Location.zone),
                 selectinload(TaskLine.product))
        .where(Task.id.in_(by_task.keys()), TaskLine.status.in_(OPEN_LINE),
               Task.status.in_(("waiting", "in_progress")))
    ).all()

    grouped: dict[tuple[int, int, str | None], Stop] = {}
    for line, task in rows:
        if line.from_location is None:
            continue
        key = (line.from_location_id, line.product_id, line.batch)
        stop = grouped.get(key)
        if stop is None:
            stop = Stop(location=line.from_location, zone=line.from_location.zone.code,
                        product=line.product, batch=line.batch, uom=line.uom)
            grouped[key] = stop
        member = by_task[task.id]
        outstanding = line.expected_qty - (line.actual_qty or Decimal(0))
        if outstanding <= 0:
            continue
        stop.picks.append(Pick(tote=member.tote, delivery=refs[task.id], task_id=task.id,
                               line_no=line.line_no, qty=outstanding))
    out = sorted(grouped.values(), key=lambda s: (s.location.pick_sequence, s.location.code,
                                                  s.product.sku, s.batch or ""))
    for stop in out:
        stop.picks.sort(key=lambda p: p.tote)
    return [s for s in out if s.picks]


def next_tote(existing: list[str]) -> str:
    numbers = [int(t) for t in existing if t.isdigit()]
    return str(max(numbers, default=0) + 1)


def build(db: Session, *, warehouse: Warehouse, owner: str, deliveries: list[Delivery],
          assigned_to: str | None, created_by: str, note: str | None = None) -> PickBatch:
    settings = effective(warehouse.settings)
    limit = settings["batch_pick_max_orders"]
    if len(deliveries) > limit:
        raise RuleError("deliveries", f"this warehouse batches at most {limit} orders at a time")

    batch = PickBatch(owner=owner, external_ref="", warehouse_id=warehouse.id, status="new",
                      assigned_to=assigned_to, created_by=created_by, note=note)
    db.add(batch)
    db.flush()
    batch.external_ref = f"BP-{batch.id:04d}"

    totes: list[str] = []
    for i, delivery in enumerate(deliveries):
        task = db.get(Task, delivery.pick_task_id) if delivery.pick_task_id else None
        if task is None:
            raise RuleError(f"deliveries.{i}", f"{delivery.external_ref} has no pick task")
        if task.status not in ("waiting",):
            raise RuleError(f"deliveries.{i}",
                            f"{delivery.external_ref} is already picking; a batch takes orders that have not started")
        already = db.execute(
            select(PickBatchMember).join(PickBatch)
            .where(PickBatchMember.delivery_id == delivery.id,
                   PickBatch.status.in_(("new", "picking", "picked")))
        ).scalars().first()
        if already is not None:
            raise RuleError(f"deliveries.{i}", f"{delivery.external_ref} is already in a batch")
        tote = next_tote(totes)
        totes.append(tote)
        batch.members.append(PickBatchMember(delivery_id=delivery.id, task_id=task.id, tote=tote))
        task.assigned_to = assigned_to or task.assigned_to
        task.note = f"{task.note or delivery.external_ref} · batch {batch.external_ref} tote {tote}"
    db.flush()
    return batch


def confirm_stop(db: Session, batch: PickBatch, stop: Stop, *, picks: dict[str, Decimal] | None,
                 actor: tasks.Actor, reason: str | None, note: str | None) -> list[Pick]:
    """Pick one shelf for every tote that wants it. A tote that gets less than
    it asked for is short, which needs a reason and a supervisor badge."""
    wanted = {p.tote: p for p in stop.picks}
    if picks is not None:
        for i, tote in enumerate(picks):
            if tote not in wanted:
                raise RuleError(f"picks.{i}.tote", f"tote {tote} wants nothing from {stop.location.code}")
            if picks[tote] > wanted[tote].qty:
                raise RuleError(f"picks.{i}.qty",
                                f"tote {tote} wants {qstr(wanted[tote].qty)} {stop.uom} here, not {qstr(picks[tote])}")

    done: list[Pick] = []
    for pick in stop.picks:
        qty = wanted[pick.tote].qty if picks is None else picks.get(pick.tote, Decimal(0))
        task = db.get(Task, pick.task_id)
        line = next(l for l in task.lines if l.line_no == pick.line_no)
        if qty > 0:
            tasks.confirm(db, task, line, qty=qty, uom=stop.uom, actor=actor, note=note)
        if qty < pick.qty:
            if not reason:
                raise RuleError("reason", f"tote {pick.tote} is short; say why")
            tasks.short_pick(db, task, line, qty=Decimal(0), reason=reason, actor=actor, note=note)
        done.append(Pick(tote=pick.tote, delivery=pick.delivery, task_id=pick.task_id,
                         line_no=pick.line_no, qty=qty))

    if batch.status == "new":
        batch.status = "picking"
        batch.started_at = datetime.now(UTC)
    db.flush()
    if not stops(db, batch):
        batch.status = "picked"
        batch.completed_at = datetime.now(UTC)
    db.flush()
    return done


def cancel(db: Session, batch: PickBatch, reason: str | None) -> None:
    """The orders keep their own tasks and reservations; only the grouping goes."""
    if batch.status in ("picked", "cancelled"):
        raise tasks.TaskError("not_open", f"{batch.external_ref} is {batch.status}")
    batch.status = "cancelled"
    batch.cancelled_at = datetime.now(UTC)
    batch.note = reason or batch.note
    db.flush()


def suggest(db: Session, warehouse: Warehouse, owner: str) -> list[dict]:
    """Waiting orders that want batching, grouped by the zone they mostly sit
    in. Fewer stops than lines is the whole point."""
    settings = effective(warehouse.settings)
    limit = settings["batch_pick_max_orders"]
    candidates = db.execute(
        select(Delivery).options(selectinload(Delivery.lines))
        .where(Delivery.warehouse_id == warehouse.id, Delivery.owner == owner,
               Delivery.status == "allocated", Delivery.pick_mode.in_(("batch", "auto")))
        .order_by(Delivery.id)
    ).scalars().all()

    in_a_batch = {
        m.delivery_id for m in db.execute(
            select(PickBatchMember).join(PickBatch)
            .where(PickBatch.status.in_(("new", "picking", "picked")))
        ).scalars()
    }

    by_zone: dict[str, list[tuple[Delivery, list[TaskLine]]]] = {}
    for delivery in candidates:
        if delivery.id in in_a_batch or not delivery.pick_task_id:
            continue
        task = db.get(Task, delivery.pick_task_id)
        if task is None or task.status != "waiting":
            continue
        lines = list(task.lines)
        if not lines:
            continue
        zones: dict[str, int] = {}
        for l in lines:
            if l.from_location is None:
                continue
            code = db.get(Zone, l.from_location.zone_id).code
            zones[code] = zones.get(code, 0) + 1
        if not zones:
            continue
        main = max(zones, key=lambda z: zones[z])
        by_zone.setdefault(main, []).append((delivery, lines))

    groups: list[dict] = []
    for zone, members in by_zone.items():
        for chunk_start in range(0, len(members), limit):
            chunk = members[chunk_start:chunk_start + limit]
            if len(chunk) < 2:
                continue
            line_count = sum(len(lines) for _, lines in chunk)
            stop_keys = {(l.from_location_id, l.product_id, l.batch)
                         for _, lines in chunk for l in lines}
            groups.append({
                "zone": zone,
                "deliveries": [d.external_ref for d, _ in chunk],
                "orders": len(chunk),
                "lines": line_count,
                "stops": len(stop_keys),
                "saved": line_count - len(stop_keys),
            })
    groups.sort(key=lambda g: (-g["saved"], g["zone"]))
    return groups
