import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from wms.models import AuditLog

from conftest import login


def test_login_returns_session_and_user(client, admin):
    body = login(client, "leighton", "correct horse")
    assert body["token"].startswith("wms_s.")
    assert body["refresh_token"]
    assert body["expires_in"] == 900
    assert body["user"] == {
        "username": "leighton", "display_name": "Leighton L.", "role": "admin",
        "warehouses": ["*"], "owner": "*", "wms_id": str(admin.id),
    }


def test_me_reports_who_and_what_they_may_do(client, user_headers):
    r = client.get("/v1/auth/me", headers=user_headers)
    assert r.status_code == 200
    assert r.json()["username"] == "leighton"
    assert r.json()["scopes"] == ["*"]


def test_wrong_password_is_401_and_audited(client, db, admin):
    r = client.post("/v1/auth/login", json={"username": "leighton", "password": "nope"})
    assert r.status_code == 401
    r = client.post("/v1/auth/login", json={"username": "nobody", "password": "nope"})
    assert r.status_code == 401
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert actions.count("login_failed") == 2


def test_deactivated_user_cannot_log_in(client, db, admin):
    admin.active = False
    db.commit()
    r = client.post("/v1/auth/login", json={"username": "leighton", "password": "correct horse"})
    assert r.status_code == 401


def test_session_token_works_on_ordinary_endpoints(client, user_headers):
    r = client.post("/v1/sites", headers=user_headers,
                    json={"message_id": str(uuid.uuid4()), "code": "BAL", "name": "Ballarat"})
    assert r.status_code == 202, r.text
    assert client.get("/v1/sites", headers=user_headers).json()["total"] == 1


def test_picker_role_is_read_only_on_master_data(client, picker):
    token = login(client, "sam", "pick pick")["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/v1/products", headers=h).status_code == 200
    r = client.post("/v1/products", headers=h, json={
        "message_id": str(uuid.uuid4()), "sku": "X", "name": "X", "uom": "EA"})
    assert r.status_code == 403


def test_expired_access_token_is_rejected(client, admin):
    from wms.services.sessions import issue_access_token

    old = issue_access_token(admin, now=datetime.now(UTC) - timedelta(hours=1))
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {old}"})
    assert r.status_code == 401


def test_tampered_token_is_rejected(client, user_headers):
    token = user_headers["Authorization"].split()[1]
    bad = token[:-4] + ("aaaa" if not token.endswith("aaaa") else "bbbb")
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_refresh_rotates_and_logout_revokes(client, admin):
    first = login(client, "leighton", "correct horse")

    r = client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert r.status_code == 200, r.text
    second = r.json()
    assert second["token"] != first["token"]
    assert second["refresh_token"] != first["refresh_token"]

    # the old refresh token is spent
    r = client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert r.status_code == 401

    r = client.post("/v1/auth/logout", json={"refresh_token": second["refresh_token"]})
    assert r.status_code == 204
    r = client.post("/v1/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert r.status_code == 401


def test_user_scoped_to_one_warehouse(client, picker):
    token = login(client, "sam", "pick pick")["token"]
    h = {"Authorization": f"Bearer {token}"}
    r = client.get("/v1/locations", headers=h, params={"warehouse": "MEL-WH01"})
    assert r.status_code == 403
