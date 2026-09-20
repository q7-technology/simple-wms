"""Single sign-on. The sign-in screen has had the button since the design."""
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from wms.models import AuditLog, User
from wms.services.access import hash_password


class _Provider(BaseHTTPRequestHandler):
    """A stand-in identity provider: discovery, token, userinfo."""

    state: dict = {}

    def _send(self, body: dict, status: int = 200):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        base = self.state["base"]
        if self.path.startswith("/.well-known/openid-configuration"):
            self.state["discovery_calls"] += 1
            return self._send({
                "issuer": base,
                "authorization_endpoint": f"{base}/authorize",
                "token_endpoint": f"{base}/token",
                "userinfo_endpoint": f"{base}/userinfo",
            })
        if self.path.startswith("/userinfo"):
            auth = self.headers.get("Authorization", "")
            if auth != "Bearer access-token-123":
                return self._send({"error": "invalid_token"}, 401)
            return self._send(self.state["userinfo"])
        self._send({"error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/token"):
            return self._send({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length", 0))
        form = urllib.parse.parse_qs(self.rfile.read(length).decode())
        self.state["token_request"] = {k: v[0] for k, v in form.items()}
        if self.state.get("token_status", 200) != 200:
            return self._send({"error": "invalid_grant"}, self.state["token_status"])
        self._send({"access_token": "access-token-123", "token_type": "Bearer", "expires_in": 300})

    def log_message(self, *a):
        pass


@pytest.fixture
def provider(monkeypatch):
    state = {"discovery_calls": 0, "userinfo": {
        "sub": "abc-123", "email": "leighton@q7technology.com.au",
        "preferred_username": "leighton", "name": "Leighton L.",
    }}
    handler = type("H", (_Provider,), {"state": state})
    server = HTTPServer(("127.0.0.1", 0), handler)
    state["base"] = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    from wms.config import get_settings
    from wms.services import sso

    get_settings.cache_clear()
    monkeypatch.setenv("WMS_OIDC_ISSUER", state["base"])
    monkeypatch.setenv("WMS_OIDC_CLIENT_ID", "simple-wms")
    monkeypatch.setenv("WMS_OIDC_CLIENT_SECRET", "shh")
    monkeypatch.setenv("WMS_OIDC_REDIRECT_URI", "https://wms.example/sso")
    sso.forget_discovery()
    yield SimpleNamespace(state=state, base=state["base"])
    server.shutdown()
    server.server_close()
    get_settings.cache_clear()
    sso.forget_discovery()


@pytest.fixture
def sso_user(db):
    user = User(username="leighton", display_name="Leighton L.",
                email="leighton@q7technology.com.au", role="admin", warehouses=["*"],
                password_hash=hash_password("correct horse"))
    db.add(user)
    db.commit()
    return user


def start(client):
    return client.get("/v1/auth/sso/start")


def finish(client, state, code="code-1"):
    return client.post("/v1/auth/sso/callback", json={"code": code, "state": state})


# --- is it on at all ----------------------------------------------------------

def test_sso_is_off_until_it_is_configured(client, db):
    r = client.get("/v1/auth/sso")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "name": None}
    assert start(client).status_code == 409
    assert start(client).json()["code"] == "sso_not_configured"


def test_sso_says_it_is_on_once_it_is(client, db, provider):
    r = client.get("/v1/auth/sso")
    assert r.status_code == 200
    assert r.json()["enabled"] is True


# --- the round trip -------------------------------------------------------------

def test_the_start_hands_back_somewhere_to_send_the_browser(client, db, provider):
    r = start(client)
    assert r.status_code == 200, r.text
    body = r.json()
    url = urllib.parse.urlparse(body["authorize_url"])
    query = urllib.parse.parse_qs(url.query)
    assert url.path == "/authorize"
    assert query["client_id"] == ["simple-wms"]
    assert query["response_type"] == ["code"]
    assert query["redirect_uri"] == ["https://wms.example/sso"]
    assert query["state"] == [body["state"]]
    assert "openid" in query["scope"][0]
    # PKCE, so a stolen code is no use without the verifier we kept
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) > 20


def test_a_known_person_signs_in(client, db, provider, sso_user):
    state = start(client).json()["state"]
    r = finish(client, state)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "signed_in"
    assert body["token"].startswith("wms_s.")
    assert body["user"]["username"] == "leighton"

    sent = provider.state["token_request"]
    assert sent["grant_type"] == "authorization_code"
    assert sent["code"] == "code-1"
    assert sent["client_id"] == "simple-wms"
    assert sent["client_secret"] == "shh"
    assert sent["redirect_uri"] == "https://wms.example/sso"
    assert len(sent["code_verifier"]) > 20

    h = {"Authorization": f"Bearer {body['token']}"}
    assert client.get("/v1/auth/me", headers=h).json()["username"] == "leighton"
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "login_sso" in actions


def test_the_state_is_good_once(client, db, provider, sso_user):
    state = start(client).json()["state"]
    assert finish(client, state).status_code == 200
    r = finish(client, state)
    assert r.status_code == 401
    assert r.json()["code"] == "unknown_state"


def test_a_made_up_state_is_refused(client, db, provider, sso_user):
    r = finish(client, "not-a-state")
    assert r.status_code == 401
    assert r.json()["code"] == "unknown_state"


def test_the_provider_refusing_the_code_is_passed_on(client, db, provider, sso_user):
    provider.state["token_status"] = 400
    state = start(client).json()["state"]
    r = finish(client, state)
    assert r.status_code == 401
    assert r.json()["code"] == "sso_refused"


# --- who it lets in ---------------------------------------------------------------

def test_somebody_the_wms_does_not_know_is_turned_away(client, db, provider):
    provider.state["userinfo"] = {"sub": "x", "email": "stranger@example.com",
                                  "preferred_username": "stranger"}
    state = start(client).json()["state"]
    r = finish(client, state)
    assert r.status_code == 403
    assert r.json()["code"] == "no_account"
    assert "stranger@example.com" in r.json()["detail"]


def test_it_can_make_an_account_when_the_install_says_so(client, db, provider, monkeypatch):
    from wms.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("WMS_OIDC_CREATE_USERS", "true")
    monkeypatch.setenv("WMS_OIDC_DEFAULT_ROLE", "picker")
    provider.state["userinfo"] = {"sub": "y", "email": "new@q7technology.com.au",
                                  "preferred_username": "newbie", "name": "New Person"}
    state = start(client).json()["state"]
    r = finish(client, state)
    assert r.status_code == 200, r.text
    assert r.json()["user"]["username"] == "newbie"
    assert r.json()["user"]["role"] == "picker"

    made = db.execute(select(User).where(User.username == "newbie")).scalar_one()
    assert made.email == "new@q7technology.com.au"
    assert made.display_name == "New Person"
    # no password: they come in through the provider, every time
    assert made.password_hash is None
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "user.created_by_sso" in actions
    get_settings.cache_clear()


def test_a_deactivated_person_stays_out(client, db, provider, sso_user):
    sso_user.active = False
    db.commit()
    state = start(client).json()["state"]
    r = finish(client, state)
    assert r.status_code == 403
    assert r.json()["code"] == "no_account"


def test_matching_falls_back_to_the_username(client, db, provider, sso_user):
    sso_user.email = None
    db.commit()
    state = start(client).json()["state"]
    assert finish(client, state).status_code == 200


def test_a_person_with_a_password_can_still_use_it(client, db, provider, sso_user):
    r = client.post("/v1/auth/login", json={"username": "leighton", "password": "correct horse"})
    assert r.status_code == 200
    assert r.json()["status"] == "signed_in"


def test_discovery_is_asked_for_once(client, db, provider, sso_user):
    for _ in range(3):
        state = start(client).json()["state"]
        finish(client, state)
    assert provider.state["discovery_calls"] == 1
