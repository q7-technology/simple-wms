"""Drains the outbound_event queue with backoff. Run as `python -m wms.worker`.

Backoff after a failed delivery: 1 min, 5 min, 30 min, 2 h. After the last
try the row is marked `failed` and waits for "retry now" on the Integrations
page (status back to pending, attempts to 0).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from wms.config import get_settings
from wms.db import get_sessionmaker
from wms.models import InboundMessage, OutboundEvent, Subscriber
from wms.services import sap

log = logging.getLogger("wms.worker")

BACKOFF = (60, 300, 1800, 7200)


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def deliver(http: httpx.Client, row: OutboundEvent, now: datetime,
            connect: Callable[[Subscriber], object] | None = None) -> None:
    """Hand one event to its subscriber, however that subscriber is reached.
    A refusal is a refusal whether it came back as an HTTP status or as a
    row in a BAPI return table, and it backs off the same way."""
    if row.subscriber.transport == sap.TRANSPORT:
        _deliver_to_sap(row, now, connect or sap.connect)
        return
    body = json.dumps(row.payload, separators=(",", ":")).encode()
    headers = {
        "Content-Type": "application/json",
        "X-WMS-Signature": sign(row.subscriber.secret, body),
        "X-WMS-Event-Id": str(row.event_id),
        "X-WMS-Event-Type": row.event_type,
        "User-Agent": "simple-wms/0.1",
    }
    error = None
    try:
        resp = http.post(row.subscriber.url, content=body, headers=headers,
                         timeout=get_settings().worker_http_timeout_seconds)
        if not 200 <= resp.status_code < 300:
            error = f"HTTP {resp.status_code}: {resp.text[:200]}"
    except httpx.HTTPError as exc:
        error = f"{type(exc).__name__}: {exc}"[:500]

    row.attempts += 1
    if error is None:
        row.status = "delivered"
        row.delivered_at = now
        row.last_error = None
        return
    _retry_later(row, now, error)


def _deliver_to_sap(row: OutboundEvent, now: datetime,
                    connect: Callable[[Subscriber], object]) -> None:
    row.attempts += 1
    try:
        document = sap.deliver(row, connect(row.subscriber))
    except sap.Unmapped as exc:
        # Four goes at a mapping that does not exist is just noise. Fail it
        # now and let somebody see it on the Integrations page.
        row.status = "failed"
        row.last_error = str(exc)[:500]
        log.warning("event %s to %s has no SAP mapping: %s", row.event_id, row.subscriber.name, exc)
        return
    except sap.SapError as exc:
        _retry_later(row, now, str(exc)[:500])
        return
    row.status = "delivered"
    row.delivered_at = now
    row.last_error = None
    log.info("event %s posted to SAP by %s as document %s",
             row.event_id, row.subscriber.name, document or "(none)")


def _retry_later(row: OutboundEvent, now: datetime, error: str) -> None:
    row.last_error = error
    if row.attempts >= len(BACKOFF):
        row.status = "failed"
        log.warning("event %s to %s failed for good: %s", row.event_id, row.subscriber.name, error)
    else:
        row.next_attempt_at = now + timedelta(seconds=BACKOFF[row.attempts - 1])
        log.info("event %s to %s attempt %d failed, next at %s: %s",
                 row.event_id, row.subscriber.name, row.attempts, row.next_attempt_at, error)


def run_once(session: Session, http: httpx.Client, now: datetime | None = None,
             limit: int = 50, connect: Callable[[Subscriber], object] | None = None) -> int:
    """Deliver every due event. Returns how many were attempted."""
    now = now or datetime.now(UTC)
    rows = session.execute(
        select(OutboundEvent)
        .where(OutboundEvent.status == "pending", OutboundEvent.next_attempt_at <= now)
        .order_by(OutboundEvent.next_attempt_at, OutboundEvent.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).scalars().all()
    for row in rows:
        deliver(http, row, now, connect)
        session.commit()
    return len(rows)


def send_print_jobs(session: Session, http: httpx.Client, now: datetime | None = None,
                    limit: int = 50) -> int:
    """Hand due print jobs to Platen. The WMS renders nothing: it sends the
    template name, version, printer, copies and the JSON. Platen answers
    `accepted`, then tells us `printed` or `failed` on its own."""
    from wms.models import PrintJob, Warehouse
    from wms.services.settings import effective

    now = now or datetime.now(UTC)
    rows = session.execute(
        select(PrintJob)
        .where(PrintJob.status == "pending", PrintJob.next_attempt_at <= now)
        .order_by(PrintJob.next_attempt_at, PrintJob.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).scalars().all()

    sent = 0
    for job in rows:
        wh = session.get(Warehouse, job.warehouse_id) if job.warehouse_id else None
        url = effective(wh.settings if wh else None)["platen_url"]
        if not url:
            # nowhere to send it yet; it waits until a Platen URL is set
            continue
        body = json.dumps({
            "job_id": str(job.job_id), "template": job.template, "version": job.version,
            "printer": job.printer, "copies": job.copies, "reference": job.reference,
            "data": job.data,
        }, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "X-WMS-Job-Id": str(job.job_id),
                   "X-WMS-Template": f"{job.template}/{job.version}", "User-Agent": "simple-wms/0.1"}
        error = None
        try:
            resp = http.post(url, content=body, headers=headers,
                             timeout=get_settings().worker_http_timeout_seconds)
            if not 200 <= resp.status_code < 300:
                error = f"HTTP {resp.status_code}: {resp.text[:200]}"
        except httpx.HTTPError as exc:
            error = f"{type(exc).__name__}: {exc}"[:500]

        job.attempts += 1
        sent += 1
        if error is None:
            job.status = "accepted"
            job.sent_at = now
            job.last_error = None
            log.info("print job %s (%s) accepted by %s", job.job_id, job.template, url)
        else:
            job.last_error = error
            if job.attempts >= len(BACKOFF):
                job.status = "failed"
                log.warning("print job %s failed for good: %s", job.job_id, error)
            else:
                job.next_attempt_at = now + timedelta(seconds=BACKOFF[job.attempts - 1])
                log.info("print job %s attempt %d failed, next at %s: %s",
                         job.job_id, job.attempts, job.next_attempt_at, error)
        session.commit()
    return sent


def purge_inbound_messages(session: Session, now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(hours=get_settings().message_ttl_hours)
    result = session.execute(delete(InboundMessage).where(InboundMessage.received_at < cutoff))
    session.commit()
    return result.rowcount


def wait_for_schema(session: Session, timeout: float = 120, poll: float = 2) -> bool:
    """Block until the api container has run the migrations."""
    from sqlalchemy.exc import ProgrammingError

    deadline = time.monotonic() + timeout
    while True:
        try:
            session.execute(select(OutboundEvent.id).limit(1))
            return True
        except ProgrammingError:
            session.rollback()
            if time.monotonic() >= deadline:
                raise TimeoutError("outbound_event table never appeared; did the migrations run?")
            log.info("waiting for migrations")
            time.sleep(poll)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    make_session = get_sessionmaker()
    with make_session() as session:
        wait_for_schema(session)
    log.info("worker started, polling events and print jobs every %ss", settings.worker_poll_seconds)
    last_purge = 0.0
    with httpx.Client() as http:
        while True:
            try:
                with make_session() as session:
                    done = run_once(session, http) + send_print_jobs(session, http)
                    if time.monotonic() - last_purge > 3600:
                        purged = purge_inbound_messages(session)
                        last_purge = time.monotonic()
                        if purged:
                            log.info("purged %d inbound messages past the dedup window", purged)
            except Exception:  # keep the loop alive; log and back off
                log.exception("worker loop error")
                done = 0
            if done == 0:
                time.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
