"""The SAP adapter: an event becomes a BAPI call.

There is no SAP system here and there is no `pyrfc` either, because the SAP
RFC SDK is licensed and cannot be installed from a public index. So the
adapter takes its connection from the caller: the worker hands it a real
`pyrfc` connection, and these tests hand it one that writes down what it was
asked to do. The mapping is what is being tested, and the mapping is all the
adapter is."""
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from wms.models import OutboundEvent, Subscriber
from wms.services import sap
from wms.worker import run_once


class FakeSap:
    """Stands in for `pyrfc.Connection`. Answers every call with a clean
    RETURN table unless it has been told to complain."""

    def __init__(self, complaint: dict | None = None, doc: str = "4900001234"):
        self.calls: list[tuple[str, dict]] = []
        self.complaint = complaint
        self.doc = doc

    def call(self, function: str, **params) -> dict:
        self.calls.append((function, params))
        if function == "BAPI_GOODSMVT_CREATE":
            if self.complaint:
                return {"RETURN": [self.complaint], "MATERIALDOCUMENT": ""}
            return {"RETURN": [{"TYPE": "S", "MESSAGE": "Document posted"}],
                    "MATERIALDOCUMENT": self.doc, "MATDOCUMENTYEAR": "2026"}
        return {"RETURN": []}

    def named(self, function: str) -> list[dict]:
        return [p for f, p in self.calls if f == function]


SETTINGS = {
    "connection": {"ashost": "sap.example", "sysnr": "00", "client": "100", "user": "WMS",
                   "passwd_env": "SAP_PASSWORD"},
    "plant_by_warehouse": {"BAL-WH01": "1000"},
    "storage_location": "0001",
}


def subscriber(db, **over):
    row = Subscriber(name="sap", url="rfc://sap", secret="unused", event_types=["*"],
                     transport="sap_rfc", settings={**SETTINGS, **over.pop("settings", {})}, **over)
    db.add(row)
    db.commit()
    return row


def event(db, sub, event_type, data, warehouse="BAL-WH01", ref="PO-1"):
    row = OutboundEvent(
        event_id="11111111-1111-1111-1111-111111111111", subscriber_id=sub.id,
        event_type=event_type, occurred_at=datetime.now(UTC), warehouse=warehouse,
        owner="DEFAULT", external_ref=ref, status="pending", attempts=0,
        next_attempt_at=datetime.now(UTC),
        payload={"event_id": "11111111-1111-1111-1111-111111111111", "event_type": event_type,
                 "occurred_at": "2026-09-21T02:00:00Z", "warehouse": warehouse, "owner": "DEFAULT",
                 "external_ref": ref, "data": data})
    db.add(row)
    db.commit()
    return row


# --- the mapping ----------------------------------------------------------------

def test_a_receipt_becomes_a_goods_receipt(db):
    sub = subscriber(db)
    row = event(db, sub, "receipt.confirmed",
                {"sku": "ABC123", "batch": "B2601", "qty": "24", "uom": "EA",
                 "location": "BK-04-01-C", "receipt_ref": "PO-88815"})
    fake = FakeSap()
    sap.deliver(row, fake)

    posted = fake.named("BAPI_GOODSMVT_CREATE")
    assert len(posted) == 1
    head, code = posted[0]["GOODSMVT_HEADER"], posted[0]["GOODSMVT_CODE"]
    assert code == {"GM_CODE": "01"}          # goods receipt for a purchase order
    assert head["REF_DOC_NO"] == "PO-88815"
    item = posted[0]["GOODSMVT_ITEM"][0]
    assert item["MATERIAL"] == "ABC123"
    assert item["PLANT"] == "1000"
    assert item["STGE_LOC"] == "0001"
    assert item["MOVE_TYPE"] == "101"
    assert item["ENTRY_QNT"] == "24"          # a decimal string, never a float
    assert item["ENTRY_UOM"] == "EA"
    assert item["BATCH"] == "B2601"
    # And it is committed, or nothing happened at all.
    assert [f for f, _ in fake.calls] == ["BAPI_GOODSMVT_CREATE", "BAPI_TRANSACTION_COMMIT"]


def test_a_shipment_becomes_a_goods_issue_with_a_line_each(db):
    sub = subscriber(db)
    row = event(db, sub, "delivery.shipped",
                {"delivery_ref": "0080012345", "carrier": "Toll",
                 "lines": [{"sku": "ABC123", "batch": "B1", "qty_shipped": "6", "uom": "EA"},
                           {"sku": "FG-900", "batch": None, "qty_shipped": "2", "uom": "EA"}]},
                ref="0080012345")
    fake = FakeSap()
    sap.deliver(row, fake)

    posted = fake.named("BAPI_GOODSMVT_CREATE")[0]
    assert posted["GOODSMVT_CODE"] == {"GM_CODE": "03"}
    items = posted["GOODSMVT_ITEM"]
    assert [i["MATERIAL"] for i in items] == ["ABC123", "FG-900"]
    assert {i["MOVE_TYPE"] for i in items} == {"601"}
    assert items[0]["BATCH"] == "B1"
    assert "BATCH" not in items[1]            # no batch is no key, not an empty one
    assert [i["ENTRY_QNT"] for i in items] == ["6", "2"]


def test_an_adjustment_up_and_down_use_the_two_difference_movements(db):
    sub = subscriber(db)
    up = event(db, sub, "stock.adjusted",
               {"sku": "ABC123", "batch": None, "location": "PF-01-02-A", "qty_change": "2",
                "uom": "EA", "reason": "found", "ledger_id": "51"})
    fake = FakeSap()
    sap.deliver(up, fake)
    assert fake.named("BAPI_GOODSMVT_CREATE")[0]["GOODSMVT_ITEM"][0]["MOVE_TYPE"] == "701"

    down = event(db, sub, "stock.adjusted",
                 {"sku": "ABC123", "batch": None, "location": "PF-01-02-A", "qty_change": "-2",
                  "uom": "EA", "reason": "damaged", "ledger_id": "52"})
    fake2 = FakeSap()
    sap.deliver(down, fake2)
    item = fake2.named("BAPI_GOODSMVT_CREATE")[0]["GOODSMVT_ITEM"][0]
    assert item["MOVE_TYPE"] == "702"
    assert item["ENTRY_QNT"] == "2"           # SAP is told a quantity and a direction


def test_a_move_becomes_a_transfer_posting(db):
    sub = subscriber(db)
    row = event(db, sub, "stock.moved",
                {"sku": "ABC123", "batch": "B1", "qty": "12", "uom": "EA",
                 "from": "BK-04-01-C", "to": "PF-01-02-A", "reason": "replenishment"})
    fake = FakeSap()
    sap.deliver(row, fake)
    item = fake.named("BAPI_GOODSMVT_CREATE")[0]["GOODSMVT_ITEM"][0]
    assert item["MOVE_TYPE"] == "311"
    assert item["STGE_LOC"] == "0001" and item["MOVE_STLOC"] == "0001"


def test_production_issue_and_receipt_carry_the_order(db):
    sub = subscriber(db)
    issued = event(db, sub, "production.components_issued",
                   {"po_ref": "PO-4711", "complete": True,
                    "lines": [{"sku": "ABC123", "batch": "B1", "qty_issued": "100", "uom": "EA"}]})
    fake = FakeSap()
    sap.deliver(issued, fake)
    item = fake.named("BAPI_GOODSMVT_CREATE")[0]["GOODSMVT_ITEM"][0]
    assert item["MOVE_TYPE"] == "261"
    assert item["ORDERID"] == "PO-4711"

    made = event(db, sub, "production.received",
                 {"po_ref": "PO-4711", "sku": "FG-900", "batch": "F1", "qty": "50", "uom": "EA",
                  "location": "BK-04-01-C"})
    fake2 = FakeSap()
    sap.deliver(made, fake2)
    item = fake2.named("BAPI_GOODSMVT_CREATE")[0]["GOODSMVT_ITEM"][0]
    assert item["MOVE_TYPE"] == "101"
    assert item["ORDERID"] == "PO-4711"


# --- when SAP says no --------------------------------------------------------------

def test_an_sap_error_rolls_back_and_raises_with_sap_s_own_words(db):
    sub = subscriber(db)
    row = event(db, sub, "receipt.confirmed",
                {"sku": "ABC123", "batch": None, "qty": "24", "uom": "EA",
                 "location": "BK-04-01-C", "receipt_ref": "PO-88815"})
    fake = FakeSap(complaint={"TYPE": "E", "ID": "M7", "NUMBER": "021",
                              "MESSAGE": "Deficit of stock 24 EA : ABC123 1000 0001"})
    with pytest.raises(sap.SapError) as raised:
        sap.deliver(row, fake)
    assert "Deficit of stock" in str(raised.value)
    assert [f for f, _ in fake.calls] == ["BAPI_GOODSMVT_CREATE", "BAPI_TRANSACTION_ROLLBACK"]


def test_an_event_with_no_mapping_says_so_instead_of_guessing(db):
    sub = subscriber(db)
    row = event(db, sub, "delivery.packed", {"delivery_ref": "0080012345", "packages": []})
    fake = FakeSap()
    with pytest.raises(sap.Unmapped) as raised:
        sap.deliver(row, fake)
    assert "delivery.packed" in str(raised.value)
    assert fake.calls == []


def test_a_warehouse_with_no_plant_is_a_clear_error_not_a_bad_posting(db):
    sub = subscriber(db, settings={"plant_by_warehouse": {"MEL-WH01": "2000"}})
    row = event(db, sub, "receipt.confirmed",
                {"sku": "ABC123", "batch": None, "qty": "1", "uom": "EA",
                 "location": "BK-04-01-C", "receipt_ref": "PO-1"})
    fake = FakeSap()
    with pytest.raises(sap.SapError) as raised:
        sap.deliver(row, fake)
    assert "BAL-WH01" in str(raised.value)
    assert fake.calls == []


# --- through the worker, on the same queue ------------------------------------------

def test_the_worker_posts_to_sap_and_marks_the_event_delivered(db):
    sub = subscriber(db)
    row = event(db, sub, "receipt.confirmed",
                {"sku": "ABC123", "batch": None, "qty": "24", "uom": "EA",
                 "location": "BK-04-01-C", "receipt_ref": "PO-88815"})
    fake = FakeSap()
    done = run_once(db, http=None, connect=lambda s: fake)
    assert done == 1
    db.refresh(row)
    assert row.status == "delivered"
    assert row.last_error is None
    assert fake.named("BAPI_GOODSMVT_CREATE")


def test_a_refusal_from_sap_retries_on_the_same_backoff_as_everything_else(db):
    sub = subscriber(db)
    row = event(db, sub, "receipt.confirmed",
                {"sku": "ABC123", "batch": None, "qty": "24", "uom": "EA",
                 "location": "BK-04-01-C", "receipt_ref": "PO-88815"})
    fake = FakeSap(complaint={"TYPE": "E", "MESSAGE": "Posting period 09 2026 is not open"})
    now = datetime.now(UTC)
    run_once(db, http=None, now=now, connect=lambda s: fake)
    db.refresh(row)
    assert row.status == "pending"
    assert row.attempts == 1
    assert "Posting period" in row.last_error
    assert (row.next_attempt_at - now).total_seconds() == pytest.approx(60, abs=2)


def test_an_unmapped_event_is_not_retried_forever(db):
    """Four goes at a mapping that does not exist is just noise. It fails at
    once and waits on the Integrations page, where somebody can see it."""
    sub = subscriber(db)
    row = event(db, sub, "delivery.packed", {"delivery_ref": "0080012345", "packages": []})
    run_once(db, http=None, connect=lambda s: FakeSap())
    db.refresh(row)
    assert row.status == "failed"
    assert "delivery.packed" in row.last_error


# --- the connection itself ----------------------------------------------------------

def test_without_the_sap_sdk_the_error_says_what_to_install(db):
    sub = subscriber(db)
    with pytest.raises(sap.SapError) as raised:
        sap.connect(sub)
    message = str(raised.value)
    assert "pyrfc" in message
    assert "SAP NetWeaver RFC SDK" in message


def test_a_password_is_read_from_the_environment_not_the_database(db, monkeypatch):
    sub = subscriber(db)
    assert "passwd" not in sub.settings["connection"]
    monkeypatch.setenv("SAP_PASSWORD", "hunter2")
    params = sap.connection_params(sub)
    assert params["passwd"] == "hunter2"
    assert params["ashost"] == "sap.example"
    assert "passwd_env" not in params


def test_a_missing_password_is_named_before_anything_is_attempted(db, monkeypatch):
    sub = subscriber(db)
    monkeypatch.delenv("SAP_PASSWORD", raising=False)
    with pytest.raises(sap.SapError) as raised:
        sap.connection_params(sub)
    assert "SAP_PASSWORD" in str(raised.value)


# --- setting one up through the API ---------------------------------------------------

def test_an_sap_subscriber_is_made_like_any_other(client, headers, db):
    r = client.post("/v1/subscribers", headers=headers, json={
        "name": "sap-erp", "url": "rfc://PRD", "transport": "sap_rfc",
        "event_types": ["receipt.confirmed", "delivery.shipped", "stock.adjusted"],
        "settings": {"connection": {"ashost": "sap.example", "sysnr": "00", "client": "100",
                                    "user": "WMS", "passwd_env": "SAP_PASSWORD"},
                     "plant_by_warehouse": {"BAL-WH01": "1000"}, "storage_location": "0001"},
    })
    assert r.status_code in (200, 201), r.text
    got = r.json()
    assert got["transport"] == "sap_rfc"
    assert got["settings"]["plant_by_warehouse"] == {"BAL-WH01": "1000"}

    listing = client.get("/v1/subscribers", headers=headers).json()
    mine = next(s for s in listing["items"] if s["name"] == "sap-erp")
    assert mine["transport"] == "sap_rfc"


def test_an_sap_subscriber_may_not_hide_a_password_in_the_database(client, headers):
    r = client.post("/v1/subscribers", headers=headers, json={
        "name": "sap-bad", "url": "rfc://PRD", "transport": "sap_rfc",
        "event_types": ["receipt.confirmed"],
        "settings": {"connection": {"ashost": "sap.example", "passwd": "hunter2"},
                     "plant_by_warehouse": {"BAL-WH01": "1000"}},
    })
    assert r.status_code == 422
    assert "passwd_env" in r.text


def test_an_http_subscriber_still_needs_an_http_url(client, headers):
    r = client.post("/v1/subscribers", headers=headers, json={
        "name": "nope", "url": "rfc://PRD", "event_types": ["receipt.confirmed"]})
    assert r.status_code == 422
