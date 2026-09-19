"""API keys, subscribers and the event queue: the Integrations screen.
Plain REST from a signed-in admin; no message envelope."""
from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from wms.api.deps import DB, Principal, require
from wms.api.errors import FieldError, NotFound
from wms.api.schemas import Page
from wms.models import ApiClient, InboundMessage, OutboundEvent, Subscriber
from wms.services import access, audit

router = APIRouter(tags=["integration"])


# --- api clients ---------------------------------------------------------

class ApiClientIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(max_length=120)
    scopes: list[str] = Field(min_length=1)
    warehouses: list[str] = Field(min_length=1)
    owner: str = Field(default="DEFAULT", max_length=32)
    ip_allowlist: list[str] = Field(default_factory=list)


class ApiClientOut(BaseModel):
    wms_id: str
    name: str
    key_prefix: str
    scopes: list[str]
    warehouses: list[str]
    owner: str
    ip_allowlist: list[str]
    active: bool
    created_at: datetime
    rotated_at: datetime | None
    last_used_at: datetime | None
    duplicates_24h: int = 0
    last_duplicate_at: datetime | None = None


class ApiClientWithKey(ApiClientOut):
    key: str


def _dupes(db, client_id: int) -> tuple[int, datetime | None]:
    since = datetime.now(UTC) - timedelta(hours=24)
    row = db.execute(
        select(func.coalesce(func.sum(InboundMessage.duplicates), 0),
               func.max(InboundMessage.last_duplicate_at))
        .where(InboundMessage.api_client_id == client_id, InboundMessage.received_at >= since)
    ).one()
    return int(row[0]), row[1]


def api_client_out(db, c: ApiClient, key: str | None = None) -> ApiClientOut:
    dupes, last = _dupes(db, c.id)
    data = dict(
        wms_id=str(c.id), name=c.name, key_prefix=c.key_prefix, scopes=c.scopes,
        warehouses=c.warehouses, owner=c.owner, ip_allowlist=c.ip_allowlist, active=c.active,
        created_at=c.created_at, rotated_at=c.rotated_at, last_used_at=c.last_used_at,
        duplicates_24h=dupes, last_duplicate_at=last,
    )
    return ApiClientWithKey(key=key, **data) if key else ApiClientOut(**data)


@router.post("/api-clients", status_code=201, response_model=ApiClientWithKey)
def create_api_client(body: ApiClientIn, db: DB, who: Principal = require("integration:admin")):
    if db.execute(select(ApiClient).where(ApiClient.name == body.name)).scalar_one_or_none():
        raise FieldError("name", f"an API client called {body.name} already exists")
    client, raw = access.create_api_client(
        db, name=body.name, scopes=body.scopes, warehouses=body.warehouses,
        owner=body.owner, ip_allowlist=body.ip_allowlist,
    )
    audit.record(db, actor_type=who.kind, actor=who.name, action="api_client.created",
                 target_type="api_client", target=client.name, ip=who.ip,
                 detail={"scopes": body.scopes, "warehouses": body.warehouses})
    db.commit()
    return api_client_out(db, client, key=raw)


@router.get("/api-clients", response_model=Page[ApiClientOut])
def list_api_clients(db: DB, who: Principal = require("integration:read")):
    rows = db.execute(select(ApiClient).order_by(ApiClient.name)).scalars().all()
    return Page(items=[api_client_out(db, c) for c in rows], total=len(rows))


def _get_client(db, id: int) -> ApiClient:
    client = db.get(ApiClient, id)
    if client is None:
        raise NotFound(f"no API client {id}")
    return client


@router.post("/api-clients/{id}/rotate", response_model=ApiClientWithKey)
def rotate_api_client(id: int, db: DB, who: Principal = require("integration:admin")):
    client = _get_client(db, id)
    raw = access.rotate_api_key(db, client)
    client.active = True
    audit.record(db, actor_type=who.kind, actor=who.name, action="api_client.rotated",
                 target_type="api_client", target=client.name, ip=who.ip)
    db.commit()
    return api_client_out(db, client, key=raw)


@router.post("/api-clients/{id}/revoke", response_model=ApiClientOut)
def revoke_api_client(id: int, db: DB, who: Principal = require("integration:admin")):
    client = _get_client(db, id)
    client.active = False
    audit.record(db, actor_type=who.kind, actor=who.name, action="api_client.revoked",
                 target_type="api_client", target=client.name, ip=who.ip)
    db.commit()
    return api_client_out(db, client)


# --- subscribers ---------------------------------------------------------

class SubscriberIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(max_length=120)
    url: str = Field(max_length=500, pattern=r"^https?://")
    secret: str | None = Field(default=None, min_length=16, max_length=128)
    event_types: list[str] = Field(min_length=1)
    warehouses: list[str] = Field(default_factory=lambda: ["*"])
    owner: str = Field(default="*", max_length=32)
    active: bool = True


class SubscriberOut(BaseModel):
    wms_id: str
    name: str
    url: str
    event_types: list[str]
    warehouses: list[str]
    owner: str
    active: bool
    created_at: datetime
    status: str  # idle, ok, retrying, failed
    last_delivery_at: datetime | None
    pending: int
    failed: int


class SubscriberWithSecret(SubscriberOut):
    secret: str


def _subscriber_health(db, sub_id: int) -> dict:
    counts = dict(db.execute(
        select(OutboundEvent.status, func.count()).where(OutboundEvent.subscriber_id == sub_id)
        .group_by(OutboundEvent.status)
    ).all())
    retrying = db.execute(
        select(func.count()).where(
            OutboundEvent.subscriber_id == sub_id, OutboundEvent.status == "pending",
            OutboundEvent.last_error.is_not(None))
    ).scalar_one()
    last = db.execute(
        select(func.max(OutboundEvent.delivered_at)).where(OutboundEvent.subscriber_id == sub_id)
    ).scalar_one()
    if counts.get("failed"):
        status = "failed"
    elif retrying:
        status = "retrying"
    elif last:
        status = "ok"
    else:
        status = "idle"
    return dict(status=status, last_delivery_at=last, pending=counts.get("pending", 0),
                failed=counts.get("failed", 0))


def subscriber_out(db, s: Subscriber, secret: str | None = None) -> SubscriberOut:
    data = dict(
        wms_id=str(s.id), name=s.name, url=s.url, event_types=s.event_types,
        warehouses=s.warehouses, owner=s.owner, active=s.active, created_at=s.created_at,
        **_subscriber_health(db, s.id),
    )
    return SubscriberWithSecret(secret=secret, **data) if secret else SubscriberOut(**data)


@router.post("/subscribers", response_model=SubscriberWithSecret | SubscriberOut,
             responses={201: {"model": SubscriberWithSecret}})
def upsert_subscriber(body: SubscriberIn, db: DB, who: Principal = require("integration:admin")):
    from fastapi.responses import JSONResponse

    sub = db.execute(select(Subscriber).where(Subscriber.name == body.name)).scalar_one_or_none()
    data = body.model_dump(exclude_unset=True, exclude={"secret"})
    shown_secret = None
    if sub is None:
        shown_secret = body.secret or secrets.token_urlsafe(32)
        sub = Subscriber(secret=shown_secret, **data)
        db.add(sub)
        created = True
    else:
        for k, v in data.items():
            setattr(sub, k, v)
        if body.secret:
            sub.secret = body.secret
        created = False
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name,
                 action="subscriber.created" if created else "subscriber.updated",
                 target_type="subscriber", target=sub.name, ip=who.ip)
    db.commit()
    out = subscriber_out(db, sub, secret=shown_secret)
    return JSONResponse(status_code=201 if created else 200, content=out.model_dump(mode="json"))


@router.get("/subscribers", response_model=Page[SubscriberOut])
def list_subscribers(db: DB, who: Principal = require("integration:read")):
    rows = db.execute(select(Subscriber).order_by(Subscriber.name)).scalars().all()
    return Page(items=[subscriber_out(db, s) for s in rows], total=len(rows))


# --- event queue ---------------------------------------------------------

class EventOut(BaseModel):
    wms_id: str
    event_id: uuid.UUID
    event_type: str
    subscriber: str
    warehouse: str | None
    owner: str
    external_ref: str | None
    occurred_at: datetime
    status: str
    attempts: int
    next_attempt_at: datetime | None
    last_error: str | None
    delivered_at: datetime | None


def event_out(e: OutboundEvent) -> EventOut:
    return EventOut(
        wms_id=str(e.id), event_id=e.event_id, event_type=e.event_type,
        subscriber=e.subscriber.name, warehouse=e.warehouse, owner=e.owner,
        external_ref=e.external_ref, occurred_at=e.occurred_at, status=e.status,
        attempts=e.attempts, next_attempt_at=e.next_attempt_at if e.status == "pending" else None,
        last_error=e.last_error, delivered_at=e.delivered_at,
    )


@router.get("/events", response_model=Page[EventOut])
def list_events(
    db: DB, status: str | None = None, subscriber: str | None = None,
    event_type: str | None = None, external_ref: str | None = None,
    limit: int = Query(default=100, le=1000), offset: int = 0,
    who: Principal = require("integration:read"),
):
    q = select(OutboundEvent).join(Subscriber)
    if status:
        q = q.where(OutboundEvent.status == status)
    if subscriber:
        q = q.where(Subscriber.name == subscriber)
    if event_type:
        q = q.where(OutboundEvent.event_type == event_type)
    if external_ref:
        q = q.where(OutboundEvent.external_ref == external_ref)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(OutboundEvent.id.desc()).limit(limit).offset(offset)).scalars().all()
    return Page(items=[event_out(e) for e in rows], total=total)


@router.get("/events/{id}", response_model=EventOut)
def get_event(id: int, db: DB, who: Principal = require("integration:read")):
    e = db.get(OutboundEvent, id)
    if e is None:
        raise NotFound(f"no event {id}")
    return event_out(e)


class EventPayload(EventOut):
    payload: dict


@router.post("/events/{id}/retry", response_model=EventOut)
def retry_event(id: int, db: DB, who: Principal = require("integration:admin")):
    """Retry now: back to pending with a clean attempt count."""
    e = db.get(OutboundEvent, id)
    if e is None:
        raise NotFound(f"no event {id}")
    if e.status == "delivered":
        raise FieldError("status", "this event was delivered; nothing to retry")
    e.status = "pending"
    e.attempts = 0
    e.next_attempt_at = datetime.now(UTC)
    audit.record(db, actor_type=who.kind, actor=who.name, action="event.retried",
                 target_type="outbound_event", target=str(e.event_id), ip=who.ip)
    db.commit()
    return event_out(e)
