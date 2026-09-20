"""Step 6a: pallets, cartons and totes, with SSCC and nesting."""
import uuid
from decimal import Decimal

import pytest

from sqlalchemy import select

from wms.models import Container, StockLedger
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def stock(db, s, product, location, qty, batch=None, container=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, container_id=container,
                         movement_type="receipt", actor="jo", received_at=s.received)])
    db.commit()


def make(client, headers, **body):
    return client.post("/v1/containers", headers=headers, json=msg(
        warehouse="BAL-WH01", owner="DEFAULT", **body))


# --- registering ------------------------------------------------------------

def test_a_pallet_gets_a_code_and_can_carry_an_sscc(client, db, structure, headers):
    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers,
                     json={"gs1_company_prefix": "9312345"})
    assert r.status_code == 200, r.text

    r = make(client, headers, type="pallet", location="BK-04-01-C", assign_sscc=True)
    assert r.status_code == 202, r.text
    got = client.get(f"/v1/containers/{r.json()['wms_id']}", headers=headers).json()
    assert got["type"] == "pallet"
    assert got["status"] == "open"
    assert got["location"] == "BK-04-01-C"
    assert got["container_id"].startswith("PAL-")
    sscc = got["sscc"]
    assert len(sscc) == 18 and sscc.isdigit()
    assert sscc.startswith("09312345")
    assert check_digit_ok(sscc)


def check_digit_ok(sscc: str) -> bool:
    """GS1 mod 10: every second digit from the right times three."""
    body, check = sscc[:-1], int(sscc[-1])
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def test_an_sscc_needs_a_company_prefix(client, db, structure, headers):
    r = make(client, headers, type="pallet", assign_sscc=True)
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "assign_sscc"
    assert "GS1 company prefix" in r.json()["errors"][0]["message"]


def test_a_given_code_is_kept_and_reused(client, db, structure, headers):
    r = make(client, headers, container_id="TOTE-01", type="tote")
    assert r.status_code == 202
    assert r.json()["status"] == "created"
    r = make(client, headers, container_id="TOTE-01", type="tote", location="PACK-01")
    assert r.json()["status"] == "updated"
    got = client.get("/v1/containers/TOTE-01", headers=headers).json()
    assert got["location"] == "PACK-01"
    assert client.get("/v1/containers", headers=headers,
                      params={"warehouse": "BAL-WH01"}).json()["total"] == 1


def test_a_scanned_sscc_finds_its_container(client, db, structure, headers):
    client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers,
                 json={"gs1_company_prefix": "9312345"})
    ref = make(client, headers, type="pallet", assign_sscc=True).json()["wms_id"]
    sscc = client.get(f"/v1/containers/{ref}", headers=headers).json()["sscc"]

    r = client.post("/v1/scans/parse", headers=headers, json={
        "raw": "]C1" + "00" + sscc, "warehouse": "BAL-WH01"})
    assert r.status_code == 200, r.text
    assert r.json()["type"] == "container"
    assert r.json()["resolved"]["container_id"] == ref
    assert r.json()["resolved"]["type"] == "pallet"

    # and the plain code works too
    assert client.post("/v1/scans/parse", headers=headers,
                       json={"raw": ref, "warehouse": "BAL-WH01"}).json()["type"] == "container"


# --- nesting -----------------------------------------------------------------

def test_cartons_nest_on_a_pallet(client, db, structure, headers):
    pallet = make(client, headers, container_id="PAL-01", type="pallet",
                  location="BK-04-01-C").json()["wms_id"]
    for code in ("CTN-01", "CTN-02"):
        make(client, headers, container_id=code, type="carton")
        r = client.post(f"/v1/containers/{code}/nest", headers=headers, json=msg(parent="PAL-01"))
        assert r.status_code == 202, r.text

    got = client.get("/v1/containers/PAL-01", headers=headers).json()
    assert [c["container_id"] for c in got["children"]] == ["CTN-01", "CTN-02"]
    carton = client.get("/v1/containers/CTN-01", headers=headers).json()
    assert carton["parent"] == "PAL-01"
    # a nested carton follows its pallet
    assert carton["location"] == "BK-04-01-C"

    r = client.post("/v1/containers/CTN-01/unnest", headers=headers, json=msg())
    assert r.status_code == 202, r.text
    assert client.get("/v1/containers/CTN-01", headers=headers).json()["parent"] is None


def test_a_container_cannot_hold_itself(client, db, structure, headers):
    make(client, headers, container_id="PAL-01", type="pallet")
    r = client.post("/v1/containers/PAL-01/nest", headers=headers, json=msg(parent="PAL-01"))
    assert r.status_code == 422
    assert "itself" in r.json()["errors"][0]["message"]


def test_a_loop_is_refused_even_if_the_types_would_allow_it(client, db, structure, headers):
    """The type rules make a loop impossible today. This guards the day they change."""
    from wms.services.containers import CAN_HOLD, nest
    from wms.services.stock import RuleError

    make(client, headers, container_id="PAL-01", type="pallet", location="BK-04-01-C")
    make(client, headers, container_id="PAL-02", type="pallet")
    outer = db.execute(select(Container).where(Container.container_id == "PAL-01")).scalar_one()
    inner = db.execute(select(Container).where(Container.container_id == "PAL-02")).scalar_one()

    original = CAN_HOLD["pallet"]
    CAN_HOLD["pallet"] = (*original, "pallet")
    try:
        nest(db, inner, outer)
        db.flush()
        with pytest.raises(RuleError, match="already inside"):
            nest(db, outer, inner)
    finally:
        CAN_HOLD["pallet"] = original
        db.rollback()


def test_a_carton_cannot_hold_a_pallet(client, db, structure, headers):
    make(client, headers, container_id="PAL-01", type="pallet")
    make(client, headers, container_id="CTN-01", type="carton")
    r = client.post("/v1/containers/PAL-01/nest", headers=headers, json=msg(parent="CTN-01"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "parent"


# --- what is on it and moving it ----------------------------------------------

def test_a_container_shows_what_is_on_it(client, db, structure, headers):
    s = structure
    make(client, headers, container_id="PAL-01", type="pallet", location="BK-04-01-C")
    stock(db, s, s.abc, s.bk1, "40", container="PAL-01")
    stock(db, s, s.fg, s.bk1, "10", batch="B1", container="PAL-01")
    stock(db, s, s.abc, s.bk1, "5")  # loose on the same shelf, not on the pallet

    got = client.get("/v1/containers/PAL-01", headers=headers).json()
    assert [(c["sku"], c["batch"], c["qty"]) for c in got["contents"]] == [
        ("ABC123", None, "40"), ("FG-900", "B1", "10")]
    assert got["total_qty"] == "50"


def test_moving_a_pallet_moves_everything_on_it(client, db, structure, headers):
    s = structure
    make(client, headers, container_id="PAL-01", type="pallet", location="BK-04-01-C")
    make(client, headers, container_id="CTN-01", type="carton")
    client.post("/v1/containers/CTN-01/nest", headers=headers, json=msg(parent="PAL-01"))
    stock(db, s, s.abc, s.bk1, "40", container="PAL-01")
    stock(db, s, s.fg, s.bk1, "6", batch="B1", container="CTN-01")

    r = client.post("/v1/containers/PAL-01/move", headers=headers, json=msg(
        to_location="BK-04-02-A", reason="tidy", operator="op-017"))
    assert r.status_code == 202, r.text
    assert r.json()["moved"] == "46"

    assert client.get("/v1/containers/PAL-01", headers=headers).json()["location"] == "BK-04-02-A"
    assert client.get("/v1/containers/CTN-01", headers=headers).json()["location"] == "BK-04-02-A"
    at_old = client.get("/v1/locations/BK-04-01-C/stock", headers=headers,
                        params={"warehouse": "BAL-WH01"}).json()["stock"]
    assert at_old == []
    at_new = {(x["sku"], x["batch"]): x["on_hand"] for x in client.get(
        "/v1/locations/BK-04-02-A/stock", headers=headers,
        params={"warehouse": "BAL-WH01"}).json()["stock"]}
    assert at_new == {("ABC123", None): "40", ("FG-900", "B1"): "6"}

    rows = db.execute(select(StockLedger).where(StockLedger.movement_type == "move")
                      .order_by(StockLedger.id)).scalars().all()
    assert {r.container_id for r in rows} == {"PAL-01", "CTN-01"}
    assert len(rows) == 4  # two products, out and in


def test_moving_an_empty_container_just_moves_the_label(client, db, structure, headers):
    make(client, headers, container_id="TOTE-01", type="tote", location="PACK-01")
    r = client.post("/v1/containers/TOTE-01/move", headers=headers, json=msg(
        to_location="BK-04-01-C", operator="op-017"))
    assert r.status_code == 202, r.text
    assert r.json()["moved"] == "0"
    assert client.get("/v1/containers/TOTE-01", headers=headers).json()["location"] == "BK-04-01-C"


def test_a_closed_pallet_is_not_added_to(client, db, structure, headers):
    make(client, headers, container_id="PAL-01", type="pallet", location="BK-04-01-C")
    make(client, headers, container_id="CTN-01", type="carton")
    r = client.post("/v1/containers/PAL-01/close", headers=headers, json=msg())
    assert r.status_code == 202, r.text
    assert client.get("/v1/containers/PAL-01", headers=headers).json()["status"] == "closed"
    r = client.post("/v1/containers/CTN-01/nest", headers=headers, json=msg(parent="PAL-01"))
    assert r.status_code == 409
    assert r.json()["code"] == "container_closed"
    assert client.post("/v1/containers/PAL-01/reopen", headers=headers, json=msg()).status_code == 202
    assert client.post("/v1/containers/CTN-01/nest", headers=headers, json=msg(parent="PAL-01")).status_code == 202


def test_a_pallet_label_carries_the_sscc(client, db, structure, headers):
    s = structure
    client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers,
                 json={"gs1_company_prefix": "9312345"})
    ref = make(client, headers, container_id="PAL-01", type="pallet", location="BK-04-01-C",
               assign_sscc=True).json()["wms_id"]
    stock(db, s, s.fg, s.bk1, "120", batch="B2609A", container="PAL-01")

    r = client.post("/v1/print-jobs", headers=headers, json=msg(
        warehouse="BAL-WH01", template="pallet-label", printer="Forklift",
        reference={"type": "container", "ref": ref}))
    assert r.status_code == 202, r.text
    from wms.models import PrintJob
    job = db.execute(select(PrintJob).order_by(PrintJob.id.desc())).scalars().first()
    assert job.data["sscc"] == client.get(f"/v1/containers/{ref}", headers=headers).json()["sscc"]
    assert job.data["location"] == "BK-04-01-C"
    assert job.data["lines"] == [{"sku": "FG-900", "batch": "B2609A", "qty": "120", "uom": "EA"}]


def test_containers_are_listed_and_filtered(client, db, structure, headers):
    make(client, headers, container_id="PAL-01", type="pallet", location="BK-04-01-C")
    make(client, headers, container_id="CTN-01", type="carton")
    client.post("/v1/containers/CTN-01/nest", headers=headers, json=msg(parent="PAL-01"))
    make(client, headers, container_id="TOTE-01", type="tote", location="PACK-01")

    page = client.get("/v1/containers", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert page["total"] == 3
    pallets = client.get("/v1/containers", headers=headers,
                         params={"warehouse": "BAL-WH01", "type": "pallet"}).json()
    assert [c["container_id"] for c in pallets["items"]] == ["PAL-01"]
    top = client.get("/v1/containers", headers=headers,
                     params={"warehouse": "BAL-WH01", "nested": "false"}).json()
    assert {c["container_id"] for c in top["items"]} == {"PAL-01", "TOTE-01"}
