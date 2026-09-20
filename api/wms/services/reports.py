"""Reports, all out of the ledger.

Nothing here keeps its own numbers. Every figure is read from `stock_ledger`
or from the balances that rebuild from it, so a report can never drift from
what actually happened."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import Date, case, cast, func, select
from sqlalchemy.orm import Session

from wms.models import (
    Delivery, DeliveryLine, Location, Package, Product, StockBalance, StockLedger, Warehouse, Zone,
)
from wms.services.qty import qstr
from wms.services.reservations import promisable


@dataclass(slots=True)
class Report:
    name: str
    columns: list[str]
    rows: list[dict]
    totals: dict
    describe: str = ""


DESCRIBE = {
    "stock-on-hand": "What is on the shelves right now, from the balances the ledger rebuilds.",
    "movements": "Every movement by day and type: what came in, what went out.",
    "pick-rate": "Lines and units picked per operator, and how fast.",
    "variances": "Every adjustment with its reason, oldest at the bottom.",
    "shipped": "Deliveries that left, by day.",
    "billing": "What one owner's stock cost to handle and hold, for a third-party invoice.",
}
FILTERS = {
    "stock-on-hand": ["warehouse", "owner", "zone", "sku", "group_by"],
    "movements": ["warehouse", "owner", "from", "to", "sku", "movement_type"],
    "pick-rate": ["warehouse", "owner", "from", "to", "operator"],
    "variances": ["warehouse", "owner", "from", "to", "sku", "reason"],
    "shipped": ["warehouse", "owner", "from", "to"],
    "billing": ["warehouse", "owner", "from", "to"],
}


def _window(q, column, frm: date | None, to: date | None):
    if frm:
        q = q.where(cast(column, Date) >= frm)
    if to:
        q = q.where(cast(column, Date) <= to)
    return q


def _round(value: Decimal, places: str = "0.01") -> str:
    return str(value.quantize(Decimal(places), rounding=ROUND_HALF_UP).normalize())


# --- stock on hand -----------------------------------------------------------

def stock_on_hand(db: Session, *, warehouse: Warehouse, owner: str, zone: str | None = None,
                  sku: str | None = None, group_by: str = "location") -> Report:
    q = (select(StockBalance, Product, Location, Zone)
         .join(Product, Product.id == StockBalance.product_id)
         .join(Location, Location.id == StockBalance.location_id)
         .join(Zone, Zone.id == Location.zone_id)
         .where(StockBalance.warehouse_id == warehouse.id, StockBalance.owner == owner,
                StockBalance.on_hand != 0))
    if zone:
        q = q.where(Zone.code == zone)
    if sku:
        q = q.where(Product.sku == sku)
    rows = db.execute(q.order_by(Product.sku, Location.pick_sequence, Location.code)).all()

    if group_by == "product":
        grouped: dict[str, dict] = {}
        for bal, product, loc, zn in rows:
            row = grouped.setdefault(product.sku, {
                "sku": product.sku, "name": product.name, "uom": bal.uom, "owner": owner,
                "on_hand": Decimal(0), "reserved": Decimal(0), "available": Decimal(0),
                "locations": 0, "batches": set()})
            row["on_hand"] += bal.on_hand
            row["reserved"] += bal.reserved
            row["available"] += (bal.on_hand - bal.reserved) if promisable(zn.kind) else Decimal(0)
            row["locations"] += 1
            if bal.batch:
                row["batches"].add(bal.batch)
        out = []
        for row in grouped.values():
            row["batches"] = len(row["batches"])
            for k in ("on_hand", "reserved", "available"):
                row[k] = qstr(row[k])
            out.append(row)
        columns = ["sku", "name", "uom", "owner", "on_hand", "reserved", "available",
                   "locations", "batches"]
    else:
        out = []
        for bal, product, loc, zn in rows:
            available = (bal.on_hand - bal.reserved) if promisable(zn.kind) else Decimal(0)
            out.append({
                "sku": product.sku, "name": product.name, "warehouse": warehouse.code,
                "zone": zn.code, "location": loc.code, "batch": bal.batch, "owner": bal.owner,
                "on_hand": qstr(bal.on_hand), "reserved": qstr(bal.reserved),
                "available": qstr(available), "uom": bal.uom,
                "received_at": bal.received_at.isoformat() if bal.received_at else None})
        columns = ["sku", "name", "warehouse", "zone", "location", "batch", "owner",
                   "on_hand", "reserved", "available", "uom", "received_at"]

    totals = {"lines": len(out),
              "on_hand": qstr(sum((Decimal(r["on_hand"]) for r in out), Decimal(0))),
              "available": qstr(sum((Decimal(r["available"]) for r in out), Decimal(0)))}
    return Report("stock-on-hand", columns, out, totals, DESCRIBE["stock-on-hand"])


# --- movements ---------------------------------------------------------------

def movements(db: Session, *, warehouse: Warehouse, owner: str, frm: date | None, to: date | None,
              sku: str | None = None, movement_type: str | None = None) -> Report:
    day = cast(StockLedger.at, Date).label("day")
    q = (select(day, StockLedger.movement_type,
                func.count().label("lines"),
                func.sum(case((StockLedger.qty_change > 0, StockLedger.qty_change), else_=0)).label("qty_in"),
                func.sum(case((StockLedger.qty_change < 0, -StockLedger.qty_change), else_=0)).label("qty_out"))
         .where(StockLedger.warehouse_id == warehouse.id, StockLedger.owner == owner))
    if sku:
        q = q.join(Product, Product.id == StockLedger.product_id).where(Product.sku == sku)
    if movement_type:
        q = q.where(StockLedger.movement_type.in_(movement_type.split(",")))
    q = _window(q, StockLedger.at, frm, to)
    rows = db.execute(q.group_by(day, StockLedger.movement_type)
                      .order_by(day.desc(), StockLedger.movement_type)).all()

    out = [{"day": r.day.isoformat(), "movement_type": r.movement_type, "lines": r.lines,
            "qty_in": qstr(r.qty_in or Decimal(0)), "qty_out": qstr(r.qty_out or Decimal(0)),
            "net": qstr((r.qty_in or Decimal(0)) - (r.qty_out or Decimal(0)))} for r in rows]
    totals = {"lines": sum(r["lines"] for r in out),
              "qty_in": qstr(sum((Decimal(r["qty_in"]) for r in out), Decimal(0))),
              "qty_out": qstr(sum((Decimal(r["qty_out"]) for r in out), Decimal(0)))}
    return Report("movements", ["day", "movement_type", "lines", "qty_in", "qty_out", "net"],
                  out, totals, DESCRIBE["movements"])


# --- pick rate ----------------------------------------------------------------

def pick_rate(db: Session, *, warehouse: Warehouse, owner: str, frm: date | None, to: date | None,
              operator: str | None = None) -> Report:
    q = (select(StockLedger.actor,
                func.count().label("lines"),
                func.sum(-StockLedger.qty_change).label("units"),
                func.min(StockLedger.at).label("first_at"),
                func.max(StockLedger.at).label("last_at"))
         .where(StockLedger.warehouse_id == warehouse.id, StockLedger.owner == owner,
                StockLedger.movement_type == "pick", StockLedger.qty_change < 0))
    if operator:
        q = q.where(StockLedger.actor == operator)
    q = _window(q, StockLedger.at, frm, to)
    rows = db.execute(q.group_by(StockLedger.actor).order_by(func.count().desc(),
                                                             StockLedger.actor)).all()

    out = []
    for r in rows:
        span = (r.last_at - r.first_at).total_seconds() / 3600 if r.last_at and r.first_at else 0
        hours = Decimal(str(span))
        out.append({
            "operator": r.actor, "lines": r.lines, "units": qstr(r.units or Decimal(0)),
            "first_at": r.first_at.isoformat() if r.first_at else None,
            "last_at": r.last_at.isoformat() if r.last_at else None,
            "hours": _round(hours) if hours else "0",
            "lines_per_hour": _round(Decimal(r.lines) / hours) if hours > 0 else None,
            "units_per_hour": _round((r.units or Decimal(0)) / hours) if hours > 0 else None,
        })
    totals = {"operators": len(out), "lines": sum(r["lines"] for r in out),
              "units": qstr(sum((Decimal(r["units"]) for r in out), Decimal(0)))}
    return Report("pick-rate",
                  ["operator", "lines", "units", "first_at", "last_at", "hours",
                   "lines_per_hour", "units_per_hour"], out, totals, DESCRIBE["pick-rate"])


# --- variances -----------------------------------------------------------------

def variances(db: Session, *, warehouse: Warehouse, owner: str, frm: date | None, to: date | None,
              sku: str | None = None, reason: str | None = None) -> Report:
    q = (select(StockLedger, Product, Location, Zone)
         .join(Product, Product.id == StockLedger.product_id)
         .join(Location, Location.id == StockLedger.location_id)
         .join(Zone, Zone.id == Location.zone_id)
         .where(StockLedger.warehouse_id == warehouse.id, StockLedger.owner == owner,
                StockLedger.movement_type == "adjustment"))
    if sku:
        q = q.where(Product.sku == sku)
    if reason:
        q = q.where(StockLedger.reason == reason)
    q = _window(q, StockLedger.at, frm, to)
    rows = db.execute(q.order_by(StockLedger.id.desc())).all()

    out = [{"at": l.at.isoformat(), "location": loc.code, "zone": zn.code, "sku": p.sku,
            "batch": l.batch, "qty_change": qstr(l.qty_change), "uom": l.uom,
            "reason": l.reason, "actor": l.actor, "note": l.note, "ledger_id": str(l.id)}
           for l, p, loc, zn in rows]
    up = sum((Decimal(r["qty_change"]) for r in out if Decimal(r["qty_change"]) > 0), Decimal(0))
    down = sum((-Decimal(r["qty_change"]) for r in out if Decimal(r["qty_change"]) < 0), Decimal(0))
    totals = {"lines": len(out), "qty_up": qstr(up), "qty_down": qstr(down), "net": qstr(up - down)}
    return Report("variances",
                  ["at", "location", "zone", "sku", "batch", "qty_change", "uom", "reason",
                   "actor", "note", "ledger_id"], out, totals, DESCRIBE["variances"])


# --- shipped --------------------------------------------------------------------

def shipped(db: Session, *, warehouse: Warehouse, owner: str, frm: date | None,
            to: date | None) -> Report:
    day = cast(Delivery.shipped_at, Date).label("day")
    q = (select(day, Delivery.id, Delivery.short)
         .where(Delivery.warehouse_id == warehouse.id, Delivery.owner == owner,
                Delivery.status == "shipped"))
    q = _window(q, Delivery.shipped_at, frm, to)
    rows = db.execute(q).all()

    by_day: dict[str, dict] = {}
    for r in rows:
        key = r.day.isoformat()
        row = by_day.setdefault(key, {"day": key, "deliveries": 0, "lines": 0,
                                      "units": Decimal(0), "short": 0, "packages": 0})
        row["deliveries"] += 1
        row["short"] += 1 if r.short else 0
        lines = db.execute(select(DeliveryLine).where(DeliveryLine.delivery_id == r.id)).scalars().all()
        row["lines"] += sum(1 for l in lines if l.qty_shipped > 0)
        row["units"] += sum((l.qty_shipped for l in lines), Decimal(0))
        row["packages"] += db.execute(
            select(func.count()).select_from(Package).where(Package.delivery_id == r.id)).scalar_one()

    out = sorted(by_day.values(), key=lambda r: r["day"], reverse=True)
    for row in out:
        row["units"] = qstr(row["units"])
    totals = {"deliveries": sum(r["deliveries"] for r in out),
              "lines": sum(r["lines"] for r in out),
              "units": qstr(sum((Decimal(r["units"]) for r in out), Decimal(0))),
              "short": sum(r["short"] for r in out)}
    return Report("shipped", ["day", "deliveries", "lines", "units", "short", "packages"],
                  out, totals, DESCRIBE["shipped"])


# --- billing ---------------------------------------------------------------------

# What a third-party warehouse charges for: work done, and space held. Each
# measure names the movement types it bills, and which direction it counts.
# `in` bills the units that arrived, `out` the units that left, and `both` the
# units touched either way, which is what an adjustment is.
BILLED = [
    ("Receipts", ("receipt", "transfer_in", "production_receipt"), "in"),
    ("Put-aways and moves", ("putaway", "move", "replenish"), "in"),
    ("Picks", ("pick",), "out"),
    ("Production issues", ("production_issue",), "out"),
    ("Shipments", ("ship", "transfer_out"), "out"),
    ("Adjustments", ("adjustment", "count"), "both"),
]


def _one_uom(uoms: set[str]) -> str | None:
    """One unit if everything agrees, `mixed` if not. A 3PL that stores pallets
    and eaches has to be told, not given a meaningless sum."""
    if not uoms:
        return None
    return uoms.pop() if len(uoms) == 1 else "mixed"


def billing(db: Session, *, warehouse: Warehouse, owner: str, frm: date | None,
            to: date | None) -> Report:
    q = (select(StockLedger.movement_type, StockLedger.uom,
                func.count().label("lines"),
                func.sum(case((StockLedger.qty_change > 0, StockLedger.qty_change), else_=0)).label("qty_in"),
                func.sum(case((StockLedger.qty_change < 0, -StockLedger.qty_change), else_=0)).label("qty_out"))
         .where(StockLedger.warehouse_id == warehouse.id, StockLedger.owner == owner))
    q = _window(q, StockLedger.at, frm, to)
    handled = db.execute(q.group_by(StockLedger.movement_type, StockLedger.uom)).all()

    seen: dict[str, list] = {}
    for r in handled:
        seen.setdefault(r.movement_type, []).append(r)

    out: list[dict] = []
    units_in = units_out = Decimal(0)
    movements = 0
    for measure, types, direction in BILLED:
        lines = 0
        qty = Decimal(0)
        uoms: set[str] = set()
        for movement_type in types:
            for r in seen.get(movement_type, []):
                lines += r.lines
                qty_in, qty_out = r.qty_in or Decimal(0), r.qty_out or Decimal(0)
                qty += {"in": qty_in, "out": qty_out, "both": qty_in + qty_out}[direction]
                units_in += qty_in
                units_out += qty_out
                if qty_in or qty_out:
                    uoms.add(r.uom)
        movements += lines
        out.append({"measure": measure, "detail": ", ".join(types), "count": lines,
                    "qty": qstr(qty), "uom": _one_uom(uoms)})

    # Cartons that left on a delivery. The work of packing one is billed whether
    # it held one line or ten.
    cartons = (select(func.count()).select_from(Package).join(Delivery, Delivery.id == Package.delivery_id)
               .where(Delivery.warehouse_id == warehouse.id, Delivery.owner == owner,
                      Delivery.status == "shipped"))
    cartons = _window(cartons, Delivery.shipped_at, frm, to)
    out.append({"measure": "Cartons shipped", "detail": "packed and despatched",
                "count": db.execute(cartons).scalar_one(), "qty": None, "uom": None})

    # Space. Read now, not over the window: a ledger says what moved, not what
    # sat still, so storage is charged on what is on the shelves at this moment.
    held = db.execute(
        select(StockBalance.location_id, StockBalance.product_id, StockBalance.on_hand,
               StockBalance.uom)
        .where(StockBalance.warehouse_id == warehouse.id, StockBalance.owner == owner,
               StockBalance.on_hand != 0)).all()
    locations = {r.location_id for r in held}
    skus = {r.product_id for r in held}
    on_hand = sum((r.on_hand for r in held), Decimal(0))
    out.append({"measure": "Locations held", "detail": "with stock on them right now",
                "count": len(locations), "qty": None, "uom": None})
    out.append({"measure": "Stock on hand", "detail": "as at this moment",
                "count": len(skus), "qty": qstr(on_hand),
                "uom": _one_uom({r.uom for r in held})})

    totals = {"owner": owner, "movements": movements, "units_in": qstr(units_in),
              "units_out": qstr(units_out), "locations": len(locations),
              "on_hand": qstr(on_hand)}
    return Report("billing", ["measure", "detail", "count", "qty", "uom"], out, totals,
                  DESCRIBE["billing"])


REPORTS = {
    "stock-on-hand": stock_on_hand,
    "movements": movements,
    "pick-rate": pick_rate,
    "variances": variances,
    "shipped": shipped,
    "billing": billing,
}
