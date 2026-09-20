"""Step 5c: one walk for several orders, sorted into totes."""
import uuid
from decimal import Decimal

from sqlalchemy import select

from wms.models import StockLedger, Task
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def stock(db, s, product, location, qty, batch=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, movement_type="receipt", actor="jo",
                         received_at=s.received)])
    db.commit()


def delivery(client, headers, ref, lines, pick_mode="batch", name="Acme"):
    return client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref=ref, warehouse="BAL-WH01", pick_mode=pick_mode,
        ship_to={"name": name}, lines=lines))


def three_orders(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.pf, "40")
    stock(db, s, s.fg, s.bk1, "40", batch="B1")
    delivery(client, headers, "D1", [{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}], name="Repco")
    delivery(client, headers, "D2", [{"delivery_line": 10, "sku": "ABC123", "qty": 8, "uom": "EA"},
                                     {"delivery_line": 20, "sku": "FG-900", "qty": 5, "uom": "EA"}], name="Autobarn")
    delivery(client, headers, "D3", [{"delivery_line": 10, "sku": "ABC123", "qty": 4, "uom": "EA"}], name="Burson")


def make_batch(client, headers, refs=("D1", "D2", "D3"), **extra):
    return client.post("/v1/pick-batches", headers=headers, json=msg(
        warehouse="BAL-WH01", deliveries=list(refs), **extra))


# --- building a batch --------------------------------------------------------

def test_a_batch_groups_orders_and_gives_each_one_a_tote(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    r = make_batch(client, headers, assigned_to="op-017")
    assert r.status_code == 202, r.text

    got = client.get(f"/v1/pick-batches/{r.json()['wms_id']}", headers=headers).json()
    assert got["status"] == "new"
    assert got["warehouse"] == "BAL-WH01"
    assert got["assigned_to"] == "op-017"
    assert [(t["tote"], t["delivery"], t["ship_to"]) for t in got["totes"]] == [
        ("1", "D1", "Repco"), ("2", "D2", "Autobarn"), ("3", "D3", "Burson")]
    assert got["orders"] == 3
    assert got["lines"] == 4


def test_stops_collapse_into_one_walk(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    r = make_batch(client, headers)
    got = client.get(f"/v1/pick-batches/{r.json()['wms_id']}", headers=headers).json()

    # one stop per shelf and product, in walk order, with the split per tote
    assert [(s["location"], s["sku"], s["qty"]) for s in got["stops"]] == [
        ("PF-01-02-A", "ABC123", "18"), ("BK-04-01-C", "FG-900", "5")]
    assert [(p["tote"], p["delivery"], p["qty"]) for p in got["stops"][0]["picks"]] == [
        ("1", "D1", "6"), ("2", "D2", "8"), ("3", "D3", "4")]
    assert got["stops"][0]["zone"] == "PICKFACE"
    assert got["stops"][1]["batch"] == "B1"


def test_an_order_that_is_already_being_picked_cannot_join(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    task_id = client.get("/v1/deliveries/D1", headers=headers).json()["task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=6, uom="EA"))
    r = make_batch(client, headers)
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "deliveries.0"
    assert "picking" in r.json()["errors"][0]["message"]


def test_an_order_in_another_warehouse_cannot_join(client, db, structure, receiver, headers):
    three_orders(client, db, structure, headers)
    r = make_batch(client, headers, refs=["D1", "NOPE"])
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "deliveries.1"


def test_too_many_orders_for_the_warehouse_setting(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers, json={"batch_pick_max_orders": 2})
    r = make_batch(client, headers)
    assert r.status_code == 422
    assert "2" in r.json()["errors"][0]["message"]


def test_an_order_can_only_be_in_one_batch(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    assert make_batch(client, headers, refs=["D1", "D2"]).status_code == 202
    r = make_batch(client, headers, refs=["D2", "D3"])
    assert r.status_code == 422
    assert "already" in r.json()["errors"][0]["message"]


# --- walking it ---------------------------------------------------------------

def test_confirming_a_stop_fans_out_to_every_order(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]

    r = client.post(f"/v1/pick-batches/{ref}/stops/1/confirm", headers=headers, json=msg(
        operator="op-017", device="SCN-BAL-07"))
    assert r.status_code == 202, r.text
    assert r.json()["picked"] == "18"
    assert [(p["tote"], p["delivery"], p["qty"]) for p in r.json()["picks"]] == [
        ("1", "D1", "6"), ("2", "D2", "8"), ("3", "D3", "4")]

    # one ledger pair per order, so each delivery keeps its own line
    rows = db.execute(select(StockLedger).where(StockLedger.movement_type == "pick")
                      .order_by(StockLedger.id)).scalars().all()
    assert [(r.external_ref, r.qty_change) for r in rows] == [
        ("D1", Decimal("-6")), ("D1", Decimal("6")),
        ("D2", Decimal("-8")), ("D2", Decimal("8")),
        ("D3", Decimal("-4")), ("D3", Decimal("4"))]

    assert client.get("/v1/deliveries/D1", headers=headers).json()["status"] == "picked"
    assert client.get("/v1/deliveries/D2", headers=headers).json()["status"] == "picking"

    got = client.get(f"/v1/pick-batches/{ref}", headers=headers).json()
    assert got["status"] == "picking"
    assert [(s["location"], s["qty"]) for s in got["stops"]] == [("BK-04-01-C", "5")]
    assert got["done_stops"] == 1


def test_the_batch_finishes_when_the_last_stop_is_done(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]
    client.post(f"/v1/pick-batches/{ref}/stops/1/confirm", headers=headers, json=msg(operator="op-017"))
    r = client.post(f"/v1/pick-batches/{ref}/stops/1/confirm", headers=headers, json=msg(operator="op-017"))
    assert r.status_code == 202, r.text

    got = client.get(f"/v1/pick-batches/{ref}", headers=headers).json()
    assert got["status"] == "picked"
    assert got["stops"] == []
    for d in ("D1", "D2", "D3"):
        assert client.get(f"/v1/deliveries/{d}", headers=headers).json()["status"] == "picked"


def test_a_short_shelf_shorts_the_totes_that_miss_out(client, db, structure, headers, supervisor_badge):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]

    # only 15 on the shelf: the last tote misses four
    r = client.post(f"/v1/pick-batches/{ref}/stops/1/confirm", headers=headers, json=msg(
        operator="op-017", picks=[{"tote": "1", "qty": 6}, {"tote": "2", "qty": 8}, {"tote": "3", "qty": 1}],
        reason="short_on_shelf", supervisor_badge=supervisor_badge))
    assert r.status_code == 202, r.text
    assert r.json()["picked"] == "15"

    d3 = client.get("/v1/deliveries/D3", headers=headers).json()
    assert d3["status"] == "picked"
    assert d3["short"] is True
    assert d3["lines"][0]["qty_picked"] == "1"
    assert d3["lines"][0]["short_reason"] == "short_on_shelf"
    # a count for that shelf, because the shelf and the system disagree
    counts = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01", "type": "count"}).json()
    assert counts["total"] == 1
    assert counts["items"][0]["lines"][0]["from_location"] == "PF-01-02-A"


def test_shorting_without_a_supervisor_is_refused(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]
    r = client.post(f"/v1/pick-batches/{ref}/stops/1/confirm", headers=headers, json=msg(
        operator="op-017", picks=[{"tote": "1", "qty": 6}, {"tote": "2", "qty": 8}, {"tote": "3", "qty": 0}],
        reason="not_found"))
    assert r.status_code == 409
    assert r.json()["code"] == "needs_supervisor"


def test_picking_more_than_the_stop_wants_is_refused(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]
    r = client.post(f"/v1/pick-batches/{ref}/stops/1/confirm", headers=headers, json=msg(
        operator="op-017", picks=[{"tote": "1", "qty": 99}]))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "picks.0.qty"


def test_an_unknown_stop_is_404(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]
    assert client.post(f"/v1/pick-batches/{ref}/stops/9/confirm", headers=headers,
                       json=msg()).status_code == 404


# --- suggesting and cancelling --------------------------------------------------

def test_suggest_groups_waiting_orders_that_share_a_zone(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    # a fourth order, from a different zone only
    stock(db, structure, structure.fg, structure.bk2, "20", batch="B2")
    delivery(client, headers, "D4", [{"delivery_line": 10, "sku": "FG-900", "batch": "B2", "qty": 2, "uom": "EA"}])
    # and one that does not want batching
    delivery(client, headers, "D5", [{"delivery_line": 10, "sku": "ABC123", "qty": 2, "uom": "EA"}],
             pick_mode="single")

    r = client.get("/v1/pick-batches/suggest", headers=headers, params={"warehouse": "BAL-WH01"})
    assert r.status_code == 200, r.text
    groups = r.json()["groups"]
    assert len(groups) >= 1
    first = groups[0]
    assert set(first["deliveries"]) >= {"D1", "D2", "D3"}
    assert "D5" not in first["deliveries"]
    assert first["zone"] == "PICKFACE"
    assert first["stops"] < first["lines"]  # that is the point of a batch


def test_suggest_respects_the_maximum(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers, json={"batch_pick_max_orders": 2})
    groups = client.get("/v1/pick-batches/suggest", headers=headers,
                        params={"warehouse": "BAL-WH01"}).json()["groups"]
    assert all(len(g["deliveries"]) <= 2 for g in groups)


def test_cancel_a_batch_leaves_the_orders_alone(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    ref = make_batch(client, headers).json()["wms_id"]
    r = client.post(f"/v1/pick-batches/{ref}/cancel", headers=headers, json=msg(reason="wrong orders"))
    assert r.status_code == 202, r.text
    assert client.get(f"/v1/pick-batches/{ref}", headers=headers).json()["status"] == "cancelled"
    # each order still has its own pick task, untouched
    for d in ("D1", "D2", "D3"):
        got = client.get(f"/v1/deliveries/{d}", headers=headers).json()
        assert got["status"] == "allocated"
        assert got["task"]["status"] == "waiting"
    # and they can be batched again
    assert make_batch(client, headers).status_code == 202


def test_batch_listing(client, db, structure, headers):
    three_orders(client, db, structure, headers)
    make_batch(client, headers, refs=["D1", "D2"])
    make_batch(client, headers, refs=["D3"])
    page = client.get("/v1/pick-batches", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert page["total"] == 2
    assert [b["orders"] for b in page["items"]] == [2, 1]
