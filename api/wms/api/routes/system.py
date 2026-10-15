"""Site-wide settings: the ones that used to need an edit to `.env` and a
restart. Admins only."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from wms.api.deps import DB, Principal, require
from wms.api.errors import field_errors
from wms.services import audit, system

router = APIRouter(tags=["system"])


@router.get("/system/settings")
def get_system_settings(db: DB, who: Principal = require("system:read")):
    """What is in force, and where each value came from. Secrets only say
    whether they are set."""
    return system.describe(db)


@router.patch("/system/settings")
def patch_system_settings(patch: dict, db: DB, who: Principal = require("system:write")):
    """Save these keys. A null clears the saved value, back to `.env`."""
    try:
        system.save(db, patch)
    except ValidationError as exc:
        return JSONResponse(status_code=422, content={"errors": field_errors(exc.errors())})
    audit.record(db, actor_type=who.kind, actor=who.name, action="system.settings_changed",
                 target_type="system", target="settings", ip=who.ip,
                 detail=system.redacted(patch))
    db.commit()
    system.forget()
    return system.describe(db)
