"""Single sign-on over OpenID Connect.

The authorization code flow with PKCE, and the code exchanged server to
server over TLS with the provider's own token endpoint. Identity then comes
from that provider's userinfo endpoint, using the access token it just gave
us. Nothing here verifies a signature, because nothing here has to: the
tokens arrive down an authenticated TLS channel from the issuer itself, not
through the browser.

Configured with environment variables, alongside the rest of the secrets."""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass

import httpx

from wms.config import get_settings

STATE_TTL_SECONDS = 600
DEFAULT_SCOPES = "openid email profile"


class SsoError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(slots=True)
class Identity:
    subject: str
    email: str | None
    username: str | None
    display_name: str | None

    @property
    def who(self) -> str:
        return self.email or self.username or self.subject


def configured() -> bool:
    s = get_settings()
    return bool(s.oidc_issuer and s.oidc_client_id and s.oidc_redirect_uri)


def provider_name() -> str | None:
    s = get_settings()
    if not configured():
        return None
    return s.oidc_name or s.oidc_issuer.split("//")[-1].split("/")[0]


def _require_configured() -> None:
    if not configured():
        raise SsoError(409, "sso_not_configured",
                       "single sign-on is not set up on this install")


# Discovery, fetched once. A provider's endpoints do not move about.
_DISCOVERY: dict | None = None


def forget_discovery() -> None:
    global _DISCOVERY
    _DISCOVERY = None


def discovery(http: httpx.Client | None = None) -> dict:
    global _DISCOVERY
    if _DISCOVERY is not None:
        return _DISCOVERY
    s = get_settings()
    url = s.oidc_issuer.rstrip("/") + "/.well-known/openid-configuration"
    client = http or httpx.Client(timeout=s.worker_http_timeout_seconds)
    try:
        resp = client.get(url)
        if resp.status_code != 200:
            raise SsoError(502, "sso_unreachable",
                           f"the identity provider did not answer at {url}")
        _DISCOVERY = resp.json()
    except httpx.HTTPError as exc:
        raise SsoError(502, "sso_unreachable", f"could not reach {url}: {exc}") from exc
    finally:
        if http is None:
            client.close()
    return _DISCOVERY


# Half-finished sign ins: the PKCE verifier, kept here and never sent to the
# browser, so a code lifted in transit is worth nothing on its own.
_PENDING: dict[str, tuple[str, float]] = {}


def _sweep(now: float) -> None:
    for key, (_, expires) in list(_PENDING.items()):
        if expires <= now:
            _PENDING.pop(key, None)


def start() -> dict:
    """Where to send the browser, and the state to expect back."""
    _require_configured()
    s = get_settings()
    endpoints = discovery()
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    now = time.time()
    _sweep(now)
    _PENDING[state] = (verifier, now + STATE_TTL_SECONDS)

    from urllib.parse import urlencode

    query = urlencode({
        "response_type": "code", "client_id": s.oidc_client_id,
        "redirect_uri": s.oidc_redirect_uri, "scope": s.oidc_scopes or DEFAULT_SCOPES,
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
    })
    return {"authorize_url": f"{endpoints['authorization_endpoint']}?{query}",
            "state": state, "expires_in": STATE_TTL_SECONDS}


def finish(code: str, state: str) -> Identity:
    """Swap the code for an access token, then ask who it belongs to."""
    _require_configured()
    s = get_settings()
    found = _PENDING.pop(state, None)
    if found is None or found[1] <= time.time():
        raise SsoError(401, "unknown_state", "that sign in has expired; start again")
    verifier = found[0]
    endpoints = discovery()

    with httpx.Client(timeout=s.worker_http_timeout_seconds) as http:
        try:
            token = http.post(endpoints["token_endpoint"], data={
                "grant_type": "authorization_code", "code": code,
                "redirect_uri": s.oidc_redirect_uri, "client_id": s.oidc_client_id,
                "client_secret": s.oidc_client_secret or "", "code_verifier": verifier,
            }, headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise SsoError(502, "sso_unreachable", f"could not reach the provider: {exc}") from exc
        if token.status_code != 200:
            raise SsoError(401, "sso_refused",
                           "the identity provider would not accept that sign in")
        access = token.json().get("access_token")
        if not access:
            raise SsoError(502, "sso_refused", "the identity provider sent no access token")

        try:
            info = http.get(endpoints["userinfo_endpoint"],
                            headers={"Authorization": f"Bearer {access}",
                                     "Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise SsoError(502, "sso_unreachable", f"could not reach the provider: {exc}") from exc
        if info.status_code != 200:
            raise SsoError(401, "sso_refused", "the identity provider would not say who that is")
        claims = info.json()

    return Identity(
        subject=str(claims.get("sub") or ""),
        email=(claims.get("email") or None),
        username=(claims.get("preferred_username") or claims.get("nickname") or None),
        display_name=(claims.get("name") or claims.get("given_name") or None),
    )
