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
