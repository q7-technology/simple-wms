"""Reports. Every figure comes out of the ledger, so none of them can drift."""
from __future__ import annotations

import csv
import io
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import NotFound
from wms.api.routes.inbound import get_warehouse
from wms.api.schemas import Page
from wms.services import reports

router = APIRouter(tags=["reports"])


class ReportListing(BaseModel):
    report: str
    describe: str
    filters: list[str]


class ReportOut(BaseModel):
    report: str
    warehouse: str
    owner: str
    from_: date | None = None
    to: date | None = None
    describe: str
    columns: list[str]
    rows: list[dict[str, Any]]
    totals: dict[str, Any]

    model_config = {"populate_by_name": True, "ser_json_exclude_none": False}


@router.get("/reports", response_model=Page[ReportListing])
def list_reports(who: Principal = require("stock:read")):
    items = [ReportListing(report=name, describe=reports.DESCRIBE[name],
                           filters=reports.FILTERS[name])
             for name in sorted(reports.REPORTS)]
    return Page(items=items, total=len(items))


def as_csv(report: reports.Report) -> PlainTextResponse:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=report.columns, extrasaction="ignore")
    writer.writeheader()
    for row in report.rows:
        writer.writerow({k: ("" if row.get(k) is None else row.get(k)) for k in report.columns})
    return PlainTextResponse(
        out.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{report.name}.csv"'})


@router.get("/reports/{name}")
def run_report(
    name: str, db: DB, warehouse: str = Query(), owner: str = "DEFAULT",
    from_: date | None = Query(default=None, alias="from"), to: date | None = None,
    sku: str | None = None, zone: str | None = None, movement_type: str | None = None,
    reason: str | None = None, operator: str | None = None, group_by: str = "location",
    format: str = "json", who: Principal = require("stock:read"),
):
    """One shape for every report: columns, rows and totals. `format=csv`
    downloads the same thing."""
    if name not in reports.REPORTS:
        raise NotFound(f"no report called {name}; try {', '.join(sorted(reports.REPORTS))}")
    authorise(who, warehouse=warehouse, owner=owner)
    wh = get_warehouse(db, warehouse)

    kwargs: dict[str, Any] = {"warehouse": wh, "owner": owner}
    if name == "stock-on-hand":
        kwargs |= {"zone": zone, "sku": sku, "group_by": group_by}
    elif name == "movements":
        kwargs |= {"frm": from_, "to": to, "sku": sku, "movement_type": movement_type}
    elif name == "pick-rate":
        kwargs |= {"frm": from_, "to": to, "operator": operator}
    elif name == "variances":
        kwargs |= {"frm": from_, "to": to, "sku": sku, "reason": reason}
    elif name == "shipped":
        kwargs |= {"frm": from_, "to": to}

    report = reports.REPORTS[name](db, **kwargs)
    if format == "csv":
        return as_csv(report)
    return {"report": report.name, "warehouse": wh.code, "owner": owner,
            "from": from_.isoformat() if from_ else None, "to": to.isoformat() if to else None,
            "describe": report.describe, "columns": report.columns, "rows": report.rows,
            "totals": report.totals}
