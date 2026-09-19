"""Desktop sessions: a short-lived signed access token plus a stored,
rotating refresh token. No extra dependency; HMAC from the standard library."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.config import get_settings
from wms.models import User, UserSession

ACCESS_PREFIX = "wms_s."
ACCESS_TTL_SECONDS = 15 * 60
REFRESH_TTL = timedelta(days=14)

# What each desktop role may do. API keys carry their own scope list.
ROLE_SCOPES: dict[str, list[str]] = {
    "admin": ["*"],
    "supervisor": ["master:*", "stock:*", "tasks:*", "integration:read", "access:read"],
    "inventory_controller": ["master:*", "stock:*", "tasks:*"],
    "receiver": ["master:read", "stock:read", "tasks:*"],
    "picker": ["master:read", "stock:read", "tasks:*"],
}


def scopes_for(role: str) -> list[str]:
    return list(ROLE_SCOPES.get(role, ["master:read", "stock:read"]))


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: str) -> str:
    key = get_settings().secret_key.encode()
    return _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest())


def issue_access_token(user: User, now: datetime | None = None,
                       ttl: int = ACCESS_TTL_SECONDS, session_id: int | None = None) -> str:
    now = now or datetime.now(UTC)
    payload = _b64(json.dumps(
        {
            "uid": user.id,
            "sid": session_id,
            "exp": int((now + timedelta(seconds=ttl)).timestamp()),
            "n": secrets.token_hex(4),
        },
        separators=(",", ":"),
    ).encode())
    return f"{ACCESS_PREFIX}{payload}.{_sign(payload)}"


def read_access_token(token: str, now: datetime | None = None) -> int | None:
    """Returns the user id, or None if the token is not ours, tampered or expired."""
    if not token.startswith(ACCESS_PREFIX):
        return None
    try:
        payload, sig = token[len(ACCESS_PREFIX):].split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    try:
        data = json.loads(_unb64(payload))
    except (ValueError, UnicodeDecodeError):
        return None
    now = now or datetime.now(UTC)
    if int(data.get("exp", 0)) <= int(now.timestamp()):
        return None
    return int(data["uid"])


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def start_session(db: Session, user: User, *, ip: str | None = None,
                  user_agent: str | None = None) -> tuple[UserSession, str]:
    raw = "wms_r." + secrets.token_urlsafe(32)
    row = UserSession(
        user_id=user.id, refresh_hash=_hash(raw), expires_at=datetime.now(UTC) + REFRESH_TTL,
        ip=ip, user_agent=(user_agent or "")[:300] or None,
    )
    db.add(row)
    db.flush()
    return row, raw


def find_session(db: Session, raw_refresh: str) -> UserSession | None:
    row = db.execute(
        select(UserSession).where(UserSession.refresh_hash == _hash(raw_refresh))
    ).scalar_one_or_none()
    if row is None or row.revoked_at is not None or row.expires_at <= datetime.now(UTC):
        return None
    return row


def rotate_session(db: Session, row: UserSession) -> str:
    """Spend this refresh token and hand out a new one on the same session row."""
    raw = "wms_r." + secrets.token_urlsafe(32)
    row.refresh_hash = _hash(raw)
    row.expires_at = datetime.now(UTC) + REFRESH_TTL
    row.last_used_at = datetime.now(UTC)
    db.flush()
    return raw


def revoke_session(db: Session, row: UserSession) -> None:
    row.revoked_at = datetime.now(UTC)
    db.flush()
