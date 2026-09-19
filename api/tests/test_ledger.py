from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.exc import DBAPIError

from wms.models import StockBalance, StockLedger
from wms.services.ledger import InsufficientStock, LedgerLine, post, rebuild_balances


def snapshot(db):
    rows = db.execute(select(StockBalance)).scalars().all()
    return {
        (r.location_id, r.product_id, r.batch, r.owner): (r.on_hand, r.uom, r.received_at)
        for r in rows
    }


def receive(s, product, location, qty, batch=None, received=None):
    return LedgerLine(
        product_id=product.id,
        location_id=location.id,
        qty_change=Decimal(qty),
        uom=product.uom,
        batch=batch,
        movement_type="receipt",
        actor="op-017",
        received_at=received or s.received,
    )


def test_receipt_creates_ledger_row_and_balance(db, structure):
    s = structure
    rows = post(db, [receive(s, s.abc, s.bk1, "120")])
    db.commit()

    assert len(rows) == 1
    assert rows[0].id is not None
    assert snapshot(db) == {
        (s.bk1.id, s.abc.id, None, "DEFAULT"): (Decimal("120"), "EA", s.received)
    }


def test_balances_rebuild_exactly_from_the_ledger(db, structure):
    s = structure
    post(db, [receive(s, s.abc, s.bk1, "120")])
    post(db, [receive(s, s.abc, s.bk1, "30.5", received=date(2026, 9, 2))])
    post(db, [receive(s, s.fg, s.bk2, "500", batch="B2609A")])
    # move 48 from bulk to the pick face: two rows, one per location
    post(db, [
        LedgerLine(product_id=s.abc.id, location_id=s.bk1.id, qty_change=Decimal("-48"),
                   uom="EA", movement_type="move", actor="op-017", received_at=s.received),
        LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("48"),
                   uom="EA", movement_type="move", actor="op-017", received_at=s.received),
    ])
    # count variance on the pick face
    post(db, [LedgerLine(product_id=s.abc.id, location_id=s.pf.id, qty_change=Decimal("-2"),
                         uom="EA", movement_type="adjustment", reason="count_variance",
                         actor="op-017", received_at=s.received)])
    db.commit()

    before = snapshot(db)
    assert before == {
        (s.bk1.id, s.abc.id, None, "DEFAULT"): (Decimal("102.5"), "EA", s.received),
        (s.pf.id, s.abc.id, None, "DEFAULT"): (Decimal("46"), "EA", s.received),
        (s.bk2.id, s.fg.id, "B2609A", "DEFAULT"): (Decimal("500"), "EA", s.received),
    }

    # Corrupt the materialised table, then prove the ledger alone restores it.
    db.execute(update(StockBalance).values(on_hand=Decimal("999")))
    db.execute(delete(StockBalance).where(StockBalance.location_id == s.bk2.id))
    db.commit()
    assert snapshot(db) != before

    rebuild_balances(db)
    db.commit()
    assert snapshot(db) == before


def test_stock_cannot_go_negative(db, structure):
    s = structure
    post(db, [receive(s, s.abc, s.bk1, "10")])
    with pytest.raises(InsufficientStock):
        post(db, [LedgerLine(product_id=s.abc.id, location_id=s.bk1.id,
                             qty_change=Decimal("-10.001"), uom="EA",
                             movement_type="move", actor="op-017", received_at=s.received)])


def test_ledger_rows_cannot_be_updated(db, structure):
    s = structure
    post(db, [receive(s, s.abc, s.bk1, "10")])
    db.commit()
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(update(StockLedger).values(qty_change=Decimal("11")))
        db.commit()


def test_ledger_rows_cannot_be_deleted(db, structure):
    s = structure
    post(db, [receive(s, s.abc, s.bk1, "10")])
    db.commit()
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(delete(StockLedger))
        db.commit()
