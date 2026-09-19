"""Desktop sign in. Scanner login (device + operator + PIN) comes with step 2."""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from wms.api.deps import DB, Who, client_ip
from wms.api.errors import Unauthorised
from wms.models import User
from wms.services import access, audit, sessions

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(max_length=64)
    password: str = Field(max_length=200)


class UserOut(BaseModel):
    wms_id: str
    username: str
    display_name: str
    role: str
    warehouses: list[str]


class SessionOut(BaseModel):
    token: str
    expires_in: int
    refresh_token: str
    user: UserOut


class RefreshIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refresh_token: str


class MeOut(UserOut):
    scopes: list[str]
    kind: str


def user_out(u: User) -> UserOut:
    return UserOut(wms_id=str(u.id), username=u.username, display_name=u.display_name,
                   role=u.role, warehouses=list(u.warehouses or []))


def _ip(request: Request) -> str | None:
    return client_ip(request)


@router.post("/login", response_model=SessionOut)
def login(body: LoginIn, request: Request, db: DB):
    user = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    ok = user is not None and user.active and access.verify_password(body.password, user.password_hash)
    if not ok:
        audit.record(db, actor_type="user", actor=body.username, action="login_failed",
                     ip=_ip(request), detail={"reason": "bad credentials or inactive"})
        db.commit()
        raise Unauthorised("wrong username or password")
    row, refresh = sessions.start_session(
        db, user, ip=_ip(request), user_agent=request.headers.get("user-agent"))
    user.last_login_at = datetime.now(UTC)
    audit.record(db, actor_type="user", actor=user.username, action="login", ip=_ip(request),
                 detail={"session": row.id})
    db.commit()
    return SessionOut(
        token=sessions.issue_access_token(user, session_id=row.id),
        expires_in=sessions.ACCESS_TTL_SECONDS, refresh_token=refresh, user=user_out(user),
    )


@router.post("/refresh", response_model=SessionOut)
def refresh(body: RefreshIn, db: DB):
    row = sessions.find_session(db, body.refresh_token)
    user = db.get(User, row.user_id) if row else None
    if row is None or user is None or not user.active:
        raise Unauthorised("session expired or invalid")
    new_refresh = sessions.rotate_session(db, row)
    db.commit()
    return SessionOut(
        token=sessions.issue_access_token(user, session_id=row.id),
        expires_in=sessions.ACCESS_TTL_SECONDS, refresh_token=new_refresh, user=user_out(user),
    )


@router.post("/logout", status_code=204)
def logout(body: RefreshIn, request: Request, db: DB):
    row = sessions.find_session(db, body.refresh_token)
    if row is not None:
        sessions.revoke_session(db, row)
        user = db.get(User, row.user_id)
        audit.record(db, actor_type="user", actor=user.username if user else str(row.user_id),
                     action="logout", ip=_ip(request), detail={"session": row.id})
        db.commit()
    return Response(status_code=204)


@router.get("/me", response_model=MeOut)
def me(who: Who):
    return MeOut(
        wms_id=str(who.id), username=who.name,
        display_name=who.user.display_name if who.user else who.name,
        role=who.role or "integration", warehouses=who.warehouses, scopes=who.scopes,
        kind=who.kind,
    )
