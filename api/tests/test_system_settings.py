"""Site-wide settings on the Settings screen, with `.env` as the fallback."""
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import create_engine, select, text

from conftest import login
from test_migrations import alembic_config, blank_database  # noqa: F401  fixture
from test_printing import queue_one, set_platen
from test_sso import finish, provider, start  # noqa: F401  fixture
from wms.models import AuditLog, InboundMessage, User
from wms.services import sso, system
from wms.services.access import hash_password

URL = "/v1/system/settings"

ENV = ("WMS_WORKER_POLL_SECONDS", "WMS_WORKER_HTTP_TIMEOUT_SECONDS", "WMS_PLATEN_KEY",
       "WMS_OIDC_ISSUER", "WMS_OIDC_CLIENT_ID", "WMS_OIDC_CLIENT_SECRET",
       "WMS_OIDC_REDIRECT_URI", "WMS_OIDC_SCOPES", "WMS_OIDC_NAME", "WMS_OIDC_CREATE_USERS",
       "WMS_OIDC_DEFAULT_ROLE")


@pytest.fixture
def clean_env(monkeypatch):
    """Only conftest's WMS_MESSAGE_TTL_HOURS; a developer's shell may have more."""
    from wms.config import get_settings

    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield monkeypatch
    get_settings.cache_clear()


def patch(client, headers, **body):
    return client.patch(URL, headers=headers, json=body)


# --- reading -------------------------------------------------------------------

def test_defaults_and_env_show_where_they_came_from(client, db, clean_env, user_headers):
    r = client.get(URL, headers=user_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["values"] == {
        "message_ttl_hours": 24, "worker_poll_seconds": 5.0, "worker_http_timeout_seconds": 10.0,
        "oidc_issuer": "", "oidc_client_id": "", "oidc_redirect_uri": "", "oidc_scopes": "",
        "oidc_name": "", "oidc_create_users": False, "oidc_default_role": "picker",
    }
    assert body["secrets"] == {"platen_key": False, "oidc_client_secret": False}
    assert set(body["source"]) == set(system.EDITABLE)
    assert body["source"]["message_ttl_hours"] == "env"     # conftest sets it
    assert body["source"]["worker_poll_seconds"] == "default"


def test_a_patch_is_saved_and_a_null_goes_back_to_env(client, db, clean_env, user_headers):
    r = patch(client, user_headers, message_ttl_hours=48, worker_poll_seconds=2,
              oidc_scopes="  openid email  ")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["values"]["message_ttl_hours"] == 48
    assert body["values"]["worker_poll_seconds"] == 2.0
    assert body["values"]["oidc_scopes"] == "openid email"
    assert body["source"]["message_ttl_hours"] == "settings"
    assert body["source"]["worker_poll_seconds"] == "settings"
    assert system.current().message_ttl_hours == 48

    # only the keys sent are touched
    r = patch(client, user_headers, message_ttl_hours=None)
    body = r.json()
    assert body["values"]["message_ttl_hours"] == 24
    assert body["source"]["message_ttl_hours"] == "env"
    assert body["values"]["worker_poll_seconds"] == 2.0
    assert client.get(URL, headers=user_headers).json() == body


def test_a_blank_wins_over_env(client, db, clean_env, user_headers):
    clean_env.setenv("WMS_OIDC_NAME", "Entra")
    from wms.config import get_settings
    get_settings.cache_clear()
    assert client.get(URL, headers=user_headers).json()["source"]["oidc_name"] == "env"

    body = patch(client, user_headers, oidc_name="").json()
    assert body["values"]["oidc_name"] == ""
    assert body["source"]["oidc_name"] == "settings"


def test_secrets_are_never_returned(client, db, clean_env, user_headers):
    r = patch(client, user_headers, platen_key="pk_live_123", oidc_client_secret="shh")
    assert r.status_code == 200, r.text
    assert r.json()["secrets"] == {"platen_key": True, "oidc_client_secret": True}
    r = client.get(URL, headers=user_headers)
    assert "pk_live_123" not in r.text and "shh" not in r.text
    assert "platen_key" not in r.json()["values"]
    assert system.current().platen_key == "pk_live_123"

    r = patch(client, user_headers, platen_key=None)
    assert r.json()["secrets"]["platen_key"] is False


def test_the_audit_row_hides_secret_values(client, db, clean_env, user_headers):
    patch(client, user_headers, platen_key="pk_live_123", message_ttl_hours=12)
    patch(client, user_headers, oidc_client_secret=None)
    rows = db.execute(select(AuditLog).where(AuditLog.action == "system.settings_changed")
                      .order_by(AuditLog.id)).scalars().all()
    assert [r.detail for r in rows] == [
        {"platen_key": "(set)", "message_ttl_hours": 12},
        {"oidc_client_secret": "(cleared)"},
    ]
    assert rows[0].actor == "leighton"
    assert rows[0].target_type == "system"


@pytest.mark.parametrize("body, field", [
    ({"duplicate_window_hours": 24}, "duplicate_window_hours"),
    ({"database_url": "postgresql://x"}, "database_url"),
    ({"message_ttl_hours": 0}, "message_ttl_hours"),
    ({"worker_poll_seconds": 0.1}, "worker_poll_seconds"),
    ({"oidc_default_role": "boss"}, "oidc_default_role"),
    ({"oidc_issuer": "login.example.com"}, "oidc_issuer"),
    ({"oidc_redirect_uri": "ftp://wms"}, "oidc_redirect_uri"),
    ({"oidc_name": "x" * 501}, "oidc_name"),
])
def test_bad_keys_and_values_are_422(client, db, clean_env, user_headers, body, field):
    r = client.patch(URL, headers=user_headers, json=body)
    assert r.status_code == 422, r.text
    assert [e["field"] for e in r.json()["errors"]] == [field]
    assert client.get(URL, headers=user_headers).json()["source"]["message_ttl_hours"] == "env"


def test_only_admins(client, db, picker):
    db.add(User(username="tony", display_name="Tony S.", role="supervisor", warehouses=["*"],
                password_hash=hash_password("long enough password")))
    db.commit()
    for name, password in (("tony", "long enough password"), ("sam", "pick pick")):
        h = {"Authorization": f"Bearer {login(client, name, password)['token']}"}
        assert client.get(URL, headers=h).status_code == 403
        assert client.patch(URL, headers=h, json={"message_ttl_hours": 48}).status_code == 403


# --- where they are used ---------------------------------------------------------

def test_dedup_follows_the_saved_window(client, db, clean_env, user_headers, headers):
    body = {"message_id": str(uuid.uuid4()), "code": "BAL", "name": "Ballarat"}
    assert client.post("/v1/sites", headers=headers, json=body).status_code == 202
    # older than .env's 24 h, inside the saved 48 h
    db.execute(text("update inbound_message set received_at = :t"),
               {"t": datetime.now(UTC) - timedelta(hours=30)})
    db.commit()
    patch(client, user_headers, message_ttl_hours=48)

    r = client.post("/v1/sites", headers=headers, json=body)
    assert r.status_code == 202, r.text
    row = db.get(InboundMessage, uuid.UUID(body["message_id"]))
    db.refresh(row)
    assert row.duplicates == 1


def test_the_worker_sends_the_saved_platen_key(client, db, structure, headers, user_headers,
                                              listener, clean_env):
    from wms.worker import send_print_jobs

    patch(client, user_headers, platen_key="pk_from_the_screen")
    set_platen(client, headers, listener)
    job = queue_one(client, db, structure, headers)
    with httpx.Client() as http:
        assert send_print_jobs(db, http, now=job.next_attempt_at) == 1
    assert listener.received[0]["headers"]["Authorization"] == "Bearer pk_from_the_screen"


def test_sso_switches_on_from_the_screen_alone(client, db, clean_env, user_headers):
    assert client.get("/v1/auth/sso").json() == {"enabled": False, "name": None}
    r = patch(client, user_headers, oidc_issuer="https://login.example.com/tenant",
              oidc_client_id="simple-wms", oidc_redirect_uri="https://wms.example/sso")
    assert r.status_code == 200, r.text
    assert sso.configured()
    assert client.get("/v1/auth/sso").json() == {"enabled": True, "name": "login.example.com"}

    patch(client, user_headers, oidc_issuer="")
    assert not sso.configured()


def test_a_new_issuer_is_discovered_afresh(client, db, provider, user_headers):  # noqa: F811
    sso.discovery()
    sso.discovery()
    assert provider.state["discovery_calls"] == 1
    other = provider.base.replace("127.0.0.1", "localhost")
    patch(client, user_headers, oidc_issuer=other)
    assert sso.discovery()["issuer"] == provider.base
    assert provider.state["discovery_calls"] == 2


def test_saved_settings_make_accounts_on_sso(client, db, provider, user_headers):  # noqa: F811
    patch(client, user_headers, oidc_create_users=True, oidc_default_role="receiver")
    provider.state["userinfo"] = {"sub": "y", "email": "new@q7technology.com.au",
                                  "preferred_username": "newbie", "name": "New Person"}
    r = finish(client, start(client).json()["state"])
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "receiver"


# --- the migration ---------------------------------------------------------------

def test_the_warehouse_duplicate_window_moves_to_the_site(blank_database):  # noqa: F811
    from alembic import command

    cfg = alembic_config(blank_database)
    command.upgrade(cfg, "0015")
    engine = create_engine(blank_database)
    with engine.begin() as conn:
        conn.execute(text("insert into site (code, name, timezone, active) "
                          "values ('BAL', 'Ballarat', 'Australia/Melbourne', true)"))
        for code, s in (("A", '{"duplicate_window_hours": 36, "blind_counts": true}'),
                        ("B", '{"duplicate_window_hours": 72}'), ("C", "{}")):
            conn.execute(text(
                "insert into warehouse (site_id, code, name, settings, active) "
                "select id, :code, :code, cast(:s as jsonb), true from site"), {"code": code, "s": s})
    command.upgrade(cfg, "0016")
    with engine.connect() as conn:
        saved = conn.execute(text("select settings from system_setting where id = 1")).scalar()
        left = dict(conn.execute(text("select code, settings from warehouse")).all())
    engine.dispose()
    assert saved == {"message_ttl_hours": 72}
    assert left == {"A": {"blind_counts": True}, "B": {}, "C": {}}
