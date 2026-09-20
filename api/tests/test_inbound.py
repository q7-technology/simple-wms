"""Step 2: receipts, put away, moves, counts and replenishment, all as tasks."""
import uuid
from decimal import Decimal

from sqlalchemy import select

from wms.models import OutboundEvent, StockLedger, Subscriber, Task
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def receipt_body(ref="PO-88815", lines=None):
    return msg(
        external_ref=ref, warehouse="BAL-WH01", owner="DEFAULT", supplier="Supplier Co",
        expected_at="2026-09-22",
        lines=lines or [
            {"line": 1, "sku": "ABC123", "batch": None, "qty": 120, "uom": "EA"},
            {"line": 2, "sku": "FG-900", "batch": "B2609A", "qty": 100, "uom": "EA"},
        ],
    )


def subscribe(db, listener, *types):
    db.add(Subscriber(name="erp", url=listener.url, secret="s3cret", event_types=list(types)))
    db.commit()


def events(db):
    return [e.event_type for e in db.execute(select(OutboundEvent).order_by(OutboundEvent.id)).scalars()]


# --- receipts -------------------------------------------------------------

def test_receipt_creates_a_receive_task(client, structure, headers):
    r = client.post("/v1/receipts", headers=headers, json=receipt_body())
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "accepted"

    got = client.get("/v1/receipts/PO-88815", headers=headers, params={"warehouse": "BAL-WH01"})
    assert got.status_code == 200, got.text
    receipt = got.json()
    assert receipt["status"] == "expected"
    assert receipt["supplier"] == "Supplier Co"
    assert [(l["line"], l["sku"], l["expected_qty"], l["received_qty"]) for l in receipt["lines"]] == [
        (1, "ABC123", "120", "0"), (2, "FG-900", "100", "0")]
    assert receipt["task"]["type"] == "receive"
    assert receipt["task"]["status"] == "waiting"

    tasks = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "receive"}).json()
    assert tasks["total"] == 1
    task = tasks["items"][0]
    assert task["source_ref"] == "PO-88815"
    assert task["title"] == "Receive PO-88815"
    assert task["progress"] == {"done": 0, "total": 2}
    assert task["lines"][0]["expected_qty"] == "120"
    assert task["lines"][0]["to_location"] is None


def test_receipt_with_unknown_sku_is_422(client, structure, headers):
    r = client.post("/v1/receipts", headers=headers, json=receipt_body(
        lines=[{"line": 1, "sku": "NOPE", "qty": 1, "uom": "EA"}]))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "lines.0.sku"


def test_batch_tracked_line_without_a_batch_must_scan_one(client, structure, headers):
    r = client.post("/v1/receipts", headers=headers, json=receipt_body(
        lines=[{"line": 1, "sku": "FG-900", "batch": None, "qty": 1, "uom": "EA"}]))
    # allowed at receipt creation: the batch comes off the label at the dock
    assert r.status_code == 202
    task_id = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01"}).json()["items"][0]["wms_id"]
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=1, uom="EA", location="BK-04-01-C"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "batch"
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=1, uom="EA", batch="B1", location="BK-04-01-C"))
    assert r.status_code == 202


def test_receive_line_puts_stock_on_a_shelf_and_fires_events(client, db, structure, headers, listener):
    subscribe(db, listener, "receipt.confirmed", "receipt.closed")
    client.post("/v1/receipts", headers=headers, json=receipt_body())
    task_id = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01"}).json()["items"][0]["wms_id"]

    r = client.post(f"/v1/tasks/{task_id}/start", headers=headers, json=msg(operator="op-017", device="SCN-BAL-07"))
    assert r.status_code == 202, r.text
    assert client.get(f"/v1/tasks/{task_id}", headers=headers).json()["status"] == "in_progress"

    # first pallet of line 1
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=80, uom="EA", location="BK-04-01-C", operator="op-017", device="SCN-BAL-07"))
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["line"]["status"] == "open"
    assert body["line"]["actual_qty"] == "80"
    assert body["task"]["status"] == "in_progress"

    # second pallet finishes the line
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=40, uom="EA", location="BK-04-02-A", operator="op-017", device="SCN-BAL-07"))
    assert r.json()["line"]["status"] == "done"

    stock = client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()
    assert stock["total_on_hand"] == "120"
    assert {(l["location"], l["on_hand"]) for l in stock["locations"]} == {("BK-04-01-C", "80"), ("BK-04-02-A", "40")}

    # the receipt says which batch is coming; a different scan is refused
    r = client.post(f"/v1/tasks/{task_id}/lines/2/confirm", headers=headers, json=msg(
        qty=100, uom="EA", batch="WRONG", location="BK-04-02-A", operator="op-017"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "batch"

    r = client.post(f"/v1/tasks/{task_id}/lines/2/confirm", headers=headers, json=msg(
        qty=100, uom="EA", batch="B2609A", location="BK-04-02-A", operator="op-017"))
    assert r.status_code == 202, r.text
    assert r.json()["task"]["status"] == "done"

    receipt = client.get("/v1/receipts/PO-88815", headers=headers).json()
    assert receipt["status"] == "complete"
    assert receipt["lines"][0]["received_qty"] == "120"
    assert [(p["location"], p["qty"]) for p in receipt["putaways"]] == [
        ("BK-04-01-C", "80"), ("BK-04-02-A", "40"), ("BK-04-02-A", "100")]

    assert events(db) == ["receipt.confirmed", "receipt.confirmed", "receipt.confirmed", "receipt.closed"]
    first = db.execute(select(OutboundEvent).order_by(OutboundEvent.id)).scalars().first()
    assert first.payload["data"] == {
        "sku": "ABC123", "batch": None, "qty": "80", "uom": "EA", "location": "BK-04-01-C",
        "receipt_ref": "PO-88815", "line": 1, "operator": "op-017", "device": "SCN-BAL-07",
    }
    ledger = db.execute(select(StockLedger).order_by(StockLedger.id)).scalars().all()
    assert [l.movement_type for l in ledger] == ["receipt"] * 3
    assert ledger[0].task_id == int(task_id) and ledger[0].actor == "op-017"
    assert ledger[0].received_at is not None


def test_confirm_is_idempotent_per_message_id(client, db, structure, headers):
    client.post("/v1/receipts", headers=headers, json=receipt_body())
    task_id = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01"}).json()["items"][0]["wms_id"]
    body = msg(qty=50, uom="EA", location="BK-04-01-C", operator="op-017")
    r1 = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=body)
    r2 = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=body)
    assert r1.status_code == r2.status_code == 202
    assert r1.json() == r2.json()
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "50"


def test_over_receipt_needs_a_supervisor(client, db, structure, headers, supervisor_badge):
    client.post("/v1/receipts", headers=headers, json=receipt_body())
    task_id = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01"}).json()["items"][0]["wms_id"]

    # 5 % tolerance by default: 126 is fine, 130 is not
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=130, uom="EA", location="BK-04-01-C", operator="op-017"))
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "needs_supervisor"
    assert "tolerance" in r.json()["detail"]

    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=130, uom="EA", location="BK-04-01-C", operator="op-017", supervisor_badge="bad-badge"))
    assert r.status_code == 403

    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=130, uom="EA", location="BK-04-01-C", operator="op-017", supervisor_badge=supervisor_badge))
    assert r.status_code == 202, r.text
    assert r.json()["line"]["status"] == "done"
    assert r.json()["line"]["actual_qty"] == "130"


def test_close_receipt_short(client, db, structure, headers, listener):
    subscribe(db, listener, "receipt.closed")
    client.post("/v1/receipts", headers=headers, json=receipt_body())
    task_id = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01"}).json()["items"][0]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=100, uom="EA", location="BK-04-01-C", operator="op-017"))

    r = client.post(f"/v1/tasks/{task_id}/close", headers=headers, json=msg(reason="supplier_short", operator="op-017"))
    assert r.status_code == 202, r.text
    task = client.get(f"/v1/tasks/{task_id}", headers=headers).json()
    assert task["status"] == "done"
    assert [l["status"] for l in task["lines"]] == ["short", "short"]
    receipt = client.get("/v1/receipts/PO-88815", headers=headers).json()
    assert receipt["status"] == "closed_short"
    closed = db.execute(select(OutboundEvent)).scalar_one()
    assert closed.payload["data"]["complete"] is False
    assert closed.payload["data"]["lines"][1] == {"line": 2, "sku": "FG-900", "batch": "B2609A", "qty_expected": "100", "qty_received": "0", "uom": "EA"}


def test_task_board_listing_and_cancel(client, structure, headers):
    client.post("/v1/receipts", headers=headers, json=receipt_body("PO-1"))
    client.post("/v1/receipts", headers=headers, json=receipt_body("PO-2"))
    items = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "status": "waiting"}).json()["items"]
    assert [t["source_ref"] for t in items] == ["PO-1", "PO-2"]

    t = items[0]["wms_id"]
    assert client.post(f"/v1/tasks/{t}/assign", headers=headers, json=msg(assigned_to="op-017")).status_code == 202
    assert client.get(f"/v1/tasks/{t}", headers=headers).json()["assigned_to"] == "op-017"
    assert client.post(f"/v1/tasks/{t}/cancel", headers=headers, json=msg(reason="duplicate")).status_code == 202
    assert client.get(f"/v1/tasks/{t}", headers=headers).json()["status"] == "cancelled"
    assert client.get("/v1/receipts/PO-1", headers=headers).json()["status"] == "cancelled"
    # a cancelled task cannot be worked
    r = client.post(f"/v1/tasks/{t}/lines/1/confirm", headers=headers, json=msg(qty=1, uom="EA", location="BK-04-01-C"))
    assert r.status_code == 409


# --- putaway suggestions -----------------------------------------------------

def test_suggest_prefers_same_sku_then_preferred_zone_then_any_then_overflow(client, db, structure, headers):
    s = structure
    s.abc.preferred_zone = "PICKFACE"
    db.commit()
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("10"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received)])
    db.commit()

    r = client.post("/v1/locations/suggest", headers=headers, json={
        "warehouse": "BAL-WH01", "sku": "ABC123", "batch": None, "qty": 20, "uom": "EA", "purpose": "putaway"})
    assert r.status_code == 200, r.text
    got = [(x["location"], x["reason"]) for x in r.json()["suggestions"]]
    assert got[0] == ("BK-04-01-C", "same_sku_has_space")
    assert got[1] == ("PF-01-02-A", "empty_in_preferred_zone")
    assert got[2] == ("BK-04-02-A", "empty_shelf")

    # nothing empty and no same-sku: overflow with a flag
    post(db, [LedgerLine(product_id=s.fg.id, location_id=s.pf.id, qty_change=Decimal("1"), uom="EA", batch="B",
                         movement_type="receipt", actor="t", received_at=s.received),
              LedgerLine(product_id=s.fg.id, location_id=s.bk2.id, qty_change=Decimal("1"), uom="EA", batch="B",
                         movement_type="receipt", actor="t", received_at=s.received)])
    s.bk1.mixing = "single_sku"
    db.commit()
    r = client.post("/v1/locations/suggest", headers=headers, json={
        "warehouse": "BAL-WH01", "sku": "FG-900", "batch": "C", "qty": 5, "uom": "EA", "purpose": "putaway"})
    got = [(x["location"], x["reason"]) for x in r.json()["suggestions"]]
    assert ("PF-01-02-A", "same_sku_has_space") in got
    assert r.json()["flag"] is None


# --- moves ---------------------------------------------------------------

def test_move_within_warehouse_is_a_done_task_with_two_ledger_rows(client, db, structure, headers, listener):
    subscribe(db, listener, "stock.moved")
    s = structure
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("72"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received)])
    db.commit()

    r = client.post("/v1/moves", headers=headers, json=msg(
        warehouse="BAL-WH01", owner="DEFAULT", sku="ABC123", batch=None, qty=12, uom="EA",
        from_location="BK-04-01-C", to_location="PF-01-02-A", reason="tidy", operator="op-017", device="SCN-BAL-07"))
    assert r.status_code == 202, r.text
    task = client.get(f"/v1/tasks/{r.json()['wms_id']}", headers=headers).json()
    assert task["type"] == "move" and task["status"] == "done"
    assert task["lines"][0]["actual_qty"] == "12"

    stock = client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()
    assert {(l["location"], l["on_hand"], l["received_at"]) for l in stock["locations"]} == {
        ("BK-04-01-C", "60", "2026-08-30"), ("PF-01-02-A", "12", "2026-08-30")}
    ev = db.execute(select(OutboundEvent)).scalar_one()
    assert ev.payload["data"] == {"sku": "ABC123", "batch": None, "qty": "12", "uom": "EA",
                                  "from": "BK-04-01-C", "to": "PF-01-02-A", "reason": "tidy", "operator": "op-017"}

    r = client.post("/v1/moves", headers=headers, json=msg(
        warehouse="BAL-WH01", sku="ABC123", qty=100, uom="EA", from_location="BK-04-01-C", to_location="PF-01-02-A"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "qty"


def test_move_rejects_single_sku_shelf_with_another_product(client, db, structure, headers):
    s = structure
    s.pf.mixing = "single_sku"
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("5"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received),
              LedgerLine(product_id=s.fg.id, location_id=s.bk1.id, qty_change=Decimal("5"), uom="EA", batch="B",
                         movement_type="receipt", actor="t", received_at=s.received)])
    db.commit()
    r = client.post("/v1/moves", headers=headers, json=msg(
        warehouse="BAL-WH01", sku="FG-900", batch="B", qty=1, uom="EA", from_location="BK-04-01-C", to_location="PF-01-02-A"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "to_location"


# --- counts --------------------------------------------------------------

def test_blind_count_variance_needs_supervisor_then_adjusts(client, db, structure, headers, listener, supervisor_badge):
    subscribe(db, listener, "stock.adjusted")
    s = structure
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("48"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received)])
    db.commit()

    r = client.post("/v1/counts", headers=headers, json=msg(warehouse="BAL-WH01", locations=["PF-01-02-A", "BK-04-01-C"]))
    assert r.status_code == 202, r.text
    task = client.get(f"/v1/tasks/{r.json()['wms_id']}", headers=headers).json()
    assert task["type"] == "count"
    assert task["title"].startswith("Count ")
    assert len(task["lines"]) == 1  # only the shelf with stock has a line
    assert task["lines"][0]["from_location"] == "PF-01-02-A"
    # blind: the expected quantity is not handed to the scanner
    assert task["lines"][0]["expected_qty"] is None

    r = client.post(f"/v1/tasks/{task['wms_id']}/lines/1/confirm", headers=headers, json=msg(qty=46, uom="EA", operator="op-022"))
    assert r.status_code == 202, r.text
    assert r.json()["line"]["status"] == "variance"
    assert r.json()["line"]["variance"] == "-2"
    assert r.json()["task"]["status"] == "needs_supervisor"
    assert events(db) == []

    # supervisor on the desktop approves with a reason
    r = client.post(f"/v1/tasks/{task['wms_id']}/lines/1/approve", headers=headers, json=msg(reason="damaged", note="two cracked"))
    assert r.status_code == 202, r.text
    assert r.json()["task"]["status"] == "done"
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "46"
    ev = db.execute(select(OutboundEvent)).scalar_one()
    assert ev.payload["data"]["qty_change"] == "-2"
    assert ev.payload["data"]["reason"] == "damaged"
    assert ev.payload["data"]["ledger_id"]


def test_count_match_verifies_without_a_ledger_row_and_recount_resets(client, db, structure, headers):
    s = structure
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("48"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received)])
    db.commit()
    t = client.post("/v1/counts", headers=headers, json=msg(warehouse="BAL-WH01", locations=["PF-01-02-A"])).json()["wms_id"]

    r = client.post(f"/v1/tasks/{t}/lines/1/confirm", headers=headers, json=msg(qty=40, uom="EA"))
    assert r.json()["line"]["status"] == "variance"
    r = client.post(f"/v1/tasks/{t}/lines/1/recount", headers=headers, json=msg())
    assert r.status_code == 202
    assert r.json()["line"]["status"] == "open"
    assert r.json()["task"]["status"] == "in_progress"

    r = client.post(f"/v1/tasks/{t}/lines/1/confirm", headers=headers, json=msg(qty=48, uom="EA"))
    assert r.json()["line"]["status"] == "done"
    assert r.json()["task"]["status"] == "done"
    assert db.execute(select(StockLedger)).scalars().all().__len__() == 1


# --- replenishment ---------------------------------------------------------

def test_replenishment_task_picks_fifo_source_and_completes(client, db, structure, headers, listener):
    subscribe(db, listener, "replenishment.completed")
    s = structure
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk2.id, qty_change=Decimal("100"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received.replace(day=2))])
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("100"), uom="EA",
                         movement_type="receipt", actor="t", received_at=s.received)])
    db.commit()

    r = client.post("/v1/replenishments", headers=headers, json=msg(
        external_ref="REP-1001", warehouse="BAL-WH01", owner="DEFAULT", priority="high",
        lines=[{"line": 1, "sku": "ABC123", "qty": 48, "uom": "EA", "to_location": "PF-01-02-A", "from_location": None, "batch": None}]))
    assert r.status_code == 202, r.text
    task = client.get(f"/v1/tasks/{r.json()['wms_id']}", headers=headers).json()
    assert task["type"] == "replenish" and task["priority"] == "high"
    assert task["lines"][0]["from_location"] == "BK-04-02-A"  # oldest received first
    assert task["lines"][0]["to_location"] == "PF-01-02-A"

    r = client.post(f"/v1/tasks/{task['wms_id']}/lines/1/confirm", headers=headers, json=msg(qty=48, uom="EA", operator="op-017"))
    assert r.status_code == 202, r.text
    assert r.json()["task"]["status"] == "done"
    stock = client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()
    assert {(l["location"], l["on_hand"]) for l in stock["locations"]} == {("BK-04-01-C", "100"), ("BK-04-02-A", "52"), ("PF-01-02-A", "48")}
    ev = db.execute(select(OutboundEvent)).scalar_one()
    assert ev.payload["data"]["replen_ref"] == "REP-1001"
    assert ev.payload["data"]["lines"][0]["qty_moved"] == "48"


def test_task_needs_stock_scope_for_writes(client, db, structure):
    from wms.services.access import create_api_client

    _, raw = create_api_client(db, name="ro", scopes=["stock:read", "tasks:read"], warehouses=["*"], owner="DEFAULT")
    db.commit()
    h = {"Authorization": f"Bearer {raw}"}
    assert client.get("/v1/tasks", headers=h, params={"warehouse": "BAL-WH01"}).status_code == 200
    assert client.post("/v1/receipts", headers=h, json=receipt_body()).status_code == 403
