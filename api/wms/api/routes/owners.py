"""Owners: whose stock it is. One to start with; a third-party warehouse
switches on more."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from wms.api.deps import DB, Principal, require
from wms.api.errors import FieldError, NotFound
from wms.api.schemas import Page
from wms.models import Owner
from wms.services import audit

router = APIRouter(tags=["owners"])


class OwnerIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(min_length=1, max_length=32, pattern=r"^[A-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=200)
    contact: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    settings: dict = Field(default_factory=dict)
    note: str | None = Field(default=None, max_length=500)
    active: bool = True


class OwnerOut(BaseModel):
    wms_id: str
    code: str
    name: str
    contact: str | None
    email: str | None
    phone: str | None
    settings: dict
    note: str | None
    active: bool
    created_at: datetime


def owner_out(o: Owner) -> OwnerOut:
    return OwnerOut(wms_id=str(o.id), code=o.code, name=o.name, contact=o.contact, email=o.email,
                    phone=o.phone, settings=o.settings, note=o.note, active=o.active,
                    created_at=o.created_at)


def _get(db, code: str) -> Owner:
    o = db.execute(select(Owner).where(Owner.code == code)).scalar_one_or_none()
    if o is None:
        raise NotFound(f"no owner {code}")
    return o


@router.post("/owners", response_model=OwnerOut, responses={201: {"model": OwnerOut}})
def upsert_owner(body: OwnerIn, db: DB, who: Principal = require("access:admin")):
    """Create or update by code. Codes are shouty so they read well on a label."""
    from fastapi.responses import JSONResponse

    existing = db.execute(select(Owner).where(Owner.code == body.code)).scalar_one_or_none()
    if existing is None:
        owner = Owner(**body.model_dump())
        db.add(owner)
        created = True
    else:
        owner = existing
        for k, v in body.model_dump(exclude={"code"}).items():
            setattr(owner, k, v)
        created = False
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name,
                 action="owner.created" if created else "owner.updated",
                 target_type="owner", target=owner.code, ip=who.ip)
    db.commit()
    return JSONResponse(status_code=201 if created else 200,
                        content=owner_out(owner).model_dump(mode="json"))


@router.get("/owners", response_model=Page[OwnerOut])
def list_owners(db: DB, active: bool | None = None, who: Principal = require("master:read")):
    q = select(Owner)
    if active is not None:
        q = q.where(Owner.active.is_(active))
    rows = db.execute(q.order_by(Owner.code)).scalars().all()
    return Page(items=[owner_out(o) for o in rows], total=len(rows))


@router.get("/owners/{code}", response_model=OwnerOut)
def get_owner(code: str, db: DB, who: Principal = require("master:read")):
    return owner_out(_get(db, code))


@router.post("/owners/{code}/deactivate", response_model=OwnerOut)
def deactivate_owner(code: str, db: DB, who: Principal = require("access:admin")):
    """Deactivated, never deleted: their stock and history stay put."""
    owner = _get(db, code)
    if owner.code == "DEFAULT":
        raise FieldError("code", "DEFAULT is the owner everything falls back to; it stays on")
    owner.active = False
    audit.record(db, actor_type=who.kind, actor=who.name, action="owner.deactivated",
                 target_type="owner", target=owner.code, ip=who.ip)
    db.commit()
    return owner_out(owner)


@router.post("/owners/{code}/reactivate", response_model=OwnerOut)
def reactivate_owner(code: str, db: DB, who: Principal = require("access:admin")):
    owner = _get(db, code)
    owner.active = True
    audit.record(db, actor_type=who.kind, actor=who.name, action="owner.reactivated",
                 target_type="owner", target=owner.code, ip=who.ip)
    db.commit()
    return owner_out(owner)
