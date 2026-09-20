"""Batch picking: one walk for several orders, sorted into totes."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, Forbidden, NotFound
from wms.api.routes.inbound import get_warehouse
from wms.api.schemas import Page, Qty
from wms.api.schemas_tasks import ActorFields
from wms.models import Delivery, PickBatch, Warehouse
from wms.services import access, batch_pick
from wms.services import tasks as engine
from wms.services.stock import RuleError

router = APIRouter(tags=["batch picking"])


class BatchIn(envelope.Envelope):
    warehouse: str = Field(min_length=1, max_length=32)
    deliveries: list[str] = Field(min_length=1, max_length=50)
    assigned_to: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)


class ToteOut(BaseModel):
    tote: str
    delivery: str
    ship_to: str | None
    status: str
    lines: int


class PickOut(BaseModel):
    tote: str
    delivery: str
    qty: Qty


class StopOut(BaseModel):
    stop: int
    location: str
    zone: str
    pick_sequence: int
    sku: str
    name: str
    batch: str | None
    qty: Qty
    uom: str
    picks: list[PickOut]


class BatchOut(BaseModel):
    wms_id: str
    external_ref: str
    owner: str
    warehouse: str
    status: str
    assigned_to: str | None
    note: str | None
    created_by: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    cancelled_at: datetime | None
    orders: int
    lines: int
    stops: list[StopOut]
    done_stops: int
    totes: list[ToteOut]


def batch_out(db, b: PickBatch, full: bool = True) -> BatchOut:
    from wms.models import Task

    wh = db.get(Warehouse, b.warehouse_id)
    totes = []
    lines = 0
    for m in b.members:
        delivery = db.get(Delivery, m.delivery_id)
        task = db.get(Task, m.task_id)
        lines += len(task.lines) if task else 0
        totes.append(ToteOut(tote=m.tote, delivery=delivery.external_ref,
                             ship_to=(delivery.ship_to or {}).get("name"),
                             status=delivery.status, lines=len(task.lines) if task else 0))
    left = batch_pick.stops(db, b) if full else []
    return BatchOut(
        wms_id=b.external_ref, external_ref=b.external_ref, owner=b.owner, warehouse=wh.code,
        status=b.status, assigned_to=b.assigned_to, note=b.note, created_by=b.created_by,
        created_at=b.created_at, started_at=b.started_at, completed_at=b.completed_at,
        cancelled_at=b.cancelled_at, orders=len(b.members), lines=lines,
        stops=[StopOut(
            stop=i + 1, location=s.location.code, zone=s.zone, pick_sequence=s.location.pick_sequence,
            sku=s.product.sku, name=s.product.name, batch=s.batch, qty=s.qty, uom=s.uom,
            picks=[PickOut(tote=p.tote, delivery=p.delivery, qty=p.qty) for p in s.picks])
            for i, s in enumerate(left)],
        done_stops=0 if not full else max(0, _total_stops(db, b) - len(left)),
        totes=totes,
    )


def _total_stops(db, b: PickBatch) -> int:
    """Every distinct shelf and product this batch ever had to visit."""
    from wms.models import Task

    keys = set()
    for m in b.members:
        task = db.get(Task, m.task_id)
        for l in (task.lines if task else []):
            if l.from_location_id and l.status != "cancelled":
                keys.add((l.from_location_id, l.product_id, l.batch))
    return len(keys)


def get_batch(db, ref: str, owner: str, who: Principal) -> tuple[PickBatch, Warehouse]:
    b = db.execute(
        select(PickBatch).options(selectinload(PickBatch.members))
        .where(PickBatch.owner == owner, PickBatch.external_ref == ref)
    ).scalar_one_or_none()
    if b is None:
        raise NotFound(f"no pick batch {ref}")
    wh = db.get(Warehouse, b.warehouse_id)
    authorise(who, warehouse=wh.code, owner=owner)
    return b, wh


def _rules(fn):
    try:
        return fn()
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    except engine.TaskError as e:
        raise Conflict(e.code, e.message) from e


@router.post("/pick-batches", status_code=202, response_model=envelope.Accepted)
def create_batch(body: BatchIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    """Group waiting orders into one walk. Each keeps its own task and its own
    reservations; the batch only decides the order of the walk and the totes."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        wh = get_warehouse(db, body.warehouse)
        deliveries = []
        seen = set()
        for i, ref in enumerate(body.deliveries):
            if ref in seen:
                raise FieldError(f"deliveries.{i}", f"{ref} is listed twice")
            seen.add(ref)
            d = db.execute(select(Delivery).where(
                Delivery.owner == body.owner, Delivery.external_ref == ref)).scalar_one_or_none()
            if d is None or d.warehouse_id != wh.id:
                raise FieldError(f"deliveries.{i}", f"no delivery {ref} in {wh.code}")
            deliveries.append(d)
        batch = _rules(lambda: batch_pick.build(
            db, warehouse=wh, owner=body.owner, deliveries=deliveries,
            assigned_to=body.assigned_to, created_by=who.name, note=body.note))
        return envelope.Accepted(message_id=body.message_id, wms_id=batch.external_ref,
                                 status="created")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/pick-batches", response_model=Page[BatchOut])
def list_batches(db: DB, warehouse: str = Query(), status: str | None = None, owner: str = "DEFAULT",
                 assigned_to: str | None = None, limit: int = Query(default=100, le=1000),
                 offset: int = 0, who: Principal = require("tasks:read")):
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    q = (select(PickBatch).options(selectinload(PickBatch.members))
         .where(PickBatch.warehouse_id == wh.id, PickBatch.owner == owner))
    if status:
        q = q.where(PickBatch.status.in_(status.split(",")))
    if assigned_to:
        q = q.where(PickBatch.assigned_to == assigned_to)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(PickBatch.id).limit(limit).offset(offset)).scalars().all()
    return Page(items=[batch_out(db, b, full=False) for b in rows], total=total)


class SuggestGroup(BaseModel):
    zone: str
    deliveries: list[str]
    orders: int
    lines: int
    stops: int
    saved: int


class SuggestOut(BaseModel):
    groups: list[SuggestGroup]
    max_orders: int


@router.get("/pick-batches/suggest", response_model=SuggestOut)
def suggest_batches(db: DB, warehouse: str = Query(), owner: str = "DEFAULT",
                    who: Principal = require("tasks:read")):
    """Waiting orders worth walking together, and how many stops it saves."""
    from wms.services.settings import effective

    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    groups = batch_pick.suggest(db, wh, owner)
    return SuggestOut(groups=[SuggestGroup(**g) for g in groups],
                      max_orders=effective(wh.settings)["batch_pick_max_orders"])


@router.get("/pick-batches/{ref}", response_model=BatchOut)
def get_batch_detail(ref: str, db: DB, owner: str = "DEFAULT", who: Principal = require("tasks:read")):
    b, _ = get_batch(db, ref, owner, who)
    return batch_out(db, b)


class StopPickIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    tote: str = Field(min_length=1, max_length=16)
    qty: Decimal = Field(ge=0)


class ConfirmStopIn(ActorFields):
    picks: list[StopPickIn] | None = None
    reason: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)
    supervisor_badge: str | None = Field(default=None, max_length=128)


class StopConfirmed(envelope.Accepted):
    picked: Qty
    picks: list[PickOut]
    batch_status: str
    stops_left: int


@router.post("/pick-batches/{ref}/stops/{index}/confirm", status_code=202,
             response_model=StopConfirmed)
def confirm_stop(ref: str, index: int, body: ConfirmStopIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    """One shelf, every tote that wants it. A tote that gets less than it asked
    for is short, which needs a reason and a supervisor badge."""
    b, wh = get_batch(db, ref, body.owner, who)

    def work():
        current = batch_pick.stops(db, b)
        if index < 1 or index > len(current):
            raise NotFound(f"{ref} has no stop {index}")
        stop = current[index - 1]
        supervisor = None
        if body.supervisor_badge:
            op = access.find_supervisor_by_badge(db, body.supervisor_badge, wh.code)
            if op is None:
                raise Forbidden("that badge is not a supervisor for this warehouse")
            supervisor = op.code
        actor = engine.Actor(name=body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id, supervisor=supervisor)
        picks = {p.tote: p.qty for p in body.picks} if body.picks is not None else None
        done = _rules(lambda: batch_pick.confirm_stop(
            db, b, stop, picks=picks, actor=actor, reason=body.reason, note=body.note))
        left = batch_pick.stops(db, b)
        return StopConfirmed(
            message_id=body.message_id, wms_id=b.external_ref, status="accepted",
            picked=sum((p.qty for p in done), Decimal(0)),
            picks=[PickOut(tote=p.tote, delivery=p.delivery, qty=p.qty) for p in done],
            batch_status=b.status, stops_left=len(left))

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


class CancelBatchIn(ActorFields):
    reason: str | None = Field(default=None, max_length=200)


@router.post("/pick-batches/{ref}/cancel", status_code=202, response_model=envelope.Accepted)
def cancel_batch(ref: str, body: CancelBatchIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    """Only the grouping goes. Every order keeps its task and its stock."""
    b, _ = get_batch(db, ref, body.owner, who)

    def work():
        _rules(lambda: batch_pick.cancel(db, b, body.reason))
        return envelope.Accepted(message_id=body.message_id, wms_id=b.external_ref, status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)
