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


# --- going out again --------------------------------------------------------------

def test_it_ships_again_from_the_returns_dock_with_the_new_carrier(client, db, structure, headers, listener):
    subscribe(db, listener, "delivery.shipped", "delivery.returned")
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    assert came_back(client, headers).status_code == 202

    r = client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        carrier="Ridgeline Express", tracking_no="RX-77310042", shipped_by="dee"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "shipped"
    assert (got["carrier"], got["tracking_no"]) == ("Ridgeline Express", "RX-77310042")
    assert got["lines"][0]["qty_shipped"] == "10"

    # out of the dock, not off a shelf or the bench, a row per carton line again
    out = db.execute(select(StockLedger).where(StockLedger.movement_type == "ship")
                     .order_by(StockLedger.id)).scalars().all()
    assert [(r.location_id, r.qty_change) for r in out[2:]] == [
        (dock.id, Decimal("-6")), (dock.id, Decimal("-4"))]
    assert on_hand(db, dock) == Decimal("0")
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "0"

    # the ERP hears: shipped, came back, shipped again
    order = [e.event_type for e in db.execute(select(OutboundEvent).order_by(OutboundEvent.id)).scalars()]
    assert order == ["delivery.shipped", "delivery.returned", "delivery.shipped"]
    again = events(db, "delivery.shipped")[-1]
    assert (again["carrier"], again["tracking_no"]) == ("Ridgeline Express", "RX-77310042")
    assert again["lines"][0]["qty_shipped"] == "10"


def test_it_can_come_back_more_than_once(client, db, structure, headers):
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    assert came_back(client, headers).status_code == 202
    client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        carrier="Own fleet", tracking_no="R-0009", shipped_by="dee"))
    r = came_back(client, headers, tracking_no="R-0009", reason="wrong_address")
    assert r.status_code == 202, r.text
    assert on_hand(db, dock) == Decimal("10")
    returns = db.execute(select(Task).where(Task.type == "return").order_by(Task.id)).scalars().all()
    assert [t.status for t in returns] == ["done", "done"]
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "returned"


def test_a_delivery_that_came_back_is_not_packed_again(client, db, structure, headers):
    """It goes again in the cartons it came back in."""
    s = structure
    returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    came_back(client, headers)
    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        packages=[{"package_no": 3, "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 1, "uom": "EA"}]}]))
    assert r.status_code == 409
    assert r.json()["code"] == "not_open"


# --- or not at all --------------------------------------------------------------------

def test_cancelling_one_that_came_back_puts_it_back_on_a_shelf(client, db, structure, headers, listener):
    """The customer doesn't want it after all. Nothing is left on the dock: a
    put-away task takes it home, like stock left on the bench by a cancel."""
    subscribe(db, listener, "delivery.cancelled")
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    came_back(client, headers)

    r = client.post("/v1/deliveries/0080012345/cancel", headers=headers, json=msg(reason="customer refused it"))
    assert r.status_code == 202, r.text
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "cancelled"
    assert events(db, "delivery.cancelled") == [{"delivery_ref": "0080012345", "reason": "customer refused it"}]

    putaways = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "putaway"}).json()
    assert putaways["total"] == 1
    task = putaways["items"][0]
    assert task["priority"] == "high"
    assert "0080012345 was cancelled after it came back" in task["note"]
    assert [(l["sku"], l["expected_qty"], l["from_location"]) for l in task["lines"]] == [
        ("ABC123", "10", "RETURNS-01")]

    r = client.post(f"/v1/tasks/{task['wms_id']}/lines/1/confirm", headers=headers, json=msg(
        qty=10, uom="EA", location="BK-04-01-C", operator="op-017"))
    assert r.status_code == 202, r.text
    assert on_hand(db, dock) == Decimal("0")
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_available"] == "10"
    # back on the shelf it keeps the date it was first received
    shelf = db.execute(select(StockBalance).where(StockBalance.location_id == s.bk1.id)).scalar_one()
    assert shelf.received_at == date(2026, 8, 1)


# --- two at once ------------------------------------------------------------------

def held(engine, ref="0080012345"):
    """Another transaction holding the delivery's row, as a slow request would."""
    from sqlalchemy.orm import Session

    from wms.models import Delivery

    other = Session(engine)
    other.execute(select(Delivery).where(Delivery.external_ref == ref).with_for_update())
    return other


def other_key(db):
    """A second caller. Two calls on one key queue behind each other on the
    key's last_used_at, which would hide the race; two systems would not."""
    from wms.services.access import create_api_client

    _, raw = create_api_client(db, name="tms", scopes=["*"], warehouses=["*"], owner="*")
    db.commit()
    return {"Authorization": f"Bearer {raw}"}


def all_at_once(engine, calls):
    """Start every call while the delivery is held, check each one waits for
    it, then let go. Returns the replies in the order the calls were given."""
    import threading
    import time

    blocker = held(engine)
    replies: list = [None] * len(calls)

    def run(i, call):
        replies[i] = call()

    threads = [threading.Thread(target=run, args=(i, c), daemon=True) for i, c in enumerate(calls)]
    try:
        for t in threads:
            t.start()
        time.sleep(0.5)
        waiting = [t.is_alive() for t in threads]
    finally:
        blocker.rollback()
        blocker.close()
    for t in threads:
        t.join(timeout=10)
    assert waiting == [True] * len(calls), "each call should wait for the delivery's row"
    return replies


def test_two_returns_at_once_bring_it_back_once(client, db, engine, structure, headers):
    """Different message_ids, so the envelope cannot catch it: the delivery's
    row is locked and the second sees it has already come back."""
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers)

    tms = other_key(db)
    replies = all_at_once(engine, [lambda: came_back(client, headers), lambda: came_back(client, tms)])
    assert sorted(r.status_code for r in replies) == [202, 409], [r.text for r in replies]
    assert [r.json()["code"] for r in replies if r.status_code == 409] == ["already_returned"]
    db.expire_all()
    assert on_hand(db, dock) == Decimal("10")
    assert len(db.execute(select(Task).where(Task.type == "return")).scalars().all()) == 1


def test_shipping_again_and_cancelling_at_once_do_one_or_the_other(client, db, engine, structure, headers):
    s = structure
    dock = returns_dock(db, s)
    shipped_delivery(client, db, s, headers)
    assert came_back(client, headers).status_code == 202
    tms = other_key(db)

    ship, cancel = all_at_once(engine, [
        lambda: client.post("/v1/deliveries/0080012345/ship", headers=tms, json=msg(
            carrier="Ridgeline Express", tracking_no="RX-1", shipped_by="dee")),
        lambda: client.post("/v1/deliveries/0080012345/cancel", headers=headers, json=msg(reason="refused")),
    ])
    assert sorted([ship.status_code, cancel.status_code]) == [202, 409], (ship.text, cancel.text)
    db.expire_all()
    putaways = db.execute(select(Task).where(Task.type == "putaway")).scalars().all()
    status = client.get("/v1/deliveries/0080012345", headers=headers).json()["status"]
    if ship.status_code == 202:
        assert (status, cancel.json()["code"]) == ("shipped", "already_shipped")
        assert on_hand(db, dock) == Decimal("0") and putaways == []
    else:
        assert (status, ship.json()["code"]) == ("cancelled", "cancelled")
        assert on_hand(db, dock) == Decimal("10") and len(putaways) == 1

