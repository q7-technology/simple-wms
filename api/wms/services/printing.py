"""The WMS never renders a label. It sends a template name, a version, a
printer and JSON to Platen (or any print service) through the same durable
queue as events.

Each document type has a fixed, versioned data shape. Adding a field is a new
version; old versions keep working, because a printer out there is still
rendering them."""
from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import (
    Delivery, Location, Package, PrintJob, PrintPoint, Product, Task, Warehouse, Zone,
)
from wms.services.qty import qstr
from wms.services.stock import RuleError


class TemplateError(RuleError):
    """Something a print job asked for is not there."""


@dataclass(slots=True)
class Template:
    name: str
    version: str
    fields: list[str]
    # events that can fire this template through a print point
    fires_on: list[str] = field(default_factory=list)
    # build from a reference the caller gave us: returns (data, reference)
    from_reference: Callable[..., tuple[dict, dict]] | None = None
    # build from an event: returns one (data, reference) per sheet to print
    from_event: Callable[..., list[tuple[dict, dict]]] | None = None
    describe: str = ""


TEMPLATES: dict[str, Template] = {}


def register(t: Template) -> Template:
    TEMPLATES[t.name] = t
    return t


def get(name: str) -> Template:
    t = TEMPLATES.get(name)
    if t is None:
        raise TemplateError("template", f"unknown template {name}; try {', '.join(sorted(TEMPLATES))}")
    return t


# --- lookups ---------------------------------------------------------------

def _location(db: Session, wh: Warehouse | None, code: str) -> Location:
    q = select(Location).where(Location.code == code)
    if wh:
        q = q.where(Location.warehouse_id == wh.id)
    loc = db.execute(q).scalars().first()
    if loc is None:
        raise TemplateError("reference", f"no location {code}")
    return loc


def _product(db: Session, sku: str, owner: str) -> Product:
    p = db.execute(select(Product).where(Product.owner == owner, Product.sku == sku)).scalar_one_or_none()
    if p is None:
        raise TemplateError("reference", f"no product {sku}")
    return p


def _delivery(db: Session, ref: str, owner: str) -> Delivery:
    d = db.execute(select(Delivery).where(Delivery.owner == owner, Delivery.external_ref == ref)).scalar_one_or_none()
    if d is None:
        raise TemplateError("reference", f"no delivery {ref}")
    return d


def _barcode(product: Product) -> str | None:
    for kind in ("gtin", "supplier", "carton", "other"):
        for b in product.barcodes:
            if b.kind == kind:
                return b.barcode
    return product.sku


# --- location-label ---------------------------------------------------------

def _location_data(db: Session, loc: Location) -> dict:
    zone = db.get(Zone, loc.zone_id)
    wh = db.get(Warehouse, loc.warehouse_id)
    return {"location": loc.code, "warehouse": wh.code, "zone": zone.code,
            "barcode": loc.barcode or loc.code, "type": loc.type, "access": loc.access,
            "pick_sequence": loc.pick_sequence}


register(Template(
    name="location-label", version="v2",
    fields=["location", "warehouse", "zone", "barcode", "type", "access", "pick_sequence"],
    fires_on=["receipt.confirmed"],
    describe="A shelf label, printed when stock first lands there.",
    from_reference=lambda db, wh, ref, owner: (
        _location_data(db, _location(db, wh, ref.get("ref", ""))),
        {"type": "location", "ref": ref.get("ref", "")},
    ),
    from_event=lambda db, wh, owner, external_ref, data: (
        [(_location_data(db, _location(db, wh, data["location"])),
          {"type": "location", "ref": data["location"], "receipt_ref": data.get("receipt_ref")})]
        if data.get("location") else []
    ),
))


# --- product-label ----------------------------------------------------------

def _product_data(db: Session, product: Product, batch: str | None, qty) -> dict:
    return {"sku": product.sku, "name": product.name, "uom": product.uom,
            "barcode": _barcode(product), "batch": batch, "batch_tracked": product.batch_tracked,
            "qty": qstr(Decimal(str(qty))) if qty is not None else None}


register(Template(
    name="product-label", version="v1",
    fields=["sku", "name", "uom", "barcode", "batch", "batch_tracked", "qty"],
    fires_on=[],
    describe="A product label, printed by hand from the Products screen.",
    from_reference=lambda db, wh, ref, owner: (
        _product_data(db, _product(db, ref.get("ref", ""), owner), ref.get("batch"), ref.get("qty")),
        {"type": "product", "ref": ref.get("ref", ""), "batch": ref.get("batch")},
    ),
))


# --- carton-label -----------------------------------------------------------

def _carton_data(db: Session, delivery: Delivery, package: Package, count: int) -> dict:
    lines: dict[tuple[str, str], Decimal] = {}
    for pl in package.lines:
        product = db.get(Product, pl.product_id)
        key = (product.sku, pl.uom)
        lines[key] = lines.get(key, Decimal(0)) + pl.qty
    return {
        "ship_to": delivery.ship_to or {}, "delivery_ref": delivery.external_ref,
        "package_no": package.package_no, "package_count": count,
        "weight_kg": qstr(package.weight_kg), "carrier": delivery.carrier or delivery.carrier_hint,
        "tracking_no": delivery.tracking_no, "sscc": package.sscc,
        "lines": [{"sku": sku, "qty": qstr(qty), "uom": uom} for (sku, uom), qty in lines.items()],
    }


def _carton_from_reference(db, wh, ref, owner):
    delivery = _delivery(db, ref.get("ref", ""), owner)
    number = ref.get("package_no")
    package = next((p for p in delivery.packages if p.package_no == number), None)
    if package is None:
        raise TemplateError("reference", f"{delivery.external_ref} has no package {number}")
    return (_carton_data(db, delivery, package, len(delivery.packages)),
            {"type": "delivery", "ref": delivery.external_ref, "package_no": package.package_no})


def _carton_from_event(db, wh, owner, external_ref, data):
    delivery = _delivery(db, external_ref, owner)
    count = len(delivery.packages)
    out = []
    for package in delivery.packages:
        out.append((_carton_data(db, delivery, package, count),
                    {"type": "delivery", "ref": delivery.external_ref, "package_no": package.package_no}))
    return out


register(Template(
    name="carton-label", version="v3",
    fields=["ship_to", "delivery_ref", "package_no", "package_count", "weight_kg", "carrier",
            "tracking_no", "sscc", "lines"],
    fires_on=["delivery.packed"],
    describe="One label per carton, printed when packing closes.",
    from_reference=_carton_from_reference, from_event=_carton_from_event,
))


# --- pallet-label -----------------------------------------------------------

register(Template(
    name="pallet-label", version="v1",
    fields=["sku", "name", "batch", "qty", "uom", "location", "reference", "sscc"],
    fires_on=["production.received"],
    describe="A pallet label for finished goods. Production arrives with build step 5.",
    from_event=lambda db, wh, owner, external_ref, data: [({
        "sku": data.get("sku"), "name": (_product(db, data["sku"], owner).name if data.get("sku") else None),
        "batch": data.get("batch"), "qty": data.get("qty"), "uom": data.get("uom"),
        "location": data.get("location"), "reference": external_ref, "sscc": None,
    }, {"type": "production_order", "ref": external_ref})] if data.get("sku") else [],
))


# --- pick-list --------------------------------------------------------------

def _pick_list_data(db: Session, delivery: Delivery) -> dict:
    task = db.get(Task, delivery.pick_task_id) if delivery.pick_task_id else None
    lines = []
    for l in (task.lines if task else []):
        if l.status == "cancelled":
            continue
        product = db.get(Product, l.product_id)
        loc = db.get(Location, l.from_location_id) if l.from_location_id else None
        lines.append({"location": loc.code if loc else None, "sku": product.sku, "name": product.name,
                      "batch": l.batch, "qty": qstr(l.expected_qty), "uom": l.uom})
    return {"delivery_ref": delivery.external_ref, "ship_to": delivery.ship_to or {},
            "required_by": delivery.required_by.isoformat() if delivery.required_by else None,
            "priority": delivery.priority, "pick_mode": delivery.pick_mode, "lines": lines}


register(Template(
    name="pick-list", version="v1",
    fields=["delivery_ref", "ship_to", "required_by", "priority", "pick_mode", "lines"],
    fires_on=["delivery.allocated"],
    describe="A paper walk list, for warehouses that want one beside the scanner.",
    from_reference=lambda db, wh, ref, owner: (
        _pick_list_data(db, _delivery(db, ref.get("ref", ""), owner)),
        {"type": "delivery", "ref": ref.get("ref", "")},
    ),
    from_event=lambda db, wh, owner, external_ref, data: [(
        _pick_list_data(db, _delivery(db, external_ref, owner)),
        {"type": "delivery", "ref": external_ref})],
))


# --- packing-slip -----------------------------------------------------------

def _packing_slip_data(db: Session, delivery: Delivery) -> dict:
    lines = []
    for l in delivery.lines:
        product = db.get(Product, l.product_id)
        lines.append({"delivery_line": l.line_no, "sku": product.sku, "name": product.name,
                      "batch": l.batch, "qty_ordered": qstr(l.qty_ordered),
                      "qty_packed": qstr(l.qty_picked), "uom": l.uom})
    return {"delivery_ref": delivery.external_ref, "ship_to": delivery.ship_to or {},
            "carrier": delivery.carrier or delivery.carrier_hint, "tracking_no": delivery.tracking_no,
            "packages": [{"package_no": p.package_no, "weight_kg": qstr(p.weight_kg), "sscc": p.sscc}
                         for p in delivery.packages],
            "lines": lines}


register(Template(
    name="packing-slip", version="v1",
    fields=["delivery_ref", "ship_to", "carrier", "tracking_no", "packages", "lines"],
    fires_on=["delivery.packed"],
    describe="The page that travels in the carton.",
    from_reference=lambda db, wh, ref, owner: (
        _packing_slip_data(db, _delivery(db, ref.get("ref", ""), owner)),
        {"type": "delivery", "ref": ref.get("ref", "")},
    ),
    from_event=lambda db, wh, owner, external_ref, data: [(
        _packing_slip_data(db, _delivery(db, external_ref, owner)),
        {"type": "delivery", "ref": external_ref})],
))


# --- transfer-docket --------------------------------------------------------

def _not_yet(*args, **kwargs):
    raise TemplateError("template", "transfer dockets arrive with build step 5")


register(Template(
    name="transfer-docket", version="v1",
    fields=["transfer_ref", "from_warehouse", "to_warehouse", "packages", "lines"],
    fires_on=["transfer.shipped"],
    describe="The docket that travels between warehouses. Transfers arrive with build step 5.",
    from_reference=_not_yet, from_event=lambda db, wh, owner, external_ref, data: [],
))


# --- the queue --------------------------------------------------------------

def queue_job(db: Session, *, template: Template, warehouse: Warehouse | None, printer: str,
              copies: int, reference: dict, data: dict, owner: str = "DEFAULT",
              task_id: int | None = None, print_point_id: int | None = None,
              reprint_of_id: int | None = None, external_ref: str | None = None) -> PrintJob:
    job = PrintJob(
        job_id=uuid.uuid4(), warehouse_id=warehouse.id if warehouse else None, owner=owner,
        template=template.name, version=template.version, printer=printer, copies=copies,
        reference=reference, data=data, task_id=task_id, print_point_id=print_point_id,
        reprint_of_id=reprint_of_id, external_ref=external_ref or reference.get("ref"),
        status="pending", attempts=0, next_attempt_at=datetime.now(UTC),
    )
    db.add(job)
    db.flush()
    return job


def matching_points(db: Session, event_type: str, warehouse: Warehouse | None, owner: str) -> list[PrintPoint]:
    rows = db.execute(
        select(PrintPoint).where(PrintPoint.event_type == event_type, PrintPoint.active.is_(True),
                                 PrintPoint.copies > 0)
    ).scalars().all()
    return [p for p in rows
            if (p.warehouse_id is None or (warehouse and p.warehouse_id == warehouse.id))
            and (p.owner == "*" or p.owner == owner)]


def fire(db: Session, event_type: str, *, warehouse_code: str | None, owner: str,
         external_ref: str | None, data: dict) -> list[PrintJob]:
    """Whatever the print points say this event should print. A template that
    cannot build its data prints nothing rather than blocking the movement
    that caused it."""
    wh = db.execute(select(Warehouse).where(Warehouse.code == warehouse_code)).scalar_one_or_none() \
        if warehouse_code else None
    out: list[PrintJob] = []
    for point in matching_points(db, event_type, wh, owner):
        template = TEMPLATES.get(point.template)
        if template is None or template.from_event is None:
            continue
        try:
            sheets = template.from_event(db, wh, owner, external_ref, data)
        except (TemplateError, KeyError):
            continue
        for sheet_data, reference in sheets:
            out.append(queue_job(db, template=template, warehouse=wh, printer=point.printer,
                                 copies=point.copies, reference=reference, data=sheet_data,
                                 owner=owner, print_point_id=point.id, external_ref=external_ref))
    return out
