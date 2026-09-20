"""Containers: pallets, cartons and totes, with SSCC and nesting."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, NotFound
from wms.api.routes.inbound import get_location, get_warehouse
from wms.api.schemas import Page, Qty
from wms.api.schemas_tasks import ActorFields
from wms.models import Container, Location, Warehouse
from wms.services import containers
from wms.services import tasks as engine
from wms.services.stock import RuleError

router = APIRouter(tags=["containers"])

ContainerType = Literal["pallet", "carton", "tote", "cage"]


class ContainerIn(envelope.Envelope):
    warehouse: str = Field(min_length=1, max_length=32)
    container_id: str | None = Field(default=None, max_length=64)
    type: ContainerType = "pallet"
    location: str | None = Field(default=None, max_length=64)
    parent: str | None = Field(default=None, max_length=64)
    sscc: str | None = Field(default=None, min_length=18, max_length=18, pattern=r"^[0-9]{18}$")
    assign_sscc: bool = False
    weight_kg: Decimal | None = Field(default=None, gt=0)
    note: str | None = Field(default=None, max_length=500)


class ContentOut(BaseModel):
    sku: str
    name: str
    batch: str | None
    qty: Qty
    uom: str
    container_id: str
    received_at: date | None


class ChildOut(BaseModel):
    container_id: str
    type: str
    sscc: str | None
    status: str


class ContainerOut(BaseModel):
    wms_id: str
    container_id: str
    sscc: str | None
    owner: str
    type: str
    warehouse: str
    location: str | None
    parent: str | None
    status: str
    weight_kg: Qty | None
    note: str | None
    created_at: datetime
    closed_at: datetime | None
    children: list[ChildOut]
    contents: list[ContentOut]
    total_qty: Qty


def container_out(db, c: Container, full: bool = True) -> ContainerOut:
    wh = db.get(Warehouse, c.warehouse_id)
    loc = db.get(Location, c.location_id) if c.location_id else None
    items = containers.contents(db, c) if full else []
    return ContainerOut(
        wms_id=c.container_id, container_id=c.container_id, sscc=c.sscc, owner=c.owner,
        type=c.type, warehouse=wh.code, location=loc.code if loc else None,
        parent=c.parent.container_id if c.parent else None, status=c.status,
        weight_kg=c.weight_kg, note=c.note, created_at=c.created_at, closed_at=c.closed_at,
        children=[ChildOut(container_id=k.container_id, type=k.type, sscc=k.sscc, status=k.status)
                  for k in c.children] if full else [],
        contents=[ContentOut(**item) for item in items],
        total_qty=sum((Decimal(i["qty"]) for i in items), Decimal(0)),
    )


def get_container(db, ref: str, owner: str, who: Principal) -> tuple[Container, Warehouse]:
    c = containers.find(db, ref, owner)
    if c is None:
        raise NotFound(f"no container {ref}")
    wh = db.get(Warehouse, c.warehouse_id)
    authorise(who, warehouse=wh.code, owner=c.owner)
    return c, wh


def _rules(fn):
    try:
        return fn()
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    except engine.TaskError as e:
        raise Conflict(e.code, e.message) from e


@router.post("/containers", status_code=202, response_model=envelope.Accepted)
def upsert_container(body: ContainerIn, request: Request, db: DB,
                     who: Principal = require("stock:write")):
    """Register a pallet, carton or tote. Create or update by its code."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        wh = get_warehouse(db, body.warehouse)
        loc = get_location(db, wh, body.location, "location") if body.location else None
        existing = containers.find(db, body.container_id, body.owner) if body.container_id else None
        if existing is None:
            container = Container(
                container_id=body.container_id or containers.next_code(db, body.type),
                owner=body.owner, type=body.type, warehouse_id=wh.id,
                location_id=loc.id if loc else None, sscc=body.sscc, weight_kg=body.weight_kg,
                note=body.note)
            db.add(container)
            db.flush()
            status = "created"
        else:
            container = existing
            container.type = body.type
            if loc is not None:
                container.location_id = loc.id
            if body.sscc:
                container.sscc = body.sscc
            if body.weight_kg is not None:
                container.weight_kg = body.weight_kg
            container.note = body.note or container.note
            status = "updated"
        if body.assign_sscc and not container.sscc:
            _rules(lambda: containers.assign_sscc(db, container, wh))
        if body.parent:
            parent, _ = get_container(db, body.parent, body.owner, who)
            _rules(lambda: containers.nest(db, container, parent))
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=container.container_id,
                                 status=status)

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/containers", response_model=Page[ContainerOut])
def list_containers(db: DB, warehouse: str = Query(), type: str | None = None,
                    status: str | None = None, location: str | None = None,
                    nested: str | None = None, owner: str = "DEFAULT",
                    limit: int = Query(default=200, le=2000), offset: int = 0,
                    who: Principal = require("stock:read")):
    """`nested=false` shows only the ones that are not inside something else."""
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)
    q = (select(Container).options(selectinload(Container.children), selectinload(Container.parent))
         .where(Container.warehouse_id == wh.id, Container.owner == owner))
    if type:
        q = q.where(Container.type.in_(type.split(",")))
    if status:
        q = q.where(Container.status.in_(status.split(",")))
    if location:
        loc = get_location(db, wh, location, "location")
        q = q.where(Container.location_id == loc.id)
    if nested is not None:
        q = q.where(Container.parent_id.is_not(None) if nested.lower() == "true"
                    else Container.parent_id.is_(None))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(Container.container_id).limit(limit).offset(offset)).scalars().all()
    return Page(items=[container_out(db, c, full=False) for c in rows], total=total)


@router.get("/containers/{ref}", response_model=ContainerOut)
def get_container_detail(ref: str, db: DB, owner: str = "DEFAULT",
                         who: Principal = require("stock:read")):
    c, _ = get_container(db, ref, owner, who)
    return container_out(db, c)


class NestIn(ActorFields):
    parent: str = Field(min_length=1, max_length=64)


@router.post("/containers/{ref}/nest", status_code=202, response_model=envelope.Accepted)
def nest_container(ref: str, body: NestIn, request: Request, db: DB,
                   who: Principal = require("stock:write")):
    """Put this carton on that pallet. It follows the pallet from now on."""
    c, _ = get_container(db, ref, body.owner, who)

    def work():
        parent, _ = get_container(db, body.parent, body.owner, who)
        _rules(lambda: containers.nest(db, c, parent))
        return envelope.Accepted(message_id=body.message_id, wms_id=c.container_id, status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.post("/containers/{ref}/unnest", status_code=202, response_model=envelope.Accepted)
def unnest_container(ref: str, body: ActorFields, request: Request, db: DB,
                     who: Principal = require("stock:write")):
    c, _ = get_container(db, ref, body.owner, who)

    def work():
        containers.unnest(db, c)
        return envelope.Accepted(message_id=body.message_id, wms_id=c.container_id, status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


class MoveContainerIn(ActorFields):
    to_location: str = Field(min_length=1, max_length=64)
    reason: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)


class ContainerMoved(envelope.Accepted):
    moved: Qty
    to_location: str


@router.post("/containers/{ref}/move", status_code=202, response_model=ContainerMoved)
def move_container(ref: str, body: MoveContainerIn, request: Request, db: DB,
                   who: Principal = require("tasks:write")):
    """Move the container and everything it carries, nested cartons included."""
    c, wh = get_container(db, ref, body.owner, who)

    def work():
        to = get_location(db, wh, body.to_location, "to_location")
        actor = engine.Actor(name=body.operator or who.name, device=body.device,
                             api_client_id=who.api_client_id)
        moved = _rules(lambda: containers.move(db, c, to, reason=body.reason, actor=actor,
                                               note=body.note))
        return ContainerMoved(message_id=body.message_id, wms_id=c.container_id, status="accepted",
                              moved=moved, to_location=to.code)

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.post("/containers/{ref}/close", status_code=202, response_model=envelope.Accepted)
def close_container(ref: str, body: ActorFields, request: Request, db: DB,
                    who: Principal = require("stock:write")):
    """Seal it: nothing else goes on until it is reopened."""
    c, _ = get_container(db, ref, body.owner, who)

    def work():
        containers.close(db, c)
        return envelope.Accepted(message_id=body.message_id, wms_id=c.container_id, status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.post("/containers/{ref}/reopen", status_code=202, response_model=envelope.Accepted)
def reopen_container(ref: str, body: ActorFields, request: Request, db: DB,
                     who: Principal = require("stock:write")):
    c, _ = get_container(db, ref, body.owner, who)

    def work():
        _rules(lambda: containers.reopen(db, c))
        return envelope.Accepted(message_id=body.message_id, wms_id=c.container_id, status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)
