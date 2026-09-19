import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, text

from wms.models import OutboundEvent, Subscriber
from wms.services.events import emit
from wms.worker import BACKOFF, run_once

T0 = datetime(2026, 9, 19, 4, 12, tzinfo=UTC)


def subscribe(db, url, event_types=("stock.moved",), name="erp"):
    sub = Subscriber(name=name, url=url, secret="s3cret", event_types=list(event_types))
    db.add(sub)
    db.commit()
    return sub


def pending(db):
    return db.execute(select(OutboundEvent)).scalars().all()


def test_emit_queues_one_event_per_matching_subscriber(db, listener):
    subscribe(db, listener.url, ["stock.moved"])
    subscribe(db, listener.url, ["delivery.shipped"], name="carrier")
    emit(db, "stock.moved", warehouse="BAL-WH01", owner="DEFAULT", external_ref=None,
         data={"sku": "ABC123", "qty": "12"}, occurred_at=T0)
    db.commit()
    rows = pending(db)
    assert len(rows) == 1
    assert rows[0].status == "pending"
    assert rows[0].payload["event_type"] == "stock.moved"
    assert rows[0].payload["occurred_at"] == "2026-09-19T04:12:00Z"


def test_delivery_is_signed_and_marked_delivered(db, listener):
    subscribe(db, listener.url)
    emit(db, "stock.moved", warehouse="BAL-WH01", owner="DEFAULT", external_ref="0080012345",
         data={"sku": "ABC123"}, occurred_at=T0)
    db.commit()

    with httpx.Client() as http:
        assert run_once(db, http, now=T0) == 1
    db.commit()

    (row,) = pending(db)
    assert row.status == "delivered"
    assert row.attempts == 1
    assert len(listener.received) == 1
    req = listener.received[0]
    body = req["body"]
    expected = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert req["headers"]["X-WMS-Signature"] == expected
    assert req["headers"]["X-WMS-Event-Id"] == str(row.event_id)
    assert req["headers"]["Content-Type"] == "application/json"
    sent = json.loads(body)
    assert sent["event_type"] == "stock.moved"
    assert sent["external_ref"] == "0080012345"
    assert sent["data"] == {"sku": "ABC123"}


def test_failures_back_off_then_give_up(db, listener):
    subscribe(db, listener.url)
    emit(db, "stock.moved", warehouse="BAL-WH01", owner="DEFAULT", external_ref=None,
         data={}, occurred_at=T0)
    db.commit()
    listener.responses.extend([500, 500, 500, 500])

    now = T0
    with httpx.Client() as http:
        for attempt, delay in enumerate(BACKOFF, start=1):
            assert run_once(db, http, now=now) == 1
            db.commit()
            (row,) = pending(db)
            assert row.attempts == attempt
            if attempt < len(BACKOFF):
                assert row.status == "pending"
                assert row.next_attempt_at == now + timedelta(seconds=delay)
                assert row.last_error.startswith("HTTP 500")
                # not due yet: nothing happens
                assert run_once(db, http, now=now + timedelta(seconds=delay - 1)) == 0
                now = now + timedelta(seconds=delay)
        assert row.status == "failed"

        # "retry now" from the Integrations page
        row.status = "pending"
        row.attempts = 0
        row.next_attempt_at = now
        db.commit()
        assert run_once(db, http, now=now) == 1
        db.commit()
        assert pending(db)[0].status == "delivered"


def test_backoff_schedule_matches_the_contract():
    assert BACKOFF == (60, 300, 1800, 7200)


def test_worker_waits_for_the_schema(db):
    from wms.worker import wait_for_schema

    assert wait_for_schema(db, timeout=0) is True

    db.execute(text("create schema empty_schema"))
    db.commit()
    db.execute(text("set search_path to empty_schema"))
    with pytest.raises(TimeoutError):
        wait_for_schema(db, timeout=0, poll=0)
    db.execute(text("set search_path to public"))
    db.execute(text("drop schema empty_schema cascade"))
    db.commit()
