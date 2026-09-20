"""Step 5b: issue components to the line, take finished goods back."""
import uuid
from decimal import Decimal

from sqlalchemy import select

from wms.models import OutboundEvent, StockLedger, Subscriber
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def stock(db, s, product, location, qty, batch=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, movement_type="receipt", actor="jo",
                         received_at=s.received)])
    db.commit()


def subscribe(db, listener, *types):
    db.add(Subscriber(name="erp", url=listener.url, secret="s3cret", event_types=list(types)))
    db.commit()


def events(db):
    return [(e.event_type, e.payload["data"]) for e in
            db.execute(select(OutboundEvent).order_by(OutboundEvent.id)).scalars()]


def order_body(ref="PRD-1000456", **extra):
    body = dict(external_ref=ref, warehouse="BAL-WH01", owner="DEFAULT",
                required_by="2026-09-22T06:00:00Z",
                output={"sku": "FG-900", "batch": "B2609A", "qty": 100, "uom": "EA"},
                components=[{"line": 1, "sku": "ABC123", "batch": None, "qty": 20, "uom": "EA",
                             "deliver_to": "LINE-03-IN"}])
    body.update(extra)
    return msg(**body)


def open_order(client, db, structure, headers, on_hand="50", **extra):
    stock(db, structure, structure.abc, structure.bk1, on_hand)
    r = client.post("/v1/production-orders", headers=headers, json=order_body(**extra))
    assert r.status_code == 202, r.text
    return client.get("/v1/production-orders/PRD-1000456", headers=headers).json()


# --- raising the order ------------------------------------------------------

def test_an_order_reserves_its_components_and_raises_an_issue_task(client, db, structure, headers):
    got = open_order(client, db, structure, headers)
    assert got["status"] == "issuing"
    assert got["output"] == {"sku": "FG-900", "name": "Finished good", "batch": "B2609A",
                             "qty": "100", "qty_received": "0", "uom": "EA"}
    assert [(c["sku"], c["qty_requested"], c["qty_issued"], c["deliver_to"]) for c in got["components"]] == [
        ("ABC123", "20", "0", "LINE-03-IN")]

    task = got["issue_task"]
    assert task["type"] == "production_issue"
    assert task["title"] == "Issue PRD-1000456"
    assert [(l["from_location"], l["to_location"], l["expected_qty"]) for l in task["lines"]] == [
        ("BK-04-01-C", "LINE-03-IN", "20")]
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_available"] == "30"


def test_an_unknown_line_side_location_is_422(client, db, structure, headers):
    stock(db, structure, structure.abc, structure.bk1, "50")
    r = client.post("/v1/production-orders", headers=headers, json=order_body(
        components=[{"line": 1, "sku": "ABC123", "qty": 5, "uom": "EA", "deliver_to": "NOPE"}]))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "components.0.deliver_to"


def test_an_output_sku_that_is_not_a_product_is_422(client, db, structure, headers):
    stock(db, structure, structure.abc, structure.bk1, "50")
    r = client.post("/v1/production-orders", headers=headers, json=order_body(
        output={"sku": "NOPE", "batch": None, "qty": 10, "uom": "EA"}))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "output.sku"


def test_components_at_the_line_are_not_offered_to_a_pick(client, db, structure, headers):
    got = open_order(client, db, structure, headers)
    client.post(f"/v1/tasks/{got['issue_task']['wms_id']}/lines/1/confirm", headers=headers,
                json=msg(qty=20, uom="EA", operator="op-017"))
    # the 20 sitting at the line are on hand but no delivery may have them
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "50"
    r = client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="D1", warehouse="BAL-WH01", ship_to={"name": "Acme"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 50, "uom": "EA"}]))
    assert r.json()["allocation"][0]["qty_allocated"] == "30"


# --- issuing ----------------------------------------------------------------

def test_issuing_moves_components_to_the_line_and_tells_the_erp(client, db, structure, headers, listener):
    subscribe(db, listener, "production.components_issued")
    got = open_order(client, db, structure, headers)
    task_id = got["issue_task"]["wms_id"]

    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=20, uom="EA", operator="op-017", device="SCN-BAL-07"))
    assert r.status_code == 202, r.text
    assert r.json()["task"]["status"] == "done"

    rows = db.execute(select(StockLedger).where(StockLedger.movement_type == "production_issue")
                      .order_by(StockLedger.id)).scalars().all()
    assert [r.qty_change for r in rows] == [Decimal("-20"), Decimal("20")]
    at_line = client.get("/v1/locations/LINE-03-IN/stock", headers=headers,
                         params={"warehouse": "BAL-WH01"}).json()["stock"]
    assert [(x["sku"], x["on_hand"]) for x in at_line] == [("ABC123", "20")]

    got = client.get("/v1/production-orders/PRD-1000456", headers=headers).json()
    assert got["status"] == "in_production"
    assert got["components"][0]["qty_issued"] == "20"

    issued = [e for e in events(db) if e[0] == "production.components_issued"][0][1]
    assert issued["po_ref"] == "PRD-1000456"
    assert issued["complete"] is True
    assert issued["lines"] == [{"line": 1, "sku": "ABC123", "batch": None, "qty_requested": "20",
                                "qty_issued": "20", "uom": "EA", "deliver_to": "LINE-03-IN"}]


def test_a_short_issue_is_allowed_and_the_remainder_stays_open(client, db, structure, headers, listener):
    subscribe(db, listener, "production.components_issued")
    got = open_order(client, db, structure, headers)
    task_id = got["issue_task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=12, uom="EA"))
    r = client.post(f"/v1/tasks/{task_id}/close", headers=headers, json=msg(reason="that is all there was"))
    assert r.status_code == 202, r.text

    got = client.get("/v1/production-orders/PRD-1000456", headers=headers).json()
    assert got["status"] == "in_production"
    assert got["components"][0]["qty_issued"] == "12"
    assert got["components"][0]["short"] == "8"
    issued = [e for e in events(db) if e[0] == "production.components_issued"][0][1]
    assert issued["complete"] is False
    assert issued["lines"][0]["qty_issued"] == "12"
    # the 8 that never went are back on the shelf, not held
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_available"] == "38"


# --- receiving finished goods --------------------------------------------------

def receipt_body(**extra):
    body = dict(warehouse="BAL-WH01", sku="FG-900", batch="B2609A", qty=40, uom="EA",
                to_location="BK-04-02-A", container_id=None, operator="op-017",
                device_id="SCN-BAL-07")
    body.update(extra)
    return msg(**body)


def test_finished_goods_come_back_pallet_by_pallet(client, db, structure, headers, listener):
    subscribe(db, listener, "production.received")
    got = open_order(client, db, structure, headers)
    client.post(f"/v1/tasks/{got['issue_task']['wms_id']}/lines/1/confirm", headers=headers,
                json=msg(qty=20, uom="EA"))

    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=receipt_body())
    assert r.status_code == 202, r.text
    assert r.json()["received_total"] == "40"
    assert r.json()["expected"] == "100"

    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers,
                    json=receipt_body(qty=60))
    assert r.status_code == 202, r.text
    assert r.json()["received_total"] == "100"

    got = client.get("/v1/production-orders/PRD-1000456", headers=headers).json()
    assert got["status"] == "complete"
    assert got["output"]["qty_received"] == "100"
    assert [(p["qty"], p["location"]) for p in got["receipts"]] == [("40", "BK-04-02-A"), ("60", "BK-04-02-A")]

    on_hand = client.get("/v1/stock", headers=headers, params={"sku": "FG-900"}).json()
    assert on_hand["total_on_hand"] == "100"
    rows = db.execute(select(StockLedger).where(StockLedger.movement_type == "production_receipt")).scalars().all()
    assert [r.batch for r in rows] == ["B2609A", "B2609A"]

    received = [e for e in events(db) if e[0] == "production.received"]
    assert len(received) == 2
    assert received[0][1] == {"po_ref": "PRD-1000456", "sku": "FG-900", "batch": "B2609A",
                              "qty": "40", "uom": "EA", "location": "BK-04-02-A",
                              "container_id": None, "operator": "op-017",
                              "received_total": "40", "expected": "100", "complete": False}


def test_the_batch_must_match_the_order(client, db, structure, headers):
    got = open_order(client, db, structure, headers)
    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers,
                    json=receipt_body(batch="WRONG"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "batch"
    assert "B2609A" in r.json()["errors"][0]["message"]

    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers,
                    json=receipt_body(batch=None))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "batch"


def test_a_wrong_sku_is_refused(client, db, structure, headers):
    open_order(client, db, structure, headers)
    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers,
                    json=receipt_body(sku="ABC123"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "sku"


def test_over_receipt_beyond_tolerance_needs_a_supervisor(client, db, structure, headers, supervisor_badge):
    open_order(client, db, structure, headers)
    client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=receipt_body(qty=100))

    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=receipt_body(qty=12))
    assert r.status_code == 409
    assert r.json()["code"] == "needs_supervisor"
    assert "tolerance" in r.json()["detail"]

    # within the 5 % tolerance is fine
    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=receipt_body(qty=4))
    assert r.status_code == 202, r.text

    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers,
                    json=receipt_body(qty=20, supervisor_badge=supervisor_badge))
    assert r.status_code == 202, r.text
    assert r.json()["received_total"] == "124"


def test_when_the_erp_counts_the_goods_receipt_no_event_is_sent(client, db, structure, headers, listener):
    subscribe(db, listener, "production.received")
    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers, json={"erp_counts_gr": True})
    assert r.status_code == 200, r.text
    open_order(client, db, structure, headers)

    r = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=receipt_body())
    assert r.status_code == 202, r.text
    assert r.json()["event_sent"] is False
    # the bins are still assigned, the ERP simply hears nothing
    assert client.get("/v1/stock", headers=headers, params={"sku": "FG-900"}).json()["total_on_hand"] == "40"
    assert [e for e in events(db) if e[0] == "production.received"] == []


def test_a_receipt_is_idempotent_per_message_id(client, db, structure, headers):
    open_order(client, db, structure, headers)
    body = receipt_body()
    r1 = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=body)
    r2 = client.post("/v1/production-orders/PRD-1000456/receipts", headers=headers, json=body)
    assert r1.json() == r2.json()
    assert client.get("/v1/stock", headers=headers, params={"sku": "FG-900"}).json()["total_on_hand"] == "40"


# --- cancelling and listing -------------------------------------------------

def test_cancel_gives_the_components_back(client, db, structure, headers):
    open_order(client, db, structure, headers)
    r = client.post("/v1/production-orders/PRD-1000456/cancel", headers=headers, json=msg(reason="line down"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/production-orders/PRD-1000456", headers=headers).json()
    assert got["status"] == "cancelled"
    assert got["issue_task"]["status"] == "cancelled"
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_available"] == "50"


def test_production_order_listing(client, db, structure, headers):
    open_order(client, db, structure, headers)
    stock(db, structure, structure.abc, structure.bk2, "50")
    client.post("/v1/production-orders", headers=headers, json=order_body("PRD-2"))
    page = client.get("/v1/production-orders", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert page["total"] == 2
    assert {p["external_ref"] for p in page["items"]} == {"PRD-1000456", "PRD-2"}
    one = client.get("/v1/production-orders", headers=headers,
                     params={"warehouse": "BAL-WH01", "status": "issuing"}).json()
    assert one["total"] == 2
