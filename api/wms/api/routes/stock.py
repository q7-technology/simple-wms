"""Where is it, and what is here. The same call feeds the scanner and partners."""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from wms.api.deps import DB, authorise, require
from wms.api.errors import FieldError, NotFound
from wms.api.schemas import StockAtLocation, StockAtShelf, StockBySku, StockLine
from wms.models import ApiClient, Location, Product, StockBalance, Warehouse
from wms.services.access import allows_warehouse

router = APIRouter(tags=["stock"])


@router.get("/stock", response_model=StockBySku)
def where_is_it(
    db: DB, sku: str = Query(), warehouse: str | None = None, batch: str | None = None,
    owner: str = "DEFAULT", client: ApiClient = require("stock:read"),
):
    authorise(client, warehouse=warehouse, owner=owner)
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
    rows = [r for r in db.execute(q).scalars() if allows_warehouse(client, r.location.warehouse.code)]
    rows.sort(key=lambda r: (r.received_at is None, r.received_at, r.location.code))

    locations = [
        StockAtLocation(
            warehouse=r.location.warehouse.code, location=r.location.code,
            zone=r.location.zone.code, batch=r.batch, owner=r.owner,
            on_hand=r.on_hand, reserved=r.reserved, available=r.on_hand - r.reserved,
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
    owner: str | None = None, client: ApiClient = require("stock:read"),
):
    loc = resolve_location(db, ref, warehouse)
    authorise(client, warehouse=loc.warehouse.code, owner=owner)
    q = (
        select(StockBalance).options(selectinload(StockBalance.product))
        .where(StockBalance.location_id == loc.id, StockBalance.on_hand != 0)
    )
    if batch:
        q = q.where(StockBalance.batch == batch)
    if owner:
        q = q.where(StockBalance.owner == owner)
    rows = db.execute(q).scalars().all()
    rows = [r for r in rows if r.owner == client.owner or client.owner == "*"]
    rows.sort(key=lambda r: (r.product.sku, r.received_at is None, r.received_at, r.batch or ""))
    return StockAtShelf(
        wms_id=str(loc.id), warehouse=loc.warehouse.code, location=loc.code, zone=loc.zone.code,
        stock=[
            StockLine(
                sku=r.product.sku, name=r.product.name, batch=r.batch, owner=r.owner,
                on_hand=r.on_hand, reserved=r.reserved, available=r.on_hand - r.reserved,
                uom=r.uom, received_at=r.received_at,
            )
            for r in rows
        ],
    )
