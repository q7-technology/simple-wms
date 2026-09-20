"""Transfers between warehouses: one order, two legs."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, NotFound
from wms.api.routes.inbound import get_product, get_warehouse
from wms.api.schemas import Page, Qty
from wms.api.schemas_tasks import ActorFields, Priority, TaskOut, task_out
from wms.models import Location, Product, Task, Transfer, TransferLine, Warehouse
from wms.services import tasks as engine
from wms.services import transfers
from wms.services.stock import RuleError

router = APIRouter(tags=["transfers"])


class TransferLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    line: int = Field(ge=1)
    sku: str = Field(min_length=1, max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)


class TransferIn(envelope.Envelope):
    external_ref: str = Field(min_length=1, max_length=64)
    from_warehouse: str = Field(min_length=1, max_length=32)
    to_warehouse: str = Field(min_length=1, max_length=32)
    required_by: date | None = None
    priority: Priority = "normal"
    carrier_hint: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)
    lines: list[TransferLineIn] = Field(min_length=1)


class AllocationRow(BaseModel):
    line: int
    sku: str
    qty_requested: Qty
    qty_allocated: Qty
    uom: str
    short: Qty


class TransferAccepted(envelope.Accepted):
    allocation: list[AllocationRow]


class TransferLineOut(BaseModel):
    line: int
    sku: str
    name: str
    batch: str | None
    qty_requested: Qty
    qty_allocated: Qty
    qty_picked: Qty
    qty_shipped: Qty
    qty_received: Qty
    variance: Qty
    uom: str


class TransferOut(BaseModel):
    wms_id: str
    external_ref: str
    owner: str
    from_warehouse: str
    to_warehouse: str
    required_by: date | None
    priority: str
    carrier_hint: str | None
    carrier: str | None
    tracking_no: str | None
    status: str
    staging_location: str | None
    in_transit_location: str | None
    note: str | None
    variance_reason: str | None
    created_at: datetime
    allocated_at: datetime | None
    shipped_at: datetime | None
    received_at: datetime | None
    closed_at: datetime | None
    cancelled_at: datetime | None
    lines: list[TransferLineOut]
    pick_task: TaskOut | None
    receive_task: TaskOut | None


def transfer_out(db, t: Transfer, full: bool = True) -> TransferOut:
    from wms.api.routes.tasks import LOAD

    sender = db.get(Warehouse, t.from_warehouse_id)
    receiver = db.get(Warehouse, t.to_warehouse_id)

    def load(task_id: int | None, wh: Warehouse) -> TaskOut | None:
        if not task_id or not full:
            return None
        task = db.execute(select(Task).options(*LOAD).where(Task.id == task_id)).scalar_one_or_none()
        return task_out(task, wh.code) if task else None

    bench = db.get(Location, t.staging_location_id) if t.staging_location_id else None
    bucket = db.get(Location, t.in_transit_location_id) if t.in_transit_location_id else None
    return TransferOut(
        wms_id=str(t.id), external_ref=t.external_ref, owner=t.owner, from_warehouse=sender.code,
        to_warehouse=receiver.code, required_by=t.required_by, priority=t.priority,
        carrier_hint=t.carrier_hint, carrier=t.carrier, tracking_no=t.tracking_no, status=t.status,
        staging_location=bench.code if bench else None,
        in_transit_location=bucket.code if bucket else None, note=t.note,
        variance_reason=t.variance_reason, created_at=t.created_at, allocated_at=t.allocated_at,
        shipped_at=t.shipped_at, received_at=t.received_at, closed_at=t.closed_at,
        cancelled_at=t.cancelled_at,
        lines=[TransferLineOut(
            line=l.line_no, sku=db.get(Product, l.product_id).sku,
            name=db.get(Product, l.product_id).name, batch=l.batch, qty_requested=l.qty_requested,
            qty_allocated=l.qty_allocated, qty_picked=l.qty_picked, qty_shipped=l.qty_shipped,
            qty_received=l.qty_received, variance=l.qty_received - l.qty_shipped, uom=l.uom)
            for l in t.lines],
        pick_task=load(t.pick_task_id, sender), receive_task=load(t.receive_task_id, receiver),
    )


def get_transfer(db, ref: str, owner: str, who: Principal) -> tuple[Transfer, Warehouse, Warehouse]:
    t = db.execute(
        select(Transfer).options(selectinload(Transfer.lines))
        .where(Transfer.owner == owner, Transfer.external_ref == ref)
    ).scalar_one_or_none()
    if t is None:
        raise NotFound(f"no transfer {ref}")
    sender = db.get(Warehouse, t.from_warehouse_id)
    receiver = db.get(Warehouse, t.to_warehouse_id)
    if not (who.allows_warehouse(sender.code) or who.allows_warehouse(receiver.code)):
        from wms.api.errors import Forbidden
        raise Forbidden(f"you are not allowed either end of {ref}")
    authorise(who, warehouse=None, owner=owner)
    return t, sender, receiver


def _rules(fn):
    try:
        return fn()
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    except engine.TaskError as e:
        raise Conflict(e.code, e.message) from e


@router.post("/transfers", status_code=202, response_model=TransferAccepted)
def create_transfer(body: TransferIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    """Reserves at the sender and raises the first leg. The second leg opens
    when it ships."""
    authorise(who, warehouse=body.from_warehouse, owner=body.owner)

    def work():
        if body.from_warehouse == body.to_warehouse:
            raise FieldError("to_warehouse", "a transfer needs two different warehouses; use /v1/moves")
        sender = get_warehouse(db, body.from_warehouse, "from_warehouse")
        receiver = get_warehouse(db, body.to_warehouse, "to_warehouse")
        existing = db.execute(select(Transfer).where(
            Transfer.owner == body.owner, Transfer.external_ref == body.external_ref)).scalar_one_or_none()
        if existing is not None:
            raise FieldError("external_ref", f"transfer {body.external_ref} already exists (status {existing.status})")
        seen = set()
        transfer = Transfer(owner=body.owner, external_ref=body.external_ref, message_id=body.message_id,
                            from_warehouse_id=sender.id, to_warehouse_id=receiver.id,
                            required_by=body.required_by, priority=body.priority,
                            carrier_hint=body.carrier_hint, note=body.note)
        for i, l in enumerate(body.lines):
            if l.line in seen:
                raise FieldError(f"lines.{i}.line", f"line {l.line} repeats")
            seen.add(l.line)
            product = get_product(db, l.sku, body.owner, f"lines.{i}.sku")
            transfer.lines.append(TransferLine(
                line_no=l.line, product_id=product.id, batch=l.batch, qty_requested=l.qty,
                qty_allocated=Decimal(0), qty_picked=Decimal(0), qty_shipped=Decimal(0),
                qty_received=Decimal(0), uom=l.uom))
        db.add(transfer)
        db.flush()
        summary = _rules(lambda: transfers.allocate(db, transfer, sender, receiver, who.name))
        return TransferAccepted(message_id=body.message_id, wms_id=str(transfer.id), status="accepted",
                                allocation=[AllocationRow(**row) for row in summary])

    return envelope.handle(db, who, body.message_id, request.url.path, work)


@router.get("/transfers", response_model=Page[TransferOut])
def list_transfers(db: DB, warehouse: str = Query(), status: str | None = None, owner: str = "DEFAULT",
                   direction: str | None = None, limit: int = Query(default=200, le=2000),
                   offset: int = 0, who: Principal = require("tasks:read")):
    """Both ends see a transfer. `direction` narrows it to `out` or `in`."""
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    q = select(Transfer).options(selectinload(Transfer.lines)).where(Transfer.owner == owner)
    if direction == "out":
        q = q.where(Transfer.from_warehouse_id == wh.id)
    elif direction == "in":
        q = q.where(Transfer.to_warehouse_id == wh.id)
    else:
        q = q.where(or_(Transfer.from_warehouse_id == wh.id, Transfer.to_warehouse_id == wh.id))
    if status:
        q = q.where(Transfer.status.in_(status.split(",")))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(func.coalesce(Transfer.required_by, date.max).asc(),
                   engine.priority_order(Transfer.priority), Transfer.id)
        .limit(limit).offset(offset)
    ).scalars().all()
    return Page(items=[transfer_out(db, t, full=False) for t in rows], total=total)


@router.get("/transfers/{ref}", response_model=TransferOut)
def get_transfer_detail(ref: str, db: DB, owner: str = "DEFAULT", who: Principal = require("tasks:read")):
    t, _, _ = get_transfer(db, ref, owner, who)
    return transfer_out(db, t)


class ShipIn(ActorFields):
    carrier: str | None = Field(default=None, max_length=64)
    tracking_no: str | None = Field(default=None, max_length=64)
    shipped_by: str | None = Field(default=None, max_length=64)


@router.post("/transfers/{ref}/ship", status_code=202, response_model=envelope.Accepted)
def ship_transfer(ref: str, body: ShipIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    t, sender, receiver = get_transfer(db, ref, body.owner, who)

    def work():
        actor = engine.Actor(name=body.shipped_by or body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id)
        _rules(lambda: transfers.ship(db, t, sender, receiver, carrier=body.carrier,
                                      tracking_no=body.tracking_no, actor=actor))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(t.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work)


class CloseVarianceIn(ActorFields):
    reason: str = Field(min_length=1, max_length=64)
    note: str | None = Field(default=None, max_length=500)


@router.post("/transfers/{ref}/close-variance", status_code=202, response_model=envelope.Accepted)
def close_variance(ref: str, body: CloseVarianceIn, request: Request, db: DB,
                   who: Principal = require("tasks:write")):
    """Whatever never turned up is written off the bucket, with a reason."""
    t, _, receiver = get_transfer(db, ref, body.owner, who)

    def work():
        actor = engine.Actor(name=body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id)
        _rules(lambda: transfers.close_variance(db, t, receiver, reason=body.reason, note=body.note,
                                                actor=actor))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(t.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work)


class CancelTransferIn(ActorFields):
    reason: str | None = Field(default=None, max_length=200)


@router.post("/transfers/{ref}/cancel", status_code=202, response_model=envelope.Accepted)
def cancel_transfer(ref: str, body: CancelTransferIn, request: Request, db: DB,
                    who: Principal = require("tasks:write")):
    t, _, _ = get_transfer(db, ref, body.owner, who)

    def work():
        actor = engine.Actor(name=body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id)
        _rules(lambda: transfers.cancel(db, t, body.reason, actor))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(t.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work)
