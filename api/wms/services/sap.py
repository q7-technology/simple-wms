"""The SAP adapter: an outbound event becomes a BAPI call.

Python was chosen for this API so that `pyrfc` would be available when an SAP
system turned up. It has, and this is it. It is not a second queue and not a
second retry scheme: an SAP subscriber is an ordinary row in `subscriber`
with `transport = "sap_rfc"`, its events sit in the same `outbound_event`
table, and a refusal from SAP backs off exactly like a listener that would
not answer.

The connection is handed in rather than made here. The worker hands over a
real `pyrfc.Connection`; a test hands over something that writes down what it
was asked to do. What is worth testing is the mapping, and the mapping is all
this module is.

`pyrfc` needs the SAP NetWeaver RFC SDK, which is licensed and not on any
public index, so it is imported only at the moment a connection is opened.
Every other part of this file works, and is tested, without it."""
from __future__ import annotations

import os
from datetime import date
from decimal import Decimal
from typing import Any, Protocol

from wms.models import OutboundEvent, Subscriber

TRANSPORT = "sap_rfc"

# A goods movement in SAP is one BAPI with a code saying what kind it is and a
# movement type saying which direction. These are the ordinary ones; a site
# with its own numbering overrides them in the subscriber's settings.
GM_CODES = {
    "receipt.confirmed": "01",              # goods receipt for a purchase order
    "production.received": "02",            # goods receipt for a production order
    "delivery.shipped": "03",               # goods issue
    "production.components_issued": "03",
    "stock.moved": "04",                    # transfer posting
    "stock.adjusted": "05",                 # other goods receipt / difference
    "transfer.shipped": "04",
    "transfer.received": "04",
}
MOVEMENT_TYPES = {
    "receipt.confirmed": "101",
    "production.received": "101",
    "delivery.shipped": "601",
    "production.components_issued": "261",
    "stock.moved": "311",
    "transfer.shipped": "351",              # stock in transit, out of the sending plant
    "transfer.received": "101",
    "stock.adjusted.up": "701",
    "stock.adjusted.down": "702",
}


class SapError(RuntimeError):
    """SAP refused, or could not be reached, or was not configured properly."""


class Unmapped(SapError):
    """This event type has no BAPI. Retrying will not invent one."""


class Rfc(Protocol):
    def call(self, function: str, **params: Any) -> dict: ...


# --- the connection ---------------------------------------------------------------

def connection_params(sub: Subscriber) -> dict:
    """The `pyrfc` connection parameters for this subscriber. The password is
    never in the database: the settings name an environment variable and the
    value is read from the host, beside every other secret."""
    conn = dict((sub.settings or {}).get("connection") or {})
    if not conn:
        raise SapError(f"subscriber {sub.name} has no SAP connection in its settings")
    env = conn.pop("passwd_env", None)
    if env:
        value = os.environ.get(env)
        if not value:
            raise SapError(f"{env} is not set on this host, so {sub.name} cannot sign in to SAP")
        conn["passwd"] = value
    if "passwd" not in conn:
        raise SapError(f"subscriber {sub.name} has no SAP password; set passwd_env in its settings")
    return conn


def connect(sub: Subscriber) -> Rfc:
    """Open a connection to SAP. Imported here, not at the top of the file,
    because `pyrfc` needs the SAP NetWeaver RFC SDK and most installations of
    this WMS will never have it."""
    try:
        import pyrfc  # noqa: PLC0415  the SDK is optional and licensed
    except ImportError as exc:
        raise SapError(
            "pyrfc is not installed, so this WMS cannot talk to SAP. It needs the "
            "SAP NetWeaver RFC SDK from the SAP Software Downloads, which is "
            "licensed and cannot be fetched from PyPI, and then "
            "`pip install pyrfc`. See docs/api.md under SAP."
        ) from exc
    params = connection_params(sub)
    try:
        return pyrfc.Connection(**params)
    except Exception as exc:  # noqa: BLE001  pyrfc raises its own family
        raise SapError(f"could not reach SAP: {type(exc).__name__}: {exc}") from exc


# --- building the posting -----------------------------------------------------------

def _settings(sub: Subscriber) -> dict:
    return sub.settings or {}


def _plant(sub: Subscriber, warehouse: str | None) -> str:
    plants = _settings(sub).get("plant_by_warehouse") or {}
    plant = plants.get(warehouse or "")
    if not plant:
        raise SapError(
            f"no SAP plant for warehouse {warehouse} on subscriber {sub.name}; "
            "add it to plant_by_warehouse in the subscriber's settings")
    return str(plant)


def _storage_location(sub: Subscriber, warehouse: str | None) -> str:
    by_warehouse = _settings(sub).get("storage_location_by_warehouse") or {}
    loc = by_warehouse.get(warehouse or "") or _settings(sub).get("storage_location")
    if not loc:
        raise SapError(
            f"no SAP storage location for warehouse {warehouse} on subscriber {sub.name}; "
            "set storage_location in the subscriber's settings")
    return str(loc)


def _movement_type(sub: Subscriber, key: str) -> str:
    override = (_settings(sub).get("movement_types") or {}).get(key)
    if override:
        return str(override)
    kind = MOVEMENT_TYPES.get(key)
    if kind is None:
        raise Unmapped(f"no SAP movement type for {key}")
    return kind


def _qty(value: Any) -> str:
    """A quantity crosses as the decimal string it already is. Turning it into
    a float on the way to a stock posting is how a warehouse ends up with
    23.999999 on a shelf."""
    return str(Decimal(str(value)).normalize()) if Decimal(str(value)) else "0"


def _item(sub: Subscriber, warehouse: str | None, *, sku: str, qty: Any, uom: str,
          move_type: str, batch: str | None = None, extra: dict | None = None) -> dict:
    item = {
        "MATERIAL": sku,
        "PLANT": _plant(sub, warehouse),
        "STGE_LOC": _storage_location(sub, warehouse),
        "MOVE_TYPE": move_type,
        "ENTRY_QNT": _qty(qty),
        "ENTRY_UOM": uom,
    }
    if batch:
        item["BATCH"] = batch
    item.update(extra or {})
    return item


def build(sub: Subscriber, event: OutboundEvent) -> dict:
    """The BAPI_GOODSMVT_CREATE parameters for one event, or Unmapped."""
    payload = event.payload or {}
    data = payload.get("data") or {}
    warehouse = event.warehouse
    kind = event.event_type
    gm_code = (_settings(sub).get("gm_codes") or {}).get(kind) or GM_CODES.get(kind)
    if gm_code is None:
        raise Unmapped(
            f"no BAPI mapping for {kind}; an SAP subscriber should not be subscribed to it")

    # SAP's reference document is the paper this movement belongs to: the
    # purchase order, the delivery, the production order. The envelope's
    # external_ref is the same thing in every case the WMS raises itself, but
    # the data says it plainly, so prefer that.
    reference = (data.get("receipt_ref") or data.get("delivery_ref") or data.get("po_ref")
                 or data.get("transfer_ref") or event.external_ref or "")
    header = {"PSTNG_DATE": date.today(), "DOC_DATE": date.today(),
              "REF_DOC_NO": reference[:16],
              "HEADER_TXT": f"WMS {kind}"[:25]}
    items: list[dict] = []

    if kind == "receipt.confirmed":
        items.append(_item(sub, warehouse, sku=data["sku"], qty=data["qty"], uom=data["uom"],
                           move_type=_movement_type(sub, kind), batch=data.get("batch"),
                           extra={"PO_NUMBER": (data.get("receipt_ref") or "")[:10]}
                           if data.get("receipt_ref") else None))
    elif kind == "production.received":
        items.append(_item(sub, warehouse, sku=data["sku"], qty=data["qty"], uom=data["uom"],
                           move_type=_movement_type(sub, kind), batch=data.get("batch"),
                           extra={"ORDERID": data.get("po_ref")}))
    elif kind == "production.components_issued":
        for line in data.get("lines") or []:
            items.append(_item(sub, warehouse, sku=line["sku"], qty=line.get("qty_issued", 0),
                               uom=line["uom"], move_type=_movement_type(sub, kind),
                               batch=line.get("batch"), extra={"ORDERID": data.get("po_ref")}))
    elif kind == "delivery.shipped":
        for line in data.get("lines") or []:
            items.append(_item(sub, warehouse, sku=line["sku"], qty=line.get("qty_shipped", 0),
                               uom=line["uom"], move_type=_movement_type(sub, kind),
                               batch=line.get("batch")))
    elif kind in ("transfer.shipped", "transfer.received"):
        qty_field = "qty_shipped" if kind == "transfer.shipped" else "qty_received"
        for line in data.get("lines") or []:
            items.append(_item(sub, warehouse, sku=line["sku"], qty=line.get(qty_field, 0),
                               uom=line["uom"], move_type=_movement_type(sub, kind),
                               batch=line.get("batch")))
    elif kind == "stock.moved":
        # One plant, one storage location either side: the shelf a thing sits
        # on is the WMS's business and SAP has never heard of it.
        items.append(_item(sub, warehouse, sku=data["sku"], qty=data["qty"], uom=data["uom"],
                           move_type=_movement_type(sub, kind), batch=data.get("batch"),
                           extra={"MOVE_STLOC": _storage_location(sub, warehouse)}))
    elif kind == "stock.adjusted":
        change = Decimal(str(data["qty_change"]))
        direction = "up" if change > 0 else "down"
        items.append(_item(sub, warehouse, sku=data["sku"], qty=abs(change), uom=data["uom"],
                           move_type=_movement_type(sub, f"stock.adjusted.{direction}"),
                           batch=data.get("batch")))
    else:
        raise Unmapped(f"no BAPI mapping for {kind}")

    if not items:
        raise Unmapped(f"{kind} for {event.external_ref} has nothing to post")
    return {"GOODSMVT_HEADER": header, "GOODSMVT_CODE": {"GM_CODE": gm_code},
            "GOODSMVT_ITEM": items}


# --- posting it ---------------------------------------------------------------------

def _complaints(reply: dict) -> list[str]:
    """SAP answers in a table rather than a status code. Anything of type E or
    A is a refusal, whatever else the table says."""
    out = []
    for row in reply.get("RETURN") or []:
        if str(row.get("TYPE", "")).upper() in ("E", "A"):
            message = row.get("MESSAGE") or f"{row.get('ID', '')}{row.get('NUMBER', '')}"
            out.append(message.strip())
    return out


def deliver(event: OutboundEvent, rfc: Rfc) -> str:
    """Post one event to SAP. Returns the material document number. Raises
    SapError if SAP refused, having rolled the work back first: a half-posted
    goods movement is worse than none."""
    sub = event.subscriber
    params = build(sub, event)
    reply = rfc.call("BAPI_GOODSMVT_CREATE", **params)
    problems = _complaints(reply)
    if problems:
        rfc.call("BAPI_TRANSACTION_ROLLBACK")
        raise SapError("; ".join(problems)[:500])
    rfc.call("BAPI_TRANSACTION_COMMIT", WAIT="X")
    return str(reply.get("MATERIALDOCUMENT") or "")
