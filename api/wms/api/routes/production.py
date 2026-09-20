"""Production orders: issue the components, take the finished goods back."""
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
from wms.api.routes.inbound import get_location, get_product, get_warehouse
from wms.api.schemas import Page, Qty
from wms.api.schemas_tasks import ActorFields, Priority, TaskOut, task_out
from wms.models import Location, Product, ProductionComponent, ProductionOrder, Task, Warehouse
from wms.services import access, production
from wms.services import tasks as engine
from wms.services.stock import RuleError

router = APIRouter(tags=["production"])


class OutputIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    sku: str = Field(min_length=1, max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)


class ComponentIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    line: int = Field(ge=1)
    sku: str = Field(min_length=1, max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)
    deliver_to: str = Field(min_length=1, max_length=64)


class ProductionOrderIn(envelope.Envelope):
    external_ref: str = Field(min_length=1, max_length=64)
    warehouse: str = Field(min_length=1, max_length=32)
    required_by: datetime | None = None
    priority: Priority = "normal"
    note: str | None = Field(default=None, max_length=500)
    output: OutputIn
    components: list[ComponentIn] = Field(min_length=1)


class AllocationRow(BaseModel):
    line: int
    sku: str
    qty_requested: Qty
    qty_allocated: Qty
    uom: str
    short: Qty


class ProductionAccepted(envelope.Accepted):
    allocation: list[AllocationRow]


class OutputOut(BaseModel):
    sku: str
    name: str
    batch: str | None
    qty: Qty
    qty_received: Qty
    uom: str


class ComponentOut(BaseModel):
    line: int
    sku: str
    name: str
    batch: str | None
    qty_requested: Qty
    qty_issued: Qty
    short: Qty
    uom: str
    deliver_to: str


class ReceiptOut(BaseModel):
    wms_id: str
    sku: str
    batch: str | None
    qty: Qty
    uom: str
    location: str
    container_id: str | None
    operator: str | None
    device: str | None
    supervisor: str | None
    event_sent: bool
    created_at: datetime


class ProductionOrderOut(BaseModel):
    wms_id: str
    external_ref: str
    owner: str
    warehouse: str
    required_by: datetime | None
    priority: str
    status: str
    note: str | None
    created_at: datetime
    issued_at: datetime | None
    completed_at: datetime | None
    cancelled_at: datetime | None
    output: OutputOut
    components: list[ComponentOut]
    receipts: list[ReceiptOut]
    issue_task: TaskOut | None


def order_out(db, o: ProductionOrder, full: bool = True) -> ProductionOrderOut:
    from wms.api.routes.tasks import LOAD

    wh = db.get(Warehouse, o.warehouse_id)
    output = db.get(Product, o.output_product_id)
    task = None
    if full and o.issue_task_id:
        row = db.execute(select(Task).options(*LOAD).where(Task.id == o.issue_task_id)).scalar_one_or_none()
        task = task_out(row, wh.code) if row else None
    return ProductionOrderOut(
        wms_id=str(o.id), external_ref=o.external_ref, owner=o.owner, warehouse=wh.code,
        required_by=o.required_by, priority=o.priority, status=o.status, note=o.note,
        created_at=o.created_at, issued_at=o.issued_at, completed_at=o.completed_at,
        cancelled_at=o.cancelled_at,
        output=OutputOut(sku=output.sku, name=output.name, batch=o.output_batch, qty=o.output_qty,
                         qty_received=o.output_received, uom=o.output_uom),
        components=[ComponentOut(
            line=c.line_no, sku=db.get(Product, c.product_id).sku,
            name=db.get(Product, c.product_id).name, batch=c.batch, qty_requested=c.qty_requested,
            qty_issued=c.qty_issued, short=max(Decimal(0), c.qty_requested - c.qty_issued),
            uom=c.uom, deliver_to=db.get(Location, c.deliver_to_id).code) for c in o.components],
        receipts=[ReceiptOut(
            wms_id=str(r.id), sku=db.get(Product, r.product_id).sku, batch=r.batch, qty=r.qty,
            uom=r.uom, location=db.get(Location, r.location_id).code, container_id=r.container_id,
            operator=r.operator, device=r.device, supervisor=r.supervisor, event_sent=r.event_sent,
            created_at=r.created_at) for r in o.receipts] if full else [],
        issue_task=task,
    )


def get_order(db, ref: str, owner: str, who: Principal) -> tuple[ProductionOrder, Warehouse]:
    o = db.execute(
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.components), selectinload(ProductionOrder.receipts))
        .where(ProductionOrder.owner == owner, ProductionOrder.external_ref == ref)
    ).scalar_one_or_none()
    if o is None:
        raise NotFound(f"no production order {ref}")
    wh = db.get(Warehouse, o.warehouse_id)
    authorise(who, warehouse=wh.code, owner=owner)
    return o, wh


def _rules(fn):
    try:
        return fn()
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    except engine.TaskError as e:
        raise Conflict(e.code, e.message) from e


@router.post("/production-orders", status_code=202, response_model=ProductionAccepted)
def create_order(body: ProductionOrderIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    """Reserves the components and raises the issue task. The last step of
    that task is to drop them at the line."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        wh = get_warehouse(db, body.warehouse)
        existing = db.execute(select(ProductionOrder).where(
            ProductionOrder.owner == body.owner,
            ProductionOrder.external_ref == body.external_ref)).scalar_one_or_none()
        if existing is not None:
            raise FieldError("external_ref",
                             f"production order {body.external_ref} already exists (status {existing.status})")
        output = get_product(db, body.output.sku, body.owner, "output.sku")
        order = ProductionOrder(
            owner=body.owner, external_ref=body.external_ref, message_id=body.message_id,
            warehouse_id=wh.id, required_by=body.required_by, priority=body.priority,
            output_product_id=output.id, output_batch=body.output.batch, output_qty=body.output.qty,
            output_received=Decimal(0), output_uom=body.output.uom, note=body.note)
        seen = set()
        for i, c in enumerate(body.components):
            if c.line in seen:
                raise FieldError(f"components.{i}.line", f"line {c.line} repeats")
            seen.add(c.line)
            product = get_product(db, c.sku, body.owner, f"components.{i}.sku")
            deliver_to = get_location(db, wh, c.deliver_to, f"components.{i}.deliver_to")
            order.components.append(ProductionComponent(
                line_no=c.line, product_id=product.id, batch=c.batch, qty_requested=c.qty,
                qty_issued=Decimal(0), uom=c.uom, deliver_to_id=deliver_to.id))
        db.add(order)
        db.flush()
        summary = _rules(lambda: production.allocate(db, order, wh, who.name))
        return ProductionAccepted(message_id=body.message_id, wms_id=str(order.id),
                                  status="accepted",
                                  allocation=[AllocationRow(**row) for row in summary])

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/production-orders", response_model=Page[ProductionOrderOut])
def list_orders(db: DB, warehouse: str = Query(), status: str | None = None, owner: str = "DEFAULT",
                limit: int = Query(default=200, le=2000), offset: int = 0,
                who: Principal = require("tasks:read")):
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    q = (select(ProductionOrder).options(selectinload(ProductionOrder.components))
         .where(ProductionOrder.warehouse_id == wh.id, ProductionOrder.owner == owner))
    if status:
        q = q.where(ProductionOrder.status.in_(status.split(",")))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(func.coalesce(ProductionOrder.required_by, func.now()).asc(),
                   engine.priority_order(ProductionOrder.priority), ProductionOrder.id)
        .limit(limit).offset(offset)
    ).scalars().all()
    return Page(items=[order_out(db, o, full=False) for o in rows], total=total)


@router.get("/production-orders/{ref}", response_model=ProductionOrderOut)
def get_order_detail(ref: str, db: DB, owner: str = "DEFAULT", who: Principal = require("tasks:read")):
    o, _ = get_order(db, ref, owner, who)
    return order_out(db, o)


class ProductionReceiptIn(ActorFields):
    warehouse: str | None = Field(default=None, max_length=32)
    sku: str = Field(min_length=1, max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)
    to_location: str = Field(min_length=1, max_length=64)
    container_id: str | None = Field(default=None, max_length=64)
    device_id: str | None = Field(default=None, max_length=64)
    supervisor_badge: str | None = Field(default=None, max_length=128)


class ProductionReceiptAccepted(envelope.Accepted):
    received_total: Qty
    expected: Qty
    complete: bool
    event_sent: bool


@router.post("/production-orders/{ref}/receipts", status_code=202,
             response_model=ProductionReceiptAccepted)
def receive_finished_goods(ref: str, body: ProductionReceiptIn, request: Request, db: DB,
                           who: Principal = require("tasks:write")):
    """One call per pallet. The running total is kept against the order."""
    o, wh = get_order(db, ref, body.owner, who)

    def work():
        product = get_product(db, body.sku, body.owner, "sku")
        location = get_location(db, wh, body.to_location, "to_location")
        supervisor = None
        if body.supervisor_badge:
            op = access.find_supervisor_by_badge(db, body.supervisor_badge, wh.code)
            if op is None:
                raise Forbidden("that badge is not a supervisor for this warehouse")
            supervisor = op.code
        actor = engine.Actor(name=body.operator or who.name, device=body.device_id or body.device,
                             api_client_id=who.api_client_id, supervisor=supervisor)
        receipt = _rules(lambda: production.receive(
            db, o, wh, product=product, batch=body.batch, qty=body.qty, uom=body.uom,
            location=location, container_id=body.container_id, actor=actor,
            message_id=body.message_id))
        return ProductionReceiptAccepted(
            message_id=body.message_id, wms_id=str(receipt.id), status="accepted",
            received_total=o.output_received, expected=o.output_qty,
            complete=o.status == "complete", event_sent=receipt.event_sent)

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


class CancelOrderIn(ActorFields):
    reason: str | None = Field(default=None, max_length=200)


@router.post("/production-orders/{ref}/cancel", status_code=202, response_model=envelope.Accepted)
def cancel_order(ref: str, body: CancelOrderIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    o, _ = get_order(db, ref, body.owner, who)

    def work():
        actor = engine.Actor(name=body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id)
        _rules(lambda: production.cancel(db, o, body.reason, actor))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(o.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)
