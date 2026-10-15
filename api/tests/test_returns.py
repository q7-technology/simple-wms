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
