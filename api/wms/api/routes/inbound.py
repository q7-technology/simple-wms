"""Receipts, moves, counts, replenishments and putaway suggestions."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, NotFound
from wms.api.schemas import Page, Qty
from wms.api.schemas_tasks import ActorFields, Priority, TaskOut, task_out
from wms.models import Location, OutboundEvent, Product, Receipt, ReceiptLine, StockBalance, StockLedger, Task, TaskLine, Warehouse
from wms.services import batches, putaway, stock
from wms.services import tasks as engine
from wms.services.stock import RuleError

router = APIRouter(tags=["inbound"])


def get_warehouse(db, code: str | None, field: str = "warehouse") -> Warehouse:
    if not code:
        raise FieldError(field, "warehouse is required")
    wh = db.execute(select(Warehouse).where(Warehouse.code == code)).scalar_one_or_none()
    if wh is None:
        raise FieldError(field, f"unknown warehouse {code}")
    return wh


def get_product(db, sku: str, owner: str, field: str) -> Product:
    p = db.execute(select(Product).where(Product.owner == owner, Product.sku == sku)).scalar_one_or_none()
    if p is None:
        raise FieldError(field, f"unknown sku {sku}{_did_you_mean(db, sku, owner)}")
    return p


def _did_you_mean(db, sku: str, owner: str) -> str:
    """A typo is the usual reason a SKU is not found, so say the near miss."""
    from difflib import get_close_matches

    known = db.execute(
        select(Product.sku).where(Product.owner == owner, Product.active.is_(True)).limit(5000)
    ).scalars().all()
    close = get_close_matches(sku.upper(), [s.upper() for s in known], n=1, cutoff=0.7)
    if not close:
        return ""
    match = next(s for s in known if s.upper() == close[0])
    return f"; did you mean {match}?"


def get_location(db, wh: Warehouse, code: str | None, field: str) -> Location | None:
    if not code:
        return None
    loc = db.execute(select(Location).where(Location.warehouse_id == wh.id, Location.code == code)).scalar_one_or_none()
    if loc is None:
        raise FieldError(field, f"unknown location {code} in {wh.code}")
    return loc


# --- receipts -------------------------------------------------------------

class ReceiptLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    line: int = Field(ge=1)
    sku: str = Field(max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)


class ReceiptIn(envelope.Envelope):
    external_ref: str = Field(max_length=64)
    warehouse: str = Field(max_length=32)
    supplier: str | None = Field(default=None, max_length=120)
    expected_at: date | None = None
    dock: str | None = Field(default=None, max_length=64)
    carrier: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)
    lines: list[ReceiptLineIn] = Field(min_length=1)


class ReceiptLineOut(BaseModel):
    line: int
    sku: str
    name: str
    batch: str | None
    expected_qty: Qty
    received_qty: Qty
    uom: str


class PutawayOut(BaseModel):
    ledger_id: str
    at: datetime
    sku: str
    batch: str | None
    qty: Qty
    uom: str
    location: str
    actor: str
    device: str | None


class EventSummary(BaseModel):
    event_type: str
    subscriber: str
    status: str
    at: datetime


class ReceiptOut(BaseModel):
    wms_id: str
    external_ref: str
    owner: str
    warehouse: str
    supplier: str | None
    kind: str
    expected_at: date | None
    dock: str | None
    carrier: str | None
    status: str
    note: str | None
    created_at: datetime
    arrived_at: datetime | None
    closed_at: datetime | None
    expected_total: Qty
    received_total: Qty
    lines: list[ReceiptLineOut]
    task: TaskOut | None
    putaways: list[PutawayOut]
    events: list[EventSummary]


def receipt_out(db, r: Receipt, wh: Warehouse, full: bool = True) -> ReceiptOut:
    task = None
    putaways: list[PutawayOut] = []
    events: list[EventSummary] = []
    if r.task_id:
        from wms.api.routes.tasks import LOAD
        t = db.execute(select(Task).options(*LOAD).where(Task.id == r.task_id)).scalar_one_or_none()
        task = task_out(t, wh) if t else None
        if full and t:
            rows = db.execute(
                select(StockLedger, Product, Location).join(Product, Product.id == StockLedger.product_id)
                .join(Location, Location.id == StockLedger.location_id)
                .where(StockLedger.task_id == t.id).order_by(StockLedger.id)
            ).all()
            putaways = [PutawayOut(ledger_id=str(l.id), at=l.at, sku=p.sku, batch=l.batch, qty=l.qty_change,
                                   uom=l.uom, location=loc.code, actor=l.actor, device=l.device) for l, p, loc in rows]
    if full:
        evs = db.execute(
            select(OutboundEvent).options(selectinload(OutboundEvent.subscriber))
            .where(OutboundEvent.external_ref == r.external_ref, OutboundEvent.event_type.like("receipt.%"))
            .order_by(OutboundEvent.id)
        ).scalars().all()
        events = [EventSummary(event_type=e.event_type, subscriber=e.subscriber.name, status=e.status,
                               at=e.delivered_at or e.occurred_at) for e in evs]
    lines = [ReceiptLineOut(line=l.line_no, sku=db.get(Product, l.product_id).sku, name=db.get(Product, l.product_id).name,
                            batch=l.batch, expected_qty=l.expected_qty, received_qty=l.received_qty, uom=l.uom) for l in r.lines]
    return ReceiptOut(
        wms_id=str(r.id), external_ref=r.external_ref, owner=r.owner, warehouse=wh.code, supplier=r.supplier,
        kind=r.kind, expected_at=r.expected_at, dock=r.dock, carrier=r.carrier, status=r.status, note=r.note,
        created_at=r.created_at, arrived_at=r.arrived_at, closed_at=r.closed_at,
        expected_total=sum((l.expected_qty for l in r.lines), Decimal(0)),
        received_total=sum((l.received_qty for l in r.lines), Decimal(0)),
        lines=lines, task=task, putaways=putaways, events=events,
    )


def apply_receipt(db, body: ReceiptIn, created_by: str) -> Receipt:
    """Create the receipt and its receive task. Shared by the endpoint and CSV import."""
    wh = get_warehouse(db, body.warehouse)
    existing = db.execute(select(Receipt).where(Receipt.owner == body.owner, Receipt.external_ref == body.external_ref)).scalar_one_or_none()
    if existing is not None:
        raise FieldError("external_ref", f"receipt {body.external_ref} already exists (status {existing.status})")
    seen = set()
    specs = []
    receipt = Receipt(owner=body.owner, external_ref=body.external_ref, message_id=body.message_id, warehouse_id=wh.id,
                      supplier=body.supplier, expected_at=body.expected_at, dock=body.dock, carrier=body.carrier, note=body.note)
    for i, l in enumerate(body.lines):
        if l.line in seen:
            raise FieldError(f"lines.{i}.line", f"line {l.line} repeats")
        seen.add(l.line)
        product = get_product(db, l.sku, body.owner, f"lines.{i}.sku")
        receipt.lines.append(ReceiptLine(line_no=l.line, product_id=product.id, batch=l.batch,
                                         expected_qty=l.qty, received_qty=Decimal(0), uom=l.uom))
        # The batch master fills in behind the ledger: a batch the warehouse
        # is about to handle gets a row, empty until somebody describes it.
        batches.ensure(db, product, l.batch)
        specs.append(engine.LineSpec(product=product, expected_qty=l.qty, uom=l.uom, batch=l.batch, source_line=l.line))
    task = engine.create(db, type="receive", warehouse=wh, owner=body.owner, lines=specs, source_type="receipt",
                         source_ref=body.external_ref, created_by=created_by, note=body.supplier)
    receipt.task_id = task.id
    db.add(receipt)
    db.flush()
    return receipt


@router.post("/receipts", status_code=202, response_model=envelope.Accepted)
def create_receipt(body: ReceiptIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        receipt = apply_receipt(db, body, who.name)
        return envelope.Accepted(message_id=body.message_id, wms_id=str(receipt.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/receipts", response_model=Page[ReceiptOut])
def list_receipts(db: DB, warehouse: str = Query(), status: str | None = None, owner: str = "DEFAULT",
                  limit: int = Query(default=200, le=2000), offset: int = 0, who: Principal = require("tasks:read")):
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    q = select(Receipt).options(selectinload(Receipt.lines)).where(Receipt.warehouse_id == wh.id, Receipt.owner == owner)
    if status:
        q = q.where(Receipt.status.in_(status.split(",")))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(Receipt.expected_at.nulls_last(), Receipt.id).limit(limit).offset(offset)).scalars().all()
    return Page(items=[receipt_out(db, r, wh, full=False) for r in rows], total=total)


@router.get("/receipts/{ref}", response_model=ReceiptOut)
def get_receipt(ref: str, db: DB, warehouse: str | None = None, owner: str = "DEFAULT", who: Principal = require("tasks:read")):
    r = db.execute(select(Receipt).options(selectinload(Receipt.lines)).where(Receipt.owner == owner, Receipt.external_ref == ref)).scalar_one_or_none()
    if r is None:
        raise NotFound(f"no receipt {ref}")
    wh = db.get(Warehouse, r.warehouse_id)
    authorise(who, warehouse=wh.code, owner=owner)
    return receipt_out(db, r, wh)


class ArrivedIn(ActorFields):
    dock: str | None = Field(default=None, max_length=64)
    carrier: str | None = Field(default=None, max_length=64)


@router.post("/receipts/{ref}/arrived", status_code=202, response_model=envelope.Accepted)
def receipt_arrived(ref: str, body: ArrivedIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    r = db.execute(select(Receipt).where(Receipt.owner == body.owner, Receipt.external_ref == ref)).scalar_one_or_none()
    if r is None:
        raise NotFound(f"no receipt {ref}")
    wh = db.get(Warehouse, r.warehouse_id)
    authorise(who, warehouse=wh.code, owner=body.owner)

    def work():
        if r.status not in ("expected", "arrived"):
            raise Conflict("receipt_not_open", f"receipt {ref} is {r.status}")
        r.status = "arrived"
        r.arrived_at = datetime.now()
        r.dock = body.dock or r.dock
        r.carrier = body.carrier or r.carrier
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(r.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


# --- putaway suggestions ---------------------------------------------------

class SuggestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    warehouse: str = Field(max_length=32)
    sku: str = Field(max_length=64)
    batch: str | None = None
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)
    purpose: str = "putaway"
    owner: str = "DEFAULT"


class SuggestOut(BaseModel):
    suggestions: list[dict]
    flag: str | None


@router.post("/locations/suggest", response_model=SuggestOut)
def suggest_location(body: SuggestIn, db: DB, who: Principal = require("stock:read")):
    authorise(who, warehouse=body.warehouse, owner=body.owner)
    wh = get_warehouse(db, body.warehouse)
    product = get_product(db, body.sku, body.owner, "sku")
    suggestions, flag = putaway.suggest(db, wh, product, body.batch, body.qty, body.uom, body.owner)
    return SuggestOut(suggestions=suggestions, flag=flag)


# --- moves ---------------------------------------------------------------

class MoveIn(ActorFields):
    warehouse: str = Field(max_length=32)
    sku: str = Field(max_length=64)
    batch: str | None = Field(default=None, max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)
    from_location: str = Field(max_length=64)
    to_location: str = Field(max_length=64)
    container_id: str | None = Field(default=None, max_length=64)
    reason: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)


def _rule_errors(fn):
    try:
        return fn()
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    except engine.TaskError as e:
        raise Conflict(e.code, e.message) from e


@router.post("/moves", status_code=202, response_model=envelope.Accepted)
def move(body: MoveIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    """A move within one warehouse, done on the spot. Between warehouses use /transfers."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        wh = get_warehouse(db, body.warehouse)
        product = get_product(db, body.sku, body.owner, "sku")
        other = db.execute(select(Location).join(Warehouse).where(Location.code == body.to_location, Warehouse.code != wh.code)).first()
        src = get_location(db, wh, body.from_location, "from_location")
        try:
            dst = get_location(db, wh, body.to_location, "to_location")
        except FieldError:
            if other:
                raise FieldError("to_location", f"{body.to_location} is in another warehouse; use POST /v1/transfers")
            raise
        actor = engine.Actor(name=body.operator or who.name, device=body.device, api_client_id=who.api_client_id)
        task = engine.create(db, type="move", warehouse=wh, owner=body.owner, source_type="manual",
                             source_ref=body.external_ref, created_by=who.name, status="in_progress",
                             lines=[engine.LineSpec(product=product, expected_qty=body.qty, uom=body.uom, batch=body.batch,
                                                    from_location=src, to_location=dst, container_id=body.container_id)])
        task.started_at = datetime.now()
        task.assigned_to = actor.name
        task.device = actor.device
        line = task.lines[0]
        _rule_errors(lambda: engine.confirm(db, task, line, qty=body.qty, uom=body.uom, actor=actor, batch=body.batch,
                                            to_location=body.to_location, from_location=body.from_location,
                                            container_id=body.container_id, reason=body.reason, note=body.note))
        return envelope.Accepted(message_id=body.message_id, wms_id=str(task.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


# --- counts --------------------------------------------------------------

class CountIn(ActorFields):
    warehouse: str = Field(max_length=32)
    locations: list[str] = Field(default_factory=list)
    zone: str | None = Field(default=None, max_length=32)
    sku: str | None = Field(default=None, max_length=64)
    priority: Priority = "normal"
    note: str | None = Field(default=None, max_length=500)


@router.post("/counts", status_code=202, response_model=envelope.Accepted)
def create_count(body: CountIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    """A blind cycle count over some shelves. One line per product and batch found there."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        wh = get_warehouse(db, body.warehouse)
        locs: list[Location] = []
        for i, code in enumerate(body.locations):
            locs.append(get_location(db, wh, code, f"locations.{i}"))
        if body.zone:
            from wms.models import Zone
            zone = db.execute(select(Zone).where(Zone.warehouse_id == wh.id, Zone.code == body.zone)).scalar_one_or_none()
            if zone is None:
                raise FieldError("zone", f"unknown zone {body.zone}")
            locs += db.execute(select(Location).where(Location.zone_id == zone.id, Location.active.is_(True))
                               .order_by(Location.pick_sequence, Location.code)).scalars().all()
        if not locs:
            raise FieldError("locations", "say which shelves or which zone to count")
        product_filter = get_product(db, body.sku, body.owner, "sku") if body.sku else None
        specs = []
        for loc in locs:
            for b in stock.balances_at(db, loc.id):
                if b.owner != body.owner or (product_filter and b.product_id != product_filter.id):
                    continue
                specs.append(engine.LineSpec(product=db.get(Product, b.product_id), expected_qty=b.on_hand, uom=b.uom,
                                             batch=b.batch, from_location=loc))
        if not specs:
            raise FieldError("locations", "nothing is recorded on those shelves; nothing to count")
        task = engine.create(db, type="count", warehouse=wh, owner=body.owner, lines=specs, source_type="count",
                             source_ref=body.external_ref, priority=body.priority, created_by=who.name, note=body.note)
        if not task.source_ref:
            task.source_ref = f"CNT-{task.id:04d}"
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(task.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


# --- replenishments ---------------------------------------------------------

class ReplenLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    line: int = Field(ge=1)
    sku: str = Field(max_length=64)
    qty: Decimal = Field(gt=0)
    uom: str = Field(default="EA", max_length=16)
    to_location: str = Field(max_length=64)
    from_location: str | None = Field(default=None, max_length=64)
    batch: str | None = Field(default=None, max_length=64)


class ReplenIn(ActorFields):
    warehouse: str = Field(max_length=32)
    priority: Priority = "normal"
    source: str = Field(default="api", max_length=16)  # api, min_max, manual
    lines: list[ReplenLineIn] = Field(min_length=1)


def fifo_source(db, wh: Warehouse, product: Product, batch: str | None, owner: str, exclude: Location) -> Location | None:
    q = (select(StockBalance).join(Location, Location.id == StockBalance.location_id)
         .where(StockBalance.warehouse_id == wh.id, StockBalance.product_id == product.id,
                StockBalance.owner == owner, StockBalance.on_hand > StockBalance.reserved,
                StockBalance.location_id != exclude.id, Location.active.is_(True)))
    if batch:
        q = q.where(StockBalance.batch == batch)
    rows = db.execute(q.order_by(StockBalance.received_at.nulls_last(), StockBalance.id)).scalars().all()
    return db.get(Location, rows[0].location_id) if rows else None


def apply_replenishment(db, body: ReplenIn, created_by: str):
    """Create the replenish task, choosing a FIFO source where none is given.
    Shared by the endpoint and CSV import."""
    wh = get_warehouse(db, body.warehouse)
    specs = []
    for i, l in enumerate(body.lines):
        product = get_product(db, l.sku, body.owner, f"lines.{i}.sku")
        dst = get_location(db, wh, l.to_location, f"lines.{i}.to_location")
        src = get_location(db, wh, l.from_location, f"lines.{i}.from_location") if l.from_location else \
            fifo_source(db, wh, product, l.batch, body.owner, dst)
        specs.append(engine.LineSpec(product=product, expected_qty=l.qty, uom=l.uom, batch=l.batch,
                                     from_location=src, to_location=dst, source_line=l.line))
    task = engine.create(db, type="replenish", warehouse=wh, owner=body.owner, lines=specs,
                         source_type=body.source, source_ref=body.external_ref,
                         priority=body.priority, created_by=created_by)
    if not task.source_ref:
        task.source_ref = f"REP-{task.id:04d}"
    db.flush()
    return task


@router.post("/replenishments", status_code=202, response_model=envelope.Accepted)
def create_replenishment(body: ReplenIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        task = apply_replenishment(db, body, who.name)
        return envelope.Accepted(message_id=body.message_id, wms_id=str(task.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)
