from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from wms.api.errors import Forbidden
from wms.db import get_sessionmaker
from wms.models import ApiClient
from wms.services import access


def get_db():
    with get_sessionmaker()() as session:
        yield session


DB = Annotated[Session, Depends(get_db)]


def get_client(db: DB, authorization: Annotated[str | None, Header()] = None) -> ApiClient:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401, detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    raw = authorization.split(" ", 1)[1].strip()
    client = access.find_api_client(db, raw)
    if client is None:
        raise HTTPException(
            status_code=401, detail="invalid api key", headers={"WWW-Authenticate": "Bearer"}
        )
    return client


Client = Annotated[ApiClient, Depends(get_client)]


def require(scope: str):
    """Dependency: the key must carry this scope."""

    def _check(client: Client) -> ApiClient:
        if not access.has_scope(client, scope):
            raise Forbidden(f"this key does not have the {scope} scope")
        return client

    return Depends(_check)


def authorise(client: ApiClient, *, warehouse: str | None, owner: str | None) -> None:
    """The key must be allowed this warehouse and this owner."""
    if not access.allows_warehouse(client, warehouse):
        raise Forbidden(f"this key is not allowed warehouse {warehouse}")
    if owner is not None and not access.allows_owner(client, owner):
        raise Forbidden(f"this key is not allowed owner {owner}")
