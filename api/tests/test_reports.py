"""Step 6c: every report comes out of the ledger."""
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def move(db, s, product, location, qty, **extra):
    """The ledger is append-only, so history is written with its own `at`,
    never updated afterwards."""
    rows = post(db, [LedgerLine(
        product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
        uom=product.uom, movement_type=extra.pop("movement_type", "receipt"),
        actor=extra.pop("actor", "jo"), owner=extra.pop("owner", "DEFAULT"),
        received_at=s.received, **extra)])
    db.commit()
    return rows[0]


def report(client, headers, name, **params):
    r = client.get(f"/v1/reports/{name}", headers=headers, params=params)
    assert r.status_code == 200, r.text
    return r.json()


# --- stock on hand -----------------------------------------------------------

def test_stock_on_hand_by_location(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.bk1, "120")
    move(db, s, s.abc, s.pf, "48")
    move(db, s, s.fg, s.bk2, "60", batch="B1")

    got = report(client, headers, "stock-on-hand", warehouse="BAL-WH01")
    assert got["report"] == "stock-on-hand"
    assert got["columns"][:4] == ["sku", "name", "warehouse", "zone"]
    rows = {(r["sku"], r["location"]): r for r in got["rows"]}
    assert rows[("ABC123", "BK-04-01-C")]["on_hand"] == "120"
    assert rows[("ABC123", "BK-04-01-C")]["available"] == "120"
    assert rows[("FG-900", "BK-04-02-A")]["batch"] == "B1"
    assert got["totals"]["on_hand"] == "228"
    assert got["totals"]["lines"] == 3


def test_stock_on_hand_grouped_by_product(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.bk1, "120")
    move(db, s, s.abc, s.pf, "48")
    got = report(client, headers, "stock-on-hand", warehouse="BAL-WH01", group_by="product")
    assert got["columns"][0] == "sku"
    assert "location" not in got["columns"]
    row = next(r for r in got["rows"] if r["sku"] == "ABC123")
    assert row["on_hand"] == "168"
    assert row["locations"] == 2


def test_stock_on_hand_as_csv(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.bk1, "120")
    r = client.get("/v1/reports/stock-on-hand", headers=headers,
                   params={"warehouse": "BAL-WH01", "format": "csv"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("sku,name,warehouse,zone,location")
    assert "ABC123" in lines[1] and "120" in lines[1]


# --- movements ---------------------------------------------------------------

def test_movements_by_day_and_type(client, db, structure, headers):
    s = structure
    today = datetime.now(UTC)
    move(db, s, s.abc, s.bk1, "120", at=today - timedelta(days=2))
    move(db, s, s.abc, s.bk1, "-20", movement_type="pick", actor="sam")
    move(db, s, s.abc, s.pf, "20", movement_type="pick", actor="sam")

    got = report(client, headers, "movements", warehouse="BAL-WH01",
                 **{"from": (today - timedelta(days=7)).date().isoformat()})
    assert got["columns"] == ["day", "movement_type", "lines", "qty_in", "qty_out", "net"]
    rows = {(r["day"], r["movement_type"]): r for r in got["rows"]}
    old = (today - timedelta(days=2)).date().isoformat()
    assert rows[(old, "receipt")]["qty_in"] == "120"
    assert rows[(old, "receipt")]["lines"] == 1
    pick = rows[(today.date().isoformat(), "pick")]
    assert pick["lines"] == 2
    assert pick["qty_in"] == "20" and pick["qty_out"] == "20" and pick["net"] == "0"
    assert got["totals"]["lines"] == 3


def test_movements_can_be_narrowed(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.bk1, "120")
    move(db, s, s.fg, s.bk2, "10", batch="B1")
    got = report(client, headers, "movements", warehouse="BAL-WH01", sku="ABC123")
    assert got["totals"]["lines"] == 1
    got = report(client, headers, "movements", warehouse="BAL-WH01", movement_type="pick")
    assert got["rows"] == []
    assert got["totals"]["lines"] == 0


# --- pick rate ----------------------------------------------------------------

def test_pick_rate_per_operator(client, db, structure, headers):
    s = structure
    start = datetime.now(UTC) - timedelta(hours=2)
    move(db, s, s.abc, s.bk1, "200", at=start - timedelta(minutes=1))
    for i in range(4):
        move(db, s, s.abc, s.bk1, "-10", movement_type="pick", actor="sam",
             at=start + timedelta(minutes=30 * i))
    move(db, s, s.abc, s.bk1, "-5", movement_type="pick", actor="jo", at=start)

    got = report(client, headers, "pick-rate", warehouse="BAL-WH01",
                 **{"from": (start - timedelta(days=1)).date().isoformat()})
    assert got["columns"] == ["operator", "lines", "units", "first_at", "last_at",
                              "hours", "lines_per_hour", "units_per_hour"]
    by_op = {r["operator"]: r for r in got["rows"]}
    assert by_op["sam"]["lines"] == 4
    assert by_op["sam"]["units"] == "40"
    assert by_op["sam"]["hours"] == "1.5"
    assert by_op["sam"]["lines_per_hour"] == "2.67"
    # one line in no measurable time still reports something sane
    assert by_op["jo"]["lines"] == 1
    assert by_op["jo"]["hours"] == "0"
    assert by_op["jo"]["lines_per_hour"] is None
    # busiest first
    assert [r["operator"] for r in got["rows"]] == ["sam", "jo"]


# --- variances ----------------------------------------------------------------

def test_variance_history(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.pf, "48")
    move(db, s, s.abc, s.pf, "-2", movement_type="adjustment", reason="count_variance",
         actor="priya", note="two cracked")
    move(db, s, s.fg, s.bk2, "10", batch="B1")
    move(db, s, s.fg, s.bk2, "1", movement_type="adjustment", reason="found", actor="jo", batch="B1")

    got = report(client, headers, "variances", warehouse="BAL-WH01")
    assert got["columns"] == ["at", "location", "zone", "sku", "batch", "qty_change", "uom",
                              "reason", "actor", "note", "ledger_id"]
    assert len(got["rows"]) == 2
    newest = got["rows"][0]
    assert newest["reason"] == "found" and newest["qty_change"] == "1"
    oldest = got["rows"][1]
    assert oldest["sku"] == "ABC123" and oldest["qty_change"] == "-2"
    assert oldest["note"] == "two cracked"
    assert got["totals"] == {"lines": 2, "qty_up": "1", "qty_down": "2", "net": "-1"}

    only = report(client, headers, "variances", warehouse="BAL-WH01", reason="found")
    assert len(only["rows"]) == 1


# --- shipped ------------------------------------------------------------------

def test_shipped_per_day(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.pf, "40")
    client.post("/v1/deliveries", headers=headers, json=msg(
        external_ref="D1", warehouse="BAL-WH01", ship_to={"name": "Acme"},
        lines=[{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]))
    task_id = client.get("/v1/deliveries/D1", headers=headers).json()["task"]["wms_id"]
    client.post(f"/v1/tasks/{task_id}/lines/1/confirm", headers=headers, json=msg(qty=10, uom="EA"))
    client.post("/v1/deliveries/D1/pack", headers=headers, json=msg(
        warehouse="BAL-WH01", complete=True,
        packages=[{"package_no": 1, "type": "carton", "weight_kg": 5,
                   "lines": [{"delivery_line": 10, "sku": "ABC123", "qty": 10, "uom": "EA"}]}]))
    client.post("/v1/deliveries/D1/ship", headers=headers, json=msg(carrier="Toll"))

    got = report(client, headers, "shipped", warehouse="BAL-WH01")
    assert got["columns"] == ["day", "deliveries", "lines", "units", "short", "packages"]
    row = got["rows"][0]
    assert row["day"] == date.today().isoformat()
    assert row["deliveries"] == 1 and row["lines"] == 1
    assert row["units"] == "10" and row["short"] == 0 and row["packages"] == 1
    assert got["totals"]["deliveries"] == 1


# --- the shape they all share --------------------------------------------------

def test_every_report_is_listed_and_shares_one_shape(client, db, structure, headers):
    listing = client.get("/v1/reports", headers=headers).json()
    names = {r["report"] for r in listing["items"]}
    assert names == {"stock-on-hand", "movements", "pick-rate", "variances", "shipped", "billing"}
    for row in listing["items"]:
        assert row["describe"]
        assert isinstance(row["filters"], list)

    for name in sorted(names):
        got = report(client, headers, name, warehouse="BAL-WH01")
        assert got["report"] == name
        assert isinstance(got["columns"], list) and got["columns"]
        assert isinstance(got["rows"], list)
        assert isinstance(got["totals"], dict)
        csv = client.get(f"/v1/reports/{name}", headers=headers,
                         params={"warehouse": "BAL-WH01", "format": "csv"})
        assert csv.status_code == 200
        assert csv.headers["content-type"].startswith("text/csv")


def test_an_unknown_report_is_404(client, db, structure, headers):
    r = client.get("/v1/reports/nope", headers=headers, params={"warehouse": "BAL-WH01"})
    assert r.status_code == 404


def test_reports_need_a_scope(client, db, structure):
    from wms.services.access import create_api_client

    _, raw = create_api_client(db, name="ro", scopes=["tasks:read"], warehouses=["*"], owner="DEFAULT")
    db.commit()
    r = client.get("/v1/reports/movements", headers={"Authorization": f"Bearer {raw}"},
                   params={"warehouse": "BAL-WH01"})
    assert r.status_code == 403


# --- what a third-party warehouse bills for ------------------------------------

def test_billing_counts_what_an_owner_actually_used(client, db, structure, headers):
    """A 3PL bills for movements handled and space held. Both come from the
    ledger, so neither can drift from what happened."""
    s = structure
    client.post("/v1/owners", headers=headers, json={"code": "ACME", "name": "Acme Auto Parts"})
    client.post("/v1/products", headers=headers, json=msg(
        owner="ACME", sku="ACME-1", name="Their widget", uom="EA"))
    from sqlalchemy import select as _select

    from wms.models import Product
    theirs = db.execute(_select(Product).where(Product.owner == "ACME")).scalar_one()

    move(db, s, theirs, s.bk1, "100", owner="ACME", movement_type="receipt")
    move(db, s, theirs, s.bk1, "-20", owner="ACME", movement_type="pick", actor="sam")
    move(db, s, theirs, s.pf, "20", owner="ACME", movement_type="pick", actor="sam")
    move(db, s, s.abc, s.bk2, "50")  # ours, and none of their business

    got = report(client, headers, "billing", owner="ACME", warehouse="BAL-WH01")
    assert got["report"] == "billing"
    assert got["columns"] == ["measure", "detail", "count", "qty", "uom"]
    rows = {r["measure"]: r for r in got["rows"]}
    assert rows["Receipts"]["count"] == 1
    assert rows["Receipts"]["qty"] == "100"
    assert rows["Picks"]["count"] == 2
    assert rows["Picks"]["qty"] == "20"
    assert rows["Locations held"]["count"] == 2
    assert rows["Stock on hand"]["qty"] == "100"
    assert got["totals"]["movements"] == 3
    assert got["totals"]["owner"] == "ACME"


def test_billing_is_per_owner_and_never_leaks(client, db, structure, headers):
    s = structure
    move(db, s, s.abc, s.bk1, "60")
    ours = report(client, headers, "billing", owner="DEFAULT", warehouse="BAL-WH01")
    assert ours["totals"]["movements"] == 1
    client.post("/v1/owners", headers=headers, json={"code": "ACME", "name": "Acme"})
    theirs = report(client, headers, "billing", owner="ACME", warehouse="BAL-WH01")
    assert theirs["totals"]["movements"] == 0
    assert all(r["count"] == 0 for r in theirs["rows"] if r["measure"] != "Stock on hand")


def test_billing_downloads_as_csv_like_the_others(client, db, structure, headers):
    move(db, structure, structure.abc, structure.bk1, "10")
    r = client.get("/v1/reports/billing", headers=headers,
                   params={"warehouse": "BAL-WH01", "format": "csv"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.text.splitlines()[0] == "measure,detail,count,qty,uom"
