"""Where should it go? Rules tried in order:
same product with space → empty shelf in the preferred zone → any allowed
empty shelf → overflow location with a flag. The operator may override; the
ledger records where it really went."""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from wms.models import Location, Product, Warehouse, Zone
from wms.services import stock

STORAGE_TYPES = ("shelf", "rack", "floor")


def suggest(db: Session, warehouse: Warehouse, product: Product, batch: str | None,
            qty: Decimal, uom: str, owner: str = "DEFAULT", limit: int = 5) -> tuple[list[dict], str | None]:
    locations = db.execute(
        select(Location).options(selectinload(Location.zone))
        .where(Location.warehouse_id == warehouse.id, Location.active.is_(True),
               Location.type.in_(STORAGE_TYPES))
        .order_by(Location.pick_sequence, Location.code)
    ).scalars().all()

    def allowed(loc: Location) -> bool:
        try:
            stock.check_mixing(db, loc, product, batch)
        except stock.RuleError:
            return False
        return stock.has_space(db, loc, product, qty, uom)

    out: list[dict] = []
    seen: set[int] = set()

    def add(loc: Location, reason: str):
        if loc.id not in seen:
            seen.add(loc.id)
            out.append({"location": loc.code, "zone": loc.zone.code, "reason": reason})

    normal = [l for l in locations if l.zone.kind not in ("overflow", "staging", "in_transit", "line_side")]
    # 1. same product with space
    for loc in normal:
        if stock.on_hand_total(db, loc.id, product.id, owner) > 0 and allowed(loc):
            add(loc, "same_sku_has_space")
    # 2. empty shelf in the preferred zone
    empties = [l for l in normal if not stock.balances_at(db, l.id)]
    for loc in empties:
        if product.preferred_zone and loc.zone.code == product.preferred_zone:
            add(loc, "empty_in_preferred_zone")
    # 3. any allowed empty shelf
    for loc in empties:
        if allowed(loc):
            add(loc, "empty_shelf")
    flag = None
    if not out:
        # 4. overflow, flagged so someone finds it a home
        for loc in locations:
            if loc.zone.kind == "overflow":
                add(loc, "overflow")
                flag = "overflow"
                break
    return out[:limit], flag
