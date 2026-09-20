"""Print points, print jobs and what Platen tells us afterwards."""
from __future__ import annotations

import uuid as uuidlib
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, NotFound
from wms.api.schemas import Page
from wms.api.routes.inbound import get_warehouse
from wms.models import PrintJob, PrintPoint, Warehouse
from wms.services import audit, printing
from wms.services.printing import TemplateError

router = APIRouter(tags=["printing"])


def _template(name: str):
    try:
        return printing.get(name)
    except TemplateError as e:
        raise FieldError(e.field, e.message) from e


# --- templates -------------------------------------------------------------

class TemplateOut(BaseModel):
    template: str
    version: str
    fields: list[str]
    fires_on: list[str]
    describe: str


@router.get("/print-templates", response_model=Page[TemplateOut])
def list_templates(who: Principal = require("printing:read")):
    """Every document type, its current version and the shape Platen receives."""
    items = [TemplateOut(template=t.name, version=t.version, fields=t.fields,
                         fires_on=t.fires_on, describe=t.describe)
             for t in sorted(printing.TEMPLATES.values(), key=lambda t: t.name)]
    return Page(items=items, total=len(items))


# --- print points ----------------------------------------------------------

class PrintPointIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    warehouse: str | None = Field(default=None, max_length=32)
    event_type: str = Field(min_length=1, max_length=64)
    template: str = Field(min_length=1, max_length=64)
    printer: str = Field(min_length=1, max_length=64)
    copies: int = Field(default=1, ge=0, le=99)
    owner: str = Field(default="*", max_length=32)
    active: bool = True


class PrintPointOut(BaseModel):
    wms_id: str
    warehouse: str | None
    event_type: str
    template: str
    version: str
    printer: str
    copies: int
    owner: str
    active: bool
    created_at: datetime
    updated_at: datetime | None


def point_out(db, p: PrintPoint) -> PrintPointOut:
    wh = db.get(Warehouse, p.warehouse_id) if p.warehouse_id else None
    return PrintPointOut(wms_id=str(p.id), warehouse=wh.code if wh else None, event_type=p.event_type,
                         template=p.template, version=p.version, printer=p.printer, copies=p.copies,
                         owner=p.owner, active=p.active, created_at=p.created_at, updated_at=p.updated_at)


@router.post("/print-points", response_model=PrintPointOut, responses={201: {"model": PrintPointOut}})
def upsert_print_point(body: PrintPointIn, db: DB, who: Principal = require("integration:admin")):
    """Event → template → printer. Create or update by warehouse, event,
    template and printer."""
    from fastapi.responses import JSONResponse

    template = _template(body.template)
    wh = get_warehouse(db, body.warehouse) if body.warehouse else None
    authorise(who, warehouse=body.warehouse, owner=None)
    existing = db.execute(
        select(PrintPoint).where(
            PrintPoint.warehouse_id.is_not_distinct_from(wh.id if wh else None),
            PrintPoint.event_type == body.event_type, PrintPoint.template == body.template,
            PrintPoint.printer == body.printer)
    ).scalar_one_or_none()
    if existing is None:
        point = PrintPoint(warehouse_id=wh.id if wh else None, event_type=body.event_type,
                           template=template.name, version=template.version, printer=body.printer,
                           copies=body.copies, owner=body.owner, active=body.active)
        db.add(point)
        created = True
    else:
        point = existing
        point.version = template.version
        point.copies = body.copies
        point.owner = body.owner
        point.active = body.active
        point.updated_at = datetime.now(UTC)
        created = False
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name,
                 action="print_point.created" if created else "print_point.updated",
                 target_type="print_point", target=f"{body.event_type} → {body.template}", ip=who.ip,
                 detail={"printer": body.printer, "copies": body.copies})
    db.commit()
    out = point_out(db, point)
    return JSONResponse(status_code=201 if created else 200, content=out.model_dump(mode="json"))


@router.get("/print-points", response_model=Page[PrintPointOut])
def list_print_points(db: DB, warehouse: str | None = None, who: Principal = require("printing:read")):
    q = select(PrintPoint)
    if warehouse:
        wh = get_warehouse(db, warehouse)
        q = q.where(PrintPoint.warehouse_id.in_([wh.id, None]) | PrintPoint.warehouse_id.is_(None))
    rows = db.execute(q.order_by(PrintPoint.event_type, PrintPoint.template)).scalars().all()
    return Page(items=[point_out(db, p) for p in rows], total=len(rows))


@router.post("/print-points/{id}/deactivate", response_model=PrintPointOut)
def deactivate_print_point(id: int, db: DB, who: Principal = require("integration:admin")):
    point = db.get(PrintPoint, id)
    if point is None:
        raise NotFound(f"no print point {id}")
    point.active = False
    point.updated_at = datetime.now(UTC)
    audit.record(db, actor_type=who.kind, actor=who.name, action="print_point.deactivated",
                 target_type="print_point", target=f"{point.event_type} → {point.template}", ip=who.ip)
    db.commit()
    return point_out(db, point)


# --- print jobs -------------------------------------------------------------

class PrintJobIn(envelope.Envelope):
    warehouse: str | None = Field(default=None, max_length=32)
    template: str = Field(min_length=1, max_length=64)
    printer: str = Field(min_length=1, max_length=64)
    copies: int = Field(default=1, ge=1, le=99)
    reference: dict = Field(default_factory=dict)
    task_id: int | None = None


class PrintJobOut(BaseModel):
    wms_id: str
    job_id: uuidlib.UUID
    warehouse: str | None
    owner: str
    template: str
    version: str
    printer: str
    copies: int
    reference: dict
    data: dict
    status: str
    attempts: int
    next_attempt_at: datetime | None
    last_error: str | None
    external_ref: str | None
    reprint_of: str | None
    created_at: datetime
    sent_at: datetime | None
    printed_at: datetime | None


def job_out(db, j: PrintJob) -> PrintJobOut:
    wh = db.get(Warehouse, j.warehouse_id) if j.warehouse_id else None
    return PrintJobOut(
        wms_id=str(j.id), job_id=j.job_id, warehouse=wh.code if wh else None, owner=j.owner,
        template=j.template, version=j.version, printer=j.printer, copies=j.copies,
        reference=j.reference, data=j.data, status=j.status, attempts=j.attempts,
        next_attempt_at=j.next_attempt_at if j.status == "pending" else None,
        last_error=j.last_error, external_ref=j.external_ref,
        reprint_of=str(j.reprint_of_id) if j.reprint_of_id else None,
        created_at=j.created_at, sent_at=j.sent_at, printed_at=j.printed_at)


@router.post("/print-jobs", status_code=202, response_model=envelope.Accepted)
def create_print_job(body: PrintJobIn, request: Request, db: DB, who: Principal = require("printing:write")):
    """Print one now: the WMS builds the data for the template you name."""
    authorise(who, warehouse=body.warehouse, owner=body.owner)

    def work():
        template = _template(body.template)
        if template.from_reference is None:
            raise FieldError("template", f"{template.name} is only printed by a print point")
        wh = get_warehouse(db, body.warehouse) if body.warehouse else None
        try:
            data, reference = template.from_reference(db, wh, body.reference, body.owner)
        except TemplateError as e:
            raise FieldError(e.field, e.message) from e
        job = printing.queue_job(db, template=template, warehouse=wh, printer=body.printer,
                                 copies=body.copies, reference=reference, data=data,
                                 owner=body.owner, task_id=body.task_id)
        return envelope.Accepted(message_id=body.message_id, wms_id=str(job.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/print-jobs", response_model=Page[PrintJobOut])
def list_print_jobs(db: DB, warehouse: str | None = None, status: str | None = None,
                    template: str | None = None, printer: str | None = None,
                    external_ref: str | None = None, limit: int = Query(default=100, le=1000),
                    offset: int = 0, who: Principal = require("printing:read")):
    q = select(PrintJob)
    if warehouse:
        wh = get_warehouse(db, warehouse)
        q = q.where(PrintJob.warehouse_id == wh.id)
    if status:
        q = q.where(PrintJob.status.in_(status.split(",")))
    if template:
        q = q.where(PrintJob.template == template)
    if printer:
        q = q.where(PrintJob.printer == printer)
    if external_ref:
        q = q.where(PrintJob.external_ref == external_ref)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(PrintJob.id.desc()).limit(limit).offset(offset)).scalars().all()
    return Page(items=[job_out(db, j) for j in rows], total=total)


@router.get("/print-jobs/{id}", response_model=PrintJobOut)
def get_print_job(id: int, db: DB, who: Principal = require("printing:read")):
    job = db.get(PrintJob, id)
    if job is None:
        raise NotFound(f"no print job {id}")
    return job_out(db, job)


class ReprintIn(envelope.Envelope):
    printer: str | None = Field(default=None, max_length=64)
    copies: int | None = Field(default=None, ge=1, le=99)


@router.post("/print-jobs/{id}/reprint", status_code=202, response_model=envelope.Accepted)
def reprint(id: int, body: ReprintIn, request: Request, db: DB, who: Principal = require("printing:write")):
    """The same data again as a new job. Never re-renders, never re-numbers."""
    job = db.get(PrintJob, id)
    if job is None:
        raise NotFound(f"no print job {id}")

    def work():
        template = _template(job.template)
        wh = db.get(Warehouse, job.warehouse_id) if job.warehouse_id else None
        copy = printing.queue_job(db, template=template, warehouse=wh,
                                  printer=body.printer or job.printer,
                                  copies=body.copies or job.copies, reference=job.reference,
                                  data=job.data, owner=job.owner, task_id=job.task_id,
                                  reprint_of_id=job.id, external_ref=job.external_ref)
        copy.version = job.version  # reprint exactly what was sent the first time
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(copy.id), status="accepted")

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


class JobStatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    status: Literal["accepted", "printed", "failed"]
    message: str | None = Field(default=None, max_length=500)
    printer: str | None = Field(default=None, max_length=64)


@router.post("/print-jobs/{job_id}/status", response_model=PrintJobOut)
def job_status(job_id: uuidlib.UUID, body: JobStatusIn, db: DB,
               who: Principal = require("printing:write")):
    """Platen tells us how it went. Jobs are found by their job_id, the one
    the print service was given."""
    job = db.execute(select(PrintJob).where(PrintJob.job_id == job_id)).scalar_one_or_none()
    if job is None:
        raise NotFound(f"no print job {job_id}")
    job.status = body.status
    job.printer = body.printer or job.printer
    if body.status == "printed":
        job.printed_at = datetime.now(UTC)
        job.last_error = None
    elif body.status == "failed":
        job.last_error = body.message or "the print service said it failed"
    db.commit()
    return job_out(db, job)
