"""Step 5a: one order, two legs, an in-transit bucket between them."""
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from wms.models import OutboundEvent, StockLedger, Subscriber, Task
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def stock(db, s, product, location, qty, batch=None, received=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, movement_type="receipt", actor="jo",
                         received_at=received or s.received)])
    db.commit()


def subscribe(db, listener, *types):
    db.add(Subscriber(name="erp", url=listener.url, secret="s3cret", event_types=list(types)))
    db.commit()


def events(db):
    return [(e.event_type, e.payload["data"]) for e in
            db.execute(select(OutboundEvent).order_by(OutboundEvent.id)).scalars()]


def transfer_body(ref="STO-4500012", lines=None, **extra):
    body = dict(external_ref=ref, owner="DEFAULT", from_warehouse="BAL-WH01",
                to_warehouse="MEL-WH01", required_by="2026-09-25", priority="normal",
                lines=lines or [{"line": 1, "sku": "ABC123", "batch": None, "qty": 12, "uom": "EA"}])
    body.update(extra)
    return msg(**body)


def at(client, headers, location, warehouse):
    r = client.get(f"/v1/locations/{location}/stock", headers=headers, params={"warehouse": warehouse})
    return {(x["sku"], x["batch"]): x["on_hand"] for x in r.json()["stock"]}


# --- leg one: allocate and pick at the sender -------------------------------

def test_transfer_reserves_at_the_sender_and_raises_a_pick(client, db, structure, receiver, headers, listener):
    s = structure
    stock(db, s, s.abc, s.bk1, "50")
    r = client.post("/v1/transfers", headers=headers, json=transfer_body())
    assert r.status_code == 202, r.text
    assert r.json()["allocation"] == [
        {"line": 1, "sku": "ABC123", "qty_requested": "12", "qty_allocated": "12", "uom": "EA", "short": "0"}]

    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert got["status"] == "allocated"
    assert got["from_warehouse"] == "BAL-WH01" and got["to_warehouse"] == "MEL-WH01"
    assert got["in_transit_location"] == "TRANSIT-IN"
    task = got["pick_task"]
    assert task["type"] == "transfer_pick"
    assert task["title"] == "Transfer pick STO-4500012"
    assert task["warehouse"] == "BAL-WH01"
    assert [(l["from_location"], l["to_location"], l["expected_qty"]) for l in task["lines"]] == [
        ("BK-04-01-C", "PACK-01", "12")]
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "warehouse": "BAL-WH01"}).json()["total_available"] == "38"


def test_a_receiver_without_an_in_transit_zone_says_so(client, db, structure, receiver, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "50")
    receiver.in_transit.active = False
    db.commit()
    r = client.post("/v1/transfers", headers=headers, json=transfer_body())
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "to_warehouse"
    assert "in transit" in r.json()["errors"][0]["message"]


def test_the_same_warehouse_twice_is_refused(client, db, structure, receiver, headers):
    r = client.post("/v1/transfers", headers=headers, json=transfer_body(to_warehouse="BAL-WH01"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "to_warehouse"


def test_a_move_between_warehouses_points_at_transfers(client, db, structure, receiver, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    r = client.post("/v1/moves", headers=headers, json=msg(
        warehouse="BAL-WH01", sku="ABC123", qty=1, uom="EA",
        from_location="BK-04-01-C", to_location="MB-01-01-A"))
    assert r.status_code == 422
    assert "transfers" in r.json()["errors"][0]["message"]


# --- shipping: stock goes into the bucket ------------------------------------

def shipped_transfer(client, db, structure, receiver, headers, qty="12", on_hand="50",
                     batch=None, received=None):
    s = structure
    stock(db, s, s.abc if batch is None else s.fg, s.bk1, on_hand, batch=batch, received=received)
    sku = "ABC123" if batch is None else "FG-900"
    client.post("/v1/transfers", headers=headers, json=transfer_body(lines=[
        {"line": 1, "sku": sku, "batch": batch, "qty": qty, "uom": "EA"}]))
    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["pick_task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers,
                json=msg(qty=qty, uom="EA", operator="op-017"))
    return client.post("/v1/transfers/STO-4500012/ship", headers=headers, json=msg(
        carrier="Toll", tracking_no="TOLL-5001", shipped_by="op-017"))


def test_shipping_moves_stock_into_the_bucket_and_opens_the_second_leg(
        client, db, structure, receiver, headers, listener):
    subscribe(db, listener, "transfer.shipped")
    r = shipped_transfer(client, db, structure, receiver, headers)
    assert r.status_code == 202, r.text

    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert got["status"] == "in_transit"
    assert got["carrier"] == "Toll" and got["tracking_no"] == "TOLL-5001"
    assert [(l["qty_requested"], l["qty_shipped"], l["qty_received"]) for l in got["lines"]] == [("12", "12", "0")]

    # the sender's bench is empty and the bucket holds it
    assert at(client, headers, "PACK-01", "BAL-WH01") == {}
    assert at(client, headers, "TRANSIT-IN", "MEL-WH01") == {("ABC123", None): "12"}
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "warehouse": "BAL-WH01"}).json()["total_on_hand"] == "38"

    # the receiver has work waiting
    task = got["receive_task"]
    assert task["type"] == "transfer_receive"
    assert task["warehouse"] == "MEL-WH01"
    assert task["status"] == "waiting"
    assert [(l["from_location"], l["expected_qty"], l["to_location"]) for l in task["lines"]] == [
        ("TRANSIT-IN", "12", None)]

    shipped = [e for e in events(db) if e[0] == "transfer.shipped"][0][1]
    assert shipped["transfer_ref"] == "STO-4500012"
    assert shipped["from_warehouse"] == "BAL-WH01"
    assert shipped["to_warehouse"] == "MEL-WH01"
    assert shipped["lines"] == [{"line": 1, "sku": "ABC123", "batch": None, "qty_requested": "12",
                                 "qty_shipped": "12", "uom": "EA"}]


def test_batch_and_received_date_travel_with_the_stock(client, db, structure, receiver, headers):
    old = date(2026, 7, 1)
    r = shipped_transfer(client, db, structure, receiver, headers, batch="B2607", received=old)
    assert r.status_code == 202, r.text
    bucket = client.get("/v1/locations/TRANSIT-IN/stock", headers=headers,
                        params={"warehouse": "MEL-WH01"}).json()["stock"]
    assert [(x["sku"], x["batch"], x["received_at"]) for x in bucket] == [("FG-900", "B2607", "2026-07-01")]

    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["receive_task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=12, uom="EA", location="MB-01-01-A", operator="op-022"))
    shelf = client.get("/v1/locations/MB-01-01-A/stock", headers=headers,
                       params={"warehouse": "MEL-WH01"}).json()["stock"]
    assert [(x["batch"], x["received_at"]) for x in shelf] == [("B2607", "2026-07-01")]


def test_shipping_nothing_is_refused(client, db, structure, receiver, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "50")
    client.post("/v1/transfers", headers=headers, json=transfer_body())
    r = client.post("/v1/transfers/STO-4500012/ship", headers=headers, json=msg())
    assert r.status_code == 409
    assert r.json()["code"] == "nothing_picked"


# --- leg two: receiving -------------------------------------------------------

def test_receiving_it_all_closes_the_transfer(client, db, structure, receiver, headers, listener):
    subscribe(db, listener, "transfer.received")
    shipped_transfer(client, db, structure, receiver, headers)
    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["receive_task"]["wms_id"]

    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=12, uom="EA", location="MB-01-01-A", operator="op-022", device="SCN-MEL-01"))
    assert r.status_code == 202, r.text
    assert r.json()["task"]["status"] == "done"

    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert got["status"] == "received"
    assert [(l["qty_shipped"], l["qty_received"], l["variance"]) for l in got["lines"]] == [("12", "12", "0")]
    assert at(client, headers, "TRANSIT-IN", "MEL-WH01") == {}
    assert at(client, headers, "MB-01-01-A", "MEL-WH01") == {("ABC123", None): "12"}

    rows = db.execute(select(StockLedger).where(StockLedger.movement_type.in_(("transfer_out", "transfer_in")))
                      .order_by(StockLedger.id)).scalars().all()
    assert [(r.movement_type, r.qty_change) for r in rows] == [
        ("transfer_out", Decimal("-12")), ("transfer_out", Decimal("12")),
        ("transfer_in", Decimal("-12")), ("transfer_in", Decimal("12"))]

    received = [e for e in events(db) if e[0] == "transfer.received"][0][1]
    assert received["complete"] is True
    assert received["lines"] == [{"line": 1, "sku": "ABC123", "batch": None, "qty_shipped": "12",
                                 "qty_received": "12", "variance": "0", "uom": "EA"}]


def test_a_short_receipt_leaves_the_variance_in_transit(client, db, structure, receiver, headers, listener):
    subscribe(db, listener, "transfer.received", "stock.adjusted")
    shipped_transfer(client, db, structure, receiver, headers)
    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["receive_task"]["wms_id"]

    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=10, uom="EA", location="MB-01-01-A", operator="op-022"))
    r = client.post(f"/v1/tasks/{task_id}/close", headers=headers, json=msg(reason="two short off the truck"))
    assert r.status_code == 202, r.text

    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert got["status"] == "variance"
    assert [(l["qty_shipped"], l["qty_received"], l["variance"]) for l in got["lines"]] == [("12", "10", "-2")]
    # the two that never turned up are still in the bucket, not written off
    assert at(client, headers, "TRANSIT-IN", "MEL-WH01") == {("ABC123", None): "2"}
    received = [e for e in events(db) if e[0] == "transfer.received"][0][1]
    assert received["complete"] is False
    assert received["lines"][0]["variance"] == "-2"
    assert [e for e in events(db) if e[0] == "stock.adjusted"] == []

    # closing it writes the adjustment and empties the bucket
    r = client.post("/v1/transfers/STO-4500012/close-variance", headers=headers,
                    json=msg(reason="lost_in_transit", note="carrier could not find them"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert got["status"] == "closed"
    assert at(client, headers, "TRANSIT-IN", "MEL-WH01") == {}
    adjusted = [e for e in events(db) if e[0] == "stock.adjusted"][0][1]
    assert adjusted["qty_change"] == "-2"
    assert adjusted["reason"] == "lost_in_transit"
    assert adjusted["location"] == "TRANSIT-IN"


def test_closing_a_variance_that_is_not_there_is_refused(client, db, structure, receiver, headers):
    shipped_transfer(client, db, structure, receiver, headers)
    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["receive_task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=12, uom="EA", location="MB-01-01-A"))
    r = client.post("/v1/transfers/STO-4500012/close-variance", headers=headers, json=msg(reason="x"))
    assert r.status_code == 409
    assert r.json()["code"] == "no_variance"


def test_receiving_more_than_was_shipped_is_refused(client, db, structure, receiver, headers):
    shipped_transfer(client, db, structure, receiver, headers)
    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["receive_task"]["wms_id"]
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=13, uom="EA", location="MB-01-01-A"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "qty"


# --- cancelling and listing -----------------------------------------------------

def test_cancel_before_shipping_gives_the_stock_back(client, db, structure, receiver, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "50")
    client.post("/v1/transfers", headers=headers, json=transfer_body())
    r = client.post("/v1/transfers/STO-4500012/cancel", headers=headers, json=msg(reason="not needed"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert got["status"] == "cancelled"
    assert got["pick_task"]["status"] == "cancelled"
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "warehouse": "BAL-WH01"}).json()["total_available"] == "50"


def test_cancel_after_shipping_is_refused(client, db, structure, receiver, headers):
    shipped_transfer(client, db, structure, receiver, headers)
    r = client.post("/v1/transfers/STO-4500012/cancel", headers=headers, json=msg(reason="too late"))
    assert r.status_code == 409
    assert r.json()["code"] == "already_shipped"


def test_transfer_listing_shows_both_ends(client, db, structure, receiver, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "50")
    client.post("/v1/transfers", headers=headers, json=transfer_body("STO-1"))
    client.post("/v1/transfers", headers=headers, json=transfer_body("STO-2", priority="high"))
    # the sender sees them
    page = client.get("/v1/transfers", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert [t["external_ref"] for t in page["items"]] == ["STO-2", "STO-1"]
    # so does the receiver
    page = client.get("/v1/transfers", headers=headers, params={"warehouse": "MEL-WH01"}).json()
    assert page["total"] == 2
    assert client.get("/v1/transfers", headers=headers,
                      params={"warehouse": "MEL-WH01", "status": "in_transit"}).json()["total"] == 0


# --- cartons on a transfer ------------------------------------------------------

def picked_transfer(client, db, structure, receiver, headers, qty="12"):
    s = structure
    stock(db, s, s.abc, s.bk1, "50")
    client.post("/v1/transfers", headers=headers, json=transfer_body(lines=[
        {"line": 1, "sku": "ABC123", "qty": qty, "uom": "EA"}]))
    task_id = client.get("/v1/transfers/STO-4500012", headers=headers).json()["pick_task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers,
                json=msg(qty=qty, uom="EA", operator="op-017"))


def test_a_transfer_can_be_packed_into_cartons(client, db, structure, receiver, headers, listener):
    subscribe(db, listener, "transfer.shipped")
    picked_transfer(client, db, structure, receiver, headers)

    r = client.post("/v1/transfers/STO-4500012/pack", headers=headers, json=msg(
        packed_by="op-017", complete=True,
        packages=[
            {"package_no": 1, "type": "carton", "weight_kg": 8.4, "length_cm": 40,
             "width_cm": 30, "height_cm": 25,
             "lines": [{"line": 1, "sku": "ABC123", "qty": 8, "uom": "EA"}]},
            {"package_no": 2, "type": "carton", "weight_kg": 4,
             "lines": [{"line": 1, "sku": "ABC123", "qty": 4, "uom": "EA"}]},
        ]))
    assert r.status_code == 202, r.text

    got = client.get("/v1/transfers/STO-4500012", headers=headers).json()
    assert [(p["package_no"], p["weight_kg"], p["lines"][0]["qty"]) for p in got["packages"]] == [
        (1, "8.4", "8"), (2, "4", "4")]

    r = client.post("/v1/transfers/STO-4500012/ship", headers=headers,
                    json=msg(carrier="Toll", tracking_no="T-1"))
    assert r.status_code == 202, r.text
    shipped = [e for e in events(db) if e[0] == "transfer.shipped"][0][1]
    assert shipped["packages"] == [{"package_no": 1, "weight_kg": "8.4", "sscc": None},
                                   {"package_no": 2, "weight_kg": "4", "sscc": None}]


def test_a_transfer_ships_fine_with_no_cartons_at_all(client, db, structure, receiver, headers, listener):
    subscribe(db, listener, "transfer.shipped")
    picked_transfer(client, db, structure, receiver, headers)
    assert client.post("/v1/transfers/STO-4500012/ship", headers=headers,
                       json=msg(carrier="Toll")).status_code == 202
    shipped = [e for e in events(db) if e[0] == "transfer.shipped"][0][1]
    assert shipped["packages"] == []


def test_a_transfer_carton_cannot_hold_more_than_was_picked(client, db, structure, receiver, headers):
    picked_transfer(client, db, structure, receiver, headers)
    r = client.post("/v1/transfers/STO-4500012/pack", headers=headers, json=msg(
        packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 9,
                   "lines": [{"line": 1, "sku": "ABC123", "qty": 13, "uom": "EA"}]}]))
    assert r.status_code == 422
    assert "picked" in r.json()["errors"][0]["message"]


def test_a_transfer_that_has_left_cannot_be_packed(client, db, structure, receiver, headers):
    shipped_transfer(client, db, structure, receiver, headers)
    r = client.post("/v1/transfers/STO-4500012/pack", headers=headers, json=msg(
        packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 1,
                   "lines": [{"line": 1, "sku": "ABC123", "qty": 1, "uom": "EA"}]}]))
    assert r.status_code == 409
    assert r.json()["code"] == "not_open"


def test_a_transfer_carton_label_prints(client, db, structure, receiver, headers):
    from wms.models import PrintJob

    picked_transfer(client, db, structure, receiver, headers)
    client.post("/v1/transfers/STO-4500012/pack", headers=headers, json=msg(
        packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 8.4,
                   "lines": [{"line": 1, "sku": "ABC123", "qty": 12, "uom": "EA"}]}]))
    r = client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="transfer-docket", printer="Dock",
        reference={"type": "transfer", "ref": "STO-4500012"}))
    assert r.status_code == 202, r.text
    job = db.execute(select(PrintJob).order_by(PrintJob.id.desc())).scalars().first()
    assert job.data["transfer_ref"] == "STO-4500012"
    assert job.data["from_warehouse"] == "BAL-WH01"
    assert job.data["to_warehouse"] == "MEL-WH01"
    assert job.data["packages"] == [{"package_no": 1, "weight_kg": "8.4", "sscc": None}]
    assert job.data["lines"][0]["sku"] == "ABC123"
