from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from wms.api.errors import Forbidden
from wms.db import get_sessionmaker
from wms.models import ApiClient, Operator, User
from wms.services import access, sessions


def get_db():
    with get_sessionmaker()() as session:
        yield session


DB = Annotated[Session, Depends(get_db)]


@dataclass(slots=True)
class Principal:
    """Whoever is calling: a system with an API key, or a person with a session."""

    kind: str  # api_client | user
    id: int
    name: str
    scopes: list[str]
    warehouses: list[str]
    owner: str
    role: str | None = None
    user: User | None = None
    api_client: ApiClient | None = None
    operator: Operator | None = None
    device: str | None = None
    ip: str | None = None
    _extra: dict = field(default_factory=dict)

    @property
    def api_client_id(self) -> int | None:
        return self.api_client.id if self.api_client else None

    @property
    def actor(self) -> str:
        return self.name

    def has_scope(self, scope: str) -> bool:
        area = scope.split(":")[0]
        return "*" in self.scopes or scope in self.scopes or f"{area}:*" in self.scopes

    def allows_warehouse(self, warehouse: str | None) -> bool:
        return warehouse is None or "*" in self.warehouses or warehouse in self.warehouses

    def allows_owner(self, owner: str) -> bool:
        return self.owner == "*" or self.owner == owner


def client_ip(request: Request) -> str | None:
    """The caller's IP as Caddy saw it, or None if it is not a real address."""
    import ipaddress

    forwarded = request.headers.get("x-forwarded-for", "")
    candidate = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else "")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _unauthorised(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def get_principal(
    request: Request, db: DB, authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _unauthorised("missing bearer token")
    raw = authorization.split(" ", 1)[1].strip()
    ip = client_ip(request)

    if raw.startswith(sessions.ACCESS_PREFIX):
        user_id = sessions.read_access_token(raw)
        user = db.get(User, user_id) if user_id else None
        if user is None or not user.active:
            raise _unauthorised("session expired or invalid")
        return Principal(
            kind="user", id=user.id, name=user.username, scopes=sessions.scopes_for(user.role),
            warehouses=list(user.warehouses or []), owner=user.owner or "*", role=user.role,
            user=user, ip=ip,
        )

    if raw.startswith(sessions.OPERATOR_PREFIX):
        parsed = sessions.read_operator_token(raw)
        op = db.get(Operator, parsed[0]) if parsed else None
        if op is None or not op.active or (op.locked_until and op.locked_until > datetime.now(UTC)):
            raise _unauthorised("scanner session expired or invalid")
        return Principal(
            kind="operator", id=op.id, name=op.code, scopes=sessions.operator_scopes(op.roles or []),
            warehouses=list(op.warehouses or []), owner="*", role="operator", operator=op,
            device=parsed[1] or None, ip=ip,
        )

    client = access.find_api_client(db, raw)
    if client is None:
        raise _unauthorised("invalid api key")
    if client.ip_allowlist and ip not in client.ip_allowlist:
        raise Forbidden(f"this key may not be used from {ip}")
    client.last_used_at = datetime.now(UTC)
    return Principal(
        kind="api_client", id=client.id, name=client.name, scopes=list(client.scopes),
        warehouses=list(client.warehouses), owner=client.owner, api_client=client, ip=ip,
    )


Who = Annotated[Principal, Depends(get_principal)]


def require(scope: str):
    """Dependency: the caller must carry this scope."""

    def _check(who: Who) -> Principal:
        if not who.has_scope(scope):
            raise Forbidden(f"you do not have the {scope} scope")
        return who

    return Depends(_check)


def authorise(who: Principal, *, warehouse: str | None, owner: str | None) -> None:
    """The caller must be allowed this warehouse and this owner."""
    if not who.allows_warehouse(warehouse):
        raise Forbidden(f"you are not allowed warehouse {warehouse}")
    if owner is not None and not who.allows_owner(owner):
        raise Forbidden(f"you are not allowed owner {owner}")
