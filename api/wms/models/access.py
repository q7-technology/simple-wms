from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from wms.models.base import Base, created_at_column


class User(Base):
    """Desktop users. Deactivated, never deleted."""

    __tablename__ = "user"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    email: Mapped[str | None] = mapped_column(String(200))
    display_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str | None] = mapped_column(String(200))
    # picker, receiver, supervisor, inventory_controller, admin
    role: Mapped[str] = mapped_column(String(32), default="supervisor")
    warehouses: Mapped[list] = mapped_column(JSONB, default=list)  # ["*"] or codes
    totp_secret: Mapped[str | None] = mapped_column(String(64))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Operator(Base):
    """Scanner operators: badge scan or operator ID + PIN."""

    __tablename__ = "operator"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)  # op-017
    name: Mapped[str] = mapped_column(String(120))
    pin_hash: Mapped[str | None] = mapped_column(String(200))
    badge: Mapped[str | None] = mapped_column(String(128), unique=True)
    roles: Mapped[list] = mapped_column(JSONB, default=list)  # picker, packer, receiver, counter, supervisor
    warehouses: Mapped[list] = mapped_column(JSONB, default=list)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("user.id"))
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()


class Device(Base):
    """Known scanners. Only registered devices may log in."""

    __tablename__ = "device"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)  # SCN-BAL-07
    name: Mapped[str] = mapped_column(String(120))
    warehouse_id: Mapped[int | None] = mapped_column(ForeignKey("warehouse.id"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_column()


class ApiClient(Base):
    """One scoped key per system. Hash stored, never the key."""

    __tablename__ = "api_client"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    key_prefix: Mapped[str] = mapped_column(String(12))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scopes: Mapped[list] = mapped_column(JSONB, default=list)  # ["*"] or "area:verb"
    warehouses: Mapped[list] = mapped_column(JSONB, default=list)  # ["*"] or codes
    owner: Mapped[str] = mapped_column(String(32), default="DEFAULT")  # or "*"
    ip_allowlist: Mapped[list] = mapped_column(JSONB, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = created_at_column()
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditLog(Base):
    """Insert-only. Logins, failed logins, key use, permission changes."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = created_at_column()
    # user, operator, api_client, system
    actor_type: Mapped[str] = mapped_column(String(16))
    actor: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str | None] = mapped_column(String(32))
    target: Mapped[str | None] = mapped_column(String(64))
    device: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(INET)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)


class UserSession(Base):
    """A desktop session: the refresh token (hashed) that mints short-lived access tokens."""

    __tablename__ = "user_session"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), index=True)
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = created_at_column()
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
