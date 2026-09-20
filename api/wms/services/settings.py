"""Per-warehouse switches, with defaults. Stored as JSON on the warehouse row."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class WarehouseSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Receiving and production
    erp_counts_gr: bool = False
    batch_from_production_order: bool = True
    receipt_tolerance_pct: float = Field(default=5, ge=0, le=100)
    supplier_tolerance_pct: float = Field(default=5, ge=0, le=100)
    # Picking and shipping
    allow_ship_short: bool = True
    supervisor_for_short_pick: bool = True
    auto_pick_mode: str = Field(default="auto", pattern="^(single|batch|auto)$")
    batch_pick_max_orders: int = Field(default=8, ge=1, le=100)
    # Scanners and security
    idle_logout_minutes: int = Field(default=15, ge=1, le=480)
    pin_lockout_tries: int = Field(default=5, ge=1, le=20)
    known_devices_only: bool = True
    queue_offline_confirmations: bool = True
    # Stock rules
    fifo_by_received_date: bool = True
    blind_counts: bool = True
    decimals_allowed: bool = True
    # Owners
    multi_owner: bool = False
    # Containers
    gs1_company_prefix: str | None = Field(default=None, pattern=r"^[0-9]{6,10}$")
    sscc_extension_digit: int = Field(default=0, ge=0, le=9)
    # Printing
    platen_url: str | None = None
    retry_failed_print_jobs: bool = True
    default_copies: int = Field(default=1, ge=1, le=10)
    # Data
    ledger_retention_years: int = Field(default=7, ge=1, le=50)
    duplicate_window_hours: int = Field(default=24, ge=1, le=720)
    allow_hard_deletes: bool = False

    @field_validator("allow_hard_deletes")
    @classmethod
    def _never(cls, v: bool) -> bool:
        if v:
            raise ValueError("hard deletes cannot be switched on; cancel instead")
        return v


def effective(stored: dict | None) -> dict:
    """Stored values over defaults."""
    return WarehouseSettings(**(stored or {})).model_dump()


def merge(stored: dict | None, patch: dict) -> dict:
    """Validate the patch against the whole and return the new stored dict."""
    merged = {**(stored or {}), **patch}
    return WarehouseSettings(**merged).model_dump()
