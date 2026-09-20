"""CSV import with a preview that names the problem rows before anything commits."""
from __future__ import annotations

import csv
import io
import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, ValidationError

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import FieldError, NotFound, field_errors
from wms.api.schemas import LocationIn, ProductIn

router = APIRouter(tags=["imports"])

TEMPLATES: dict[str, tuple[str, str, str]] = {
    "products": (
        "sku,name,uom,batch_tracked,decimals_allowed,preferred_zone,pickface_min,pickface_max,barcodes",
        "ABC123,Brake pad set,EA,yes,no,PICKFACE,48,96,09312345000012|ABC123-CTN12:carton:12",
        "master:write",
    ),
    "locations": (
        "code,zone,type,access,mixing,capacity,capacity_uom,pick_sequence,barcode",
        "BK-04-01-C,BULK,rack,forklift,mixed,3,PALLET,410,LOC-BK-04-01-C",
        "master:write",
    ),
    "receipts": (
        "reference,supplier,expected_at,line,sku,batch,qty,uom",
        "PO-88815,Supplier Co,2026-09-22,1,ABC123,,120,EA",
        "tasks:write",
    ),
    "deliveries": (
        "reference,ship_to_name,address,suburb,state,postcode,country,required_by,priority,"
        "pick_mode,allow_short,carrier_hint,line,sku,batch,qty,uom",
        "0080012345,Acme Auto Parts,12 Example St,Geelong,VIC,3220,AU,2026-09-22,normal,"
        "single,yes,,10,ABC123,,10,EA",
        "tasks:write",
    ),
    "replenishments": (
        "reference,priority,line,sku,qty,uom,to_location,from_location,batch",
        "REP-1001,normal,1,ABC123,48,EA,PF-01-02-A,,",
        "tasks:write",
    ),
    "transfers": (
        "reference,to_warehouse,required_by,priority,carrier_hint,line,sku,batch,qty,uom",
        "STO-4500012,MEL-WH01,2026-09-25,normal,,1,ABC123,,120,EA",
        "tasks:write",
    ),
}


class ImportIn(envelope.Envelope):
    csv: str = Field(min_length=1, max_length=5_000_000)
    dry_run: bool = True
    skip_problems: bool = True


class PreviewRow(BaseModel):
    row: int
    problem: str | None
    data: dict[str, Any]


class ImportResult(BaseModel):
    message_id: str
    type: str
    rows_read: int
    ready: int
    problems: int
    committed: bool
    imported: int
    summary: str
    preview: list[PreviewRow]


def _bool(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "y", "on")


def _num(v: str):
    v = v.strip()
    return v if v else None


def _problem(exc: ValidationError) -> str:
    return "; ".join(f"{e['field']}: {e['message']}" for e in field_errors(exc.errors()))


def read_rows(text: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]


@router.get("/imports/templates/{type}")
def template(type: str, who: Principal = require("master:read")):
    if type not in TEMPLATES:
        raise NotFound(f"no import called {type}; try {', '.join(TEMPLATES)}")
    header, example, _ = TEMPLATES[type]
    return PlainTextResponse(f"{header}\n{example}\n", media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{type}.csv"'})


@router.post("/imports/{type}", response_model=ImportResult)
def run_import(type: str, body: ImportIn, request: Request, db: DB, who: Principal = require("master:read")):
    if type not in TEMPLATES:
        raise NotFound(f"no import called {type}; try {', '.join(TEMPLATES)}")
    scope = TEMPLATES[type][2]
    if not body.dry_run and not who.has_scope(scope):
        from wms.api.errors import Forbidden
        raise Forbidden(f"importing {type} needs the {scope} scope")
    authorise(who, warehouse=body.warehouse, owner=body.owner)
    rows = read_rows(body.csv)
    runner = {"products": _products, "locations": _locations, "receipts": _receipts,
              "deliveries": _deliveries, "replenishments": _replenishments,
              "transfers": _transfers}[type]

    def work():
        # Everything happens inside one savepoint so a dry run leaves nothing behind.
        outer = db.begin_nested()
        preview, imported, summary = runner(db, body, rows, who)
        problems = sum(1 for p in preview if p.problem)
        ready = len(rows) - problems
        if body.dry_run:
            outer.rollback()
            committed = False
            imported = 0
        elif problems and not body.skip_problems:
            outer.rollback()
            raise FieldError("csv", f"{problems} rows have problems; fix them or set skip_problems")
        else:
            outer.commit()
            committed = True
        preview.sort(key=lambda p: (p.problem is None, p.row))
        return ImportResult(message_id=str(body.message_id), type=type, rows_read=len(rows), ready=ready,
                            problems=problems, committed=committed, imported=imported, summary=summary,
                            preview=preview[:500])

    if body.dry_run:
        return work()
    return envelope.handle(db, who, body.message_id, request.url.path, work,
                           status_code=200, owner=body.owner)


def _try(db, fn, row_no: int, data: dict) -> PreviewRow:
    sp = db.begin_nested()
    try:
        fn()
        sp.commit()
        return PreviewRow(row=row_no, problem=None, data=data)
    except ValidationError as exc:
        sp.rollback()
        return PreviewRow(row=row_no, problem=_problem(exc), data=data)
    except FieldError as exc:
        sp.rollback()
        return PreviewRow(row=row_no, problem=f"{exc.field}: {exc.message}", data=data)


def _products(db, body: ImportIn, rows, who):
    from wms.api.routes.products import apply_product

    preview = []
    for n, r in enumerate(rows, start=1):
        def do(r=r):
            barcodes = []
            for item in filter(None, (x.strip() for x in r.get("barcodes", "").split("|"))):
                parts = item.split(":")
                barcodes.append({"barcode": parts[0], "kind": parts[1] if len(parts) > 1 else "gtin",
                                 "qty_per": parts[2] if len(parts) > 2 else "1"})
            model = ProductIn.model_validate({
                "message_id": str(body.message_id), "owner": body.owner, "sku": r.get("sku", ""),
                "name": r.get("name", ""), "uom": r.get("uom") or "EA",
                "batch_tracked": _bool(r.get("batch_tracked", "")), "decimals_allowed": _bool(r.get("decimals_allowed", "")),
                "preferred_zone": r.get("preferred_zone") or None, "pickface_min": _num(r.get("pickface_min", "")),
                "pickface_max": _num(r.get("pickface_max", "")), "barcodes": barcodes,
            })
            apply_product(db, model)
        preview.append(_try(db, do, n, r))
    imported = sum(1 for p in preview if p.problem is None)
    return preview, imported, f"as {imported} products"


def _locations(db, body: ImportIn, rows, who):
    from wms.api.routes.structure import apply_location

    if not body.warehouse:
        raise FieldError("warehouse", "say which warehouse the locations belong to")
    preview = []
    for n, r in enumerate(rows, start=1):
        def do(r=r):
            model = LocationIn.model_validate({
                "message_id": str(body.message_id), "warehouse": body.warehouse, "code": r.get("code", ""),
                "zone": r.get("zone", ""), "type": r.get("type") or "shelf", "access": r.get("access") or "ground",
                "mixing": r.get("mixing") or "mixed", "capacity": _num(r.get("capacity", "")),
                "capacity_uom": r.get("capacity_uom") or None, "pick_sequence": int(r.get("pick_sequence") or 0),
                "barcode": r.get("barcode") or None,
            })
            apply_location(db, model)
        preview.append(_try(db, do, n, r))
    imported = sum(1 for p in preview if p.problem is None)
    return preview, imported, f"as {imported} locations"


def _receipts(db, body: ImportIn, rows, who):
    from wms.api.routes.inbound import ReceiptIn, ReceiptLineIn, apply_receipt

    if not body.warehouse:
        raise FieldError("warehouse", "say which warehouse receives them")
    groups: dict[str, list[tuple[int, dict]]] = {}
    for n, r in enumerate(rows, start=1):
        groups.setdefault(r.get("reference", ""), []).append((n, r))
    preview: list[PreviewRow] = []
    receipts = 0
    for ref, items in groups.items():
        line_models = []
        line_problems: dict[int, str] = {}
        for n, r in items:
            try:
                line_models.append(ReceiptLineIn.model_validate({
                    "line": int(r.get("line") or len(line_models) + 1), "sku": r.get("sku", ""),
                    "batch": r.get("batch") or None, "qty": _num(r.get("qty", "")) or "0", "uom": r.get("uom") or "EA"}))
            except (ValidationError, ValueError) as exc:
                line_problems[n] = _problem(exc) if isinstance(exc, ValidationError) else str(exc)
        first = items[0][1]
        group_problem = None
        if not line_problems:
            def do():
                model = ReceiptIn.model_validate({
                    "message_id": str(body.message_id), "owner": body.owner, "warehouse": body.warehouse,
                    "external_ref": ref, "supplier": first.get("supplier") or None,
                    "expected_at": date.fromisoformat(first["expected_at"]) if first.get("expected_at") else None,
                    "lines": [m.model_dump() for m in line_models],
                })
                apply_receipt(db, model, who.name)
            outcome = _try(db, do, items[0][0], first)
            group_problem = outcome.problem
            if group_problem is None:
                receipts += 1
        for n, r in items:
            problem = line_problems.get(n)
            if problem is None and line_problems:
                problem = "another line of this receipt has a problem"
            if problem is None and group_problem:
                problem = group_problem.replace(f"lines.{items.index((n, r))}.", "")
            preview.append(PreviewRow(row=n, problem=problem, data=r))
    imported = sum(1 for p in preview if p.problem is None)
    return preview, imported, f"as {receipts} receipt{'s' if receipts != 1 else ''}"


def _grouped(rows) -> dict[str, list[tuple[int, dict]]]:
    """Rows of one document, in the order they were read."""
    groups: dict[str, list[tuple[int, dict]]] = {}
    for n, r in enumerate(rows, start=1):
        groups.setdefault(r.get("reference", ""), []).append((n, r))
    return groups


def _by_document(db, body: ImportIn, rows, build, noun: str, plural: str | None = None):
    """Every import that makes documents works the same way: group the rows by
    reference, refuse a whole document if any of its lines is wrong, and say
    so on every row of it."""
    preview: list[PreviewRow] = []
    made = 0
    for ref, items in _grouped(rows).items():
        first = items[0][1]
        line_problems: dict[int, str] = {}
        lines: list[dict] = []
        for n, r in items:
            try:
                lines.append(build.line(r, len(lines) + 1))
            except (ValidationError, ValueError, KeyError) as exc:
                line_problems[n] = _problem(exc) if isinstance(exc, ValidationError) else str(exc)

        group_problem = None
        if not line_problems:
            def do(ref=ref, first=first, lines=lines):
                build.document(ref, first, lines)
            outcome = _try(db, do, items[0][0], first)
            group_problem = outcome.problem
            if group_problem is None:
                made += 1
        for n, r in items:
            problem = line_problems.get(n)
            if problem is None and line_problems:
                problem = f"another line of this {noun} has a problem"
            if problem is None and group_problem:
                problem = re.sub(r"^lines\.\d+\.", "", group_problem)
            preview.append(PreviewRow(row=n, problem=problem, data=r))
    imported = sum(1 for p in preview if p.problem is None)
    return preview, imported, f"as {made} {noun if made == 1 else (plural or noun + 's')}"


class _Build:
    def __init__(self, line, document):
        self.line = line
        self.document = document


def _deliveries(db, body: ImportIn, rows, who):
    from wms.api.routes.outbound import DeliveryIn, DeliveryLineIn, apply_delivery

    if not body.warehouse:
        raise FieldError("warehouse", "say which warehouse picks them")

    def line(r, fallback_no):
        return DeliveryLineIn.model_validate({
            "delivery_line": int(r.get("line") or fallback_no * 10), "sku": r.get("sku", ""),
            "batch": r.get("batch") or None, "qty": _num(r.get("qty", "")) or "0",
            "uom": r.get("uom") or "EA"}).model_dump()

    def document(ref, first, lines):
        ship_to = {"name": first.get("ship_to_name") or first.get("ship_to") or ""}
        for column in ("address", "suburb", "state", "postcode", "country", "contact", "phone", "email"):
            if first.get(column):
                ship_to[column] = first[column]
        model = DeliveryIn.model_validate({
            "message_id": str(body.message_id), "owner": body.owner, "warehouse": body.warehouse,
            "external_ref": ref, "ship_to": ship_to,
            "required_by": first["required_by"] if first.get("required_by") else None,
            "priority": first.get("priority") or "normal",
            "pick_mode": first.get("pick_mode") or "single",
            "allow_short": _bool(first.get("allow_short", "yes")) if first.get("allow_short") else True,
            "carrier_hint": first.get("carrier_hint") or None, "lines": lines})
        apply_delivery(db, model, who.name)

    return _by_document(db, body, rows, _Build(line, document), "delivery", "deliveries")


def _replenishments(db, body: ImportIn, rows, who):
    from wms.api.routes.inbound import ReplenIn, ReplenLineIn, apply_replenishment

    if not body.warehouse:
        raise FieldError("warehouse", "say which warehouse replenishes")

    def line(r, fallback_no):
        return ReplenLineIn.model_validate({
            "line": int(r.get("line") or fallback_no), "sku": r.get("sku", ""),
            "qty": _num(r.get("qty", "")) or "0", "uom": r.get("uom") or "EA",
            "to_location": r.get("to_location", ""), "from_location": r.get("from_location") or None,
            "batch": r.get("batch") or None}).model_dump()

    def document(ref, first, lines):
        model = ReplenIn.model_validate({
            "message_id": str(body.message_id), "owner": body.owner, "warehouse": body.warehouse,
            "external_ref": ref, "priority": first.get("priority") or "normal",
            "source": "manual", "lines": lines})
        apply_replenishment(db, model, who.name)

    return _by_document(db, body, rows, _Build(line, document), "replenishment")


def _transfers(db, body: ImportIn, rows, who):
    from wms.api.routes.transfers import TransferIn, TransferLineIn, apply_transfer

    if not body.warehouse:
        raise FieldError("warehouse", "say which warehouse sends them")

    def line(r, fallback_no):
        return TransferLineIn.model_validate({
            "line": int(r.get("line") or fallback_no), "sku": r.get("sku", ""),
            "batch": r.get("batch") or None, "qty": _num(r.get("qty", "")) or "0",
            "uom": r.get("uom") or "EA"}).model_dump()

    def document(ref, first, lines):
        model = TransferIn.model_validate({
            "message_id": str(body.message_id), "owner": body.owner,
            "external_ref": ref, "from_warehouse": first.get("from_warehouse") or body.warehouse,
            "to_warehouse": first.get("to_warehouse", ""),
            "required_by": first["required_by"] if first.get("required_by") else None,
            "priority": first.get("priority") or "normal",
            "carrier_hint": first.get("carrier_hint") or None, "lines": lines})
        apply_transfer(db, model, who.name)

    return _by_document(db, body, rows, _Build(line, document), "transfer")
