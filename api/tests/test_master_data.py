import uuid


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def test_product_create_then_update_by_sku(client, headers):
    r = client.post("/v1/products", headers=headers, json=msg(
        sku="ABC123", name="Widget", uom="EA", decimals_allowed=False,
        batch_tracked=False, preferred_zone="PICKFACE",
        barcodes=[{"barcode": "09312345000012", "kind": "gtin"}],
    ))
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "created"

    r = client.post("/v1/products", headers=headers, json=msg(
        sku="ABC123", name="Widget mk2", uom="EA",
        barcodes=[{"barcode": "09312345000012", "kind": "gtin"},
                  {"barcode": "19312345000019", "kind": "carton", "qty_per": 12}],
    ))
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "updated"

    p = client.get("/v1/products/ABC123", headers=headers).json()
    assert p["name"] == "Widget mk2"
    assert p["preferred_zone"] == "PICKFACE"
    assert {b["barcode"] for b in p["barcodes"]} == {"09312345000012", "19312345000019"}

    listing = client.get("/v1/products", headers=headers).json()
    assert [x["sku"] for x in listing["items"]] == ["ABC123"]


def test_structure_and_locations(client, headers):
    assert client.post("/v1/sites", headers=headers,
                       json=msg(code="BAL", name="Ballarat")).status_code == 202
    assert client.post("/v1/warehouses", headers=headers,
                       json=msg(code="BAL-WH01", site="BAL", name="Ballarat 1")).status_code == 202
    assert client.post("/v1/zones", headers=headers,
                       json=msg(warehouse="BAL-WH01", code="BULK", name="Bulk", kind="bulk")).status_code == 202

    r = client.post("/v1/locations", headers=headers, json=msg(
        warehouse="BAL-WH01", code="BK-04-01-C", zone="BULK", type="shelf",
        access="ground", mixing="mixed", capacity=2, capacity_uom="PALLET",
        pick_sequence=410, barcode="LOC-BK-04-01-C",
    ))
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "created"

    r = client.post("/v1/locations", headers=headers, json=msg(
        warehouse="BAL-WH01", code="BK-04-01-C", zone="BULK", pick_sequence=411))
    assert r.json()["status"] == "updated"

    listing = client.get("/v1/locations", headers=headers,
                         params={"warehouse": "BAL-WH01"}).json()
    assert len(listing["items"]) == 1
    loc = listing["items"][0]
    assert loc["code"] == "BK-04-01-C"
    assert loc["zone"] == "BULK"
    assert loc["pick_sequence"] == 411
    assert loc["barcode"] == "LOC-BK-04-01-C"


def test_location_in_unknown_warehouse_is_a_422(client, headers):
    r = client.post("/v1/locations", headers=headers, json=msg(
        warehouse="NOPE", code="X", zone="BULK"))
    assert r.status_code == 422
    assert any(e["field"] == "warehouse" for e in r.json()["errors"])


def test_key_scoped_to_another_warehouse_is_forbidden(client, db, headers):
    from wms.services.access import create_api_client

    client.post("/v1/sites", headers=headers, json=msg(code="BAL", name="Ballarat"))
    client.post("/v1/warehouses", headers=headers,
                json=msg(code="BAL-WH01", site="BAL", name="Ballarat 1"))
    _, raw = create_api_client(db, name="mel-only", scopes=["*"],
                               warehouses=["MEL-WH01"], owner="DEFAULT")
    db.commit()
    r = client.post("/v1/zones", headers={"Authorization": f"Bearer {raw}"},
                    json=msg(warehouse="BAL-WH01", code="BULK", name="Bulk", kind="bulk"))
    assert r.status_code == 403


def test_a_warehouse_carries_its_sites_timezone(client, headers):
    """A reader in Melbourne looking at Perth stock has to be shown Perth's
    clock, so the warehouse has to say which clock that is."""
    client.post("/v1/sites", headers=headers,
                json=msg(code="PER", name="Perth", timezone="Australia/Perth"))
    client.post("/v1/warehouses", headers=headers,
                json=msg(code="PER-WH01", site="PER", name="Perth 1"))

    r = client.get("/v1/warehouses", headers=headers)
    assert r.status_code == 200, r.text
    by_code = {w["code"]: w for w in r.json()["items"]}
    assert by_code["PER-WH01"]["timezone"] == "Australia/Perth"

    client.post("/v1/sites", headers=headers, json=msg(code="BAL", name="Ballarat"))
    client.post("/v1/warehouses", headers=headers,
                json=msg(code="BAL-WH01", site="BAL", name="Ballarat 1"))
    again = {w["code"]: w for w in client.get("/v1/warehouses", headers=headers).json()["items"]}
    assert again["BAL-WH01"]["timezone"] == "Australia/Melbourne"
