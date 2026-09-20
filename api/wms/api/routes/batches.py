"""Batches: what a batch code means, and whether it may be sold.

The ledger keeps the batch as a plain string. These endpoints describe that
string. Quarantining one holds the stock where it is and stops it being
promised to anybody; it never moves stock and never writes to the ledger."""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from wms.api import envelope
from wms.api.deps import DB, Principal, require
from wms.api.envelope import Envelope
from wms.api.errors import FieldError, NotFound
from wms.api.routes.inbound import get_product
from wms.api.schemas import Page, Qty
from wms.models import Batch
from wms.services import audit, batches, events
from wms.services.qty import qstr

router = APIRouter(tags=["batches"])


class BatchIn(Envelope):
    sku: str = Field(max_length=64)
    code: str = Field(min_length=1, max_length=64)
    expiry_date: date | None = None
    manufactured_on: date | None = None
    supplier_lot: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)


class HoldIn(Envelope):
    reason: str = Field(min_length=1, max_length=64)
    note: str | None = Field(default=None, max_length=500)


class ReleaseIn(Envelope):
    note: str | None = Field(default=None, max_length=500)


class BatchOut(BaseModel):
    model_config = ConfigDict(ser_json_exclude_none=False)
    wms_id: str
    sku: str
    name: str
    code: str
    expiry_date: date | None
    manufactured_on: date | None
    supplier_lot: str | None
    status: str
    reason: str | None
    note: str | None
    on_hand: Qty
    created_at: datetime
    updated_at: datetime


class BatchReply(envelope.Accepted):
    batch: BatchOut


def batch_out(db, b: Batch) -> BatchOut:
    return BatchOut(
        wms_id=str(b.id), sku=b.product.sku, name=b.product.name, code=b.code,
        expiry_date=b.expiry_date, manufactured_on=b.manufactured_on,
        supplier_lot=b.supplier_lot, status=b.status, reason=b.reason, note=b.note,
        on_hand=qstr(batches.on_hand(db, b.product_id, b.code)),
        created_at=b.created_at, updated_at=b.updated_at,
    )


def _get(db, sku: str, code: str, owner: str = "DEFAULT") -> Batch:
    product = get_product(db, sku, owner, "sku")
    row = batches.find(db, product, code)
    if row is None:
        raise NotFound(f"no batch {code} of {sku}")
    return row


@router.post("/batches", status_code=202, response_model=BatchReply)
def upsert_batch(body: BatchIn, request: Request, db: DB,
                 who: Principal = require("master:write")):
    """Create or update by product and batch code. Fields left out keep their
    value, as everywhere else in the master data."""

    def work():
        product = get_product(db, body.sku, body.owner, "sku")
        row, status = batches.upsert(
            db, product, body.code, expiry_date=body.expiry_date,
            manufactured_on=body.manufactured_on, supplier_lot=body.supplier_lot,
            note=body.note)
        return BatchReply(message_id=body.message_id, wms_id=str(row.id), status=status,
                          batch=batch_out(db, row))

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/batches", response_model=Page[BatchOut])
def list_batches(db: DB, sku: str | None = None, status: str | None = None,
                 expires_before: date | None = None, owner: str = "DEFAULT",
                 limit: int = Query(default=50, le=200), offset: int = 0,
                 who: Principal = require("stock:read")):
    """Earliest expiry first, because that is the one somebody has to act on."""
    if status and status not in batches.STATUSES:
        raise FieldError("status", f"status is one of {', '.join(batches.STATUSES)}")
    product = get_product(db, sku, owner, "sku") if sku else None
    rows, total = batches.listing(db, product=product, status=status,
                                  expires_before=expires_before, limit=limit, offset=offset)
    return Page(items=[batch_out(db, b) for b in rows], total=total)


@router.get("/batches/{sku}/{code}", response_model=BatchOut)
def get_batch(sku: str, code: str, db: DB, owner: str = "DEFAULT",
              who: Principal = require("stock:read")):
    return batch_out(db, _get(db, sku, code, owner))


@router.post("/batches/{sku}/{code}/quarantine", status_code=202, response_model=BatchReply)
def quarantine_batch(sku: str, code: str, body: HoldIn, request: Request, db: DB,
                     who: Principal = require("stock:write")):
    """Hold a batch. The stock stays where it is and the balances do not move;
    it is simply never promised to anyone again until it is released."""

    def work():
        row = _get(db, sku, code, body.owner)
        batches.set_status(db, row, batches.QUARANTINED, reason=body.reason, note=body.note)
        audit.record(db, actor_type=who.kind, actor=who.name, action="batch.quarantine",
                     target_type="batch", target=f"{sku}/{code}",
                     detail={"reason": body.reason, "note": body.note})
        events.emit(db, "batch.quarantined", warehouse=body.warehouse, owner=body.owner,
                    external_ref=body.external_ref,
                    data={"sku": sku, "batch": code, "reason": body.reason, "note": body.note,
                          "on_hand": qstr(batches.on_hand(db, row.product_id, code))})
        return BatchReply(message_id=body.message_id, wms_id=str(row.id), status="accepted",
                          batch=batch_out(db, row))

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.post("/batches/{sku}/{code}/release", status_code=202, response_model=BatchReply)
def release_batch(sku: str, code: str, body: ReleaseIn, request: Request, db: DB,
                  who: Principal = require("stock:write")):
    """Let it be picked again."""

    def work():
        row = _get(db, sku, code, body.owner)
        batches.set_status(db, row, batches.RELEASED, reason=None, note=body.note)
        audit.record(db, actor_type=who.kind, actor=who.name, action="batch.release",
                     target_type="batch", target=f"{sku}/{code}", detail={"note": body.note})
        events.emit(db, "batch.released", warehouse=body.warehouse, owner=body.owner,
                    external_ref=body.external_ref,
                    data={"sku": sku, "batch": code, "note": body.note,
                          "on_hand": qstr(batches.on_hand(db, row.product_id, code))})
        return BatchReply(message_id=body.message_id, wms_id=str(row.id), status="accepted",
                          batch=batch_out(db, row))

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)
