"""Site-wide settings changed from the Settings screen without a restart.

One row in `system_setting`. A key saved there wins; a key not saved falls
back to `.env`, then to the default in `wms.config`. Hosting values (the
database URL, the secret key) stay in `.env` only.

The saved row is cached for a few seconds per process, so the API and the
worker each pick up a change within CACHE_SECONDS."""
from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from wms.config import Settings, get_settings
from wms.models import SystemSetting

log = logging.getLogger("wms.system")

EDITABLE = (
    "message_ttl_hours", "worker_poll_seconds", "worker_http_timeout_seconds", "platen_key",
    "oidc_issuer", "oidc_client_id", "oidc_client_secret", "oidc_redirect_uri", "oidc_scopes",
    "oidc_name", "oidc_create_users", "oidc_default_role",
)
# write-only: the screen is told whether they are set, never what they are
SECRETS = ("platen_key", "oidc_client_secret")

CACHE_SECONDS = 5


class SystemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message_ttl_hours: int | None = Field(default=None, ge=1, le=720)
    worker_poll_seconds: float | None = Field(default=None, ge=0.5, le=300)
    worker_http_timeout_seconds: float | None = Field(default=None, ge=1, le=120)
    platen_key: str | None = Field(default=None, max_length=500)
    oidc_issuer: str | None = Field(default=None, max_length=500)
    oidc_client_id: str | None = Field(default=None, max_length=500)
    oidc_client_secret: str | None = Field(default=None, max_length=500)
    oidc_redirect_uri: str | None = Field(default=None, max_length=500)
    oidc_scopes: str | None = Field(default=None, max_length=500)
    oidc_name: str | None = Field(default=None, max_length=500)
    oidc_create_users: bool | None = None
    oidc_default_role: str | None = None

    @field_validator("oidc_issuer", "oidc_redirect_uri")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        if v and not v.startswith(("https://", "http://")):
            raise ValueError("must start with https:// or http://")
        return v

    @field_validator("oidc_default_role")
    @classmethod
    def _role(cls, v: str | None) -> str | None:
        from wms.services.sessions import ROLE_SCOPES

        if v is not None and v not in ROLE_SCOPES:
            raise ValueError(f"must be one of {', '.join(ROLE_SCOPES)}")
        return v


_cache: tuple[float, dict] | None = None


def forget() -> None:
    global _cache
    _cache = None


def _stored() -> dict:
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < CACHE_SECONDS:
        return _cache[1]
    from wms.db import get_sessionmaker

    try:
        with get_sessionmaker()() as db:
            stored = load(db)
    except Exception as exc:  # no table yet, or no database: .env it is
        log.debug("system settings unavailable, using .env: %s", exc)
        stored = {}
    _cache = (now, stored)
    return stored


def current() -> Settings:
    """The settings in force: saved values over `.env` over defaults."""
    stored = {k: v for k, v in _stored().items() if k in EDITABLE}
    return get_settings().model_copy(update=stored)


def load(db: Session) -> dict:
    row = db.get(SystemSetting, 1)
    return dict(row.settings) if row is not None else {}


def save(db: Session, patch: dict) -> dict:
    """Validate and apply a patch. A null removes the saved value. Raises
    pydantic's ValidationError on a bad key or value. Does not commit."""
    parsed = SystemPatch.model_validate(patch)
    row = db.get(SystemSetting, 1)
    if row is None:
        row = SystemSetting(id=1, settings={})
        db.add(row)
    stored = dict(row.settings or {})
    for key in parsed.model_fields_set:
        value = getattr(parsed, key)
        if value is None:
            stored.pop(key, None)
        else:
            stored[key] = value
    row.settings = stored
    row.updated_at = datetime.now(UTC)
    db.flush()
    return stored


def redacted(patch: dict) -> dict:
    """The patch as the audit log sees it: no secret values."""
    out = dict(patch)
    for key in SECRETS:
        if key in out:
            out[key] = "(cleared)" if out[key] is None else "(set)"
    return out


def describe(db: Session) -> dict:
    stored = {k: v for k, v in load(db).items() if k in EDITABLE}
    env = get_settings()
    effective = env.model_copy(update=stored)
    return {
        "values": {k: getattr(effective, k) for k in EDITABLE if k not in SECRETS},
        "secrets": {k: bool(getattr(effective, k)) for k in SECRETS},
        "source": {k: "settings" if k in stored else "env" if k in env.model_fields_set
                   else "default" for k in EDITABLE},
    }
