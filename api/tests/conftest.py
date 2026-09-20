import os
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://wms:wms-dev@127.0.0.1:5433/wms_test"
)
os.environ["WMS_DATABASE_URL"] = TEST_DATABASE_URL
os.environ["WMS_SECRET_KEY"] = "test-secret-key-that-is-long-enough-for-tests"
os.environ["WMS_MESSAGE_TTL_HOURS"] = "24"


def _ensure_database():
    admin_url = TEST_DATABASE_URL.rsplit("/", 1)[0] + "/postgres"
    name = TEST_DATABASE_URL.rsplit("/", 1)[1]
    engine = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with engine.connect() as conn:
        exists = conn.execute(
            text("select 1 from pg_database where datname = :n"), {"n": name}
        ).scalar()
        if not exists:
            conn.execute(text(f'create database "{name}"'))
    engine.dispose()


@pytest.fixture(scope="session")
def engine():
    _ensure_database()
    engine = create_engine(TEST_DATABASE_URL)
    with engine.begin() as conn:
        conn.execute(text("drop schema public cascade"))
        conn.execute(text("create schema public"))
    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", TEST_DATABASE_URL)
    command.upgrade(cfg, "head")
    yield engine
    engine.dispose()


@pytest.fixture
def db(engine):
    from wms.models import Base

    with Session(engine) as session:
        yield session
        session.rollback()
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"truncate {tables} restart identity cascade"))


@pytest.fixture
def structure(db):
    """One site, one warehouse, two zones, three locations, two products."""
    from wms.models import Location, Product, ProductBarcode, Site, Warehouse, Zone

    site = Site(code="BAL", name="Ballarat")
    wh = Warehouse(site=site, code="BAL-WH01", name="Ballarat 1")
    bulk = Zone(warehouse=wh, code="BULK", name="Bulk", kind="bulk")
    pick = Zone(warehouse=wh, code="PICKFACE", name="Pick face", kind="pickface")
    locs = [
        Location(warehouse=wh, zone=bulk, code="BK-04-01-C", pick_sequence=410),
        Location(warehouse=wh, zone=bulk, code="BK-04-02-A", pick_sequence=420),
        Location(warehouse=wh, zone=pick, code="PF-01-02-A", pick_sequence=120),
    ]
    abc = Product(sku="ABC123", name="Widget", uom="EA")
    abc.barcodes.append(ProductBarcode(barcode="09312345000012", kind="gtin"))
    fg = Product(sku="FG-900", name="Finished good", uom="EA", batch_tracked=True)
    db.add_all([site, wh, bulk, pick, *locs, abc, fg])
    db.commit()
    return SimpleNamespace(
        site=site, warehouse=wh, bulk=bulk, pick=pick,
        bk1=locs[0], bk2=locs[1], pf=locs[2], abc=abc, fg=fg,
        received=date(2026, 8, 30),
    )


@pytest.fixture
def api_key(db):
    from wms.services.access import create_api_client

    _, raw = create_api_client(
        db, name="tests", scopes=["*"], warehouses=["*"], owner="*"
    )
    db.commit()
    return raw


@pytest.fixture
def headers(api_key):
    return {"Authorization": f"Bearer {api_key}"}


@pytest.fixture
def client(engine):
    from fastapi.testclient import TestClient

    from wms.api.app import app

    with TestClient(app) as c:
        yield c


class _Recorder(BaseHTTPRequestHandler):
    queued: list[int] = []
    received: list[dict] = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        self.received.append({"headers": dict(self.headers), "body": body})
        status = self.queued.pop(0) if self.queued else 200
        self.send_response(status)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def listener():
    """A local HTTP listener that answers with the queued status codes."""
    handler = type("Handler", (_Recorder,), {"queued": [], "received": []})
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield SimpleNamespace(
        url=f"http://127.0.0.1:{server.server_port}/hook",
        responses=handler.queued,
        received=handler.received,
    )
    server.shutdown()
    server.server_close()


@pytest.fixture
def admin(db):
    from wms.models import User
    from wms.services.access import hash_password

    user = User(username="leighton", display_name="Leighton L.", role="admin",
                warehouses=["*"], password_hash=hash_password("correct horse"))
    db.add(user)
    db.commit()
    return user


@pytest.fixture
def picker(db):
    from wms.models import User
    from wms.services.access import hash_password

    user = User(username="sam", display_name="Sam K.", role="picker",
                warehouses=["BAL-WH01"], password_hash=hash_password("pick pick"))
    db.add(user)
    db.commit()
    return user


def login(client, username, password):
    r = client.post("/v1/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def user_headers(client, admin):
    return {"Authorization": f"Bearer {login(client, 'leighton', 'correct horse')['token']}"}


@pytest.fixture
def supervisor_badge(db):
    from wms.models import Operator
    from wms.services.access import hash_password

    db.add(Operator(code="op-001", name="Tony S.", pin_hash=hash_password("1234"), badge="0007",
                    roles=["supervisor"], warehouses=["BAL-WH01"]))
    db.commit()
    return "0007"
