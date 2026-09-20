"""Scanner login (device + operator + PIN or badge), lockout, and the scan parser."""
import uuid

from sqlalchemy import select

from wms.models import AuditLog, Device, Operator, ProductBarcode
from wms.services.access import hash_password


def setup_floor(db, structure):
    db.add(Device(code="SCN-BAL-07", name="Honeywell CT45", warehouse_id=structure.warehouse.id))
    db.add(Operator(code="op-017", name="Sam K.", pin_hash=hash_password("2468"), badge="0042",
                    roles=["picker", "packer"], warehouses=["BAL-WH01"]))
    db.add(Operator(code="op-022", name="Priya N.", pin_hash=hash_password("1111"), badge=None,
                    roles=["picker", "counter"], warehouses=["MEL-WH01"]))
    db.commit()


def login(client, **body):
    return client.post("/v1/auth/scanner-login", json={"device_id": "SCN-BAL-07", "warehouse": "BAL-WH01", **body})


def test_pin_login_returns_operator_session(client, db, structure):
    setup_floor(db, structure)
    r = login(client, operator_id="op-017", pin="2468")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"].startswith("wms_o.")
    assert body["expires_in"] == 12 * 3600
    assert body["operator"] == {"code": "op-017", "name": "Sam K.", "roles": ["picker", "packer"], "supervisor": False}
    assert body["warehouses"] == ["BAL-WH01"]
    assert body["device"] == "SCN-BAL-07"

    h = {"Authorization": f"Bearer {body['token']}"}
    me = client.get("/v1/auth/me", headers=h).json()
    assert me["kind"] == "operator" and me["username"] == "op-017"
    assert client.get("/v1/tasks", headers=h, params={"warehouse": "BAL-WH01"}).status_code == 200
    assert client.get("/v1/tasks", headers=h, params={"warehouse": "MEL-WH01"}).status_code == 403
    assert client.post("/v1/products", headers=h, json={"message_id": str(uuid.uuid4()), "sku": "X", "name": "X"}).status_code == 403
    assert client.get("/v1/users", headers=h).status_code == 403


def test_badge_login(client, db, structure):
    setup_floor(db, structure)
    r = login(client, badge="0042")
    assert r.status_code == 200, r.text
    assert r.json()["operator"]["code"] == "op-017"


def test_unknown_or_inactive_device_is_refused(client, db, structure):
    setup_floor(db, structure)
    r = client.post("/v1/auth/scanner-login", json={"device_id": "SCN-XX", "warehouse": "BAL-WH01", "operator_id": "op-017", "pin": "2468"})
    assert r.status_code == 403
    assert "registered" in r.json()["detail"]
    dev = db.execute(select(Device)).scalar_one()
    dev.active = False
    db.commit()
    assert login(client, operator_id="op-017", pin="2468").status_code == 403


def test_operator_outside_their_warehouse_is_refused(client, db, structure):
    setup_floor(db, structure)
    r = login(client, operator_id="op-022", pin="1111")
    assert r.status_code == 403


def test_five_wrong_pins_lock_the_account_and_a_supervisor_unlocks(client, db, structure, supervisor_badge):
    setup_floor(db, structure)
    for i in range(4):
        r = login(client, operator_id="op-017", pin="0000")
        assert r.status_code == 401
        assert r.json()["code"] == "wrong_pin"
        assert r.json()["tries_left"] == 4 - i
    r = login(client, operator_id="op-017", pin="0000")
    assert r.status_code == 401
    assert r.json()["code"] == "locked"
    # right PIN no longer helps
    r = login(client, operator_id="op-017", pin="2468")
    assert r.status_code == 401 and r.json()["code"] == "locked"
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert actions.count("scanner.login_failed") == 6
    assert "operator.locked" in actions

    r = client.post("/v1/auth/scanner-unlock", json={
        "device_id": "SCN-BAL-07", "warehouse": "BAL-WH01", "operator_id": "op-017",
        "supervisor_badge": "wrong", "new_pin": "1357"})
    assert r.status_code == 403
    r = client.post("/v1/auth/scanner-unlock", json={
        "device_id": "SCN-BAL-07", "warehouse": "BAL-WH01", "operator_id": "op-017",
        "supervisor_badge": supervisor_badge, "new_pin": "1357"})
    assert r.status_code == 200, r.text
    assert login(client, operator_id="op-017", pin="1357").status_code == 200
    assert client.get("/v1/operators", headers={"Authorization": "Bearer x"}).status_code == 401


def test_supervisor_badge_check(client, db, structure, supervisor_badge):
    setup_floor(db, structure)
    token = login(client, operator_id="op-017", pin="2468").json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    r = client.post("/v1/auth/supervisor-check", headers=h, json={"badge": supervisor_badge, "warehouse": "BAL-WH01"})
    assert r.status_code == 200 and r.json() == {"ok": True, "operator": "op-001", "name": "Tony S."}
    r = client.post("/v1/auth/supervisor-check", headers=h, json={"badge": "0042", "warehouse": "BAL-WH01"})
    assert r.status_code == 200 and r.json()["ok"] is False


# --- scans ---------------------------------------------------------------

def parse(client, headers, raw, **extra):
    r = client.post("/v1/scans/parse", headers=headers, json={"raw": raw, "warehouse": "BAL-WH01", **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_gs1_qr_fills_product_batch_and_qty(client, db, structure, headers):
    got = parse(client, headers, "]Q3010931234500001210B2609A\u001d37120", expecting="product")
    assert got["format"] == "gs1"
    assert got["type"] == "product"
    assert got["fields"] == {"gtin": "09312345000012", "batch": "B2609A", "qty": "120"}
    assert got["resolved"]["sku"] == "ABC123"
    assert got["resolved"]["qty"] == "120"
    assert got["matches_expected"] is True


def test_gs1_128_sscc_and_weight(client, db, structure, headers):
    got = parse(client, headers, "]C1" + "00" + "009312345000000001" + "3102001250")
    assert got["format"] == "gs1"
    assert got["type"] == "container"
    assert got["fields"]["sscc"] == "009312345000000001"
    assert got["fields"]["weight_kg"] == "12.5"


def test_json_qr_is_a_production_order(client, db, structure, headers):
    got = parse(client, headers, '{"po": "PRD-1000456", "sku": "FG-900", "batch": "B2609A", "qty": 500}')
    assert got["format"] == "json"
    assert got["type"] == "production_order"
    assert got["fields"] == {"po": "PRD-1000456", "sku": "FG-900", "batch": "B2609A", "qty": "500"}
    assert got["resolved"]["sku"] == "FG-900"


def test_plain_text_lookups(client, db, structure, headers, supervisor_badge):
    s = structure
    s.bk1.barcode = "LOC-BK-04-01-C"
    s.abc.barcodes.append(ProductBarcode(barcode="ABC123-CTN12", kind="carton", qty_per=12))
    db.commit()

    assert parse(client, headers, "LOC-BK-04-01-C")["resolved"] == {"location": "BK-04-01-C", "zone": "BULK", "warehouse": "BAL-WH01"}
    assert parse(client, headers, "BK-04-01-C")["type"] == "location"
    assert parse(client, headers, "ABC123")["resolved"]["sku"] == "ABC123"
    carton = parse(client, headers, "ABC123-CTN12")
    assert carton["type"] == "product"
    assert carton["resolved"] == {"sku": "ABC123", "name": "Widget", "uom": "EA", "batch_tracked": False, "qty": "12", "barcode_kind": "carton"}
    badge = parse(client, headers, supervisor_badge)
    assert badge["type"] == "operator"
    assert badge["resolved"] == {"operator": "op-001", "name": "Tony S.", "supervisor": True}


def test_receipt_reference_resolves_to_its_task(client, db, structure, headers):
    client.post("/v1/receipts", headers=headers, json={
        "message_id": str(uuid.uuid4()), "external_ref": "PO-88815", "warehouse": "BAL-WH01",
        "lines": [{"line": 1, "sku": "ABC123", "qty": 10, "uom": "EA"}]})
    got = parse(client, headers, "PO-88815")
    assert got["type"] == "receipt"
    assert got["resolved"]["receipt"] == "PO-88815"
    assert got["resolved"]["task_id"]


def test_wrong_type_and_unknown_scans(client, db, structure, headers):
    got = parse(client, headers, "BK-04-01-C", expecting="product")
    assert got["type"] == "location"
    assert got["matches_expected"] is False
    assert got["message"] == "That is a location. This step wants a product."

    got = parse(client, headers, "ZZZ-NOPE")
    assert got["type"] == "unknown"
    assert got["format"] == "plain"
    row = db.execute(select(AuditLog).where(AuditLog.action == "scan.unknown")).scalar_one()
    assert row.detail["raw"] == "ZZZ-NOPE"
