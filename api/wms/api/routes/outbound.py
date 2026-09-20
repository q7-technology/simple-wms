"""Deliveries: the pick order and everything that happens to it."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, NotFound
from wms.api.schemas import Page, Qty
from wms.api.schemas_tasks import ActorFields, Priority, TaskOut, task_out
from wms.api.routes.inbound import get_product, get_warehouse
from wms.models import Delivery, DeliveryLine, Package, PackageLine, Product, Task, Warehouse
from wms.services import outbound
from wms.services import tasks as engine
from wms.services.qty import qstr
from wms.services.stock import RuleError

router = APIRouter(tags=["outbound"])


class ShipTo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(max_length=200)
    address: str | None = Field(default=None, max_length=200)
    suburb: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=32)
    postcode: str | None = Field(default=None, max_length=16)
    country: str | None = Field(default=None, max_length=32)
    contact: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=200)


class DeliveryLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    delivery_line: int = Field(ge=1)
    sku: str = Field(min_length=1, max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)


class DeliveryIn(envelope.Envelope):
    external_ref: str = Field(min_length=1, max_length=64)
    warehouse: str = Field(min_length=1, max_length=32)
    pick_mode: Literal["single", "batch", "auto"] = "single"
    priority: Priority = "normal"
    required_by: date | None = None
    ship_to: ShipTo
    carrier_hint: str | None = Field(default=None, max_length=64)
    allow_short: bool = True
    note: str | None = Field(default=None, max_length=500)
    lines: list[DeliveryLineIn] = Field(min_length=1)


class AllocationRow(BaseModel):
    delivery_line: int
    sku: str
    qty_ordered: Qty
    qty_allocated: Qty
    uom: str
    short: Qty


class DeliveryAccepted(envelope.Accepted):
    allocation: list[AllocationRow]


class DeliveryLineOut(BaseModel):
    delivery_line: int
    sku: str
    name: str
    batch: str | None
    qty_ordered: Qty
    qty_allocated: Qty
    qty_picked: Qty
    qty_shipped: Qty
    uom: str
    short_reason: str | None


class PackageLineOut(BaseModel):
    delivery_line: int
    sku: str
    batch: str | None
    qty: Qty
    uom: str


class PackageOut(BaseModel):
    package_no: int
    type: str
    container_id: str | None
    sscc: str | None
    weight_kg: Qty | None
    length_cm: Qty | None
    width_cm: Qty | None
    height_cm: Qty | None
    packed_by: str | None
    created_at: datetime
    lines: list[PackageLineOut]


class EventSummary(BaseModel):
    event_type: str
    subscriber: str
    status: str
    at: datetime


class DeliveryOut(BaseModel):
    wms_id: str
    external_ref: str
    owner: str
    warehouse: str
    pick_mode: str
    priority: str
    required_by: date | None
    ship_to: dict
    carrier_hint: str | None
    carrier: str | None
    tracking_no: str | None
    allow_short: bool
    status: str
    short: bool
    staging_location: str | None
    note: str | None
    created_at: datetime
    allocated_at: datetime | None
    picked_at: datetime | None
    packed_at: datetime | None
    shipped_at: datetime | None
    cancelled_at: datetime | None
    lines: list[DeliveryLineOut]
    packages: list[PackageOut]
    task: TaskOut | None
    pack_task: TaskOut | None
    events: list[EventSummary]


def delivery_out(db, d: Delivery, wh: Warehouse, full: bool = True) -> DeliveryOut:
    from wms.api.routes.tasks import LOAD
    from wms.models import Location, OutboundEvent

    def load_task(task_id: int | None) -> TaskOut | None:
        if not task_id:
            return None
        t = db.execute(select(Task).options(*LOAD).where(Task.id == task_id)).scalar_one_or_none()
        return task_out(t, wh.code) if t else None

    events: list[EventSummary] = []
    if full:
        rows = db.execute(
            select(OutboundEvent).options(selectinload(OutboundEvent.subscriber))
            .where(OutboundEvent.external_ref == d.external_ref, OutboundEvent.event_type.like("delivery.%"))
            .order_by(OutboundEvent.id)
        ).scalars().all()
        events = [EventSummary(event_type=e.event_type, subscriber=e.subscriber.name, status=e.status,
                               at=e.delivered_at or e.occurred_at) for e in rows]
    staging = db.get(Location, d.staging_location_id) if d.staging_location_id else None
    return DeliveryOut(
        wms_id=str(d.id), external_ref=d.external_ref, owner=d.owner, warehouse=wh.code,
        pick_mode=d.pick_mode, priority=d.priority, required_by=d.required_by, ship_to=d.ship_to or {},
        carrier_hint=d.carrier_hint, carrier=d.carrier, tracking_no=d.tracking_no,
        allow_short=d.allow_short, status=d.status, short=d.short,
        staging_location=staging.code if staging else None, note=d.note, created_at=d.created_at,
        allocated_at=d.allocated_at, picked_at=d.picked_at, packed_at=d.packed_at,
        shipped_at=d.shipped_at, cancelled_at=d.cancelled_at,
        lines=[DeliveryLineOut(
            delivery_line=l.line_no, sku=db.get(Product, l.product_id).sku,
            name=db.get(Product, l.product_id).name, batch=l.batch, qty_ordered=l.qty_ordered,
            qty_allocated=l.qty_allocated, qty_picked=l.qty_picked, qty_shipped=l.qty_shipped,
            uom=l.uom, short_reason=l.short_reason) for l in d.lines],
        packages=[PackageOut(
            package_no=p.package_no, type=p.type, container_id=p.container_id, sscc=p.sscc,
            weight_kg=p.weight_kg, length_cm=p.length_cm, width_cm=p.width_cm, height_cm=p.height_cm,
            packed_by=p.packed_by, created_at=p.created_at,
            lines=[PackageLineOut(delivery_line=pl.delivery_line, sku=db.get(Product, pl.product_id).sku,
                                  batch=pl.batch, qty=pl.qty, uom=pl.uom) for pl in p.lines])
            for p in d.packages],
        task=load_task(d.pick_task_id) if full else None,
        pack_task=load_task(d.pack_task_id) if full else None,
        events=events,
    )


def get_delivery(db, ref: str, owner: str, who: Principal) -> tuple[Delivery, Warehouse]:
    d = db.execute(
        select(Delivery).options(selectinload(Delivery.lines), selectinload(Delivery.packages).selectinload(Package.lines))
        .where(Delivery.owner == owner, Delivery.external_ref == ref)
    ).scalar_one_or_none()
    if d is None:
        raise NotFound(f"no delivery {ref}")
    wh = db.get(Warehouse, d.warehouse_id)
    authorise(who, warehouse=wh.code, owner=owner)
    return d, wh


def _rules(fn):
    try:
        return fn()
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    except engine.TaskError as e:
        raise Conflict(e.code, e.message) from e


@router.post("/deliveries", status_code=202, response_model=DeliveryAccepted)
def create_delivery(body: DeliveryIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    """Stock is reserved immediately; the reply says what could not be allocated."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        wh = get_warehouse(db, body.warehouse)
        existing = db.execute(select(Delivery).where(
            Delivery.owner == body.owner, Delivery.external_ref == body.external_ref)).scalar_one_or_none()
        if existing is not None:
            raise FieldError("external_ref", f"delivery {body.external_ref} already exists (status {existing.status})")
        seen = set()
        delivery = Delivery(
            owner=body.owner, external_ref=body.external_ref, message_id=body.message_id,
            warehouse_id=wh.id, pick_mode=body.pick_mode, priority=body.priority,
            required_by=body.required_by, ship_to=body.ship_to.model_dump(exclude_none=True),
            carrier_hint=body.carrier_hint, allow_short=body.allow_short, note=body.note)
        for i, l in enumerate(body.lines):
            if l.delivery_line in seen:
                raise FieldError(f"lines.{i}.delivery_line", f"line {l.delivery_line} repeats")
            seen.add(l.delivery_line)
            product = get_product(db, l.sku, body.owner, f"lines.{i}.sku")
            delivery.lines.append(DeliveryLine(
                line_no=l.delivery_line, product_id=product.id, batch=l.batch, qty_ordered=l.qty,
                qty_allocated=Decimal(0), qty_picked=Decimal(0), qty_shipped=Decimal(0), uom=l.uom))
        db.add(delivery)
        db.flush()
        summary = _rules(lambda: outbound.allocate(db, delivery, wh, who.name))
        return DeliveryAccepted(message_id=body.message_id, wms_id=str(delivery.id), status="accepted",
                                allocation=[AllocationRow(**row) for row in summary])

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/deliveries", response_model=Page[DeliveryOut])
def list_deliveries(db: DB, warehouse: str = Query(), status: str | None = None, owner: str = "DEFAULT",
                    limit: int = Query(default=200, le=2000), offset: int = 0,
                    who: Principal = require("tasks:read")):
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    q = (select(Delivery).options(selectinload(Delivery.lines), selectinload(Delivery.packages))
         .where(Delivery.warehouse_id == wh.id, Delivery.owner == owner))
    if status:
        q = q.where(Delivery.status.in_(status.split(",")))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(func.coalesce(Delivery.required_by, date.max).asc(),
                   engine.priority_order(Delivery.priority), Delivery.id)
        .limit(limit).offset(offset)
    ).scalars().all()
    return Page(items=[delivery_out(db, d, wh, full=False) for d in rows], total=total)


@router.get("/deliveries/{ref}", response_model=DeliveryOut)
def get_delivery_detail(ref: str, db: DB, owner: str = "DEFAULT", who: Principal = require("tasks:read")):
    d, wh = get_delivery(db, ref, owner, who)
    return delivery_out(db, d, wh)


class PackLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    delivery_line: int = Field(ge=1)
    sku: str = Field(min_length=1, max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)


class PackageIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    package_no: int = Field(ge=1)
    type: Literal["carton", "pallet", "tote", "satchel"] = "carton"
    container_id: str | None = Field(default=None, max_length=64)
    sscc: str | None = Field(default=None, max_length=18)
    weight_kg: Decimal | None = Field(default=None, gt=0)
    length_cm: Decimal | None = Field(default=None, gt=0)
    width_cm: Decimal | None = Field(default=None, gt=0)
    height_cm: Decimal | None = Field(default=None, gt=0)
    lines: list[PackLineIn] = Field(min_length=1)


class PackIn(ActorFields):
    warehouse: str | None = Field(default=None, max_length=32)
    packed_by: str | None = Field(default=None, max_length=64)
    complete: bool = True
    packages: list[PackageIn] = Field(min_length=1)


@router.post("/deliveries/{ref}/pack", status_code=202, response_model=envelope.Accepted)
def pack_delivery(ref: str, body: PackIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    d, wh = get_delivery(db, ref, body.owner, who)

    def work():
        if d.status in ("shipped", "cancelled"):
            raise Conflict("not_open", f"{ref} is {d.status}")
        if d.status not in ("picked", "packing"):
            raise Conflict("not_picked", f"{ref} is {d.status}; pick it before packing")
        for i, p in enumerate(body.packages):
            if any(existing.package_no == p.package_no for existing in d.packages):
                raise FieldError(f"packages.{i}.package_no", f"package {p.package_no} is already packed")
            package = Package(package_no=p.package_no, type=p.type, container_id=p.container_id,
                              sscc=p.sscc, weight_kg=p.weight_kg, length_cm=p.length_cm,
                              width_cm=p.width_cm, height_cm=p.height_cm,
                              packed_by=body.packed_by or body.operator or who.name)
            for j, pl in enumerate(p.lines):
                product = get_product(db, pl.sku, body.owner, f"packages.{i}.lines.{j}.sku")
                line = next((l for l in d.lines if l.line_no == pl.delivery_line), None)
                if line is None:
                    raise FieldError(f"packages.{i}.lines.{j}.delivery_line",
                                     f"{ref} has no line {pl.delivery_line}")
                # take it from what is actually on the bench, batch by batch
                available = outbound.to_pack(db, d, pl.delivery_line)
                if pl.batch is not None:
                    available = [(b, q) for b, q in available if b == pl.batch]
                left = pl.qty
                for batch, on_bench in available:
                    if left <= 0:
                        break
                    take = min(on_bench, left)
                    package.lines.append(PackageLine(delivery_line=pl.delivery_line, product_id=product.id,
                                                     batch=batch, qty=take, uom=pl.uom))
                    left -= take
                if left > 0:
                    picked = outbound.packed_qty(d, pl.delivery_line)
                    raise FieldError(
                        f"packages.{i}.lines.{j}.qty",
                        f"only {qstr(line.qty_picked - picked)} {line.uom} of line {pl.delivery_line} "
                        f"{'in batch ' + pl.batch + ' ' if pl.batch else ''}are still on the bench; "
                        f"{qstr(line.qty_picked)} were picked")
            d.packages.append(package)
        db.flush()
        if body.complete:
            outbound.finish_packing(db, d, wh)
        else:
            d.status = "packing"
            db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(d.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


class ShipIn(ActorFields):
    warehouse: str | None = Field(default=None, max_length=32)
    carrier: str | None = Field(default=None, max_length=64)
    tracking_no: str | None = Field(default=None, max_length=64)
    shipped_by: str | None = Field(default=None, max_length=64)


@router.post("/deliveries/{ref}/ship", status_code=202, response_model=envelope.Accepted)
def ship_delivery(ref: str, body: ShipIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    d, wh = get_delivery(db, ref, body.owner, who)

    def work():
        actor = engine.Actor(name=body.shipped_by or body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id)
        _rules(lambda: outbound.ship(db, d, wh, carrier=body.carrier, tracking_no=body.tracking_no, actor=actor))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(d.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


class CancelDeliveryIn(ActorFields):
    reason: str | None = Field(default=None, max_length=200)


@router.post("/deliveries/{ref}/cancel", status_code=202, response_model=envelope.Accepted)
def cancel_delivery(ref: str, body: CancelDeliveryIn, request: Request, db: DB,
                    who: Principal = require("tasks:write")):
    """Cancel, never delete. The reservation goes back to the shelf."""
    d, wh = get_delivery(db, ref, body.owner, who)

    def work():
        actor = engine.Actor(name=body.operator or who.name, device=body.device, api_client_id=who.api_client_id)
        _rules(lambda: outbound.cancel(db, d, wh, body.reason, actor))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(d.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)
