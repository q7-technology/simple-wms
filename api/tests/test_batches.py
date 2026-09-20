"""The batch master: what a batch code means, and whether it may be sold.

The ledger keeps the batch as a plain string. This table fills in behind it,
so nothing already written depends on a row here existing."""
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select

from wms.models import Batch, OutboundEvent, Product
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def receive(client, headers, *, ref, sku="ABC123", batch=None, qty="24"):
    r = client.post("/v1/receipts", headers=headers, json=msg(
        external_ref=ref, warehouse="BAL-WH01", supplier="Acme",
        lines=[{"line": 10, "sku": sku, "qty": qty, "uom": "EA", **({"batch": batch} if batch else {})}]))
    assert r.status_code == 202, r.text
    return r.json()


def batch_of(db, code):
    return db.execute(select(Batch).where(Batch.code == code)).scalar_one_or_none()


# --- the record itself ---------------------------------------------------------

def test_a_batch_is_created_and_updated_by_product_and_code(client, structure, headers):
    r = client.post("/v1/batches", headers=headers, json=msg(
        sku="ABC123", code="B2601", expiry_date="2027-03-31",
        manufactured_on="2026-03-31", supplier_lot="ACME-99", note="First lot"))
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "created"

    r = client.post("/v1/batches", headers=headers, json=msg(
        sku="ABC123", code="B2601", supplier_lot="ACME-99A"))
    assert r.json()["status"] == "updated"

    got = client.get("/v1/batches/ABC123/B2601", headers=headers).json()
    assert got["sku"] == "ABC123"
    assert got["code"] == "B2601"
    assert got["expiry_date"] == "2027-03-31"      # left alone by the update
    assert got["supplier_lot"] == "ACME-99A"
    assert got["status"] == "released"
    assert got["on_hand"] == "0"


def test_the_same_code_on_two_products_is_two_batches(client, structure, headers):
    client.post("/v1/batches", headers=headers, json=msg(sku="ABC123", code="L1", expiry_date="2027-01-01"))
    client.post("/v1/batches", headers=headers, json=msg(sku="FG-900", code="L1", expiry_date="2028-01-01"))
    assert client.get("/v1/batches/ABC123/L1", headers=headers).json()["expiry_date"] == "2027-01-01"
    assert client.get("/v1/batches/FG-900/L1", headers=headers).json()["expiry_date"] == "2028-01-01"


def test_an_unknown_product_or_batch_is_not_a_500(client, structure, headers):
    assert client.post("/v1/batches", headers=headers,
                       json=msg(sku="NOPE", code="B1")).status_code == 422
    assert client.get("/v1/batches/ABC123/NOSUCH", headers=headers).status_code == 404


# --- filling in behind the ledger ----------------------------------------------

def test_a_receipt_that_names_a_batch_creates_the_record(client, db, structure, headers):
    """The table fills in behind the ledger, so a site that never touches the
    batch endpoints still ends up with a row per batch it has handled."""
    receive(client, headers, ref="PO-B1", batch="B2610")
    row = batch_of(db, "B2610")
    assert row is not None
    assert row.status == "released"
    assert row.expiry_date is None       # nobody said, so nothing is invented

    # A second receipt of the same batch does not make a second row.
    receive(client, headers, ref="PO-B2", batch="B2610")
    assert len(db.execute(select(Batch).where(Batch.code == "B2610")).scalars().all()) == 1


def test_a_receipt_without_a_batch_creates_nothing(client, db, structure, headers):
    receive(client, headers, ref="PO-B3")
    assert db.execute(select(Batch)).scalars().all() == []


# --- quarantine ----------------------------------------------------------------

def test_quarantine_and_release_are_recorded_and_announced(client, db, structure, headers, listener):
    from tests.test_outbound import subscribe
    subscribe(db, listener, "batch.quarantined", "batch.released")
    receive(client, headers, ref="PO-Q1", batch="B2620")

    r = client.post("/v1/batches/ABC123/B2620/quarantine", headers=headers,
                    json=msg(reason="suspected_contamination", note="Held pending lab result"))
    assert r.status_code == 202, r.text
    assert r.json()["batch"]["status"] == "quarantined"
    assert r.json()["batch"]["reason"] == "suspected_contamination"

    types = [e.event_type for e in db.execute(select(OutboundEvent)).scalars().all()]
    assert types == ["batch.quarantined"]

    r = client.post("/v1/batches/ABC123/B2620/release", headers=headers, json=msg(note="Lab cleared it"))
    assert r.json()["batch"]["status"] == "released"
    assert r.json()["batch"]["reason"] is None
    types = [e.event_type for e in db.execute(select(OutboundEvent)).scalars().all()]
    assert types == ["batch.quarantined", "batch.released"]


def test_quarantined_stock_is_never_promised_to_anyone(client, db, structure, headers):
    """It stays on the shelf and stays in the balances. It is simply not
    allocated, so nothing is sold that cannot be shipped."""
    receive(client, headers, ref="PO-Q2", batch="GOOD", qty="10")
    receive(client, headers, ref="PO-Q3", batch="BAD", qty="10")
    for ref in ("PO-Q2", "PO-Q3"):
        task = client.get(f"/v1/receipts/{ref}", headers=headers).json()["task"]["wms_id"]
        r = client.post(f"/v1/tasks/{task}/lines/1/confirm", headers=headers,
                        json=msg(qty=10, uom="EA", location="PF-01-02-A"))
        assert r.status_code == 202, r.text
    client.post("/v1/batches/ABC123/BAD/quarantine", headers=headers, json=msg(reason="damaged"))

    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="D-Q1", warehouse="BAL-WH01", ship_to={"name": "Acme"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 20, "uom": "EA"}]))
    d = client.get("/v1/deliveries/D-Q1", headers=headers).json()
    batches = {l["batch"] for l in d["task"]["lines"]}
    assert "BAD" not in batches
    assert "GOOD" in batches
    # Only the released ten could be promised; the rest is short.
    assert d["lines"][0]["qty_allocated"] == "10"

    # On hand is untouched: the stock is still there, it is just not for sale.
    stock = client.get("/v1/stock", headers=headers, params={"sku": "ABC123"}).json()
    assert stock["total_on_hand"] == "20"


def test_releasing_a_batch_lets_it_be_picked_again(client, db, structure, headers):
    receive(client, headers, ref="PO-Q4", batch="HELD", qty="10")
    task = client.get("/v1/receipts/PO-Q4", headers=headers).json()["task"]["wms_id"]
    r = client.post(f"/v1/tasks/{task}/lines/1/confirm", headers=headers,
                    json=msg(qty=10, uom="EA", location="PF-01-02-A"))
    assert r.status_code == 202, r.text
    client.post("/v1/batches/ABC123/HELD/quarantine", headers=headers, json=msg(reason="damaged"))
    client.post("/v1/batches/ABC123/HELD/release", headers=headers, json=msg())

    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="D-Q2", warehouse="BAL-WH01", ship_to={"name": "Acme"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 4, "uom": "EA"}]))
    d = client.get("/v1/deliveries/D-Q2", headers=headers).json()
    assert d["lines"][0]["qty_allocated"] == "4"


# --- first expiry, first out ----------------------------------------------------

def test_the_batch_that_expires_first_is_picked_first(client, db, structure, headers):
    """Received order is the usual rule, but an expiry date beats it: the
    older receipt is no use if it outlives the one behind it."""
    receive(client, headers, ref="PO-E1", batch="OLD-RECEIPT", qty="6")
    receive(client, headers, ref="PO-E2", batch="SOON", qty="6")
    for ref in ("PO-E1", "PO-E2"):
        task = client.get(f"/v1/receipts/{ref}", headers=headers).json()["task"]["wms_id"]
        r = client.post(f"/v1/tasks/{task}/lines/1/confirm", headers=headers,
                        json=msg(qty=6, uom="EA", location="PF-01-02-A"))
        assert r.status_code == 202, r.text
    client.post("/v1/batches", headers=headers, json=msg(sku="ABC123", code="OLD-RECEIPT", expiry_date="2028-01-01"))
    client.post("/v1/batches", headers=headers, json=msg(sku="ABC123", code="SOON", expiry_date="2026-11-01"))

    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="D-E1", warehouse="BAL-WH01", ship_to={"name": "Acme"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}]))
    d = client.get("/v1/deliveries/D-E1", headers=headers).json()
    assert [l["batch"] for l in d["task"]["lines"]] == ["SOON"]


# --- what is about to go off ------------------------------------------------------

def test_batches_can_be_listed_and_narrowed_to_what_expires_soon(client, db, structure, headers):
    receive(client, headers, ref="PO-L1", batch="SOON", qty="5")
    receive(client, headers, ref="PO-L2", batch="LATER", qty="5")
    soon = (date.today() + timedelta(days=20)).isoformat()
    later = (date.today() + timedelta(days=400)).isoformat()
    client.post("/v1/batches", headers=headers, json=msg(sku="ABC123", code="SOON", expiry_date=soon))
    client.post("/v1/batches", headers=headers, json=msg(sku="ABC123", code="LATER", expiry_date=later))

    listing = client.get("/v1/batches", headers=headers, params={"sku": "ABC123"}).json()
    assert [b["code"] for b in listing["items"]] == ["SOON", "LATER"]   # earliest expiry first

    cutoff = (date.today() + timedelta(days=30)).isoformat()
    narrowed = client.get("/v1/batches", headers=headers,
                          params={"sku": "ABC123", "expires_before": cutoff}).json()
    assert [b["code"] for b in narrowed["items"]] == ["SOON"]

    held = client.post("/v1/batches/ABC123/LATER/quarantine", headers=headers, json=msg(reason="damaged"))
    assert held.status_code == 202
    only_held = client.get("/v1/batches", headers=headers,
                           params={"sku": "ABC123", "status": "quarantined"}).json()
    assert [b["code"] for b in only_held["items"]] == ["LATER"]


def test_a_listed_batch_says_how_much_is_on_hand(client, db, structure, headers):
    receive(client, headers, ref="PO-H1", batch="B99", qty="7")
    task = client.get("/v1/receipts/PO-H1", headers=headers).json()["task"]["wms_id"]
    r = client.post(f"/v1/tasks/{task}/lines/1/confirm", headers=headers,
                    json=msg(qty=7, uom="EA", location="PF-01-02-A"))
    assert r.status_code == 202, r.text
    got = client.get("/v1/batches/ABC123/B99", headers=headers).json()
    assert got["on_hand"] == "7"
