"""Step 3: deliveries, reservation, pick, short pick, pack, ship."""
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from wms.models import OutboundEvent, StockBalance, StockLedger, Subscriber, Task
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


def delivery_body(ref="0080012345", lines=None, **extra):
    body = dict(
        external_ref=ref, warehouse="BAL-WH01", owner="DEFAULT", pick_mode="single",
        priority="normal", required_by="2026-09-22",
        ship_to={"name": "Acme Auto Parts", "address": "12 Example St", "suburb": "Geelong",
                 "state": "VIC", "postcode": "3220", "country": "AU"},
        carrier_hint=None, allow_short=True,
        lines=lines or [{"delivery_line": 10, "sku": "ABC123", "batch": None, "qty": 10, "uom": "EA"}],
    )
    body.update(extra)
    return msg(**body)


def reserved_at(db, location_id, product_id):
    row = db.execute(select(StockBalance).where(
        StockBalance.location_id == location_id, StockBalance.product_id == product_id)).scalar_one_or_none()
    return row.reserved if row else Decimal(0)


# --- allocation -----------------------------------------------------------

def test_delivery_reserves_fifo_and_creates_a_pick_task(client, db, structure, headers, listener):
    subscribe(db, listener, "delivery.allocated")
    s = structure
    stock(db, s, s.abc, s.bk1, "100", received=date(2026, 9, 5))
    stock(db, s, s.abc, s.pf, "6", received=date(2026, 8, 30))

    r = client.post("/v1/deliveries", headers=headers, json=delivery_body(
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "accepted"
    assert body["allocation"] == [
        {"delivery_line": 10, "sku": "ABC123", "qty_ordered": "10", "qty_allocated": "10", "uom": "EA", "short": "0"}]

    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "allocated"
    assert got["ship_to"]["name"] == "Acme Auto Parts"
    assert got["pick_mode"] == "single"
    task = got["task"]
    assert task["type"] == "pick"
    assert task["title"] == "Pick 0080012345"
    # oldest received first, then walk order by pick sequence
    assert [(l["from_location"], l["expected_qty"], l["to_location"]) for l in task["lines"]] == [
        ("PF-01-02-A", "6", "PACK-01"), ("BK-04-01-C", "4", "PACK-01")]
    assert reserved_at(db, s.pf.id, s.abc.id) == Decimal("6")
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("4")

    # available drops, on hand does not
    stock_now = client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()
    assert stock_now["total_on_hand"] == "106"
    assert stock_now["total_available"] == "96"

    assert events(db) == [("delivery.allocated", {
        "delivery_ref": "0080012345", "complete": True,
        "lines": [{"delivery_line": 10, "sku": "ABC123", "batch": None, "qty_ordered": "10",
                   "qty_allocated": "10", "uom": "EA"}]})]


def test_partial_allocation_says_what_could_not_be_allocated(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "4")
    r = client.post("/v1/deliveries", headers=headers, json=delivery_body(
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"},
               {"delivery_line": 20, "sku": "FG-900", "qty": 5, "uom": "EA"}]))
    assert r.status_code == 202, r.text
    assert r.json()["allocation"] == [
        {"delivery_line": 10, "sku": "ABC123", "qty_ordered": "10", "qty_allocated": "4", "uom": "EA", "short": "6"},
        {"delivery_line": 20, "sku": "FG-900", "qty_ordered": "5", "qty_allocated": "0", "uom": "EA", "short": "5"},
    ]
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "allocated"
    assert got["short"] is True
    assert [l["qty_allocated"] for l in got["lines"]] == ["4", "0"]


def test_forced_batch_only_takes_that_batch(client, db, structure, headers):
    s = structure
    stock(db, s, s.fg, s.bk1, "10", batch="B1", received=date(2026, 8, 1))
    stock(db, s, s.fg, s.bk2, "10", batch="B2", received=date(2026, 9, 1))
    r = client.post("/v1/deliveries", headers=headers, json=delivery_body(
        lines=[{"delivery_line": 10, "sku": "FG-900", "batch": "B2", "qty": 8, "uom": "EA"}]))
    assert r.status_code == 202, r.text
    task = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]
    assert [(l["from_location"], l["batch"], l["expected_qty"]) for l in task["lines"]] == [("BK-04-02-A", "B2", "8")]


def test_reserved_stock_is_not_offered_twice(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    client.post("/v1/deliveries", headers=headers, json=delivery_body("D1", lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 7, "uom": "EA"}]))
    r = client.post("/v1/deliveries", headers=headers, json=delivery_body("D2", lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 7, "uom": "EA"}]))
    assert r.json()["allocation"][0] == {"delivery_line": 10, "sku": "ABC123", "qty_ordered": "7",
                                         "qty_allocated": "3", "uom": "EA", "short": "4"}


def test_repeat_message_id_does_not_reserve_twice(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    body = delivery_body()
    r1 = client.post("/v1/deliveries", headers=headers, json=body)
    r2 = client.post("/v1/deliveries", headers=headers, json=body)
    assert r1.json() == r2.json()
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("10")


def test_unknown_sku_is_422_and_reserves_nothing(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    r = client.post("/v1/deliveries", headers=headers, json=delivery_body(lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 1, "uom": "EA"},
        {"delivery_line": 20, "sku": "NOPE", "qty": 1, "uom": "EA"}]))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "lines.1.sku"
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("0")


def test_packing_bench_is_preferred_over_the_receiving_dock(client, db, structure, headers):
    """Both are staging zones. Picked stock belongs at the bench, not the dock."""
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    client.post("/v1/deliveries", headers=headers, json=delivery_body())
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["staging_location"] == "PACK-01"
    assert got["task"]["lines"][0]["to_location"] == "PACK-01"


def test_warehouse_without_anywhere_to_stage_says_so(client, db, structure, headers):
    s = structure
    s.staging.active = False
    s.dock_loc.active = False
    db.commit()
    r = client.post("/v1/deliveries", headers=headers, json=delivery_body())
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "warehouse"
    assert "packing or staging" in r.json()["errors"][0]["message"]


# --- picking --------------------------------------------------------------

def open_delivery(client, db, structure, headers, qty="10", on_hand="10"):
    stock(db, structure, structure.abc, structure.bk1, on_hand)
    client.post("/v1/deliveries", headers=headers, json=delivery_body(lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": qty, "uom": "EA"}]))
    return client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]


def test_picking_moves_stock_to_staging_and_frees_the_reservation(client, db, structure, headers, listener):
    subscribe(db, listener, "delivery.picked")
    s = structure
    task_id = open_delivery(client, db, s, headers)

    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=10, uom="EA", operator="op-017", device="SCN-BAL-07"))
    assert r.status_code == 202, r.text
    assert r.json()["line"]["status"] == "done"
    assert r.json()["task"]["status"] == "done"

    rows = db.execute(select(StockLedger).order_by(StockLedger.id)).scalars().all()
    assert [(r.movement_type, r.qty_change, r.location_id) for r in rows[1:]] == [
        ("pick", Decimal("-10"), s.bk1.id), ("pick", Decimal("10"), s.staging.id)]
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("0")

    at_staging = client.get(f"/v1/locations/PACK-01/stock", headers=headers,
                            params={"warehouse": "BAL-WH01"}).json()
    assert [(x["sku"], x["on_hand"]) for x in at_staging["stock"]] == [("ABC123", "10")]

    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "picked"
    assert got["lines"][0]["qty_picked"] == "10"
    # picking done raises the pack task
    packs = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "pack"}).json()
    assert packs["total"] == 1 and packs["items"][0]["source_ref"] == "0080012345"
    assert events(db)[0][0] == "delivery.picked"
    assert events(db)[0][1]["lines"] == [{"delivery_line": 10, "sku": "ABC123", "batch": None,
                                          "qty_ordered": "10", "qty_picked": "10", "uom": "EA",
                                          "short_reason": None}]


def test_delivery_says_picking_once_the_first_line_is_off_the_shelf(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    stock(db, s, s.abc, s.pf, "10")
    client.post("/v1/deliveries", headers=headers, json=delivery_body(lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 20, "uom": "EA"}]))
    task_id = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "allocated"

    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=10, uom="EA"))
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "picking"

    client.post(f"/v1/tasks/{task_id}/lines/2/confirm", headers=headers, json=msg(qty=10, uom="EA"))
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "picked"


def test_short_pick_needs_a_reason_and_a_supervisor_and_raises_a_count(client, db, structure, headers, supervisor_badge):
    s = structure
    task_id = open_delivery(client, db, s, headers)

    r = client.post(f"/v1/tasks/{task_id}/lines/1/short", headers=headers, json=msg(
        qty=6, reason="not_found", operator="op-017"))
    assert r.status_code == 409
    assert r.json()["code"] == "needs_supervisor"

    r = client.post(f"/v1/tasks/{task_id}/lines/1/short", headers=headers, json=msg(
        qty=6, reason="not_found", operator="op-017", supervisor_badge=supervisor_badge))
    assert r.status_code == 202, r.text
    line = r.json()["line"]
    assert line["status"] == "short"
    assert line["actual_qty"] == "6"
    assert line["reason"] == "not_found"
    assert r.json()["task"]["status"] == "done"

    # six moved, the rest of the reservation is released
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("0")
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_available"] == "10"

    # a count task for that shelf, so the discrepancy is chased
    counts = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "count"}).json()
    assert counts["total"] == 1
    count = counts["items"][0]
    assert count["lines"][0]["from_location"] == "BK-04-01-C"
    assert count["note"] and "0080012345" in count["note"]

    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["short"] is True
    assert got["lines"][0]["short_reason"] == "not_found"


def test_unreadable_location_removes_the_line_without_a_count(client, db, structure, headers, supervisor_badge):
    s = structure
    task_id = open_delivery(client, db, s, headers)
    r = client.post(f"/v1/tasks/{task_id}/lines/1/short", headers=headers, json=msg(
        qty=0, reason="location_unreadable", operator="op-017", supervisor_badge=supervisor_badge))
    assert r.status_code == 202, r.text
    assert r.json()["line"]["status"] == "short"
    assert client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "count"}).json()["total"] == 0
    assert db.execute(select(StockLedger)).scalars().all().__len__() == 1  # only the receipt


def test_pick_cannot_take_more_than_the_line(client, db, structure, headers):
    s = structure
    task_id = open_delivery(client, db, s, headers, qty="10", on_hand="50")
    r = client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=12, uom="EA"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "qty"


# --- pack and ship ---------------------------------------------------------

def picked_delivery(client, db, structure, headers):
    task_id = open_delivery(client, db, structure, headers)
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=10, uom="EA", operator="op-017"))
    return task_id


def test_pack_records_cartons_and_ship_empties_staging(client, db, structure, headers, listener):
    subscribe(db, listener, "delivery.packed", "delivery.shipped")
    s = structure
    picked_delivery(client, db, s, headers)

    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=False,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 8.4, "length_cm": 40,
                   "width_cm": 30, "height_cm": 25,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}]}]))
    assert r.status_code == 202, r.text
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "packing"
    assert [(p["package_no"], p["weight_kg"], p["lines"][0]["qty"]) for p in got["packages"]] == [(1, "8.4", "6")]

    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 2, "type": "carton", "weight_kg": 5,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 4, "uom": "EA"}]}]))
    assert r.status_code == 202, r.text
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "packed"
    assert len(got["packages"]) == 2
    packed = [e for e in events(db) if e[0] == "delivery.packed"]
    assert len(packed) == 1
    assert [p["package_no"] for p in packed[0][1]["packages"]] == [1, 2]

    r = client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        warehouse="BAL-WH01", carrier="Toll", tracking_no="TOLL123", shipped_by="op-017"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "shipped"
    assert got["carrier"] == "Toll" and got["tracking_no"] == "TOLL123"

    # staging is empty and the stock has left the building
    assert client.get("/v1/locations/PACK-01/stock", headers=headers,
                      params={"warehouse": "BAL-WH01"}).json()["stock"] == []
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "0"
    # one ledger line per carton line, so the ledger says which carton it left in
    out = db.execute(select(StockLedger).where(StockLedger.movement_type == "ship")).scalars().all()
    assert [r.qty_change for r in out] == [Decimal("-6"), Decimal("-4")]
    assert [r.note for r in out] == ["package 1", "package 2"]

    shipped = [e for e in events(db) if e[0] == "delivery.shipped"][0][1]
    assert shipped["carrier"] == "Toll"
    assert shipped["tracking_no"] == "TOLL123"
    assert shipped["short"] is False
    assert shipped["lines"] == [{"delivery_line": 10, "sku": "ABC123", "batch": None,
                                 "qty_ordered": "10", "qty_shipped": "10", "uom": "EA"}]
    assert shipped["packages"] == [{"package_no": 1, "weight_kg": "8.4", "sscc": None},
                                   {"package_no": 2, "weight_kg": "5", "sscc": None}]


def test_packing_carries_the_batch_that_was_picked(client, db, structure, headers):
    """The order asked for any batch; the cartons must say which one left."""
    s = structure
    stock(db, s, s.fg, s.bk1, "6", batch="B1", received=date(2026, 8, 1))
    stock(db, s, s.fg, s.bk2, "10", batch="B2", received=date(2026, 9, 1))
    client.post("/v1/deliveries", headers=headers, json=delivery_body(lines=[
        {"delivery_line": 10, "sku": "FG-900", "qty": 9, "uom": "EA"}]))
    task_id = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]
    for line_no in (1, 2):
        client.post(f"/v1/tasks/{task_id}/lines/{line_no}/confirm", headers=headers,
                    json=msg(qty=6 if line_no == 1 else 3, uom="EA", operator="op-017"))

    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 9,
                   "lines": [{"delivery_line": 10, "sku": "FG-900", "qty": 9, "uom": "EA"}]}]))
    assert r.status_code == 202, r.text
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert [(l["batch"], l["qty"]) for l in got["packages"][0]["lines"]] == [("B1", "6"), ("B2", "3")]

    r = client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        warehouse="BAL-WH01", carrier="Toll"))
    assert r.status_code == 202, r.text
    assert client.get("/v1/locations/PACK-01/stock", headers=headers,
                      params={"warehouse": "BAL-WH01"}).json()["stock"] == []


def test_packing_a_batch_that_is_not_on_the_bench_is_refused(client, db, structure, headers):
    s = structure
    stock(db, s, s.fg, s.bk1, "6", batch="B1")
    client.post("/v1/deliveries", headers=headers, json=delivery_body(lines=[
        {"delivery_line": 10, "sku": "FG-900", "qty": 6, "uom": "EA"}]))
    task_id = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=6, uom="EA"))
    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 5,
                   "lines": [{"delivery_line": 10, "sku": "FG-900", "batch": "B9", "qty": 6, "uom": "EA"}]}]))
    assert r.status_code == 422
    assert "batch B9" in r.json()["errors"][0]["message"]


def test_pack_cannot_exceed_what_was_picked(client, db, structure, headers):
    picked_delivery(client, db, structure, headers)
    r = client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 9,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 11, "uom": "EA"}]}]))
    assert r.status_code == 422
    assert "were picked" in r.json()["errors"][0]["message"]


def test_ship_short_tells_the_erp_the_real_quantity(client, db, structure, headers, listener, supervisor_badge):
    subscribe(db, listener, "delivery.shipped")
    s = structure
    task_id = open_delivery(client, db, s, headers)
    client.post(f"/v1/tasks/{task_id}/lines/1/short", headers=headers, json=msg(
        qty=6, reason="not_found", operator="op-017", supervisor_badge=supervisor_badge))
    client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 5,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}]}]))
    r = client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        warehouse="BAL-WH01", carrier="Toll", shipped_by="op-017"))
    assert r.status_code == 202, r.text
    shipped = [e for e in events(db) if e[0] == "delivery.shipped"][0][1]
    assert shipped["short"] is True
    assert shipped["lines"][0]["qty_shipped"] == "6"
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_on_hand"] == "4"


def test_ship_is_refused_when_short_is_not_allowed(client, db, structure, headers, supervisor_badge):
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    client.post("/v1/deliveries", headers=headers, json=delivery_body(allow_short=False, lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    task_id = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/short", headers=headers, json=msg(
        qty=6, reason="not_found", operator="op-017", supervisor_badge=supervisor_badge))
    client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 5,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}]}]))
    r = client.post("/v1/deliveries/0080012345/ship", headers=headers, json=msg(
        warehouse="BAL-WH01", carrier="Toll"))
    assert r.status_code == 409
    assert r.json()["code"] == "short_not_allowed"


# --- cancel and listing -----------------------------------------------------

def test_cancel_releases_the_reservation_and_cancels_the_task(client, db, structure, headers, listener):
    subscribe(db, listener, "delivery.cancelled")
    s = structure
    open_delivery(client, db, s, headers)
    r = client.post("/v1/deliveries/0080012345/cancel", headers=headers, json=msg(reason="customer changed their mind"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["status"] == "cancelled"
    assert got["task"]["status"] == "cancelled"
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("0")
    assert events(db)[-1] == ("delivery.cancelled", {"delivery_ref": "0080012345", "reason": "customer changed their mind"})
    # a shipped delivery cannot be cancelled
    assert client.post("/v1/deliveries/0080012345/cancel", headers=headers, json=msg()).status_code == 409


def test_cancelling_after_picking_puts_the_bench_stock_back(client, db, structure, headers):
    """Nothing is left stranded at the packing bench."""
    s = structure
    task_id = open_delivery(client, db, s, headers)
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=10, uom="EA", operator="op-017"))

    client.post("/v1/deliveries/0080012345/cancel", headers=headers, json=msg(reason="customer rang"))
    putaways = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "putaway"}).json()
    assert putaways["total"] == 1
    task = putaways["items"][0]
    assert task["priority"] == "high"
    assert "0080012345 was cancelled" in task["note"]
    assert [(l["sku"], l["expected_qty"], l["from_location"], l["to_location"]) for l in task["lines"]] == [
        ("ABC123", "10", "PACK-01", None)]

    # the operator scans a shelf and the stock is home again
    r = client.post(f"/v1/tasks/{task['wms_id']}/lines/1/confirm", headers=headers, json=msg(
        qty=10, uom="EA", location="BK-04-01-C", operator="op-017"))
    assert r.status_code == 202, r.text
    assert r.json()["task"]["status"] == "done"
    assert client.get("/v1/locations/PACK-01/stock", headers=headers,
                      params={"warehouse": "BAL-WH01"}).json()["stock"] == []
    assert client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()["total_available"] == "10"


def test_cancelling_before_picking_leaves_no_putaway(client, db, structure, headers):
    s = structure
    open_delivery(client, db, s, headers)
    client.post("/v1/deliveries/0080012345/cancel", headers=headers, json=msg(reason="duplicate"))
    assert client.get("/v1/tasks", headers=headers,
                      params={"warehouse": "BAL-WH01", "type": "putaway"}).json()["total"] == 0


def test_cancelling_the_pick_task_cancels_the_delivery(client, db, structure, headers):
    s = structure
    task_id = open_delivery(client, db, s, headers)
    client.post(f"/v1/tasks/{task_id}/cancel", headers=headers, json=msg(reason="no stock"))
    assert client.get("/v1/deliveries/0080012345", headers=headers).json()["status"] == "cancelled"
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("0")


def test_delivery_listing_and_filters(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.bk1, "100")
    client.post("/v1/deliveries", headers=headers, json=delivery_body("D1"))
    client.post("/v1/deliveries", headers=headers, json=delivery_body("D2", priority="high"))
    page = client.get("/v1/deliveries", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert page["total"] == 2
    assert [d["external_ref"] for d in page["items"]] == ["D2", "D1"]  # high priority first
    assert page["items"][0]["lines"][0]["sku"] == "ABC123"
    one = client.get("/v1/deliveries", headers=headers, params={"warehouse": "BAL-WH01", "status": "allocated"}).json()
    assert one["total"] == 2


# --- the invariant --------------------------------------------------------

def test_reservations_rebuild_from_open_pick_tasks(client, db, structure, headers):
    from wms.services.reservations import rebuild_reservations

    s = structure
    stock(db, s, s.abc, s.bk1, "100")
    client.post("/v1/deliveries", headers=headers, json=delivery_body("D1", lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 30, "uom": "EA"}]))
    client.post("/v1/deliveries", headers=headers, json=delivery_body("D2", lines=[
        {"delivery_line": 10, "sku": "ABC123", "qty": 20, "uom": "EA"}]))
    db.expire_all()
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("50")

    db.execute(StockBalance.__table__.update().values(reserved=Decimal("999")))
    db.commit()
    assert rebuild_reservations(db) == 1
    db.commit()
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("50")

    # picking one of them leaves the other reserved
    task_id = client.get("/v1/deliveries/D1", headers=headers).json()["task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=30, uom="EA"))
    db.expire_all()
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("20")
    rebuild_reservations(db)
    db.commit()
    assert reserved_at(db, s.bk1.id, s.abc.id) == Decimal("20")
