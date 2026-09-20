"""Scanner sign in: a known device, an operator, a PIN or a badge. Five wrong
PINs lock the account until a supervisor unlocks it."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from wms.models import Device, Operator, Warehouse
from wms.services import access, audit
from wms.services.settings import effective

LOCKED_FOREVER = datetime(9999, 12, 31, tzinfo=UTC)


class ScannerAuthError(Exception):
    def __init__(self, status: int, code: str, message: str, tries_left: int | None = None):
        self.status = status
        self.code = code
        self.message = message
        self.tries_left = tries_left
        super().__init__(message)


def is_locked(op: Operator) -> bool:
    return bool(op.locked_until and op.locked_until > datetime.now(UTC))


def check_device(db: Session, device_code: str, warehouse: Warehouse) -> Device:
    settings = effective(warehouse.settings)
    device = db.execute(select(Device).where(Device.code == device_code)).scalar_one_or_none()
    if settings["known_devices_only"] and (device is None or not device.active):
        raise ScannerAuthError(403, "unknown_device", f"{device_code} is not a registered scanner; ask a supervisor to register it")
    if device is None:
        device = Device(code=device_code, name=device_code, warehouse_id=warehouse.id)
        db.add(device)
    device.last_seen_at = datetime.now(UTC)
    db.flush()
    return device


def login(db: Session, *, device_code: str, warehouse: Warehouse, operator_id: str | None, pin: str | None,
          badge: str | None, ip: str | None) -> Operator:
    device = check_device(db, device_code, warehouse)
    who = operator_id or badge or "?"

    def fail(code: str, message: str, status: int = 401, tries_left: int | None = None, op: Operator | None = None):
        audit.record(db, actor_type="operator", actor=op.code if op else who, action="scanner.login_failed",
                     device=device.code, ip=ip, detail={"reason": code, "warehouse": warehouse.code})
        db.commit()
        raise ScannerAuthError(status, code, message, tries_left)

    if badge:
        op = db.execute(select(Operator).where(Operator.badge == badge)).scalar_one_or_none()
    elif operator_id:
        op = db.execute(select(Operator).where(Operator.code == operator_id)).scalar_one_or_none()
    else:
        raise ScannerAuthError(422, "missing", "scan a badge or type an operator ID and PIN")
    if op is None or not op.active:
        fail("unknown_operator", "no active operator with that ID or badge")
    if is_locked(op):
        fail("locked", f"{op.code} is locked after too many wrong PINs; a supervisor can unlock it", op=op)
    if not ("*" in (op.warehouses or []) or warehouse.code in (op.warehouses or [])):
        fail("not_allowed", f"{op.code} does not work at {warehouse.code}", status=403, op=op)
    if not badge:
        if not pin or not access.verify_password(pin, op.pin_hash):
            op.failed_attempts += 1
            limit = effective(warehouse.settings)["pin_lockout_tries"]
            if op.failed_attempts >= limit:
                op.locked_until = LOCKED_FOREVER
                audit.record(db, actor_type="operator", actor=op.code, action="operator.locked",
                             device=device.code, ip=ip, detail={"after_tries": op.failed_attempts})
                fail("locked", f"wrong PIN {limit} times; {op.code} is locked until a supervisor unlocks it", op=op)
            fail("wrong_pin", "wrong PIN", tries_left=limit - op.failed_attempts, op=op)
    op.failed_attempts = 0
    audit.record(db, actor_type="operator", actor=op.code, action="scanner.login", device=device.code, ip=ip,
                 detail={"warehouse": warehouse.code, "by": "badge" if badge else "pin"})
    db.commit()
    return op


def unlock(db: Session, *, device_code: str, warehouse: Warehouse, operator_id: str, supervisor_badge: str,
           new_pin: str | None, ip: str | None) -> Operator:
    device = check_device(db, device_code, warehouse)
    sup = access.find_supervisor_by_badge(db, supervisor_badge, warehouse.code)
    if sup is None:
        raise ScannerAuthError(403, "not_supervisor", "that badge is not a supervisor for this warehouse")
    op = db.execute(select(Operator).where(Operator.code == operator_id)).scalar_one_or_none()
    if op is None:
        raise ScannerAuthError(404, "unknown_operator", f"no operator {operator_id}")
    op.failed_attempts = 0
    op.locked_until = None
    if new_pin:
        op.pin_hash = access.hash_password(new_pin)
    audit.record(db, actor_type="operator", actor=sup.code, action="operator.unlocked", target_type="operator",
                 target=op.code, device=device.code, ip=ip, detail={"new_pin": bool(new_pin)})
    db.commit()
    return op
