"""Where is it, and what is here. The same call feeds the scanner and partners."""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Query
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import FieldError, NotFound
from wms.api.schemas import StockAtLocation, StockAtShelf, StockBySku, StockLine
from wms.models import Location, Product, StockBalance, Warehouse

router = APIRouter(tags=["stock"])


def promisable_qty(balance) -> Decimal:
    """What could still be promised to an order. Stock on a packing bench, at
    the line or in transit is on hand, but none of it is free."""
    from wms.services.reservations import promisable

    if not promisable(balance.location.zone.kind):
        return Decimal(0)
    return balance.on_hand - balance.reserved


@router.get("/stock", response_model=StockBySku)
def where_is_it(
    db: DB, sku: str = Query(), warehouse: str | None = None, batch: str | None = None,
    owner: str = "DEFAULT", who: Principal = require("stock:read"),
):
    authorise(who, warehouse=warehouse, owner=owner)
    product = db.execute(
        select(Product).where(Product.owner == owner, Product.sku == sku)
    ).scalar_one_or_none()
    if product is None:
        raise NotFound(f"no product {sku} for owner {owner}")

    q = (
        select(StockBalance)
        .options(selectinload(StockBalance.location).selectinload(Location.zone),
                 selectinload(StockBalance.location).selectinload(Location.warehouse))
        .where(StockBalance.product_id == product.id, StockBalance.owner == owner,
               StockBalance.on_hand != 0)
    )
    if warehouse:
        q = q.join(Warehouse, Warehouse.id == StockBalance.warehouse_id).where(Warehouse.code == warehouse)
    if batch:
        q = q.where(StockBalance.batch == batch)
    rows = [r for r in db.execute(q).scalars() if who.allows_warehouse(r.location.warehouse.code)]
    rows.sort(key=lambda r: (r.received_at is None, r.received_at, r.location.code))

    locations = [
        StockAtLocation(
            warehouse=r.location.warehouse.code, location=r.location.code,
            zone=r.location.zone.code, batch=r.batch, owner=r.owner,
            on_hand=r.on_hand, reserved=r.reserved, available=promisable_qty(r),
            received_at=r.received_at,
        )
        for r in rows
    ]
    return StockBySku(
        sku=product.sku, uom=product.uom,
        total_on_hand=sum((x.on_hand for x in locations), Decimal(0)),
        total_available=sum((x.available for x in locations), Decimal(0)),
        locations=locations,
    )


def resolve_location(db, ref: str, warehouse: str | None) -> Location:
    opts = (selectinload(Location.zone), selectinload(Location.warehouse))
    if ref.isdigit():
        loc = db.execute(select(Location).options(*opts).where(Location.id == int(ref))).scalar_one_or_none()
        if loc is None:
            raise NotFound(f"no location with id {ref}")
        return loc
    q = select(Location).options(*opts).where(Location.code == ref)
    if warehouse:
        q = q.join(Warehouse, Warehouse.id == Location.warehouse_id).where(Warehouse.code == warehouse)
    found = db.execute(q).scalars().all()
    if not found:
        raise NotFound(f"no location {ref}")
    if len(found) > 1:
        raise FieldError("warehouse", f"{ref} exists in more than one warehouse; say which")
    return found[0]


@router.get("/locations/{ref}/stock", response_model=StockAtShelf)
def what_is_here(
    ref: str, db: DB, warehouse: str | None = None, batch: str | None = None,
    owner: str | None = None, who: Principal = require("stock:read"),
):
    loc = resolve_location(db, ref, warehouse)
    authorise(who, warehouse=loc.warehouse.code, owner=owner)
    q = (
        select(StockBalance).options(selectinload(StockBalance.product))
        .where(StockBalance.location_id == loc.id, StockBalance.on_hand != 0)
    )
    if batch:
        q = q.where(StockBalance.batch == batch)
    if owner:
        q = q.where(StockBalance.owner == owner)
    rows = db.execute(q).scalars().all()
    rows = [r for r in rows if who.allows_owner(r.owner)]
    rows.sort(key=lambda r: (r.product.sku, r.received_at is None, r.received_at, r.batch or ""))
    return StockAtShelf(
        wms_id=str(loc.id), warehouse=loc.warehouse.code, location=loc.code, zone=loc.zone.code,
        stock=[
            StockLine(
                sku=r.product.sku, name=r.product.name, batch=r.batch, owner=r.owner,
                on_hand=r.on_hand, reserved=r.reserved, available=promisable_qty(r),
                uom=r.uom, received_at=r.received_at,
            )
            for r in rows
        ],
    )


# --- ledger ---------------------------------------------------------------

from datetime import datetime  # noqa: E402

from pydantic import BaseModel  # noqa: E402

from wms.api.schemas import Page, Qty  # noqa: E402
from wms.models import StockLedger, Zone  # noqa: E402


class LedgerOut(BaseModel):
    wms_id: str
    at: datetime
    movement_type: str
    reason: str | None
    warehouse: str
    location: str
    zone: str
    sku: str
    batch: str | None
    owner: str
    qty_change: Qty
    uom: str
    received_at: datetime | None
    actor: str
    device: str | None
    task_id: str | None
    external_ref: str | None
    container_id: str | None
    note: str | None


@router.get("/stock/ledger", response_model=Page[LedgerOut])
def ledger(
    db: DB, sku: str | None = None, location: str | None = None, warehouse: str | None = None,
    batch: str | None = None, owner: str = "DEFAULT", movement_type: str | None = None,
    limit: int = Query(default=100, le=1000), offset: int = 0,
    who: Principal = require("stock:read"),
):
    """Newest first. Nothing here is ever overwritten."""
    authorise(who, warehouse=warehouse, owner=owner)
    q = (
        select(StockLedger, Product, Location, Zone, Warehouse)
        .join(Product, Product.id == StockLedger.product_id)
        .join(Location, Location.id == StockLedger.location_id)
        .join(Zone, Zone.id == Location.zone_id)
        .join(Warehouse, Warehouse.id == StockLedger.warehouse_id)
        .where(StockLedger.owner == owner)
    )
    if sku:
        q = q.where(Product.sku == sku)
    if location:
        q = q.where(Location.code == location)
    if warehouse:
        q = q.where(Warehouse.code == warehouse)
    if batch:
        q = q.where(StockLedger.batch == batch)
    if movement_type:
        q = q.where(StockLedger.movement_type == movement_type)
    if "*" not in who.warehouses:
        q = q.where(Warehouse.code.in_(who.warehouses))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(StockLedger.id.desc()).limit(limit).offset(offset)).all()
    return Page(items=[LedgerOut(
        wms_id=str(l.id), at=l.at, movement_type=l.movement_type, reason=l.reason,
        warehouse=w.code, location=loc.code, zone=z.code, sku=p.sku, batch=l.batch, owner=l.owner,
        qty_change=l.qty_change, uom=l.uom, received_at=l.received_at, actor=l.actor,
        device=l.device, task_id=str(l.task_id) if l.task_id else None,
        external_ref=l.external_ref, container_id=l.container_id, note=l.note,
    ) for l, p, loc, z, w in rows], total=total)
