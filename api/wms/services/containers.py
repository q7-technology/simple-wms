"""Pallets, cartons and totes.

A container is a labelled physical thing. Stock is attributed to one when a
movement names it, so a pallet knows what is on it by asking the ledger,
which is the only place that ever knew. Cartons nest on pallets; moving a
pallet moves everything on it and everything nested inside it."""
from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from wms.models import Container, Location, Product, StockLedger, Warehouse
from wms.services import tasks
from wms.services.ledger import LedgerLine, post
from wms.services.qty import qstr
from wms.services.settings import effective
from wms.services.stock import RuleError, balance

# what may hold what
CAN_HOLD = {"pallet": ("carton", "tote", "cage"), "cage": ("carton", "tote"),
            "tote": (), "carton": ()}
PREFIXES = {"pallet": "PAL", "carton": "CTN", "tote": "TOTE", "cage": "CAGE"}


def sscc_check_digit(body: str) -> str:
    """GS1 mod 10: every second digit from the right counts three times."""
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return str((10 - total % 10) % 10)


def make_sscc(prefix: str, extension: int, serial: int) -> str:
    """Extension digit + company prefix + serial reference + check digit = 18."""
    body = f"{extension}{prefix}"
    filler = 17 - len(body)
    if filler < 1:
        raise RuleError("assign_sscc", f"the GS1 company prefix {prefix} leaves no room for a serial")
    body += str(serial).zfill(filler)[-filler:]
    return body + sscc_check_digit(body)


def assign_sscc(db: Session, container: Container, warehouse: Warehouse) -> str:
    settings = effective(warehouse.settings)
    prefix = settings["gs1_company_prefix"]
    if not prefix:
        raise RuleError("assign_sscc",
                        f"{warehouse.code} has no GS1 company prefix; set one on the Settings screen")
    container.sscc = make_sscc(prefix, settings["sscc_extension_digit"], container.id)
    db.flush()
    return container.sscc


def next_code(db: Session, type: str) -> str:
    n = db.execute(select(func.count()).select_from(Container).where(Container.type == type)).scalar_one()
    return f"{PREFIXES.get(type, 'CON')}-{n + 1:06d}"


def find(db: Session, ref: str, owner: str | None = None) -> Container | None:
    q = select(Container).where((Container.container_id == ref) | (Container.sscc == ref))
    if owner:
        q = q.where(Container.owner == owner)
    return db.execute(q).scalars().first()


def descendants(db: Session, container: Container) -> list[Container]:
    """Every container inside this one, however deep."""
    out: list[Container] = []
    queue = list(container.children)
    while queue:
        child = queue.pop(0)
        out.append(child)
        queue.extend(child.children)
    return out


def contents(db: Session, container: Container, include_nested: bool = False) -> list[dict]:
    """What is on it, from the ledger. Only movements that named the container
    count towards it, which is the honest answer."""
    codes = [container.container_id]
    if include_nested:
        codes += [c.container_id for c in descendants(db, container)]
    rows = db.execute(
        select(StockLedger.product_id, StockLedger.batch, StockLedger.uom, StockLedger.container_id,
               func.sum(StockLedger.qty_change).label("qty"),
               func.min(StockLedger.received_at).label("received_at"))
        .where(StockLedger.container_id.in_(codes), StockLedger.owner == container.owner)
        .group_by(StockLedger.product_id, StockLedger.batch, StockLedger.uom, StockLedger.container_id)
        .having(func.sum(StockLedger.qty_change) != 0)
    ).all()
    out = []
    for r in rows:
        product = db.get(Product, r.product_id)
        out.append({"sku": product.sku, "name": product.name, "batch": r.batch,
                    "qty": qstr(r.qty), "uom": r.uom, "container_id": r.container_id,
                    "received_at": r.received_at})
    out.sort(key=lambda c: (c["sku"], c["batch"] or ""))
    return out


def nest(db: Session, container: Container, parent: Container) -> None:
    if container.id == parent.id:
        raise RuleError("parent", "a container cannot hold itself")
    if parent.status != "open":
        raise tasks.TaskError("container_closed", f"{parent.container_id} is {parent.status}")
    allowed = CAN_HOLD.get(parent.type, ())
    if container.type not in allowed:
        raise RuleError("parent", f"a {parent.type} cannot hold a {container.type}")
    if container.id in {c.id for c in descendants(db, container)} or \
            parent.id in {c.id for c in descendants(db, container)}:
        raise RuleError("parent", f"{parent.container_id} is already inside {container.container_id}")
    if container.warehouse_id != parent.warehouse_id:
        raise RuleError("parent", "a container can only nest in the same warehouse")
    container.parent_id = parent.id
    container.location_id = parent.location_id
    for child in descendants(db, container):
        child.location_id = parent.location_id
    db.flush()


def unnest(db: Session, container: Container) -> None:
    container.parent_id = None
    db.flush()


def move(db: Session, container: Container, to: Location, *, reason: str | None,
         actor: tasks.Actor, note: str | None = None) -> Decimal:
    """Move the container and everything it carries, nested cartons included."""
    if to.warehouse_id != container.warehouse_id:
        raise RuleError("to_location", f"{to.code} is in another warehouse; use a transfer")
    if container.location_id == to.id:
        raise RuleError("to_location", f"{container.container_id} is already at {to.code}")

    family = [container, *descendants(db, container)]
    lines: list[LedgerLine] = []
    moved = Decimal(0)
    for member in family:
        if member.location_id is None:
            continue
        for item in contents(db, member):
            product = db.execute(select(Product).where(
                Product.owner == container.owner, Product.sku == item["sku"])).scalar_one()
            qty = Decimal(item["qty"])
            if qty <= 0:
                continue
            bal = balance(db, member.location_id, product.id, item["batch"], container.owner)
            received = (bal.received_at if bal else None) or date.today()
            common = dict(product_id=product.id, uom=item["uom"], batch=item["batch"],
                          owner=container.owner, container_id=member.container_id,
                          movement_type="move", received_at=received, actor=actor.name,
                          device=actor.device, api_client_id=actor.api_client_id,
                          reason=reason, note=note or f"container {container.container_id}")
            lines.append(LedgerLine(location_id=member.location_id, qty_change=-qty, **common))
            lines.append(LedgerLine(location_id=to.id, qty_change=qty, **common))
            moved += qty
    if lines:
        post(db, lines)
    for member in family:
        member.location_id = to.id
    db.flush()
    return moved


def close(db: Session, container: Container) -> None:
    container.status = "closed"
    container.closed_at = datetime.now(UTC)
    db.flush()


def reopen(db: Session, container: Container) -> None:
    if container.status == "shipped":
        raise tasks.TaskError("already_shipped", f"{container.container_id} has shipped")
    container.status = "open"
    container.closed_at = None
    db.flush()
