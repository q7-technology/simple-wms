"""Desktop sign in. Scanner login (device + operator + PIN) comes with step 2."""
from __future__ import annotations

import secrets as _secrets
import time as _time
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from wms.api.deps import DB, Who, client_ip
from wms.api.errors import Conflict, FieldError, Forbidden, Unauthorised
from wms.models import User
from wms.config import get_settings
from wms.services import access, audit, sessions, sso, totp

router = APIRouter(prefix="/auth", tags=["auth"])

# Half-finished sign ins, held in memory for a couple of minutes. They are
# worthless on their own: the code from the phone is still needed.
CHALLENGE_TTL_SECONDS = 180
_CHALLENGES: dict[str, tuple[int, float]] = {}


def _new_challenge(user: User) -> str:
    now = _time.time()
    for key, (_, expires) in list(_CHALLENGES.items()):
        if expires <= now:
            _CHALLENGES.pop(key, None)
    token = _secrets.token_urlsafe(24)
    _CHALLENGES[token] = (user.id, now + CHALLENGE_TTL_SECONDS)
    return token


def _spend_challenge(token: str) -> int | None:
    """Good once. A replayed challenge is as useless as a spent ticket."""
    found = _CHALLENGES.pop(token, None)
    if found is None:
        return None
    user_id, expires = found
    return user_id if expires > _time.time() else None


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
    owner: str


class SessionOut(BaseModel):
    status: str = "signed_in"
    token: str
    expires_in: int
    refresh_token: str
    user: UserOut


class SecondFactorRequired(BaseModel):
    """Signed in as far as the password goes; the phone has the rest."""
    status: str = "totp_required"
    challenge: str
    expires_in: int


class RefreshIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refresh_token: str


class MeOut(UserOut):
    scopes: list[str]
    kind: str
    two_factor: bool = False


def user_out(u: User) -> UserOut:
    return UserOut(wms_id=str(u.id), username=u.username, display_name=u.display_name,
                   role=u.role, warehouses=list(u.warehouses or []), owner=u.owner or "*")


def _ip(request: Request) -> str | None:
    return client_ip(request)


def _refused(detail: str, code: str, **extra):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=401, content={"detail": detail, "code": code, **extra},
                        headers={"WWW-Authenticate": "Bearer"})


def _signed_in(db, user: User, request: Request) -> SessionOut:
    row, refresh = sessions.start_session(
        db, user, ip=_ip(request), user_agent=request.headers.get("user-agent"))
    user.last_login_at = datetime.now(UTC)
    user.failed_attempts = 0
    user.locked_until = None
    audit.record(db, actor_type="user", actor=user.username, action="login", ip=_ip(request),
                 detail={"session": row.id, "two_factor": bool(user.totp_secret)})
    db.commit()
    return SessionOut(
        token=sessions.issue_access_token(user, session_id=row.id),
        expires_in=sessions.ACCESS_TTL_SECONDS, refresh_token=refresh, user=user_out(user),
    )


def _lockout(db, user: User, request: Request):
    """Count a wrong password, and lock the account once there have been too
    many. The settings come from the user's first warehouse, or the defaults."""
    from wms.models import Warehouse
    from wms.services.settings import effective

    codes = [w for w in (user.warehouses or []) if w != "*"]
    wh = db.execute(select(Warehouse).where(Warehouse.code == codes[0])).scalar_one_or_none() \
        if codes else None
    settings = effective(wh.settings if wh else None)
    tries = settings["password_lockout_tries"]
    minutes = settings["password_lockout_minutes"]

    user.failed_attempts = (user.failed_attempts or 0) + 1
    left = tries - user.failed_attempts
    audit.record(db, actor_type="user", actor=user.username, action="login_failed",
                 ip=_ip(request), detail={"reason": "wrong password", "tries_left": max(0, left)})
    if left <= 0:
        user.locked_until = datetime.now(UTC) + timedelta(minutes=minutes)
        audit.record(db, actor_type="user", actor=user.username, action="user.locked",
                     ip=_ip(request), detail={"minutes": minutes})
        db.commit()
        return _refused(f"too many wrong passwords; locked for {minutes} minutes", "locked")
    db.commit()
    return _refused("wrong username or password", "wrong_password", tries_left=left)


def _is_locked(user: User) -> bool:
    return bool(user.locked_until and user.locked_until > datetime.now(UTC))


@router.post("/login", response_model=SessionOut | SecondFactorRequired)
def login(body: LoginIn, request: Request, db: DB):
    """Password first. An account with a second factor gets a challenge
    instead of a session."""
    user = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if user is None or not user.active:
        audit.record(db, actor_type="user", actor=body.username, action="login_failed",
                     ip=_ip(request), detail={"reason": "no such user, or inactive"})
        db.commit()
        # say no more than that: an unknown name and a wrong password look alike
        return _refused("wrong username or password", "wrong_password")
    if _is_locked(user):
        audit.record(db, actor_type="user", actor=user.username, action="login_failed",
                     ip=_ip(request), detail={"reason": "locked"})
        db.commit()
        return _refused("this account is locked; a supervisor can unlock it", "locked")
    if not access.verify_password(body.password, user.password_hash):
        return _lockout(db, user, request)

    if user.totp_secret:
        challenge = _new_challenge(user)
        return SecondFactorRequired(challenge=challenge, expires_in=CHALLENGE_TTL_SECONDS)
    return _signed_in(db, user, request)


class TotpLoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    challenge: str = Field(max_length=200)
    code: str = Field(min_length=6, max_length=8)


@router.post("/login/totp", response_model=SessionOut)
def login_totp(body: TotpLoginIn, request: Request, db: DB):
    """The second half of a sign in: the code from the phone."""
    user_id = _spend_challenge(body.challenge)
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.active or not user.totp_secret:
        return _refused("that sign in has expired; start again", "unknown_challenge")
    if _is_locked(user):
        return _refused("this account is locked; a supervisor can unlock it", "locked")

    step = totp.verify(user.totp_secret, body.code)
    if step is None:
        audit.record(db, actor_type="user", actor=user.username, action="login_2fa_failed",
                     ip=_ip(request), detail={"reason": "wrong code"})
        db.commit()
        return _refused("that code is not right", "wrong_code")
    if user.totp_last_step is not None and step <= user.totp_last_step:
        audit.record(db, actor_type="user", actor=user.username, action="login_2fa_failed",
                     ip=_ip(request), detail={"reason": "code already used"})
        db.commit()
        return _refused("that code has been used; wait for the next one", "code_used")
    user.totp_last_step = step
    return _signed_in(db, user, request)


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
    display = who.user.display_name if who.user else who.operator.name if who.operator else who.name
    return MeOut(
        wms_id=str(who.id), username=who.name, display_name=display,
        role=who.role or "integration", warehouses=who.warehouses, owner=who.owner,
        scopes=who.scopes, kind=who.kind,
        two_factor=bool(who.user.totp_secret) if who.user else False,
    )


# --- single sign-on ---------------------------------------------------------

class SsoStatusOut(BaseModel):
    enabled: bool
    name: str | None


class SsoStartOut(BaseModel):
    authorize_url: str
    state: str
    expires_in: int


class SsoCallbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(min_length=1, max_length=2000)
    state: str = Field(min_length=1, max_length=200)


def _sso_error(exc):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=exc.status, content={"detail": exc.message, "code": exc.code})


@router.get("/sso", response_model=SsoStatusOut)
def sso_status():
    """Whether the sign-in screen should offer the button at all."""
    return SsoStatusOut(enabled=sso.configured(), name=sso.provider_name())


@router.get("/sso/start", response_model=SsoStartOut)
def sso_start():
    """Where to send the browser. The PKCE verifier stays here."""
    try:
        return SsoStartOut(**sso.start())
    except sso.SsoError as exc:
        return _sso_error(exc)


@router.post("/sso/callback", response_model=SessionOut)
def sso_callback(body: SsoCallbackIn, request: Request, db: DB):
    """The browser came back with a code. Swap it, see who it is, sign them in."""
    try:
        identity = sso.finish(body.code, body.state)
    except sso.SsoError as exc:
        return _sso_error(exc)

    user = None
    if identity.email:
        user = db.execute(select(User).where(User.email == identity.email)).scalars().first()
    if user is None and identity.username:
        user = db.execute(select(User).where(User.username == identity.username)).scalars().first()

    settings = get_settings()
    if user is None and settings.oidc_create_users and identity.username:
        user = User(username=identity.username, display_name=identity.display_name or identity.username,
                    email=identity.email, role=settings.oidc_default_role, warehouses=["*"],
                    owner="*", password_hash=None)
        db.add(user)
        db.flush()
        audit.record(db, actor_type="user", actor=user.username, action="user.created_by_sso",
                     ip=_ip(request), detail={"provider": sso.provider_name(),
                                              "subject": identity.subject})
    if user is None or not user.active:
        audit.record(db, actor_type="user", actor=identity.who, action="login_sso_refused",
                     ip=_ip(request), detail={"reason": "no account, or inactive"})
        db.commit()
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=403, content={
            "code": "no_account",
            "detail": f"{identity.who} signed in with the provider, but has no active account here. "
                      f"A supervisor can make one.",
        })
    if _is_locked(user):
        return _refused("this account is locked; a supervisor can unlock it", "locked")

    audit.record(db, actor_type="user", actor=user.username, action="login_sso", ip=_ip(request),
                 detail={"provider": sso.provider_name(), "subject": identity.subject})
    # The provider has already said who they are, so no second factor here.
    return _signed_in(db, user, request)


class TotpSetupOut(BaseModel):
    secret: str
    otpauth_url: str


class TotpCodeIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(min_length=6, max_length=8)


class PasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(max_length=200)


@router.post("/2fa/setup", response_model=TotpSetupOut)
def setup_two_factor(who: Who, db: DB):
    """Hand back a secret to scan. Nothing changes until a code proves the
    phone has it."""
    if who.user is None:
        raise Forbidden("only a signed-in person can set up a second factor")
    who.user.totp_pending = totp.new_secret()
    db.commit()
    return TotpSetupOut(secret=who.user.totp_pending,
                        otpauth_url=totp.otpauth_url(who.user.totp_pending, who.user.username))


@router.post("/2fa/enable", response_model=MeOut)
def enable_two_factor(body: TotpCodeIn, request: Request, who: Who, db: DB):
    if who.user is None:
        raise Forbidden("only a signed-in person can set up a second factor")
    if not who.user.totp_pending:
        raise Conflict("no_setup", "ask for a secret first")
    if totp.verify(who.user.totp_pending, body.code) is None:
        raise FieldError("code", "that code is not right; check the phone's clock")
    who.user.totp_secret = who.user.totp_pending
    who.user.totp_pending = None
    who.user.totp_last_step = None
    audit.record(db, actor_type="user", actor=who.name, action="user.2fa_enabled", ip=_ip(request))
    db.commit()
    return me(who)


@router.post("/2fa/disable", response_model=MeOut)
def disable_two_factor(body: PasswordIn, request: Request, who: Who, db: DB):
    """Turning it off needs the password, so a borrowed screen cannot do it."""
    if who.user is None:
        raise Forbidden("only a signed-in person can turn off their second factor")
    if not access.verify_password(body.password, who.user.password_hash):
        raise Unauthorised("wrong password")
    who.user.totp_secret = None
    who.user.totp_pending = None
    who.user.totp_last_step = None
    audit.record(db, actor_type="user", actor=who.name, action="user.2fa_disabled", ip=_ip(request))
    db.commit()
    return me(who)


# --- scanner ---------------------------------------------------------------

class ScannerLoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    device_id: str = Field(max_length=64)
    warehouse: str = Field(max_length=32)
    operator_id: str | None = Field(default=None, max_length=32)
    pin: str | None = Field(default=None, max_length=8)
    badge: str | None = Field(default=None, max_length=128)


class OperatorOut(BaseModel):
    code: str
    name: str
    roles: list[str]
    supervisor: bool


class ScannerSessionOut(BaseModel):
    token: str
    expires_in: int
    operator: OperatorOut
    warehouses: list[str]
    device: str
    idle_logout_minutes: int


class ScannerUnlockIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    device_id: str = Field(max_length=64)
    warehouse: str = Field(max_length=32)
    operator_id: str = Field(max_length=32)
    supervisor_badge: str = Field(max_length=128)
    new_pin: str | None = Field(default=None, min_length=4, max_length=8, pattern=r"^[0-9]+$")


class SupervisorCheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    badge: str = Field(max_length=128)
    warehouse: str | None = Field(default=None, max_length=32)


def _warehouse(db, code: str):
    from wms.models import Warehouse
    wh = db.execute(select(Warehouse).where(Warehouse.code == code)).scalar_one_or_none()
    if wh is None:
        from wms.api.errors import FieldError
        raise FieldError("warehouse", f"unknown warehouse {code}")
    return wh


def _scanner_error(exc):
    from fastapi.responses import JSONResponse
    content = {"detail": exc.message, "code": exc.code}
    if exc.tries_left is not None:
        content["tries_left"] = exc.tries_left
    return JSONResponse(status_code=exc.status, content=content)


@router.post("/scanner-login", response_model=ScannerSessionOut)
def scanner_login(body: ScannerLoginIn, request: Request, db: DB):
    from wms.services import scanner_auth
    from wms.services.settings import effective

    wh = _warehouse(db, body.warehouse)
    try:
        op = scanner_auth.login(db, device_code=body.device_id, warehouse=wh, operator_id=body.operator_id,
                                pin=body.pin, badge=body.badge, ip=_ip(request))
    except scanner_auth.ScannerAuthError as exc:
        return _scanner_error(exc)
    roles = list(op.roles or [])
    return ScannerSessionOut(
        token=sessions.issue_operator_token(op.id, body.device_id), expires_in=sessions.OPERATOR_TTL_SECONDS,
        operator=OperatorOut(code=op.code, name=op.name, roles=roles, supervisor="supervisor" in roles),
        warehouses=list(op.warehouses or []), device=body.device_id,
        idle_logout_minutes=effective(wh.settings)["idle_logout_minutes"],
    )


@router.post("/scanner-unlock")
def scanner_unlock(body: ScannerUnlockIn, request: Request, db: DB):
    from wms.services import scanner_auth

    wh = _warehouse(db, body.warehouse)
    try:
        op = scanner_auth.unlock(db, device_code=body.device_id, warehouse=wh, operator_id=body.operator_id,
                                 supervisor_badge=body.supervisor_badge, new_pin=body.new_pin, ip=_ip(request))
    except scanner_auth.ScannerAuthError as exc:
        return _scanner_error(exc)
    return {"ok": True, "operator": op.code, "pin_changed": bool(body.new_pin)}


@router.post("/supervisor-check")
def supervisor_check(body: SupervisorCheckIn, who: Who, db: DB):
    """Is this badge a supervisor here? Used by the scanner before an override."""
    sup = access.find_supervisor_by_badge(db, body.badge, body.warehouse)
    if sup is None:
        return {"ok": False, "operator": None, "name": None}
    return {"ok": True, "operator": sup.code, "name": sup.name}
