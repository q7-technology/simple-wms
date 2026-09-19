"""Insert-only audit log. Logins, failed logins, key use, permission changes."""
from __future__ import annotations

from sqlalchemy.orm import Session

from wms.models import AuditLog


def record(
    db: Session, *, actor_type: str, actor: str, action: str,
    target_type: str | None = None, target: str | None = None,
    device: str | None = None, ip: str | None = None, detail: dict | None = None,
) -> AuditLog:
    row = AuditLog(
        actor_type=actor_type, actor=actor, action=action, target_type=target_type,
        target=target, device=device, ip=ip, detail=detail or {},
    )
    db.add(row)
    db.flush()
    return row
