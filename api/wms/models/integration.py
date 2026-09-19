from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from wms.models.base import Base, created_at_column


class Subscriber(Base):
    __tablename__ = "subscriber"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    url: Mapped[str] = mapped_column(String(500))
    secret: Mapped[str] = mapped_column(String(128))
    event_types: Mapped[list] = mapped_column(JSONB, default=list)  # ["*"] or names
    warehouses: Mapped[list] = mapped_column(JSONB, default=lambda: ["*"])
    owner: Mapped[str] = mapped_column(String(32), default="*")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()


class OutboundEvent(Base):
    """The event queue. One row per subscriber per event, drained by the worker."""

    __tablename__ = "outbound_event"
    __table_args__ = (Index("ix_outbound_event_due", "status", "next_attempt_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    subscriber_id: Mapped[int] = mapped_column(ForeignKey("subscriber.id"))
    event_type: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    warehouse: Mapped[str | None] = mapped_column(String(32))
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")
    external_ref: Mapped[str | None] = mapped_column(String(64), index=True)
    payload: Mapped[dict] = mapped_column(JSONB)  # the full envelope as sent
    # pending, delivered, failed
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(500))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_column()

    subscriber: Mapped[Subscriber] = relationship()


class PrintJob(Base):
    """Same queue idea for Platen. The WMS never renders a label."""

    __tablename__ = "print_job"
    __table_args__ = (Index("ix_print_job_due", "status", "next_attempt_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True)
    template: Mapped[str] = mapped_column(String(64))
    version: Mapped[str] = mapped_column(String(16))
    printer: Mapped[str] = mapped_column(String(64))
    copies: Mapped[int] = mapped_column(Integer, default=1)
    reference: Mapped[dict] = mapped_column(JSONB, default=dict)
    data: Mapped[dict] = mapped_column(JSONB, default=dict)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("task.id"))
    # pending, sent, accepted, printed, failed
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(500))
    printed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_column()


class InboundMessage(Base):
    """Remembers every message_id and the reply it got, for the dedup window."""

    __tablename__ = "inbound_message"

    message_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    api_client_id: Mapped[int | None] = mapped_column(ForeignKey("api_client.id"))
    path: Mapped[str] = mapped_column(String(200))
    status_code: Mapped[int] = mapped_column(Integer)
    response: Mapped[dict] = mapped_column(JSONB)
    received_at: Mapped[datetime] = created_at_column()
    # how many times the same message_id came back, and when it last did
    duplicates: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_duplicate_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
