"""The demo seed runs end to end through the API and leaves a sound ledger."""
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from wms.demo import SeedError, seed_demo
from wms.models import ApiClient, Receipt, StockBalance, StockLedger, Task
from wms.services.ledger import rebuild_balances


def balances(db):
    return sorted(
        (b.location_id, b.product_id, b.batch, b.owner, b.on_hand, b.reserved)
        for b in db.execute(select(StockBalance)).scalars()
    )


def test_demo_seed_fills_a_day_and_the_ledger_rebuilds(db, client):
    seed_demo()
    db.expire_all()

    statuses = dict(db.execute(select(Receipt.external_ref, Receipt.status)).all())
    assert statuses["PO-88812"] == "complete"
    assert statuses["PO-88815"] == "receiving"
    assert statuses["PO-88816"] == "arrived"
    assert statuses["PO-88817"] == "expected"

    kinds = set(db.execute(select(Task.type, Task.status)).all())
    assert ("pick", "done") in kinds and ("pick", "waiting") in kinds
    assert ("count", "needs_supervisor") in kinds
    assert ("replenish", "waiting") in kinds
    assert ("transfer_receive", "done") in kinds

    # decimals survive the trip
    assert Decimal("250.5") in db.execute(select(StockLedger.qty_change)).scalars().all()

    before = balances(db)
    rebuild_balances(db)
    assert balances(db) == before
    assert db.execute(select(func.count()).select_from(StockLedger)).scalar_one() > 50

    # the key made for the run does not outlive it
    assert db.execute(select(ApiClient.active).where(ApiClient.name == "demo-seed")).scalar_one() is False


def test_demo_seed_refuses_a_database_that_already_has_it(db, client):
    seed_demo()
    with pytest.raises(SeedError):
        seed_demo()
