"""CSV import with a preview that names the problem rows before anything commits."""
import uuid


def run(client, headers, type, csv, **extra):
    return client.post(f"/v1/imports/{type}", headers=headers, json={
        "message_id": str(uuid.uuid4()), "warehouse": "BAL-WH01", "owner": "DEFAULT", "csv": csv, **extra})


def test_templates_are_downloadable(client, headers):
    r = client.get("/v1/imports/templates/products", headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.text.splitlines()[0] == "sku,name,uom,batch_tracked,decimals_allowed,preferred_zone,pickface_min,pickface_max,barcodes"
    assert client.get("/v1/imports/templates/nope", headers=headers).status_code == 404


def test_products_preview_then_import(client, structure, headers):
    csv = (
        "sku,name,uom,batch_tracked,decimals_allowed,preferred_zone,pickface_min,pickface_max,barcodes\n"
        "NEW-1,New one,EA,yes,no,PICKFACE,10,20,09312345000999|NEW1-CTN6:carton:6\n"
        "NEW-2,Bad qty,EA,no,no,,-1,,\n"
        ",No sku,EA,no,no,,,,\n"
        "ABC123,Widget renamed,EA,no,no,,,,\n"
    )
    r = run(client, headers, "products", csv, dry_run=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows_read"] == 4
    assert body["ready"] == 2
    assert body["problems"] == 2
    assert body["committed"] is False
    # problems first
    assert [p["row"] for p in body["preview"][:2]] == [2, 3]
    assert "pickface_min" in body["preview"][0]["problem"]
    assert body["preview"][2]["problem"] is None
    assert client.get("/v1/products/NEW-1", headers=headers).status_code == 404

    r = run(client, headers, "products", csv, dry_run=False, skip_problems=True)
    assert r.status_code == 200, r.text
    assert r.json()["committed"] is True
    assert r.json()["imported"] == 2
    p = client.get("/v1/products/NEW-1", headers=headers).json()
    assert p["batch_tracked"] is True and p["pickface_min"] == "10"
    assert {(b["barcode"], b["kind"], b["qty_per"]) for b in p["barcodes"]} == {("09312345000999", "gtin", "1"), ("NEW1-CTN6", "carton", "6")}
    assert client.get("/v1/products/ABC123", headers=headers).json()["name"] == "Widget renamed"

    r = run(client, headers, "products", csv, dry_run=False, skip_problems=False)
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "csv"


def test_locations_import(client, structure, headers):
    csv = (
        "code,zone,type,access,mixing,capacity,capacity_uom,pick_sequence,barcode\n"
        "BK-09-01-A,BULK,rack,forklift,mixed,3,PALLET,910,LOC-BK-09-01-A\n"
        "BK-09-01-B,NOZONE,rack,forklift,mixed,,,911,\n"
        "BK-09-01-C,BULK,cupboard,ground,mixed,,,912,\n"
    )
    r = run(client, headers, "locations", csv, dry_run=False, skip_problems=True)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    assert "zone" in r.json()["preview"][0]["problem"]
    assert "type" in r.json()["preview"][1]["problem"]
    listing = client.get("/v1/locations", headers=headers, params={"warehouse": "BAL-WH01"}).json()
    assert "BK-09-01-A" in [l["code"] for l in listing["items"]]


def test_receipts_import_groups_lines_by_reference(client, structure, headers):
    csv = (
        "reference,supplier,expected_at,line,sku,batch,qty,uom\n"
        "PO-1,Supplier Co,2026-09-22,1,ABC123,,120,EA\n"
        "PO-1,Supplier Co,2026-09-22,2,FG-900,B2609A,100,EA\n"
        "PO-2,Other,2026-09-23,1,NOPE,,5,EA\n"
        "PO-3,Other,2026-09-23,1,ABC123,,0,EA\n"
    )
    r = run(client, headers, "receipts", csv, dry_run=True)
    assert r.status_code == 200, r.text
    assert r.json()["problems"] == 2
    assert r.json()["ready"] == 2
    assert r.json()["summary"] == "as 1 receipt"

    r = run(client, headers, "receipts", csv, dry_run=False, skip_problems=True)
    assert r.json()["imported"] == 2
    receipt = client.get("/v1/receipts/PO-1", headers=headers).json()
    assert len(receipt["lines"]) == 2 and receipt["task"]["type"] == "receive"

    # importing again: the reference already exists
    r = run(client, headers, "receipts", csv, dry_run=True)
    assert "already exists" in r.json()["preview"][0]["problem"] or any("already exists" in (p["problem"] or "") for p in r.json()["preview"])


# --- the documents the design's import screen is built around ----------------

def test_deliveries_import_groups_lines_into_orders(client, structure, headers, db):
    from decimal import Decimal

    from wms.services.ledger import LedgerLine, post
    post(db, [LedgerLine(product_id=structure.abc.id, location_id=structure.bk1.id,
                         qty_change=Decimal("100"), uom="EA", movement_type="receipt",
                         actor="jo", received_at=structure.received)])
    db.commit()

    csv = (
        "reference,ship_to_name,address,suburb,state,postcode,required_by,priority,pick_mode,"
        "allow_short,line,sku,batch,qty,uom\n"
        "0080012345,Acme Auto Parts,12 Example St,Geelong,VIC,3220,2026-09-22,normal,single,yes,10,ABC123,,10,EA\n"
        "0080012345,Acme Auto Parts,12 Example St,Geelong,VIC,3220,2026-09-22,normal,single,yes,20,ABC123,,4,EA\n"
        "0080012346,Repco Wendouree,1220 Howitt St,Wendouree,VIC,3355,2026-09-22,high,batch,no,10,NOPE,,5,EA\n"
        "0080012347,Autobarn,,Ballarat,VIC,3350,,normal,single,yes,10,ABC123,,0,EA\n"
    )
    r = run(client, headers, "deliveries", csv, dry_run=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows_read"] == 4
    assert body["problems"] == 2
    assert body["ready"] == 2
    assert body["summary"] == "as 1 delivery"
    # the design's preview says "did you mean ABC123?" on a typo, so we do too
    assert body["preview"][0]["problem"] == "sku: unknown sku NOPE"
    assert any("did you mean ABC123?" in (p["problem"] or "")
               for p in run(client, headers, "deliveries",
                            csv.replace(",NOPE,", ",ABC12,"), dry_run=True).json()["preview"])

    r = run(client, headers, "deliveries", csv, dry_run=False, skip_problems=True)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 2

    got = client.get("/v1/deliveries/0080012345", headers=headers).json()
    assert got["ship_to"] == {"name": "Acme Auto Parts", "address": "12 Example St",
                              "suburb": "Geelong", "state": "VIC", "postcode": "3220"}
    assert got["required_by"] == "2026-09-22"
    assert [(l["delivery_line"], l["qty_ordered"]) for l in got["lines"]] == [(10, "10"), (20, "4")]
    assert got["task"]["type"] == "pick"


def test_replenishments_import(client, structure, headers, db):
    from decimal import Decimal

    from wms.services.ledger import LedgerLine, post
    post(db, [LedgerLine(product_id=structure.abc.id, location_id=structure.bk1.id,
                         qty_change=Decimal("100"), uom="EA", movement_type="receipt",
                         actor="jo", received_at=structure.received)])
    db.commit()

    csv = (
        "reference,priority,line,sku,qty,uom,to_location,from_location,batch\n"
        "REP-1001,high,1,ABC123,48,EA,PF-01-02-A,,\n"
        "REP-1002,normal,1,ABC123,12,EA,NOWHERE,,\n"
    )
    r = run(client, headers, "replenishments", csv, dry_run=False, skip_problems=True)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    assert "to_location" in r.json()["preview"][0]["problem"]
    tasks = client.get("/v1/tasks", headers=headers,
                       params={"warehouse": "BAL-WH01", "type": "replenish"}).json()
    assert [t["source_ref"] for t in tasks["items"]] == ["REP-1001"]
    assert tasks["items"][0]["priority"] == "high"


def test_transfers_import(client, structure, receiver, headers, db):
    from decimal import Decimal

    from wms.services.ledger import LedgerLine, post
    post(db, [LedgerLine(product_id=structure.abc.id, location_id=structure.bk1.id,
                         qty_change=Decimal("100"), uom="EA", movement_type="receipt",
                         actor="jo", received_at=structure.received)])
    db.commit()

    csv = (
        "reference,to_warehouse,required_by,priority,line,sku,batch,qty,uom\n"
        "STO-1,MEL-WH01,2026-09-25,normal,1,ABC123,,12,EA\n"
        "STO-2,NOWHERE,,normal,1,ABC123,,5,EA\n"
    )
    r = run(client, headers, "transfers", csv, dry_run=False, skip_problems=True)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    got = client.get("/v1/transfers/STO-1", headers=headers).json()
    assert got["from_warehouse"] == "BAL-WH01" and got["to_warehouse"] == "MEL-WH01"
    assert got["lines"][0]["qty_requested"] == "12"


def test_every_import_type_has_a_template(client, headers):
    for name in ("products", "locations", "receipts", "deliveries", "replenishments", "transfers"):
        r = client.get(f"/v1/imports/templates/{name}", headers=headers)
        assert r.status_code == 200, f"{name}: {r.text}"
        header, example = r.text.strip().splitlines()[:2]
        assert header.count(",") == example.count(","), f"{name} template does not match its example"
