"""Step 4: the WMS renders nothing. It sends template + JSON to Platen."""
import uuid
from datetime import timedelta
from decimal import Decimal

import httpx
from sqlalchemy import select

from wms.models import PrintJob, PrintPoint
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def stock(db, s, product, location, qty, batch=None, received=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, movement_type="receipt", actor="jo",
                         received_at=received or s.received)])
    db.commit()


def jobs(db):
    return db.execute(select(PrintJob).order_by(PrintJob.id)).scalars().all()


def make_point(client, headers, **body):
    return client.post("/v1/print-points", headers=headers, json={
        "warehouse": "BAL-WH01", "copies": 1, "active": True, **body})


# --- print points ---------------------------------------------------------

def test_print_point_create_update_and_list(client, structure, headers):
    r = make_point(client, headers, event_type="receipt.confirmed", template="location-label",
                   printer="Receiving dock")
    assert r.status_code == 201, r.text
    point = r.json()
    assert point["template"] == "location-label"
    assert point["version"] == "v2"  # the current version of that template
    assert point["copies"] == 1
    assert point["active"] is True

    r = make_point(client, headers, event_type="receipt.confirmed", template="location-label",
                   printer="Receiving dock", copies=2)
    assert r.status_code == 200
    assert r.json()["copies"] == 2

    listing = client.get("/v1/print-points", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["printer"] == "Receiving dock"


def test_unknown_template_is_refused(client, structure, headers):
    r = make_point(client, headers, event_type="receipt.confirmed", template="nope", printer="X")
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "template"
    assert "location-label" in r.json()["errors"][0]["message"]


def test_templates_are_listed_with_their_shapes(client, headers):
    r = client.get("/v1/print-templates", headers=headers)
    assert r.status_code == 200
    names = {t["template"]: t for t in r.json()["items"]}
    assert set(names) == {"location-label", "product-label", "carton-label", "pallet-label",
                          "pick-list", "packing-slip", "transfer-docket"}
    assert names["carton-label"]["version"] == "v3"
    assert "ship_to" in names["carton-label"]["fields"]
    assert names["location-label"]["fires_on"] == ["receipt.confirmed"]


# --- events fire print points ---------------------------------------------

def receipt_and_putaway(client, db, structure, headers):
    client.post("/v1/receipts", headers=headers, json=msg(
        external_ref="PO-88815", warehouse="BAL-WH01", supplier="Supplier Co",
        lines=[{"line": 1, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    task_id = client.get("/v1/tasks", headers=headers, params={"warehouse": "BAL-WH01"}).json()["items"][0]["wms_id"]
    return client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(
        qty=10, uom="EA", location="BK-04-01-C", operator="op-017", device="SCN-BAL-07"))


def test_a_receipt_put_away_prints_a_location_label(client, db, structure, headers):
    make_point(client, headers, event_type="receipt.confirmed", template="location-label",
               printer="Receiving dock", copies=2)
    assert receipt_and_putaway(client, db, structure, headers).status_code == 202

    rows = jobs(db)
    assert len(rows) == 1
    job = rows[0]
    assert job.template == "location-label"
    assert job.version == "v2"
    assert job.printer == "Receiving dock"
    assert job.copies == 2
    assert job.status == "pending"
    assert job.reference == {"type": "location", "ref": "BK-04-01-C", "receipt_ref": "PO-88815"}
    assert job.data == {
        "location": "BK-04-01-C", "warehouse": "BAL-WH01", "zone": "BULK", "barcode": "BK-04-01-C",
        "type": "shelf", "access": "ground", "pick_sequence": 410,
    }


def test_a_print_point_that_is_off_prints_nothing(client, db, structure, headers):
    make_point(client, headers, event_type="receipt.confirmed", template="location-label",
               printer="Receiving dock", active=False)
    receipt_and_putaway(client, db, structure, headers)
    assert jobs(db) == []


def test_a_print_point_for_another_warehouse_does_not_fire(client, db, structure, headers):
    client.post("/v1/sites", headers=headers, json=msg(code="MEL", name="Melbourne"))
    client.post("/v1/warehouses", headers=headers, json=msg(code="MEL-WH01", site="MEL", name="Melbourne 1"))
    make_point(client, headers, warehouse="MEL-WH01", event_type="receipt.confirmed",
               template="location-label", printer="Other dock")
    receipt_and_putaway(client, db, structure, headers)
    assert jobs(db) == []


def test_a_print_point_with_no_warehouse_covers_them_all(client, db, structure, headers):
    r = make_point(client, headers, warehouse=None, event_type="receipt.confirmed",
                   template="location-label", printer="Anywhere")
    assert r.status_code == 201, r.text
    assert r.json()["warehouse"] is None
    receipt_and_putaway(client, db, structure, headers)
    assert len(jobs(db)) == 1


def test_packing_prints_a_carton_label_per_carton(client, db, structure, headers):
    make_point(client, headers, event_type="delivery.packed", template="carton-label",
               printer="Packing bench 2")
    s = structure
    stock(db, s, s.abc, s.bk1, "10")
    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="0080012345", warehouse="BAL-WH01",
        ship_to={"name": "Acme Auto Parts", "address": "12 Example St", "suburb": "Geelong",
                 "state": "VIC", "postcode": "3220"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    task_id = client.get("/v1/deliveries/0080012345", headers=headers).json()["task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=10, uom="EA", operator="op-017"))
    client.post("/v1/deliveries/0080012345/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", packed_by="op-017", complete=True,
        packages=[
            {"package_no": 1, "type": "carton", "weight_kg": 8.4, "length_cm": 40, "width_cm": 30,
             "height_cm": 25, "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 6, "uom": "EA"}]},
            {"package_no": 2, "type": "carton", "weight_kg": 5,
             "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 4, "uom": "EA"}]},
        ]))

    rows = jobs(db)
    assert len(rows) == 2
    assert [j.reference["package_no"] for j in rows] == [1, 2]
    assert rows[0].data == {
        "ship_to": {"name": "Acme Auto Parts", "address": "12 Example St", "suburb": "Geelong",
                    "state": "VIC", "postcode": "3220"},
        "delivery_ref": "0080012345", "package_no": 1, "package_count": 2, "weight_kg": "8.4",
        "carrier": None, "tracking_no": None, "sscc": None,
        "lines": [{"sku": "ABC123", "qty": "6", "uom": "EA"}],
    }


# --- printing on demand ----------------------------------------------------

def test_print_a_location_label_on_demand(client, db, structure, headers):
    r = client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="location-label", printer="Office",
        reference={"type": "location", "ref": "PF-01-02-A"}, copies=3))
    assert r.status_code == 202, r.text
    job = jobs(db)[0]
    assert job.copies == 3
    assert job.data["location"] == "PF-01-02-A"
    assert job.data["zone"] == "PICKFACE"

    got = client.get(f"/v1/print-jobs/{r.json()['wms_id']}", headers=headers).json()
    assert got["template"] == "location-label"
    assert got["status"] == "pending"
    assert got["reference"]["ref"] == "PF-01-02-A"


def test_print_a_product_label_on_demand(client, db, structure, headers):
    r = client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="product-label", printer="Office",
        reference={"type": "product", "ref": "ABC123", "batch": "B2601", "qty": 12}))
    assert r.status_code == 202, r.text
    job = jobs(db)[0]
    assert job.data == {"sku": "ABC123", "name": "Widget", "uom": "EA", "barcode": "09312345000012",
                        "batch": "B2601", "batch_tracked": False, "qty": "12"}


def test_print_a_pick_list_for_a_delivery(client, db, structure, headers):
    s = structure
    stock(db, s, s.abc, s.pf, "10")
    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="0080012345", warehouse="BAL-WH01", required_by="2026-09-22",
        ship_to={"name": "Acme Auto Parts", "suburb": "Geelong", "state": "VIC", "postcode": "3220"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    r = client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="pick-list", printer="Office",
        reference={"type": "delivery", "ref": "0080012345"}))
    assert r.status_code == 202, r.text
    data = jobs(db)[0].data
    assert data["delivery_ref"] == "0080012345"
    assert data["required_by"] == "2026-09-22"
    assert data["lines"] == [{"location": "PF-01-02-A", "sku": "ABC123", "name": "Widget",
                              "batch": None, "qty": "10", "uom": "EA"}]


def test_printing_something_that_is_not_there_is_422(client, db, structure, headers):
    r = client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="location-label", printer="Office",
        reference={"type": "location", "ref": "NOPE"}))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "reference"


def test_print_job_is_idempotent_per_message_id(client, db, structure, headers):
    body = msg(warehouse="BAL-WH01", template="location-label", printer="Office",
               reference={"type": "location", "ref": "PF-01-02-A"})
    r1 = client.post("/v1/print-jobs", headers=headers, json=body)
    r2 = client.post("/v1/print-jobs", headers=headers, json=body)
    assert r1.json() == r2.json()
    assert len(jobs(db)) == 1


# --- the queue, Platen and reprints -----------------------------------------

def platen_url(listener):
    return listener.url


def set_platen(client, headers, listener):
    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers,
                     json={"platen_url": platen_url(listener)})
    assert r.status_code == 200, r.text


def queue_one(client, db, structure, headers):
    client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="location-label", printer="Office",
        reference={"type": "location", "ref": "PF-01-02-A"}))
    return jobs(db)[0]


def test_worker_sends_a_job_to_platen_and_records_accepted(client, db, structure, headers, listener):
    set_platen(client, headers, listener)
    job = queue_one(client, db, structure, headers)
    from wms.worker import send_print_jobs

    now = job.next_attempt_at
    with httpx.Client() as http:
        assert send_print_jobs(db, http, now=now) == 1
    db.commit()
    db.refresh(job)
    assert job.status == "accepted"
    assert job.attempts == 1
    assert job.sent_at == now

    sent = listener.received[0]
    body = __import__("json").loads(sent["body"])
    assert body == {
        "job_id": str(job.job_id), "template": "location-label", "version": "v2",
        "printer": "Office", "copies": 1,
        "reference": {"type": "location", "ref": "PF-01-02-A"},
        "data": job.data,
    }
    assert sent["headers"]["X-WMS-Job-Id"] == str(job.job_id)


def test_platen_says_printed_or_failed_afterwards(client, db, structure, headers, listener):
    set_platen(client, headers, listener)
    job = queue_one(client, db, structure, headers)
    from wms.worker import send_print_jobs

    with httpx.Client() as http:
        send_print_jobs(db, http)
    db.commit()

    r = client.post(f"/v1/print-jobs/{job.job_id}/status", headers=headers,
                    json={"status": "printed"})
    assert r.status_code == 200, r.text
    db.refresh(job)
    assert job.status == "printed"
    assert job.printed_at is not None

    r = client.post(f"/v1/print-jobs/{job.job_id}/status", headers=headers,
                    json={"status": "failed", "message": "out of labels"})
    assert r.status_code == 200
    db.refresh(job)
    assert job.status == "failed"
    assert job.last_error == "out of labels"

    r = client.post(f"/v1/print-jobs/{uuid.uuid4()}/status", headers=headers, json={"status": "printed"})
    assert r.status_code == 404


def test_a_refused_job_backs_off_like_an_event(client, db, structure, headers, listener):
    from wms.worker import BACKOFF, send_print_jobs

    set_platen(client, headers, listener)
    job = queue_one(client, db, structure, headers)
    listener.responses.extend([503, 503, 503, 503])

    now = job.next_attempt_at
    with httpx.Client() as http:
        for attempt, delay in enumerate(BACKOFF, start=1):
            assert send_print_jobs(db, http, now=now) == 1
            db.commit()
            db.refresh(job)
            assert job.attempts == attempt
            if attempt < len(BACKOFF):
                assert job.status == "pending"
                assert job.next_attempt_at == now + timedelta(seconds=delay)
                now = now + timedelta(seconds=delay)
        assert job.status == "failed"
        assert job.last_error.startswith("HTTP 503")


def test_a_warehouse_with_no_platen_url_leaves_the_job_waiting(client, db, structure, headers):
    from wms.worker import send_print_jobs

    job = queue_one(client, db, structure, headers)
    with httpx.Client() as http:
        assert send_print_jobs(db, http) == 0
    db.refresh(job)
    assert job.status == "pending"
    assert job.attempts == 0


def test_reprint_sends_the_same_data_as_a_new_job(client, db, structure, headers):
    job = queue_one(client, db, structure, headers)
    job.status = "printed"
    db.commit()

    r = client.post(f"/v1/print-jobs/{job.id}/reprint", headers=headers, json=msg())
    assert r.status_code == 202, r.text
    rows = jobs(db)
    assert len(rows) == 2
    copy = rows[1]
    assert copy.data == job.data
    assert copy.template == job.template
    assert copy.version == job.version
    assert copy.job_id != job.job_id
    assert copy.status == "pending"
    assert copy.reprint_of_id == job.id

    # a different printer or more copies is allowed
    r = client.post(f"/v1/print-jobs/{job.id}/reprint", headers=headers,
                    json=msg(printer="Office 2", copies=3))
    assert r.status_code == 202
    again = jobs(db)[2]
    assert again.printer == "Office 2" and again.copies == 3


def test_print_job_listing_and_filters(client, db, structure, headers):
    queue_one(client, db, structure, headers)
    client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="product-label", printer="Office",
        reference={"type": "product", "ref": "ABC123"}))
    page = client.get("/v1/print-jobs", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert page["total"] == 2
    assert [j["template"] for j in page["items"]] == ["product-label", "location-label"]  # newest first
    one = client.get("/v1/print-jobs", headers=headers,
                     params={"warehouse": "BAL-WH01", "template": "product-label"}).json()
    assert one["total"] == 1
    assert client.get("/v1/print-jobs", headers=headers,
                      params={"warehouse": "BAL-WH01", "status": "printed"}).json()["total"] == 0


def test_printing_needs_its_scope(client, db, structure):
    from wms.services.access import create_api_client

    _, raw = create_api_client(db, name="ro", scopes=["stock:read"], warehouses=["*"], owner="DEFAULT")
    db.commit()
    h = {"Authorization": f"Bearer {raw}"}
    r = client.post("/v1/print-jobs", headers=h, json=msg(
        warehouse="BAL-WH01", template="location-label", printer="Office",
        reference={"type": "location", "ref": "PF-01-02-A"}))
    assert r.status_code == 403
