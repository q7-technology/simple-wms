"""Sites, warehouses, zones and locations. Create or update by code."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import func, select

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import FieldError
from wms.api.schemas import (
    LocationIn, LocationOut, Page, SiteIn, SiteOut, WarehouseIn, WarehouseOut, ZoneIn, ZoneOut,
)
from wms.models import Location, Site, Warehouse, Zone
from wms.services import settings

router = APIRouter(tags=["structure"])


def site_out(s: Site) -> SiteOut:
    return SiteOut(wms_id=str(s.id), code=s.code, name=s.name, timezone=s.timezone, active=s.active)


def warehouse_out(w: Warehouse) -> WarehouseOut:
    return WarehouseOut(wms_id=str(w.id), code=w.code, site=w.site.code, name=w.name,
                        settings=settings.effective(w.settings), active=w.active)


def zone_out(z: Zone) -> ZoneOut:
    return ZoneOut(wms_id=str(z.id), warehouse=z.warehouse.code, code=z.code, name=z.name,
                   kind=z.kind, active=z.active)


def location_out(l: Location) -> LocationOut:
    return LocationOut(
        wms_id=str(l.id), warehouse=l.warehouse.code, code=l.code, zone=l.zone.code,
        type=l.type, access=l.access, mixing=l.mixing, capacity=l.capacity,
        capacity_uom=l.capacity_uom, pick_sequence=l.pick_sequence, barcode=l.barcode,
        active=l.active,
    )


def get_warehouse(db, code: str, field: str = "warehouse") -> Warehouse:
    wh = db.execute(select(Warehouse).where(Warehouse.code == code)).scalar_one_or_none()
    if wh is None:
        raise FieldError(field, f"unknown warehouse {code}")
    return wh


def _apply(obj, data: dict, skip=()):
    for k, v in data.items():
        if k not in skip:
            setattr(obj, k, v)


@router.post("/sites", status_code=202, response_model=envelope.Accepted)
def upsert_site(body: SiteIn, request: Request, db: DB, who: Principal = require("master:write")):
    def work():
        site = db.execute(select(Site).where(Site.code == body.code)).scalar_one_or_none()
        data = body.model_dump(exclude_unset=True, exclude=set(envelope.Envelope.model_fields))
        if site is None:
            site = Site(**data)
            db.add(site)
            status = "created"
        else:
            _apply(site, data)
            status = "updated"
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(site.id), status=status)

    return envelope.handle(db, who, body.message_id, request.url.path, work)


@router.get("/sites", response_model=Page[SiteOut])
def list_sites(db: DB, who: Principal = require("master:read")):
    rows = db.execute(select(Site).order_by(Site.code)).scalars().all()
    return Page(items=[site_out(s) for s in rows], total=len(rows))


@router.post("/warehouses", status_code=202, response_model=envelope.Accepted)
def upsert_warehouse(body: WarehouseIn, request: Request, db: DB,
                     who: Principal = require("master:write")):
    authorise(who, warehouse=body.code, owner=None)

    def work():
        site = db.execute(select(Site).where(Site.code == body.site)).scalar_one_or_none()
        if site is None:
            raise FieldError("site", f"unknown site {body.site}")
        wh = db.execute(select(Warehouse).where(Warehouse.code == body.code)).scalar_one_or_none()
        data = body.model_dump(exclude_unset=True,
                               exclude=set(envelope.Envelope.model_fields) | {"site"})
        if wh is None:
            wh = Warehouse(site=site, **data)
            db.add(wh)
            status = "created"
        else:
            wh.site = site
            _apply(wh, data)
            status = "updated"
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(wh.id), status=status)

    return envelope.handle(db, who, body.message_id, request.url.path, work)


@router.get("/warehouses", response_model=Page[WarehouseOut])
def list_warehouses(db: DB, who: Principal = require("master:read")):
    rows = db.execute(select(Warehouse).order_by(Warehouse.code)).scalars().all()
    rows = [w for w in rows if who.allows_warehouse(w.code)]
    return Page(items=[warehouse_out(w) for w in rows], total=len(rows))


@router.get("/warehouses/{code}", response_model=WarehouseOut)
def get_warehouse_detail(code: str, db: DB, who: Principal = require("master:read")):
    authorise(who, warehouse=code, owner=None)
    return warehouse_out(get_warehouse(db, code, field="code"))


@router.patch("/warehouses/{code}/settings", response_model=WarehouseOut)
def patch_settings(code: str, patch: dict, db: DB, who: Principal = require("master:write")):
    """Merge these switches into the warehouse. Unknown keys and impossible
    values (hard deletes) are 422."""
    from pydantic import ValidationError

    from wms.api.errors import field_errors
    from wms.services import audit

    authorise(who, warehouse=code, owner=None)
    wh = get_warehouse(db, code, field="code")
    try:
        wh.settings = settings.merge(wh.settings, patch)
    except ValidationError as exc:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=422, content={"errors": field_errors(exc.errors())})
    audit.record(db, actor_type=who.kind, actor=who.name, action="warehouse.settings_changed",
                 target_type="warehouse", target=wh.code, ip=who.ip, detail=patch)
    db.commit()
    return warehouse_out(wh)


@router.post("/zones", status_code=202, response_model=envelope.Accepted)
def upsert_zone(body: ZoneIn, request: Request, db: DB, who: Principal = require("master:write")):
    authorise(who, warehouse=body.warehouse, owner=None)

    def work():
        wh = get_warehouse(db, body.warehouse)
        zone = db.execute(
            select(Zone).where(Zone.warehouse_id == wh.id, Zone.code == body.code)
        ).scalar_one_or_none()
        data = body.model_dump(exclude_unset=True,
                               exclude=set(envelope.Envelope.model_fields) | {"warehouse"})
        if zone is None:
            zone = Zone(warehouse=wh, **data)
            db.add(zone)
            status = "created"
        else:
            _apply(zone, data)
            status = "updated"
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(zone.id), status=status)

    return envelope.handle(db, who, body.message_id, request.url.path, work)


@router.get("/zones", response_model=Page[ZoneOut])
def list_zones(db: DB, warehouse: str = Query(), who: Principal = require("master:read")):
    authorise(who, warehouse=warehouse, owner=None)
    wh = get_warehouse(db, warehouse)
    rows = db.execute(select(Zone).where(Zone.warehouse_id == wh.id).order_by(Zone.code)).scalars().all()
    return Page(items=[zone_out(z) for z in rows], total=len(rows))


@router.post("/locations", status_code=202, response_model=envelope.Accepted)
def upsert_location(body: LocationIn, request: Request, db: DB,
                    who: Principal = require("master:write")):
    authorise(who, warehouse=body.warehouse, owner=None)

    def work():
        wh = get_warehouse(db, body.warehouse)
        zone = db.execute(
            select(Zone).where(Zone.warehouse_id == wh.id, Zone.code == body.zone)
        ).scalar_one_or_none()
        if zone is None:
            raise FieldError("zone", f"unknown zone {body.zone} in {wh.code}")
        loc = db.execute(
            select(Location).where(Location.warehouse_id == wh.id, Location.code == body.code)
        ).scalar_one_or_none()
        data = body.model_dump(
            exclude_unset=True,
            exclude=set(envelope.Envelope.model_fields) | {"warehouse", "zone"},
        )
        if loc is None:
            loc = Location(warehouse=wh, zone=zone, **data)
            db.add(loc)
            status = "created"
        else:
            loc.zone = zone
            _apply(loc, data)
            status = "updated"
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(loc.id), status=status)

    return envelope.handle(db, who, body.message_id, request.url.path, work)


@router.get("/locations", response_model=Page[LocationOut])
def list_locations(
    db: DB, warehouse: str = Query(), zone: str | None = None,
    active: bool | None = None, limit: int = Query(default=500, le=5000), offset: int = 0,
    who: Principal = require("master:read"),
):
    authorise(who, warehouse=warehouse, owner=None)
    wh = get_warehouse(db, warehouse)
    q = select(Location).where(Location.warehouse_id == wh.id)
    if zone:
        q = q.join(Zone).where(Zone.code == zone)
    if active is not None:
        q = q.where(Location.active.is_(active))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(Location.pick_sequence, Location.code).limit(limit).offset(offset)
    ).scalars().all()
    return Page(items=[location_out(l) for l in rows], total=total)
