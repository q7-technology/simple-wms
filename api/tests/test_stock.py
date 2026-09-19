from datetime import date
from decimal import Decimal

from wms.services.ledger import LedgerLine, post


def test_where_is_it(client, db, structure, headers):
    s = structure
    post(db, [
        LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("48"),
                   uom="EA", movement_type="receipt", actor="op-017", received_at=s.received),
        LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("120"),
                   uom="EA", movement_type="receipt", actor="op-017",
                   received_at=date(2026, 9, 3)),
    ])
    db.commit()

    r = client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "warehouse": "BAL-WH01"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sku"] == "ABC123"
    assert body["uom"] == "EA"
    assert Decimal(body["total_on_hand"]) == Decimal("168")
    assert Decimal(body["total_available"]) == Decimal("168")
    # oldest received first (FIFO order)
    assert [x["location"] for x in body["locations"]] == ["PF-01-02-A", "BK-04-01-C"]
    first = body["locations"][0]
    assert first == {
        "warehouse": "BAL-WH01", "location": "PF-01-02-A", "zone": "PICKFACE",
        "batch": None, "owner": "DEFAULT", "on_hand": "48", "reserved": "0",
        "available": "48", "received_at": "2026-08-30",
    }

    r = client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "warehouse": "MEL-WH01"})
    assert r.status_code == 200
    assert r.json()["locations"] == []


def test_what_is_here(client, db, structure, headers):
    s = structure
    post(db, [
        LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("120"),
                   uom="EA", movement_type="receipt", actor="op-017", received_at=s.received),
        LedgerLine(product_id=s.fg.id, location_id=s.bk1.id, qty_change=Decimal("5"),
                   uom="EA", batch="B2609A", movement_type="receipt", actor="op-017",
                   received_at=s.received),
    ])
    db.commit()

    r = client.get(f"/v1/locations/{s.bk1.id}/stock", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["location"] == "BK-04-01-C"
    assert body["warehouse"] == "BAL-WH01"
    assert {(x["sku"], x["batch"], x["on_hand"]) for x in body["stock"]} == {
        ("ABC123", None, "120"), ("FG-900", "B2609A", "5"),
    }

    by_code = client.get("/v1/locations/BK-04-01-C/stock", headers=headers,
                         params={"warehouse": "BAL-WH01", "batch": "B2609A"})
    assert [x["sku"] for x in by_code.json()["stock"]] == ["FG-900"]

    assert client.get("/v1/locations/999999/stock", headers=headers).status_code == 404
