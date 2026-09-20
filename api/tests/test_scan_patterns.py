"""The parser's third rung: patterns a site writes for its own labels."""
import uuid

from sqlalchemy import select

from wms.models import AuditLog, ScanPattern


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def make(client, headers, **body):
    return client.post("/v1/scan-patterns", headers=headers, json={
        "warehouse": "BAL-WH01", "name": "Supplier Co carton",
        "pattern": r"^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>\d+)$",
        "type": "product", **body})


def parse(client, headers, raw, **extra):
    r = client.post("/v1/scans/parse", headers=headers,
                    json={"raw": raw, "warehouse": "BAL-WH01", **extra})
    assert r.status_code == 200, r.text
    return r.json()


# --- writing one ---------------------------------------------------------------

def test_a_pattern_is_written_and_listed(client, db, structure, headers):
    r = make(client, headers)
    assert r.status_code == 201, r.text
    got = r.json()
    assert got["name"] == "Supplier Co carton"
    assert got["type"] == "product"
    assert got["fields"] == ["sku", "batch", "qty"]
    assert got["active"] is True

    listing = client.get("/v1/scan-patterns", headers=headers,
                         params={"warehouse": "BAL-WH01"}).json()
    assert listing["total"] == 1


def test_a_pattern_that_will_not_compile_is_refused(client, db, structure, headers):
    r = make(client, headers, pattern="^SUP(?P<sku>[A-Z")
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "pattern"


def test_a_pattern_with_no_named_fields_is_refused(client, db, structure, headers):
    r = make(client, headers, pattern="^SUP[0-9]+$")
    assert r.status_code == 422
    assert "named" in r.json()["errors"][0]["message"]


def test_a_pattern_naming_something_the_wms_does_not_use_is_refused(client, db, structure, headers):
    r = make(client, headers, pattern=r"^X(?P<colour>[a-z]+)$")
    assert r.status_code == 422
    assert "colour" in r.json()["errors"][0]["message"]


def test_a_pattern_can_be_tried_before_it_is_saved(client, db, structure, headers):
    r = client.post("/v1/scan-patterns/try", headers=headers, json={
        "pattern": r"^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>\d+)$",
        "raw": "SUPABC123-B2601-24"})
    assert r.status_code == 200, r.text
    assert r.json() == {"matches": True, "fields": {"sku": "ABC123", "batch": "B2601", "qty": "24"}}

    r = client.post("/v1/scan-patterns/try", headers=headers, json={
        "pattern": r"^SUP(?P<sku>[A-Z0-9]+)$", "raw": "nope"})
    assert r.json() == {"matches": False, "fields": {}}


# --- using one ------------------------------------------------------------------

def test_a_custom_pattern_fills_product_batch_and_quantity(client, db, structure, headers):
    make(client, headers)
    got = parse(client, headers, "SUPABC123-B2601-24", expecting="product")
    assert got["format"] == "custom"
    assert got["type"] == "product"
    assert got["fields"] == {"sku": "ABC123", "batch": "B2601", "qty": "24"}
    assert got["resolved"]["sku"] == "ABC123"
    assert got["resolved"]["batch"] == "B2601"
    assert got["resolved"]["qty"] == "24"
    assert got["matches_expected"] is True
    assert got["pattern"] == "Supplier Co carton"


def test_gs1_still_wins_over_a_custom_pattern(client, db, structure, headers):
    """The order in the brief is GS1, then JSON, then custom, then plain."""
    make(client, headers, name="greedy", pattern=r"^(?P<sku>.+)$")
    got = parse(client, headers, "]Q3010931234500001210B2609A\u001d37120")
    assert got["format"] == "gs1"


def test_a_custom_pattern_beats_the_plain_lookup(client, db, structure, headers):
    make(client, headers, name="shelf code", type="location",
         pattern=r"^BAY(?P<location>[A-Z0-9-]+)$")
    structure.bk1.barcode = "BAYBK-04-01-C"
    db.commit()
    got = parse(client, headers, "BAYBK-04-01-C")
    assert got["format"] == "custom"
    assert got["type"] == "location"
    assert got["resolved"]["location"] == "BK-04-01-C"


def test_a_pattern_for_another_warehouse_is_not_tried(client, db, structure, headers):
    client.post("/v1/sites", headers=headers, json=msg(code="MEL", name="Melbourne"))
    client.post("/v1/warehouses", headers=headers, json=msg(code="MEL-WH01", site="MEL", name="Mel"))
    make(client, headers, warehouse="MEL-WH01")
    assert parse(client, headers, "SUPABC123-B2601-24")["type"] == "unknown"


def test_a_pattern_with_no_warehouse_is_tried_everywhere(client, db, structure, headers):
    r = make(client, headers, warehouse=None)
    assert r.status_code == 201, r.text
    assert parse(client, headers, "SUPABC123-B2601-24")["format"] == "custom"


def test_patterns_are_tried_in_the_order_they_are_given(client, db, structure, headers):
    make(client, headers, name="second", order=20, pattern=r"^SUP(?P<sku>[A-Z0-9-]+)$")
    make(client, headers, name="first", order=10,
         pattern=r"^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>\d+)$")
    got = parse(client, headers, "SUPABC123-B2601-24")
    assert got["pattern"] == "first"
    assert got["fields"]["batch"] == "B2601"


def test_a_pattern_that_is_off_is_not_tried(client, db, structure, headers):
    ref = make(client, headers).json()["wms_id"]
    r = client.post(f"/v1/scan-patterns/{ref}/deactivate", headers=headers, json={})
    assert r.status_code == 200
    assert parse(client, headers, "SUPABC123-B2601-24")["type"] == "unknown"


def test_a_pattern_naming_a_sku_that_is_not_there_says_so(client, db, structure, headers):
    make(client, headers)
    got = parse(client, headers, "SUPNOPE-B2601-24")
    assert got["format"] == "custom"
    assert got["resolved"] is None
    assert "NOPE" in got["message"]


# --- where new patterns come from ---------------------------------------------------

def test_unknown_scans_are_offered_back_so_a_pattern_can_be_written(client, db, structure, headers):
    for raw in ("SUPABC123-B2601-24", "SUPABC123-B2601-24", "WHAT-IS-THIS"):
        parse(client, headers, raw)
    r = client.get("/v1/scan-patterns/unknown", headers=headers,
                   params={"warehouse": "BAL-WH01"})
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert [(x["raw"], x["seen"]) for x in rows] == [
        ("SUPABC123-B2601-24", 2), ("WHAT-IS-THIS", 1)]
    assert rows[0]["last_seen_at"]
    # and once a pattern covers them, they stop turning up
    make(client, headers)
    parse(client, headers, "SUPABC123-B2601-24")
    assert db.execute(select(AuditLog).where(AuditLog.action == "scan.unknown")).scalars().all()


def test_writing_a_pattern_is_audited(client, db, structure, headers):
    make(client, headers)
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "scan_pattern.created" in actions


def test_patterns_need_their_scope(client, db, structure):
    from wms.services.access import create_api_client

    _, raw = create_api_client(db, name="ro", scopes=["stock:read"], warehouses=["*"], owner="DEFAULT")
    db.commit()
    h = {"Authorization": f"Bearer {raw}"}
    assert client.get("/v1/scan-patterns", headers=h,
                      params={"warehouse": "BAL-WH01"}).status_code == 200
    assert make(client, h).status_code == 403
