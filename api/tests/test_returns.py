"""Came back: a delivery that left and came back undelivered is on the ledger
again, at the returns dock, and ships again from there."""
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from wms.models import Location, OutboundEvent, StockBalance, StockLedger, Subscriber, Task, Zone
from wms.services.ledger import LedgerLine, post, rebuild_balances


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def stock(db, s, product, location, qty, batch=None, received=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, movement_type="receipt", actor="jo",
                         received_at=received or s.received)])
    db.commit()


def returns_dock(db, s):
    zone = Zone(warehouse=s.warehouse, code="RETURNS", name="Returns", kind="returns")
    dock = Location(warehouse=s.warehouse, zone=zone, code="RETURNS-01", type="floor", pick_sequence=5)
    db.add_all([zone, dock])
    db.commit()
    return dock


def on_hand(db, location):
    return sum((b.on_hand for b in db.execute(
        select(StockBalance).where(StockBalance.location_id == location.id)).scalars()), Decimal(0))


# --- the returns zone ----------------------------------------------------------

def test_a_returns_zone_can_be_made(client, db, structure, headers):
    r = client.post("/v1/zones", headers=headers, json=msg(
        warehouse="BAL-WH01", code="RETURNS", name="Returns", kind="returns"))
    assert r.status_code == 202, r.text
    assert db.execute(select(Zone.kind).where(Zone.code == "RETURNS")).scalar_one() == "returns"


def test_stock_at_the_returns_dock_is_never_promised_or_put_away_to(client, db, structure, headers):
    """It belongs to a delivery that is going out again, not to the shelves."""
    s = structure
    dock = returns_dock(db, s)
    stock(db, s, s.abc, dock, "10")

    r = client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="D-OTHER", warehouse="BAL-WH01", ship_to={"name": "Someone else"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 5, "uom": "EA"}]))
    assert r.status_code == 202, r.text
    assert r.json()["allocation"][0]["qty_allocated"] == "0"

    r = client.post("/v1/locations/suggest", headers=headers, json={
        "warehouse": "BAL-WH01", "sku": "ABC123", "batch": None, "qty": 5, "uom": "EA", "purpose": "putaway"})
    assert r.status_code == 200, r.text
    assert "RETURNS-01" not in [x["location"] for x in r.json()["suggestions"]]


# --- coming back -----------------------------------------------------------------

def subscribe(db, listener, *types):
    db.add(Subscriber(name="erp", url=listener.url, secret="s3cret", event_types=list(types)))
    db.commit()


def events(db, event_type):
    return [e.payload["data"] for e in db.execute(
        select(OutboundEvent).where(OutboundEvent.event_type == event_type).order_by(OutboundEvent.id)).scalars()]


def shipped_delivery(client, db, s, headers, *, batch=None, tracking_no="R-0007"):
    """10 of ABC123 picked from BK-04-01-C, packed in two cartons, shipped."""
    stock(db, s, s.abc, s.bk1, "10", batch=batch, received=date(2026, 8, 1))
    r = client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="0080012345", warehouse="BAL-WH01", ship_to={"name": "Station Deli"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    assert r.status_code == 202, r.text
    task_id = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=10, uom="EA", operator="op-017"))
    assert r.status_code == 202, r.text
    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 6, "container_id": "CTN-1",
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}]},
                  {"package_no": 2, "type": "carton", "weight_kg": 4,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 4, "uom": "EA"}]}]))
    assert r.status_code == 202, r.text
    r = client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        carrier="Own fleet", tracking_no=tracking_no, shipped_by="dee"))
    assert r.status_code == 202, r.text


def came_back(client, headers, **over):
    body = msg(reason="closed", note="Shop shut, sign on the door", tracking_no="R-0007",
               returned_by="dee")
    body.update(over)
    return client.post("/v1/deliveries/0080012345/return", headers=headers, json=body)


def test_what_came_back_is_on_the_ledger_at_the_returns_dock(client, db, structure, headers, listener):
    subscribe(db, listener, "delivery.returned")
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "0"

    r = came_back(client, headers)
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "accepted"

    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "returned"
    assert got["returned_at"] is not None
    assert got["return_location"] == "RETURNS-01"
    # still the shipment that came back until it goes again
    assert (got["carrier"], got["tracking_no"]) == ("Own fleet", "R-0007")

    # one ledger row per carton line, into the dock, with the carton, the
    # reason and the shelf's received date, so FIFO is not reset by the trip
    rows = db.execute(select(StockLedger).where(StockLedger.movement_type == "return")
                      .order_by(StockLedger.id)).scalars().all()
    assert [(r.location_id, r.qty_change, r.container_id, r.reason, r.received_at, r.note)
            for r in rows] == [
        (dock.id, Decimal("6"), "CTN-1", "closed", date(2026, 8, 1), "Shop shut, sign on the door"),
        (dock.id, Decimal("4"), None, "closed", date(2026, 8, 1), "Shop shut, sign on the door")]
    assert {r.external_ref for r in rows} == {"0080012345"}
    assert on_hand(db, dock) == Decimal("10")
    stock_now = client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()
    assert (stock_now["total_on_hand"], stock_now["total_available"]) == ("10", "0")

    # it went through the task engine: one return task, done, a line per carton line
    task = db.get(Task, rows[0].task_id)
    assert (task.type, task.status, task.source_type, task.source_ref) == (
        "return", "done", "delivery", "0080012345")
    assert [(l.expected_qty, l.actual_qty, l.status, l.to_location_id) for l in task.lines] == [
        (Decimal("6"), Decimal("6"), "done", dock.id), (Decimal("4"), Decimal("4"), "done", dock.id)]
    assert task.assigned_to == "dee"

    assert events(db, "delivery.returned") == [{
        "delivery_ref": "0080012345", "carrier": "Own fleet", "tracking_no": "R-0007",
        "reason": "closed", "note": "Shop shut, sign on the door", "location": "RETURNS-01",
        "returned_by": "dee",
        "lines": [{"delivery_line": 10, "sku": "ABC123", "batch": None, "qty_ordered": "10",
                   "qty_returned": "10", "uom": "EA"}],
        "packages": [{"package_no": 1, "weight_kg": "6", "sscc": None},
                     {"package_no": 2, "weight_kg": "4", "sscc": None}]}]

    # the balances still rebuild from the ledger alone
    before = sorted((b.location_id, b.product_id, b.batch, b.on_hand) for b in
                    db.execute(select(StockBalance)).scalars())
    rebuild_balances(db)
    db.commit()
    after = sorted((b.location_id, b.product_id, b.batch, b.on_hand) for b in
                   db.execute(select(StockBalance)).scalars())
    assert before == after


def test_a_batch_comes_back_as_the_batch_that_left(client, db, structure, headers):
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers, batch="B7")
    assert came_back(client, headers).status_code == 202
    rows = db.execute(select(StockLedger).where(StockLedger.movement_type == "return")).scalars().all()
    assert {(r.location_id, r.batch) for r in rows} == {(dock.id, "B7")}


def test_the_same_message_twice_brings_it_back_once(client, db, structure, headers):
    s = structure
    returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    body = msg(reason="refused", tracking_no="R-0007")
    first = client.post("/v1/deliveries/0080012345/return", headers=headers, json=body)
    again = client.post("/v1/deliveries/0080012345/return", headers=headers, json=body)
    assert first.status_code == again.status_code == 202
    assert first.json() == again.json()
    assert len(db.execute(select(StockLedger).where(StockLedger.movement_type == "return")).scalars().all()) == 2


def test_only_a_shipped_delivery_can_come_back(client, db, structure, headers):
    s = structure
    returns_dock(db, s)
    stock(db, s, s.abc, s.bk1, "10")
    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="0080012345", warehouse="BAL-WH01", ship_to={"name": "Station Deli"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    r = came_back(client, headers)
    assert r.status_code == 409
    assert r.json()["code"] == "not_shipped"
    assert "allocated" in r.json()["detail"]


def test_coming_back_twice_without_going_again_is_refused(client, db, structure, headers):
    s = structure
    returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    assert came_back(client, headers).status_code == 202
    r = came_back(client, headers)
    assert r.status_code == 409
    assert r.json()["code"] == "already_returned"


def test_a_return_for_another_shipment_is_refused(client, db, structure, headers):
    """It names the shipment that came back. A late word about an earlier trip
    must not bring back the one on the road now."""
    s = structure
    returns_dock(db, s)
    shipped_delivery(client, db, s, headers, tracking_no="R-0009")
    r = came_back(client, headers, tracking_no="R-0007")
    assert r.status_code == 409
    assert r.json()["code"] == "not_that_shipment"
    assert "R-0009" in r.json()["detail"]
    assert db.execute(select(StockLedger).where(StockLedger.movement_type == "return")).first() is None


def test_a_warehouse_without_a_returns_zone_says_what_to_add(client, db, structure, headers):
    s = structure
    shipped_delivery(client, db, s, headers)
    r = came_back(client, headers)
    assert r.status_code == 422
    error = r.json()["errors"][0]
    assert error["field"] == "warehouse"
    assert "returns zone" in error["message"]
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "shipped"


def test_a_reason_is_needed(client, db, structure, headers):
    s = structure
    returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    body = msg(tracking_no="R-0007")
    r = client.post("/v1/deliveries/0080012345/return", headers=headers, json=body)
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "reason"
