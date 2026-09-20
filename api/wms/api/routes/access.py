"""Users, operators, devices and the audit log: the Users screen.
Deactivate, never delete. Plain REST from a signed-in admin."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from wms.api.deps import DB, Principal, require
from wms.api.errors import FieldError, NotFound
from wms.api.schemas import Page
from wms.models import AuditLog, Device, Operator, User, Warehouse
from wms.services import access, audit

router = APIRouter(tags=["access"])

Role = Literal["picker", "receiver", "supervisor", "inventory_controller", "admin"]
OperatorRole = Literal["picker", "packer", "receiver", "counter", "supervisor"]


# --- users ---------------------------------------------------------------

class UserIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(max_length=64, pattern=r"^[a-z0-9._-]+$")
    display_name: str = Field(max_length=120)
    email: str | None = Field(default=None, max_length=200)
    role: Role = "supervisor"
    warehouses: list[str] = Field(default_factory=lambda: ["*"])
    # "*" for our own people; an owner code pins a third-party portal user
    owner: str = Field(default="*", max_length=32)
    password: str = Field(min_length=12, max_length=200)


class UserOut(BaseModel):
    wms_id: str
    username: str
    display_name: str
    email: str | None
    role: str
    warehouses: list[str]
    owner: str
    active: bool
    two_factor: bool
    locked: bool
    created_at: datetime
    last_login_at: datetime | None


class PasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=12, max_length=200)


def user_out(u: User) -> UserOut:
    return UserOut(
        wms_id=str(u.id), username=u.username, display_name=u.display_name, email=u.email,
        role=u.role, warehouses=list(u.warehouses or []), owner=u.owner or "*", active=u.active,
        two_factor=bool(u.totp_secret),
        locked=bool(u.locked_until and u.locked_until > datetime.now(UTC)),
        created_at=u.created_at, last_login_at=u.last_login_at,
    )


def _get_user(db, id: int) -> User:
    u = db.get(User, id)
    if u is None:
        raise NotFound(f"no user {id}")
    return u


@router.post("/users", status_code=201, response_model=UserOut)
def create_user(body: UserIn, db: DB, who: Principal = require("access:admin")):
    if db.execute(select(User).where(User.username == body.username)).scalar_one_or_none():
        raise FieldError("username", f"{body.username} is taken")
    u = User(
        username=body.username, display_name=body.display_name, email=body.email,
        role=body.role, warehouses=body.warehouses, owner=body.owner,
        password_hash=access.hash_password(body.password),
    )
    db.add(u)
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.created",
                 target_type="user", target=u.username, ip=who.ip, detail={"role": u.role})
    db.commit()
    return user_out(u)


@router.get("/users", response_model=Page[UserOut])
def list_users(db: DB, who: Principal = require("access:read")):
    rows = db.execute(select(User).order_by(User.active.desc(), User.username)).scalars().all()
    return Page(items=[user_out(u) for u in rows], total=len(rows))


class UserPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    display_name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    role: Role | None = None
    warehouses: list[str] | None = None
    owner: str | None = Field(default=None, max_length=32)


@router.patch("/users/{id}", response_model=UserOut)
def update_user(id: int, body: UserPatch, db: DB, who: Principal = require("access:admin")):
    u = _get_user(db, id)
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(u, k, v)
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.updated",
                 target_type="user", target=u.username, ip=who.ip, detail=changes)
    db.commit()
    return user_out(u)


@router.post("/users/{id}/deactivate", response_model=UserOut)
def deactivate_user(id: int, db: DB, who: Principal = require("access:admin")):
    u = _get_user(db, id)
    if who.kind == "user" and who.id == u.id:
        raise FieldError("id", "you cannot deactivate your own account")
    u.active = False
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.deactivated",
                 target_type="user", target=u.username, ip=who.ip)
    db.commit()
    return user_out(u)


@router.post("/users/{id}/reactivate", response_model=UserOut)
def reactivate_user(id: int, db: DB, who: Principal = require("access:admin")):
    u = _get_user(db, id)
    u.active = True
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.reactivated",
                 target_type="user", target=u.username, ip=who.ip)
    db.commit()
    return user_out(u)


@router.post("/users/{id}/unlock", response_model=UserOut)
def unlock_user(id: int, db: DB, who: Principal = require("access:admin")):
    """Let someone back in after too many wrong passwords."""
    u = _get_user(db, id)
    u.failed_attempts = 0
    u.locked_until = None
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.unlocked",
                 target_type="user", target=u.username, ip=who.ip)
    db.commit()
    return user_out(u)


@router.post("/users/{id}/clear-2fa", response_model=UserOut)
def clear_two_factor(id: int, db: DB, who: Principal = require("access:admin")):
    """For a lost phone. They set it up again next time they sign in."""
    u = _get_user(db, id)
    u.totp_secret = None
    u.totp_pending = None
    u.totp_last_step = None
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.2fa_cleared",
                 target_type="user", target=u.username, ip=who.ip)
    db.commit()
    return user_out(u)


@router.post("/users/{id}/password", response_model=UserOut)
def set_password(id: int, body: PasswordIn, db: DB, who: Principal = require("access:admin")):
    u = _get_user(db, id)
    u.password_hash = access.hash_password(body.password)
    audit.record(db, actor_type=who.kind, actor=who.name, action="user.password_set",
                 target_type="user", target=u.username, ip=who.ip)
    db.commit()
    return user_out(u)


# --- operators -----------------------------------------------------------

class OperatorIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(max_length=32)
    name: str = Field(max_length=120)
    pin: str = Field(min_length=4, max_length=8, pattern=r"^[0-9]+$")
    badge: str | None = Field(default=None, max_length=128)
    roles: list[OperatorRole] = Field(min_length=1)
    warehouses: list[str] = Field(min_length=1)


class OperatorOut(BaseModel):
    wms_id: str
    code: str
    name: str
    badge: str | None
    roles: list[str]
    warehouses: list[str]
    active: bool
    locked: bool
    failed_attempts: int
    created_at: datetime


class PinIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pin: str = Field(min_length=4, max_length=8, pattern=r"^[0-9]+$")


def operator_out(o: Operator) -> OperatorOut:
    from datetime import UTC

    locked = bool(o.locked_until and o.locked_until > datetime.now(UTC))
    return OperatorOut(
        wms_id=str(o.id), code=o.code, name=o.name, badge=o.badge, roles=list(o.roles or []),
        warehouses=list(o.warehouses or []), active=o.active, locked=locked,
        failed_attempts=o.failed_attempts, created_at=o.created_at,
    )


def _get_operator(db, id: int) -> Operator:
    o = db.get(Operator, id)
    if o is None:
        raise NotFound(f"no operator {id}")
    return o


@router.post("/operators", status_code=201, response_model=OperatorOut)
def create_operator(body: OperatorIn, db: DB, who: Principal = require("access:admin")):
    if db.execute(select(Operator).where(Operator.code == body.code)).scalar_one_or_none():
        raise FieldError("code", f"operator {body.code} already exists")
    if body.badge and db.execute(select(Operator).where(Operator.badge == body.badge)).scalar_one_or_none():
        raise FieldError("badge", f"badge {body.badge} belongs to another operator")
    o = Operator(
        code=body.code, name=body.name, pin_hash=access.hash_password(body.pin),
        badge=body.badge, roles=body.roles, warehouses=body.warehouses,
    )
    db.add(o)
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name, action="operator.created",
                 target_type="operator", target=o.code, ip=who.ip, detail={"roles": body.roles})
    db.commit()
    return operator_out(o)


@router.get("/operators", response_model=Page[OperatorOut])
def list_operators(db: DB, who: Principal = require("access:read")):
    rows = db.execute(select(Operator).order_by(Operator.active.desc(), Operator.code)).scalars().all()
    return Page(items=[operator_out(o) for o in rows], total=len(rows))


class OperatorPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str | None = Field(default=None, max_length=120)
    badge: str | None = Field(default=None, max_length=128)
    roles: list[OperatorRole] | None = None
    warehouses: list[str] | None = None


@router.patch("/operators/{id}", response_model=OperatorOut)
def update_operator(id: int, body: OperatorPatch, db: DB, who: Principal = require("access:admin")):
    o = _get_operator(db, id)
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(o, k, v)
    audit.record(db, actor_type=who.kind, actor=who.name, action="operator.updated",
                 target_type="operator", target=o.code, ip=who.ip, detail=changes)
    db.commit()
    return operator_out(o)


@router.post("/operators/{id}/reset-pin", response_model=OperatorOut)
def reset_pin(id: int, body: PinIn, db: DB, who: Principal = require("access:admin")):
    o = _get_operator(db, id)
    o.pin_hash = access.hash_password(body.pin)
    o.failed_attempts = 0
    o.locked_until = None
    audit.record(db, actor_type=who.kind, actor=who.name, action="operator.pin_reset",
                 target_type="operator", target=o.code, ip=who.ip)
    db.commit()
    return operator_out(o)


@router.post("/operators/{id}/unlock", response_model=OperatorOut)
def unlock_operator(id: int, db: DB, who: Principal = require("access:admin")):
    o = _get_operator(db, id)
    o.failed_attempts = 0
    o.locked_until = None
    audit.record(db, actor_type=who.kind, actor=who.name, action="operator.unlocked",
                 target_type="operator", target=o.code, ip=who.ip)
    db.commit()
    return operator_out(o)


@router.post("/operators/{id}/deactivate", response_model=OperatorOut)
def deactivate_operator(id: int, db: DB, who: Principal = require("access:admin")):
    o = _get_operator(db, id)
    o.active = False
    audit.record(db, actor_type=who.kind, actor=who.name, action="operator.deactivated",
                 target_type="operator", target=o.code, ip=who.ip)
    db.commit()
    return operator_out(o)


@router.post("/operators/{id}/reactivate", response_model=OperatorOut)
def reactivate_operator(id: int, db: DB, who: Principal = require("access:admin")):
    o = _get_operator(db, id)
    o.active = True
    audit.record(db, actor_type=who.kind, actor=who.name, action="operator.reactivated",
                 target_type="operator", target=o.code, ip=who.ip)
    db.commit()
    return operator_out(o)


# --- devices -------------------------------------------------------------

class DeviceIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(max_length=64)
    name: str = Field(max_length=120)
    warehouse: str | None = Field(default=None, max_length=32)


class DeviceOut(BaseModel):
    wms_id: str
    code: str
    name: str
    warehouse: str | None
    active: bool
    last_seen_at: datetime | None
    created_at: datetime


def device_out(d: Device, warehouse_code: str | None) -> DeviceOut:
    return DeviceOut(wms_id=str(d.id), code=d.code, name=d.name, warehouse=warehouse_code,
                     active=d.active, last_seen_at=d.last_seen_at, created_at=d.created_at)


def _warehouse_code(db, d: Device) -> str | None:
    return db.get(Warehouse, d.warehouse_id).code if d.warehouse_id else None


@router.post("/devices", status_code=201, response_model=DeviceOut)
def register_device(body: DeviceIn, db: DB, who: Principal = require("access:admin")):
    existing = db.execute(select(Device).where(Device.code == body.code)).scalar_one_or_none()
    wh = None
    if body.warehouse:
        wh = db.execute(select(Warehouse).where(Warehouse.code == body.warehouse)).scalar_one_or_none()
        if wh is None:
            raise FieldError("warehouse", f"unknown warehouse {body.warehouse}")
    if existing is None:
        d = Device(code=body.code, name=body.name, warehouse_id=wh.id if wh else None)
        db.add(d)
        action = "device.registered"
    else:
        d = existing
        d.name = body.name
        d.warehouse_id = wh.id if wh else None
        d.active = True
        action = "device.updated"
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name, action=action,
                 target_type="device", target=d.code, ip=who.ip)
    db.commit()
    return device_out(d, wh.code if wh else None)


@router.get("/devices", response_model=Page[DeviceOut])
def list_devices(db: DB, who: Principal = require("access:read")):
    rows = db.execute(select(Device).order_by(Device.active.desc(), Device.code)).scalars().all()
    return Page(items=[device_out(d, _warehouse_code(db, d)) for d in rows], total=len(rows))


@router.post("/devices/{id}/deactivate", response_model=DeviceOut)
def deactivate_device(id: int, db: DB, who: Principal = require("access:admin")):
    d = db.get(Device, id)
    if d is None:
        raise NotFound(f"no device {id}")
    d.active = False
    audit.record(db, actor_type=who.kind, actor=who.name, action="device.deactivated",
                 target_type="device", target=d.code, ip=who.ip)
    db.commit()
    return device_out(d, _warehouse_code(db, d))


# --- audit log -----------------------------------------------------------

class AuditOut(BaseModel):
    wms_id: str
    at: datetime
    actor_type: str
    actor: str
    action: str
    target_type: str | None
    target: str | None
    device: str | None
    ip: str | None
    detail: dict


@router.get("/audit-log", response_model=Page[AuditOut])
def list_audit(
    db: DB, actor: str | None = None, action: str | None = None,
    limit: int = Query(default=100, le=1000), offset: int = 0,
    who: Principal = require("access:read"),
):
    q = select(AuditLog)
    if actor:
        q = q.where(AuditLog.actor == actor)
    if action:
        q = q.where(AuditLog.action.like(f"{action}%"))
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(AuditLog.id.desc()).limit(limit).offset(offset)).scalars().all()
    return Page(items=[AuditOut(
        wms_id=str(a.id), at=a.at, actor_type=a.actor_type, actor=a.actor, action=a.action,
        target_type=a.target_type, target=a.target, device=a.device,
        ip=str(a.ip) if a.ip else None, detail=a.detail,
    ) for a in rows], total=total)
