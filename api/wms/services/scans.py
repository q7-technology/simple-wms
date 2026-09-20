"""One parser for every scan, tried in order: GS1 (QR, DataMatrix, GS1-128,
Digital Link) → JSON in a QR → plain text lookup (location, SKU, barcode,
badge, receipt, task). Unknown scans are logged with their raw text."""
from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import Location, Operator, Product, ProductBarcode, Receipt, Task, Warehouse
from wms.services.stock import RuleError
from wms.services import audit
from wms.services.qty import qstr

GS = "\x1d"
SYMBOLOGY_PREFIXES = ("]Q3", "]Q1", "]C1", "]d2", "]e0", "]E0")

# AI -> (name, fixed length or None for variable, decimals from 4th digit?)
FIXED = {
    "00": ("sscc", 18), "01": ("gtin", 14), "02": ("content_gtin", 14), "11": ("production_date", 6),
    "12": ("due_date", 6), "13": ("packaging_date", 6), "15": ("best_before", 6), "16": ("sell_by", 6),
    "17": ("expiry", 6), "20": ("variant", 2), "410": ("ship_to_gln", 13), "414": ("gln", 13),
}
VARIABLE = {
    "10": ("batch", 20), "21": ("serial", 20), "22": ("cpv", 20), "240": ("additional_id", 30),
    "241": ("customer_part", 30), "250": ("secondary_serial", 30), "30": ("qty", 8), "37": ("qty", 8),
    "90": ("internal_90", 30), "91": ("internal_91", 90), "92": ("internal_92", 90), "93": ("internal_93", 90),
    "99": ("internal_99", 90), "400": ("order_number", 30), "401": ("consignment", 30), "403": ("routing", 30),
}
DECIMAL_PREFIXES = {"310": "weight_kg", "311": "length_m", "314": "area_m2", "315": "volume_l", "316": "volume_m3",
                    "320": "weight_lb", "330": "gross_weight_kg", "392": "price", "393": "price_iso"}


def parse_gs1(raw: str) -> dict[str, str] | None:
    """Element strings to a dict, or None if it does not parse cleanly to the end."""
    text = raw
    for p in SYMBOLOGY_PREFIXES:
        if text.startswith(p):
            text = text[len(p):]
            break
    if text.startswith("http"):  # GS1 Digital Link: https://example.com/01/09312345000012/10/B2609A
        parts = text.split("/")
        fields: dict[str, str] = {}
        i = 3
        while i + 1 < len(parts):
            ai, value = parts[i], parts[i + 1].split("?")[0]
            name = (FIXED.get(ai) or VARIABLE.get(ai) or (ai, None))[0]
            fields[name] = value
            i += 2
        return fields or None
    fields = {}
    i = 0
    while i < len(text):
        if text[i] == GS:
            i += 1
            continue
        matched = False
        for length in (4, 3, 2):
            ai = text[i:i + length]
            if len(ai) < length:
                continue
            if ai in FIXED:
                name, n = FIXED[ai]
                value = text[i + length:i + length + n]
                if len(value) < n:
                    return None
                fields[name] = value
                i += length + n
                matched = True
                break
            if ai in VARIABLE:
                name, maxlen = VARIABLE[ai]
                end = text.find(GS, i + length)
                value = text[i + length:] if end == -1 else text[i + length:end]
                if not value or len(value) > maxlen:
                    return None
                fields[name] = value
                i += length + len(value)
                matched = True
                break
            if length == 4 and ai[:3] in DECIMAL_PREFIXES and ai[3].isdigit():
                value = text[i + 4:i + 10]
                if len(value) < 6 or not value.isdigit():
                    return None
                decimals = int(ai[3])
                fields[DECIMAL_PREFIXES[ai[:3]]] = qstr(Decimal(value) / (Decimal(10) ** decimals))
                i += 10
                matched = True
                break
        if not matched:
            return None
    return fields or None


def looks_like_gs1(raw: str) -> bool:
    if raw.startswith(SYMBOLOGY_PREFIXES) or raw.startswith("https://") or raw.startswith("http://"):
        return True
    return raw[:2] in ("00", "01", "02") and len(raw) >= 16 and raw[:16].isdigit()


# What a custom pattern may name. A pattern that finds something the WMS has
# no idea what to do with is a typo, not a feature.
PATTERN_FIELDS = {"sku", "gtin", "batch", "qty", "uom", "location", "container_id", "sscc",
                  "badge", "operator", "ref", "po", "serial"}
PATTERN_TYPES = {"product", "location", "container", "operator", "receipt", "delivery",
                 "production_order", "task"}


def check_pattern(pattern: str) -> list[str]:
    """Compile it and say which fields it finds. Raises RuleError if it will
    never be any use."""
    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise RuleError("pattern", f"that is not a working pattern: {exc}") from exc
    fields = list(compiled.groupindex)
    if not fields:
        raise RuleError("pattern", "a pattern needs named parts, like (?P<sku>...), "
                                   "so the WMS knows what it found")
    unknown = [f for f in fields if f not in PATTERN_FIELDS]
    if unknown:
        raise RuleError("pattern", f"the WMS has no use for {', '.join(sorted(unknown))}; "
                                   f"it knows {', '.join(sorted(PATTERN_FIELDS))}")
    return fields


def site_patterns(db: Session, warehouse: Warehouse | None):
    from wms.models import ScanPattern

    rows = db.execute(
        select(ScanPattern).where(ScanPattern.active.is_(True)).order_by(ScanPattern.order, ScanPattern.id)
    ).scalars().all()
    return [p for p in rows
            if p.warehouse_id is None or (warehouse and p.warehouse_id == warehouse.id)]


def _from_pattern(db: Session, pattern, fields: dict, owner: str, wh) -> tuple[str, dict | None, str | None]:
    """Turn what a pattern found into something the WMS knows."""
    if pattern.type == "product":
        sku = fields.get("sku")
        found = None
        if sku:
            found = db.execute(select(Product).where(
                Product.owner == owner, Product.sku == sku)).scalar_one_or_none()
        if found is None and fields.get("gtin"):
            got = _by_barcode(db, fields["gtin"], owner)
            found = got[0] if got else None
        if found is None:
            return "product", None, f"No product {sku or fields.get('gtin')}"
        qty = Decimal(fields["qty"]) if fields.get("qty") else None
        out = _product_out(found, qty, None)
        if fields.get("batch"):
            out["batch"] = fields["batch"]
        if fields.get("uom"):
            out["uom"] = fields["uom"]
        return "product", out, None
    if pattern.type == "location":
        code = fields.get("location") or fields.get("ref")
        q = select(Location).where((Location.code == code) | (Location.barcode == code))
        if wh:
            q = q.where(Location.warehouse_id == wh.id)
        loc = db.execute(q).scalars().first()
        if loc is None:
            return "location", None, f"No location {code}"
        return "location", {"location": loc.code, "zone": loc.zone.code,
                            "warehouse": loc.warehouse.code}, None
    if pattern.type == "container":
        code = fields.get("container_id") or fields.get("sscc") or fields.get("ref")
        found = _container(db, code or "", owner)
        return "container", found, (None if found else f"No container {code}")
    if pattern.type == "operator":
        badge = fields.get("badge") or fields.get("operator") or fields.get("ref")
        op = db.execute(select(Operator).where(
            Operator.badge == badge, Operator.active.is_(True))).scalar_one_or_none()
        if op is None:
            return "operator", None, f"No operator with badge {badge}"
        return "operator", {"operator": op.code, "name": op.name,
                            "supervisor": "supervisor" in (op.roles or [])}, None
    # a reference of some kind: hand back what the pattern found
    ref = fields.get("ref") or fields.get("po")
    return pattern.type, ({"ref": ref} if ref else None), (None if ref else "Nothing to look up")


NOUN = {"product": "a product", "location": "a location", "operator": "an operator badge", "receipt": "a receipt",
        "container": "a container", "production_order": "a production order", "task": "a task", "unknown": "unknown"}


def _product_out(p: Product, qty: Decimal | None, kind: str | None) -> dict:
    return {"sku": p.sku, "name": p.name, "uom": p.uom, "batch_tracked": p.batch_tracked,
            "qty": qstr(qty) if qty is not None else None, "barcode_kind": kind}


def _container(db: Session, code: str, owner: str) -> dict | None:
    from wms.services.containers import find

    c = find(db, code, owner)
    if c is None:
        return None
    from wms.models import Location
    loc = db.get(Location, c.location_id) if c.location_id else None
    return {"container_id": c.container_id, "sscc": c.sscc, "type": c.type, "status": c.status,
            "location": loc.code if loc else None,
            "parent": c.parent.container_id if c.parent else None}


def _by_barcode(db: Session, code: str, owner: str) -> tuple[Product, ProductBarcode] | None:
    candidates = {code}
    if code.isdigit():
        candidates |= {code.lstrip("0"), code.zfill(14), code.zfill(13)}
    row = db.execute(
        select(ProductBarcode).join(Product).where(ProductBarcode.barcode.in_(candidates), Product.owner == owner)
    ).scalars().first()
    return (row.product, row) if row else None


def parse(db: Session, raw: str, *, warehouse: str | None, owner: str = "DEFAULT", expecting: str | None = None,
          device: str | None = None) -> dict[str, Any]:
    raw = raw.strip()
    result: dict[str, Any] = {"raw": raw, "format": "plain", "type": "unknown", "fields": {},
                              "resolved": None, "pattern": None}
    wh = db.execute(select(Warehouse).where(Warehouse.code == warehouse)).scalar_one_or_none() if warehouse else None

    fields = parse_gs1(raw) if looks_like_gs1(raw) else None
    if fields:
        result["format"] = "gs1"
        result["fields"] = fields
        if "sscc" in fields:
            result["type"] = "container"
            result["resolved"] = _container(db, fields["sscc"], owner) or {"sscc": fields["sscc"]}
        elif "gtin" in fields or "content_gtin" in fields:
            gtin = fields.get("gtin") or fields["content_gtin"]
            found = _by_barcode(db, gtin, owner)
            qty = None
            if fields.get("qty"):
                try:
                    qty = Decimal(fields["qty"])
                except InvalidOperation:
                    qty = None
            if found:
                p, bc = found
                result["type"] = "product"
                result["resolved"] = _product_out(p, qty if qty is not None else bc.qty_per, bc.kind)
                if fields.get("batch"):
                    result["resolved"]["batch"] = fields["batch"]
            else:
                result["type"] = "product"
                result["resolved"] = None
                result["message"] = f"No product has the GTIN {gtin}"
        return _finish(db, result, expecting, warehouse, device)

    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if isinstance(data, dict):
            result["format"] = "json"
            result["fields"] = {k: (qstr(Decimal(str(v))) if isinstance(v, (int, float)) else str(v)) for k, v in data.items()}
            po = data.get("po") or data.get("production_order")
            sku = data.get("sku")
            if po:
                result["type"] = "production_order"
                result["resolved"] = {"po": str(po)}
                if sku:
                    p = db.execute(select(Product).where(Product.owner == owner, Product.sku == str(sku))).scalar_one_or_none()
                    if p:
                        result["resolved"].update(_product_out(p, Decimal(str(data.get("qty"))) if data.get("qty") is not None else None, None))
                        result["resolved"]["batch"] = data.get("batch")
            elif sku:
                p = db.execute(select(Product).where(Product.owner == owner, Product.sku == str(sku))).scalar_one_or_none()
                if p:
                    result["type"] = "product"
                    result["resolved"] = _product_out(p, Decimal(str(data.get("qty"))) if data.get("qty") is not None else None, None)
            return _finish(db, result, expecting, warehouse, device)

    # a pattern the site wrote for its own labels
    for pattern in site_patterns(db, wh):
        match = re.match(pattern.pattern, raw)
        if not match:
            continue
        fields = {k: v for k, v in match.groupdict().items() if v is not None}
        result["format"] = "custom"
        result["pattern"] = pattern.name
        result["fields"] = fields
        kind, resolved, message = _from_pattern(db, pattern, fields, owner, wh)
        result["type"] = kind
        result["resolved"] = resolved
        if message:
            result["message"] = message
        return _finish(db, result, expecting, warehouse, device)

    # plain text, tried in order
    q = select(Location).where((Location.code == raw) | (Location.barcode == raw))
    if wh:
        q = q.where(Location.warehouse_id == wh.id)
    loc = db.execute(q).scalars().first()
    if loc:
        result["type"] = "location"
        result["resolved"] = {"location": loc.code, "zone": loc.zone.code, "warehouse": loc.warehouse.code}
        return _finish(db, result, expecting, warehouse, device)
    p = db.execute(select(Product).where(Product.owner == owner, Product.sku == raw)).scalar_one_or_none()
    if p:
        result["type"] = "product"
        result["resolved"] = _product_out(p, None, None)
        return _finish(db, result, expecting, warehouse, device)
    found = _by_barcode(db, raw, owner)
    if found:
        p, bc = found
        result["type"] = "product"
        result["resolved"] = _product_out(p, bc.qty_per, bc.kind)
        return _finish(db, result, expecting, warehouse, device)
    found_container = _container(db, raw, owner)
    if found_container:
        result["type"] = "container"
        result["resolved"] = found_container
        return _finish(db, result, expecting, warehouse, device)
    op = db.execute(select(Operator).where(Operator.badge == raw, Operator.active.is_(True))).scalar_one_or_none()
    if op:
        result["type"] = "operator"
        result["resolved"] = {"operator": op.code, "name": op.name, "supervisor": "supervisor" in (op.roles or [])}
        return _finish(db, result, expecting, warehouse, device)
    rq = select(Receipt).where(Receipt.owner == owner, Receipt.external_ref == raw)
    if wh:
        rq = rq.where(Receipt.warehouse_id == wh.id)
    receipt = db.execute(rq).scalars().first()
    if receipt:
        result["type"] = "receipt"
        result["resolved"] = {"receipt": receipt.external_ref, "status": receipt.status,
                              "task_id": str(receipt.task_id) if receipt.task_id else None}
        return _finish(db, result, expecting, warehouse, device)
    m = re.fullmatch(r"(?:T|TASK)-?(\d+)", raw, re.I)
    if m:
        task = db.get(Task, int(m.group(1)))
        if task:
            result["type"] = "task"
            result["resolved"] = {"task_id": str(task.id), "type": task.type, "status": task.status, "source_ref": task.source_ref}
            return _finish(db, result, expecting, warehouse, device)
    return _finish(db, result, expecting, warehouse, device)


def _finish(db: Session, result: dict, expecting: str | None, warehouse: str | None, device: str | None) -> dict:
    if result["type"] == "unknown":
        audit.record(db, actor_type="system", actor="scanner", action="scan.unknown", device=device,
                     detail={"raw": result["raw"], "warehouse": warehouse, "expecting": expecting})
        db.commit()
        result["message"] = "Not recognised. The raw text is kept so a pattern can be added on the desktop."
    if expecting:
        ok = result["type"] == expecting
        result["matches_expected"] = ok
        if not ok and result["type"] != "unknown":
            result["message"] = f"That is {NOUN.get(result['type'], result['type'])}. This step wants {NOUN.get(expecting, expecting)}."
            result["message"] = result["message"].replace("That is a ", "That is a ").replace("That is an operator badge", "That is a badge")
    else:
        result["matches_expected"] = None
    return result
