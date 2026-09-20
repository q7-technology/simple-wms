from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

from wms.api.envelope import Envelope


def fmt_qty(d: Decimal) -> str:
    """Decimal to a plain string with no trailing zeros: 48.000000 -> "48"."""
    return format(d.normalize(), "f") if d else "0"


Qty = Annotated[Decimal, PlainSerializer(fmt_qty, return_type=str, when_used="json")]


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- structure -----------------------------------------------------------

class SiteIn(Envelope):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    timezone: str = Field(default="Australia/Melbourne", max_length=64)
    active: bool = True


class SiteOut(Out):
    wms_id: str
    code: str
    name: str
    timezone: str
    active: bool


class WarehouseIn(Envelope):
    code: str = Field(min_length=1, max_length=32)
    site: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    settings: dict = Field(default_factory=dict)
    active: bool = True


class WarehouseOut(Out):
    wms_id: str
    code: str
    site: str
    name: str
    settings: dict
    active: bool


class ZoneIn(Envelope):
    warehouse: str = Field(min_length=1, max_length=32)
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["bulk", "pickface", "packing", "staging", "in_transit", "overflow", "line_side"] = "bulk"
    active: bool = True


class ZoneOut(Out):
    wms_id: str
    warehouse: str
    code: str
    name: str
    kind: str
    active: bool


class LocationIn(Envelope):
    warehouse: str = Field(min_length=1, max_length=32)
    code: str = Field(min_length=1, max_length=64)
    zone: str = Field(min_length=1, max_length=32)
    type: Literal["shelf", "floor", "rack", "dock", "line_side", "in_transit"] = "shelf"
    access: Literal["ground", "step", "forklift"] = "ground"
    mixing: Literal["mixed", "single_sku", "single_batch"] = "mixed"
    capacity: Decimal | None = Field(default=None, ge=0)
    capacity_uom: str | None = Field(default=None, max_length=16)
    pick_sequence: int = 0
    barcode: str | None = Field(default=None, max_length=128)
    active: bool = True


class LocationOut(Out):
    wms_id: str
    warehouse: str
    code: str
    zone: str
    type: str
    access: str
    mixing: str
    capacity: Qty | None
    capacity_uom: str | None
    pick_sequence: int
    barcode: str | None
    active: bool


# --- products ------------------------------------------------------------

class BarcodeIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    barcode: str = Field(max_length=128)
    kind: Literal["gtin", "carton", "supplier", "other"] = "gtin"
    qty_per: Decimal = Field(default=Decimal(1), gt=0)


class BarcodeOut(Out):
    barcode: str
    kind: str
    qty_per: Qty


class ProductIn(Envelope):
    sku: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    uom: str = Field(default="EA", max_length=16)
    decimals_allowed: bool = False
    batch_tracked: bool = False
    preferred_zone: str | None = Field(default=None, max_length=32)
    pickface_min: Decimal | None = Field(default=None, ge=0)
    pickface_max: Decimal | None = Field(default=None, ge=0)
    barcodes: list[BarcodeIn] = Field(default_factory=list)
    active: bool = True


class ProductOut(Out):
    wms_id: str
    owner: str
    sku: str
    name: str
    uom: str
    decimals_allowed: bool
    batch_tracked: bool
    preferred_zone: str | None
    pickface_min: Qty | None
    pickface_max: Qty | None
    barcodes: list[BarcodeOut]
    active: bool


class Page[T](BaseModel):
    items: list[T]
    total: int


# --- stock ---------------------------------------------------------------

class StockAtLocation(BaseModel):
    warehouse: str
    location: str
    zone: str
    batch: str | None
    owner: str
    on_hand: Qty
    reserved: Qty
    available: Qty
    received_at: date | None


class StockBySku(BaseModel):
    sku: str
    uom: str
    total_on_hand: Qty
    total_available: Qty
    locations: list[StockAtLocation]


class StockLine(BaseModel):
    sku: str
    name: str
    batch: str | None
    owner: str
    on_hand: Qty
    reserved: Qty
    available: Qty
    uom: str
    received_at: date | None


class StockAtShelf(BaseModel):
    wms_id: str
    warehouse: str
    location: str
    zone: str
    stock: list[StockLine]
