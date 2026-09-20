"""The shared inbound envelope and message_id de-duplication."""
from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from wms.config import get_settings
from wms.models import InboundMessage


class Envelope(BaseModel):
    """Every inbound body carries these."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message_id: uuid.UUID
    external_ref: str | None = Field(default=None, max_length=64)
    warehouse: str | None = Field(default=None, max_length=32)
    owner: str = Field(default="DEFAULT", max_length=32)


class Accepted(BaseModel):
    message_id: uuid.UUID
    wms_id: str
    status: Literal["created", "updated", "accepted"]


def _lookup(db: Session, message_id: uuid.UUID) -> InboundMessage | None:
    ttl = timedelta(hours=get_settings().message_ttl_hours)
    row = db.get(InboundMessage, message_id)
    if row is None:
        return None
    if row.received_at < datetime.now(UTC) - ttl:
        return None
    return row


def _replay(db: Session, existing: InboundMessage) -> JSONResponse:
    existing.duplicates += 1
    existing.last_duplicate_at = datetime.now(UTC)
    db.commit()
    return JSONResponse(status_code=existing.status_code, content=existing.response)


def handle(
    db: Session, who, message_id: uuid.UUID, path: str, work: Callable[[], BaseModel],
    status_code: int = 202,
) -> JSONResponse:
    """Run `work` once per message_id. A repeat returns the original reply
    and does nothing. The reply is stored in the same transaction as the work,
    so either both land or neither does."""
    existing = _lookup(db, message_id)
    if existing is not None:
        return _replay(db, existing)

    reply = work()
    content = reply.model_dump(mode="json")
    db.add(InboundMessage(
        message_id=message_id, api_client_id=who.api_client_id, path=path,
        status_code=status_code, response=content,
    ))
    try:
        db.commit()
    except IntegrityError:
        # Two identical messages arrived at once; the other one won.
        db.rollback()
        existing = _lookup(db, message_id)
        if existing is None:
            raise
        return _replay(db, existing)
    return JSONResponse(status_code=status_code, content=content)
