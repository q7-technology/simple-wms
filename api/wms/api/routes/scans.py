from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from wms.api.deps import DB, Principal, authorise, require
from wms.services import scans

router = APIRouter(tags=["scans"])


class ScanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    raw: str = Field(min_length=1, max_length=2000)
    expecting: str | None = Field(default=None, max_length=32)
    warehouse: str | None = Field(default=None, max_length=32)
    owner: str = Field(default="DEFAULT", max_length=32)
    device: str | None = Field(default=None, max_length=64)


class ScanOut(BaseModel):
    raw: str
    format: str
    type: str
    fields: dict[str, Any]
    resolved: dict[str, Any] | None
    matches_expected: bool | None
    message: str | None = None


@router.post("/scans/parse", response_model=ScanOut)
def parse_scan(body: ScanIn, db: DB, who: Principal = require("stock:read")):
    authorise(who, warehouse=body.warehouse, owner=body.owner)
    return scans.parse(db, body.raw, warehouse=body.warehouse, owner=body.owner, expecting=body.expecting,
                       device=body.device or who.device)
