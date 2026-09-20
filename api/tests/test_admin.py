"""Admin endpoints behind the Integrations, Users and Settings screens.
These are plain REST calls from a signed-in person; no message envelope."""
import uuid
from datetime import UTC, datetime
from decimal import Decimal

from conftest import login
from sqlalchemy import select

from wms.models import AuditLog, OutboundEvent


# --- api clients ---------------------------------------------------------

def test_api_client_lifecycle(client, user_headers):
    r = client.post("/v1/api-clients", headers=user_headers, json={
        "name": "ERP bridge", "scopes": ["deliveries:write", "stock:read"],
        "warehouses": ["BAL-WH01"], "owner": "DEFAULT", "ip_allowlist": [],
    })
    assert r.status_code == 201, r.text
    made = r.json()
    assert made["key"].startswith("wms_")
    assert made["key_prefix"] == made["key"][:10]
    key_headers = {"Authorization": f"Bearer {made['key']}"}

    # the key works, and is scoped
    assert client.get("/v1/stock", headers=key_headers, params={"sku": "X"}).status_code == 404
    assert client.get("/v1/products", headers=key_headers).status_code == 403

    listing = client.get("/v1/api-clients", headers=user_headers).json()["items"]
    assert [c["name"] for c in listing] == ["ERP bridge"]
    assert "key" not in listing[0]
    assert listing[0]["duplicates_24h"] == 0

    r = client.post(f"/v1/api-clients/{made['wms_id']}/rotate", headers=user_headers)
    assert r.status_code == 200
    assert client.get("/v1/stock", headers=key_headers, params={"sku": "X"}).status_code == 401
    new_headers = {"Authorization": f"Bearer {r.json()['key']}"}
    assert client.get("/v1/stock", headers=new_headers, params={"sku": "X"}).status_code == 404

    r = client.post(f"/v1/api-clients/{made['wms_id']}/revoke", headers=user_headers)
    assert r.status_code == 200
    assert client.get("/v1/stock", headers=new_headers, params={"sku": "X"}).status_code == 401


def test_api_client_creation_needs_integration_admin(client, picker):
    h = {"Authorization": f"Bearer {login(client, 'sam', 'pick pick')['token']}"}
    r = client.post("/v1/api-clients", headers=h, json={"name": "x", "scopes": ["*"], "warehouses": ["*"]})
    assert r.status_code == 403


def test_duplicate_count_shows_on_the_key(client, user_headers, headers, api_key):
    body = {"message_id": str(uuid.uuid4()), "code": "BAL", "name": "Ballarat"}
    client.post("/v1/sites", headers=headers, json=body)
    client.post("/v1/sites", headers=headers, json=body)
    client.post("/v1/sites", headers=headers, json=body)
    listing = client.get("/v1/api-clients", headers=user_headers).json()["items"]
    tests_key = next(c for c in listing if c["name"] == "tests")
    assert tests_key["duplicates_24h"] == 2
    assert tests_key["last_duplicate_at"] is not None


# --- subscribers and the event queue ------------------------------------

def test_subscriber_and_event_queue(client, db, user_headers, listener):
    r = client.post("/v1/subscribers", headers=user_headers, json={
        "name": "ERP bridge", "url": listener.url, "event_types": ["stock.moved", "transfer.*"],
    })
    assert r.status_code == 201, r.text
    sub = r.json()
    assert sub["secret"]  # generated, shown once

    r = client.post("/v1/subscribers", headers=user_headers, json={
        "name": "ERP bridge", "url": listener.url, "event_types": ["stock.moved"], "active": True,
    })
    assert r.status_code == 200
    assert "secret" not in r.json()

    listing = client.get("/v1/subscribers", headers=user_headers).json()["items"]
    assert listing[0]["event_types"] == ["stock.moved"]
    assert listing[0]["status"] == "idle"

    from wms.services.events import emit

    emit(db, "stock.moved", warehouse="BAL-WH01", owner="DEFAULT", external_ref="L-1",
         data={}, occurred_at=datetime.now(UTC))
    db.commit()
    row = db.execute(select(OutboundEvent)).scalar_one()
    row.status = "failed"
    row.attempts = 4
    row.last_error = "HTTP 503: down"
    db.commit()

    events = client.get("/v1/events", headers=user_headers, params={"status": "failed"}).json()
    assert events["total"] == 1
    ev = events["items"][0]
    assert ev["subscriber"] == "ERP bridge"
    assert ev["attempts"] == 4
    assert ev["last_error"].startswith("HTTP 503")

    r = client.post(f"/v1/events/{ev['wms_id']}/retry", headers=user_headers)
    assert r.status_code == 200
    assert r.json()["status"] == "pending"
    assert r.json()["attempts"] == 0

    listing = client.get("/v1/subscribers", headers=user_headers).json()["items"]
    assert listing[0]["status"] == "retrying"


def test_wildcard_event_types_match(db, listener):
    from wms.models import Subscriber
    from wms.services.events import emit

    db.add(Subscriber(name="erp", url=listener.url, secret="s", event_types=["transfer.*"]))
    db.commit()
    assert len(emit(db, "transfer.shipped", warehouse="BAL-WH01", owner="DEFAULT",
                    external_ref=None, data={})) == 1
    assert len(emit(db, "delivery.shipped", warehouse="BAL-WH01", owner="DEFAULT",
                    external_ref=None, data={})) == 0


# --- users, operators, devices, audit ------------------------------------

def test_users_are_deactivated_never_deleted(client, user_headers, admin):
    r = client.post("/v1/users", headers=user_headers, json={
        "username": "tony", "display_name": "Tony S.", "role": "supervisor",
        "warehouses": ["BAL-WH01"], "password": "long enough password",
    })
    assert r.status_code == 201, r.text
    tony = r.json()
    assert "password" not in tony and "password_hash" not in tony
    assert login(client, "tony", "long enough password")["user"]["role"] == "supervisor"

    assert client.post(f"/v1/users/{admin.id}/deactivate", headers=user_headers).status_code == 422

    r = client.post(f"/v1/users/{tony['wms_id']}/deactivate", headers=user_headers)
    assert r.status_code == 200 and r.json()["active"] is False
    assert client.post("/v1/auth/login", json={"username": "tony", "password": "long enough password"}).status_code == 401
    users = client.get("/v1/users", headers=user_headers).json()["items"]
    assert {u["username"]: u["active"] for u in users} == {"leighton": True, "tony": False}

    r = client.post(f"/v1/users/{tony['wms_id']}/password", headers=user_headers,
                    json={"password": "short"})
    assert r.status_code == 422


def test_operators_and_devices(client, db, user_headers):
    r = client.post("/v1/operators", headers=user_headers, json={
        "code": "op-017", "name": "Sam K.", "pin": "2468", "badge": "0042",
        "roles": ["picker", "packer"], "warehouses": ["BAL-WH01"],
    })
    assert r.status_code == 201, r.text
    op = r.json()
    assert op["roles"] == ["picker", "packer"]
    assert "pin" not in op and "pin_hash" not in op

    r = client.post("/v1/devices", headers=user_headers, json={
        "code": "SCN-BAL-07", "name": "Honeywell CT45", "warehouse": "BAL-WH01"})
    assert r.status_code == 422  # warehouse does not exist yet
    client.post("/v1/sites", headers=user_headers, json={"message_id": str(uuid.uuid4()), "code": "BAL", "name": "Ballarat"})
    client.post("/v1/warehouses", headers=user_headers, json={"message_id": str(uuid.uuid4()), "code": "BAL-WH01", "site": "BAL", "name": "Ballarat 1"})
    r = client.post("/v1/devices", headers=user_headers, json={
        "code": "SCN-BAL-07", "name": "Honeywell CT45", "warehouse": "BAL-WH01"})
    assert r.status_code == 201, r.text
    assert r.json()["warehouse"] == "BAL-WH01"

    assert client.post(f"/v1/operators/{op['wms_id']}/reset-pin", headers=user_headers,
                       json={"pin": "1357"}).status_code == 200
    assert client.post(f"/v1/operators/{op['wms_id']}/deactivate", headers=user_headers).status_code == 200
    ops = client.get("/v1/operators", headers=user_headers).json()["items"]
    assert ops[0]["active"] is False
    devs = client.get("/v1/devices", headers=user_headers).json()["items"]
    assert [d["code"] for d in devs] == ["SCN-BAL-07"]


def test_audit_log_lists_newest_first_and_cannot_change(client, db, user_headers):
    client.post("/v1/auth/login", json={"username": "leighton", "password": "wrong"})
    r = client.get("/v1/audit-log", headers=user_headers, params={"limit": 5})
    assert r.status_code == 200
    actions = [a["action"] for a in r.json()["items"]]
    assert actions[0] == "login_failed"
    assert "login" in actions

    import pytest
    from sqlalchemy import delete
    from sqlalchemy.exc import DBAPIError

    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(delete(AuditLog))
        db.commit()
    db.rollback()


# --- ledger listing and settings ----------------------------------------

def test_ledger_listing_newest_first(client, db, structure, user_headers):
    from wms.services.ledger import LedgerLine, post

    s = structure
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("120"),
                         uom="EA", movement_type="receipt", actor="jo", received_at=s.received,
                         external_ref="PO-88812")])
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("-48"),
                         uom="EA", movement_type="move", actor="jo", received_at=s.received),
              LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("48"),
                         uom="EA", movement_type="move", actor="jo", received_at=s.received)])
    db.commit()

    r = client.get("/v1/stock/ledger", headers=user_headers, params={"sku": "ABC123"})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [(i["location"], i["qty_change"]) for i in items] == [
        ("PF-01-02-A", "48"), ("BK-04-01-C", "-48"), ("BK-04-01-C", "120")]
    assert items[-1]["external_ref"] == "PO-88812"
    assert items[0]["movement_type"] == "move"

    r = client.get("/v1/stock/ledger", headers=user_headers, params={"location": "PF-01-02-A"})
    assert len(r.json()["items"]) == 1


def test_warehouse_settings_merge(client, user_headers):
    client.post("/v1/sites", headers=user_headers, json={"message_id": str(uuid.uuid4()), "code": "BAL", "name": "Ballarat"})
    client.post("/v1/warehouses", headers=user_headers, json={"message_id": str(uuid.uuid4()), "code": "BAL-WH01", "site": "BAL", "name": "Ballarat 1"})

    r = client.get("/v1/warehouses/BAL-WH01", headers=user_headers)
    assert r.status_code == 200
    defaults = r.json()["settings"]
    assert defaults["erp_counts_gr"] is False
    # A picker signs in once a shift, not after every pallet.
    assert defaults["idle_logout_minutes"] == 480
    assert defaults["allow_hard_deletes"] is False

    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=user_headers,
                     json={"erp_counts_gr": True, "receipt_tolerance_pct": 10})
    assert r.status_code == 200, r.text
    got = r.json()["settings"]
    assert got["erp_counts_gr"] is True
    assert got["receipt_tolerance_pct"] == 10
    assert got["idle_logout_minutes"] == 480

    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=user_headers,
                     json={"allow_hard_deletes": True})
    assert r.status_code == 422
    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=user_headers,
                     json={"made_up": 1})
    assert r.status_code == 422
