"""API keys and passwords. Hashes only, never the secret."""
from __future__ import annotations

import hashlib
import hmac
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import ApiClient

KEY_PREFIX = "wms_"


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_api_client(
    session: Session, *, name: str, scopes: list[str], warehouses: list[str],
    owner: str = "DEFAULT", ip_allowlist: list[str] | None = None,
) -> tuple[ApiClient, str]:
    """Returns the client and the raw key. The raw key is shown once and never stored."""
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    client = ApiClient(
        name=name,
        key_prefix=raw[: len(KEY_PREFIX) + 6],
        key_hash=hash_key(raw),
        scopes=scopes,
        warehouses=warehouses,
        owner=owner,
        ip_allowlist=ip_allowlist or [],
    )
    session.add(client)
    session.flush()
    return client, raw


def rotate_api_key(session: Session, client: ApiClient) -> str:
    from sqlalchemy import func

    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    client.key_prefix = raw[: len(KEY_PREFIX) + 6]
    client.key_hash = hash_key(raw)
    client.rotated_at = func.now()
    session.flush()
    return raw


def find_api_client(session: Session, raw: str) -> ApiClient | None:
    if not raw.startswith(KEY_PREFIX):
        return None
    client = session.execute(
        select(ApiClient).where(ApiClient.key_hash == hash_key(raw), ApiClient.active.is_(True))
    ).scalar_one_or_none()
    return client


def has_scope(client: ApiClient, scope: str) -> bool:
    area = scope.split(":")[0]
    return "*" in client.scopes or scope in client.scopes or f"{area}:*" in client.scopes


def allows_warehouse(client: ApiClient, warehouse: str | None) -> bool:
    if warehouse is None:
        return True
    return "*" in client.warehouses or warehouse in client.warehouses


def allows_owner(client: ApiClient, owner: str) -> bool:
    return client.owner == "*" or client.owner == owner


# Password hashing: PBKDF2 from the standard library, no extra dependency.
_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, iterations, salt, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), int(iterations)
    )
    return hmac.compare_digest(candidate.hex(), digest)


def find_supervisor_by_badge(session: Session, badge: str, warehouse: str | None = None):
    """The operator behind a supervisor badge scan, or None."""
    from wms.models import Operator

    op = session.execute(
        select(Operator).where(Operator.badge == badge, Operator.active.is_(True))
    ).scalar_one_or_none()
    if op is None or "supervisor" not in (op.roles or []):
        return None
    if warehouse and not ("*" in (op.warehouses or []) or warehouse in (op.warehouses or [])):
        return None
    return op
