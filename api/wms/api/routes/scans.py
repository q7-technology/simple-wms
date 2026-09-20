from __future__ import annotations

from typing import Any

from datetime import datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import FieldError, NotFound
from wms.api.routes.inbound import get_warehouse
from wms.api.schemas import Page
from wms.models import ScanPattern, Warehouse
from wms.services import audit, scans
from wms.services.stock import RuleError

router = APIRouter(tags=["scans"])


class ScanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    raw: str = Field(min_length=1, max_length=2000)
    expecting: str | None = Field(default=None, max_length=32)
    warehouse: str | None = Field(default=None, max_length=32)
    owner: str = Field(default="DEFAULT", max_length=32)
    device: str | None = Field(default=None, max_length=64)


class ScanOut(BaseModel):
    raw: str
    format: str
    type: str
    fields: dict[str, Any]
    resolved: dict[str, Any] | None
    matches_expected: bool | None
    message: str | None = None
    # which site pattern read it, when one did
    pattern: str | None = None


@router.post("/scans/parse", response_model=ScanOut)
def parse_scan(body: ScanIn, db: DB, who: Principal = require("stock:read")):
    authorise(who, warehouse=body.warehouse, owner=body.owner)
    return scans.parse(db, body.raw, warehouse=body.warehouse, owner=body.owner, expecting=body.expecting,
                       device=body.device or who.device)


# --- the patterns a site writes for its own labels ---------------------------

class PatternIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    warehouse: str | None = Field(default=None, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    pattern: str = Field(min_length=1, max_length=500)
    type: str = Field(default="product", max_length=32)
    order: int = Field(default=100, ge=0, le=9999)
    note: str | None = Field(default=None, max_length=500)
    active: bool = True


class PatternOut(BaseModel):
    wms_id: str
    warehouse: str | None
    name: str
    pattern: str
    type: str
    order: int
    fields: list[str]
    note: str | None
    active: bool
    created_by: str | None
    created_at: datetime


def pattern_out(db, p: ScanPattern) -> PatternOut:
    wh = db.get(Warehouse, p.warehouse_id) if p.warehouse_id else None
    try:
        fields = scans.check_pattern(p.pattern)
    except RuleError:
        fields = []
    return PatternOut(wms_id=str(p.id), warehouse=wh.code if wh else None, name=p.name,
                      pattern=p.pattern, type=p.type, order=p.order, fields=fields, note=p.note,
                      active=p.active, created_by=p.created_by, created_at=p.created_at)


@router.post("/scan-patterns", status_code=201, response_model=PatternOut)
def upsert_pattern(body: PatternIn, db: DB, who: Principal = require("master:write")):
    """Create or update by warehouse and name. The pattern is compiled before
    it is saved, so a broken one never reaches a scanner."""
    from fastapi.responses import JSONResponse

    if body.type not in scans.PATTERN_TYPES:
        raise FieldError("type", f"a pattern reads one of {', '.join(sorted(scans.PATTERN_TYPES))}")
    try:
        scans.check_pattern(body.pattern)
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    wh = get_warehouse(db, body.warehouse) if body.warehouse else None
    authorise(who, warehouse=body.warehouse, owner=None)

    existing = db.execute(select(ScanPattern).where(
        ScanPattern.warehouse_id.is_not_distinct_from(wh.id if wh else None),
        ScanPattern.name == body.name)).scalar_one_or_none()
    if existing is None:
        row = ScanPattern(warehouse_id=wh.id if wh else None, name=body.name, pattern=body.pattern,
                          type=body.type, order=body.order, note=body.note, active=body.active,
                          created_by=who.name)
        db.add(row)
        created = True
    else:
        row = existing
        row.pattern, row.type, row.order = body.pattern, body.type, body.order
        row.note, row.active = body.note, body.active
        created = False
    db.flush()
    audit.record(db, actor_type=who.kind, actor=who.name,
                 action="scan_pattern.created" if created else "scan_pattern.updated",
                 target_type="scan_pattern", target=row.name, ip=who.ip,
                 detail={"pattern": row.pattern, "type": row.type})
    db.commit()
    return JSONResponse(status_code=201 if created else 200,
                        content=pattern_out(db, row).model_dump(mode="json"))


@router.get("/scan-patterns", response_model=Page[PatternOut])
def list_patterns(db: DB, warehouse: str | None = None, who: Principal = require("stock:read")):
    q = select(ScanPattern)
    if warehouse:
        wh = get_warehouse(db, warehouse)
        q = q.where((ScanPattern.warehouse_id == wh.id) | (ScanPattern.warehouse_id.is_(None)))
    rows = db.execute(q.order_by(ScanPattern.order, ScanPattern.id)).scalars().all()
    return Page(items=[pattern_out(db, p) for p in rows], total=len(rows))


class TryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pattern: str = Field(min_length=1, max_length=500)
    raw: str = Field(min_length=1, max_length=2000)


class TryOut(BaseModel):
    matches: bool
    fields: dict[str, str]


@router.post("/scan-patterns/try", response_model=TryOut)
def try_pattern(body: TryIn, who: Principal = require("stock:read")):
    """Try a pattern against a scan before saving it."""
    import re

    try:
        scans.check_pattern(body.pattern)
    except RuleError as e:
        raise FieldError(e.field, e.message) from e
    match = re.match(body.pattern, body.raw)
    if not match:
        return TryOut(matches=False, fields={})
    return TryOut(matches=True,
                  fields={k: v for k, v in match.groupdict().items() if v is not None})


class UnknownScan(BaseModel):
    raw: str
    seen: int
    last_seen_at: datetime
    expecting: str | None


@router.get("/scan-patterns/unknown", response_model=Page[UnknownScan])
def unknown_scans(db: DB, warehouse: str | None = None, limit: int = Query(default=50, le=500),
                  who: Principal = require("stock:read")):
    """Scans nothing could read, so a pattern can be written for them. This is
    what the raw text was kept for."""
    from wms.models import AuditLog

    rows = db.execute(
        select(AuditLog).where(AuditLog.action == "scan.unknown").order_by(AuditLog.id.desc()).limit(5000)
    ).scalars().all()
    seen: dict[str, dict] = {}
    for row in rows:
        raw = (row.detail or {}).get("raw")
        if not raw:
            continue
        if warehouse and (row.detail or {}).get("warehouse") not in (warehouse, None):
            continue
        item = seen.setdefault(raw, {"raw": raw, "seen": 0, "last_seen_at": row.at,
                                     "expecting": (row.detail or {}).get("expecting")})
        item["seen"] += 1
        if row.at > item["last_seen_at"]:
            item["last_seen_at"] = row.at
    out = sorted(seen.values(), key=lambda x: (-x["seen"], x["raw"]))[:limit]
    return Page(items=[UnknownScan(**x) for x in out], total=len(out))


@router.post("/scan-patterns/{id}/deactivate", response_model=PatternOut)
def deactivate_pattern(id: int, db: DB, who: Principal = require("master:write")):
    row = db.get(ScanPattern, id)
    if row is None:
        raise NotFound(f"no scan pattern {id}")
    row.active = False
    audit.record(db, actor_type=who.kind, actor=who.name, action="scan_pattern.deactivated",
                 target_type="scan_pattern", target=row.name, ip=who.ip)
    db.commit()
    return pattern_out(db, row)
