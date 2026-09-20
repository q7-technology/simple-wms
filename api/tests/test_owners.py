"""Step 6b: more than one owner, for a third-party warehouse."""
import uuid
from decimal import Decimal

from sqlalchemy import select

from wms.models import Owner, Product
from wms.services.ledger import LedgerLine, post


def msg(**body):
    return {"message_id": str(uuid.uuid4()), **body}


def make_owner(client, headers, code="ACME", name="Acme Auto Parts", **extra):
    return client.post("/v1/owners", headers=headers, json={"code": code, "name": name, **extra})


def stock(db, s, product, location, qty, owner="DEFAULT", batch=None):
    post(db, [LedgerLine(product_id=product.id, location_id=location.id, qty_change=Decimal(qty),
                         uom=product.uom, batch=batch, owner=owner, movement_type="receipt",
                         actor="jo", received_at=s.received)])
    db.commit()


# --- the register -----------------------------------------------------------

def test_the_default_owner_is_there_from_the_start(client, db, headers):
    rows = db.execute(select(Owner)).scalars().all()
    assert [o.code for o in rows] == ["DEFAULT"]
    listing = client.get("/v1/owners", headers=headers).json()
    assert listing["items"][0]["code"] == "DEFAULT"
    assert listing["items"][0]["active"] is True


def test_owners_are_created_updated_and_deactivated(client, db, headers):
    r = make_owner(client, headers, contact="Jo Smith", email="jo@acme.example",
                   note="3PL customer since 2026")
    assert r.status_code == 201, r.text
    assert r.json()["code"] == "ACME"

    r = make_owner(client, headers, name="Acme Auto Parts Pty Ltd")
    assert r.status_code == 200
    assert r.json()["name"] == "Acme Auto Parts Pty Ltd"

    listing = client.get("/v1/owners", headers=headers).json()
    assert [o["code"] for o in listing["items"]] == ["ACME", "DEFAULT"]

    r = client.post("/v1/owners/ACME/deactivate", headers=headers, json={})
    assert r.status_code == 200
    assert r.json()["active"] is False
    # deactivated, never deleted
    assert client.get("/v1/owners", headers=headers).json()["total"] == 2


def test_the_default_owner_cannot_be_switched_off(client, db, headers):
    r = client.post("/v1/owners/DEFAULT/deactivate", headers=headers, json={})
    assert r.status_code == 422
    assert "DEFAULT" in r.json()["errors"][0]["message"]


# --- owners on the way in ------------------------------------------------------

def test_an_unknown_owner_is_refused(client, db, structure, headers):
    r = client.post("/v1/products", headers=headers, json=msg(
        owner="NOBODY", sku="X1", name="Mystery", uom="EA"))
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "owner"
    assert "NOBODY" in r.json()["errors"][0]["message"]


def test_a_deactivated_owner_is_refused(client, db, structure, headers):
    make_owner(client, headers)
    client.post("/v1/owners/ACME/deactivate", headers=headers, json={})
    r = client.post("/v1/products", headers=headers, json=msg(
        owner="ACME", sku="X1", name="Mystery", uom="EA"))
    assert r.status_code == 422
    assert "not active" in r.json()["errors"][0]["message"]


def test_two_owners_keep_their_stock_apart_on_the_same_shelf(client, db, structure, headers):
    make_owner(client, headers)
    s = structure
    client.post("/v1/products", headers=headers, json=msg(
        owner="ACME", sku="ABC123", name="Acme brake pad", uom="EA"))
    acme = db.execute(select(Product).where(Product.owner == "ACME", Product.sku == "ABC123")).scalar_one()

    stock(db, s, s.abc, s.bk1, "40", owner="DEFAULT")
    stock(db, s, acme, s.bk1, "25", owner="ACME")

    ours = client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "owner": "DEFAULT"}).json()
    theirs = client.get("/v1/stock", headers=headers, params={"sku": "ABC123", "owner": "ACME"}).json()
    assert ours["total_on_hand"] == "40"
    assert theirs["total_on_hand"] == "25"

    shelf = client.get("/v1/locations/BK-04-01-C/stock", headers=headers,
                       params={"warehouse": "BAL-WH01"}).json()["stock"]
    assert {(x["owner"], x["on_hand"]) for x in shelf} == {("DEFAULT", "40"), ("ACME", "25")}


def test_a_key_for_one_owner_cannot_touch_another(client, db, structure, headers):
    from wms.services.access import create_api_client

    make_owner(client, headers)
    _, raw = create_api_client(db, name="acme", scopes=["*"], warehouses=["*"], owner="ACME")
    db.commit()
    h = {"Authorization": f"Bearer {raw}"}

    assert client.post("/v1/products", headers=h, json=msg(
        owner="ACME", sku="A1", name="Theirs", uom="EA")).status_code == 202
    r = client.post("/v1/products", headers=h, json=msg(
        owner="DEFAULT", sku="A2", name="Ours", uom="EA"))
    assert r.status_code == 403
    assert client.get("/v1/products", headers=h, params={"owner": "DEFAULT"}).status_code == 403
    assert client.get("/v1/products", headers=h, params={"owner": "ACME"}).status_code == 200


def test_a_portal_user_only_sees_their_own_owner(client, db, headers):
    from conftest import login
    from wms.models import User
    from wms.services.access import hash_password

    make_owner(client, headers)
    db.add(User(username="acme-portal", display_name="Acme portal", role="supervisor",
                warehouses=["*"], owner="ACME",
                password_hash=hash_password("a long enough password")))
    db.commit()

    body = login(client, "acme-portal", "a long enough password")
    assert body["user"]["owner"] == "ACME"
    h = {"Authorization": f"Bearer {body['token']}"}
    assert client.get("/v1/auth/me", headers=h).json()["owner"] == "ACME"
    assert client.get("/v1/products", headers=h, params={"owner": "ACME"}).status_code == 200
    assert client.get("/v1/products", headers=h, params={"owner": "DEFAULT"}).status_code == 403


def test_an_ordinary_user_still_sees_every_owner(client, db, headers, user_headers):
    make_owner(client, headers)
    assert client.get("/v1/auth/me", headers=user_headers).json()["owner"] == "*"
    assert client.get("/v1/products", headers=user_headers, params={"owner": "ACME"}).status_code == 200
    assert client.get("/v1/products", headers=user_headers, params={"owner": "DEFAULT"}).status_code == 200


def test_subscribers_can_be_told_apart_by_owner(client, db, structure, headers, listener):
    from wms.models import OutboundEvent, Subscriber

    make_owner(client, headers)
    db.add(Subscriber(name="acme-erp", url=listener.url, secret="s", event_types=["*"], owner="ACME"))
    db.add(Subscriber(name="our-erp", url=listener.url, secret="s", event_types=["*"], owner="DEFAULT"))
    db.commit()

    from wms.services.events import emit
    emit(db, "stock.moved", warehouse="BAL-WH01", owner="ACME", external_ref=None, data={})
    db.commit()
    rows = db.execute(select(OutboundEvent)).scalars().all()
    assert len(rows) == 1
    assert db.get(Subscriber, rows[0].subscriber_id).name == "acme-erp"


def test_multi_owner_is_off_until_it_is_switched_on(client, db, structure, headers):
    got = client.get("/v1/warehouses/BAL-WH01", headers=headers).json()
    assert got["settings"]["multi_owner"] is False
    r = client.patch("/v1/warehouses/BAL-WH01/settings", headers=headers, json={"multi_owner": True})
    assert r.status_code == 200
    assert r.json()["settings"]["multi_owner"] is True
