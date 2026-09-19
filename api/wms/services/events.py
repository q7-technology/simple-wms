"""Outbound events: one envelope, queued per subscriber, signed on the way out."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import OutboundEvent, Subscriber


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _matches(pattern: str, event_type: str) -> bool:
    """`*` matches all; `transfer.*` matches every transfer event."""
    if pattern == "*" or pattern == event_type:
        return True
    return pattern.endswith(".*") and event_type.startswith(pattern[:-1])


def matching_subscribers(session: Session, event_type: str, warehouse: str | None,
                         owner: str) -> list[Subscriber]:
    subs = session.execute(
        select(Subscriber).where(Subscriber.active.is_(True))
    ).scalars().all()
    out = []
    for s in subs:
        if not any(_matches(pattern, event_type) for pattern in s.event_types):
            continue
        if warehouse and not ("*" in s.warehouses or warehouse in s.warehouses):
            continue
        if not (s.owner == "*" or s.owner == owner):
            continue
        out.append(s)
    return out


def emit(
    session: Session, event_type: str, *, warehouse: str | None, owner: str,
    external_ref: str | None, data: dict[str, Any], occurred_at: datetime | None = None,
) -> list[OutboundEvent]:
    """Queue one event per matching subscriber. Nothing is sent here; the
    worker delivers. Runs inside the caller's transaction so an event is only
    ever queued if the change that caused it commits."""
    occurred_at = occurred_at or datetime.now(UTC)
    event_id = uuid.uuid4()
    envelope = {
        "event_id": str(event_id),
        "event_type": event_type,
        "occurred_at": iso_utc(occurred_at),
        "warehouse": warehouse,
        "owner": owner,
        "external_ref": external_ref,
        "data": data,
    }
    rows = []
    for sub in matching_subscribers(session, event_type, warehouse, owner):
        row = OutboundEvent(
            event_id=event_id,
            subscriber_id=sub.id,
            event_type=event_type,
            occurred_at=occurred_at,
            warehouse=warehouse,
            owner=owner,
            external_ref=external_ref,
            payload=envelope,
            status="pending",
            attempts=0,
            next_attempt_at=occurred_at,
        )
        session.add(row)
        rows.append(row)
    session.flush()
    return rows
