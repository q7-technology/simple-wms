from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

from wms.api.envelope import Accepted, Envelope
from wms.api.schemas import Qty
from wms.models import Task, TaskLine, Warehouse
from wms.services import tasks as task_engine
from wms.services.settings import effective


class LineOut(BaseModel):
    line_no: int
    source_line: int | None
    sku: str
    name: str
    batch: str | None
    expected_qty: Qty | None
    actual_qty: Qty | None
    variance: Qty | None
    uom: str
    from_location: str | None
    to_location: str | None
    container_id: str | None
    status: str
    reason: str | None
    completed_at: datetime | None


class TaskOut(BaseModel):
    wms_id: str
    type: str
    title: str
    status: str
    warehouse: str
    owner: str
    priority: str
    source_type: str | None
    source_ref: str | None
    assigned_to: str | None
    device: str | None
    needs_supervisor: bool
    note: str | None
    created_by: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    cancelled_at: datetime | None
    progress: dict
    lines: list[LineOut]


def blind(warehouse: Warehouse) -> bool:
    """Whether this warehouse counts blind."""
    return bool(effective(warehouse.settings)["blind_counts"])


def line_out(task: Task, l: TaskLine, *, blind_counts: bool = True) -> LineOut:
    # A count can be blind, where the counter is never shown what the system
    # thinks is there. It is a per-warehouse switch, and off by default: a
    # counter who can see the figure catches an obvious mistake on the spot.
    blind = blind_counts and task.type == "count" and l.status == "open"
    variance = None
    if task.type == "count" and l.actual_qty is not None and l.expected_qty is not None and l.status != "open":
        variance = l.actual_qty - l.expected_qty
    return LineOut(
        line_no=l.line_no, source_line=l.source_line, sku=l.product.sku, name=l.product.name, batch=l.batch,
        expected_qty=None if blind else l.expected_qty, actual_qty=l.actual_qty, variance=variance, uom=l.uom,
        from_location=l.from_location.code if l.from_location else None,
        to_location=l.to_location.code if l.to_location else None, container_id=l.container_id,
        status=l.status, reason=l.reason, completed_at=l.completed_at,
    )


def task_out(task: Task, warehouse: Warehouse | str) -> TaskOut:
    """The warehouse comes in whole where the caller has it, because the count
    switch lives in its settings. A bare code still works and counts blind."""
    blind_counts = True if isinstance(warehouse, str) else effective(warehouse.settings)["blind_counts"]
    code = warehouse if isinstance(warehouse, str) else warehouse.code
    return TaskOut(
        wms_id=str(task.id), type=task.type, title=task_engine.title(task), status=task.status,
        warehouse=code, owner=task.owner, priority=task.priority, source_type=task.source_type,
        source_ref=task.source_ref, assigned_to=task.assigned_to, device=task.device,
        needs_supervisor=task.needs_supervisor, note=task.note, created_by=task.created_by,
        created_at=task.created_at, started_at=task.started_at, completed_at=task.completed_at,
        cancelled_at=task.cancelled_at, progress=task_engine.progress(task),
        lines=[line_out(task, l, blind_counts=blind_counts) for l in task.lines],
    )


class TaskReply(Accepted):
    task: TaskOut
    line: LineOut | None = None


# --- action bodies (all carry the envelope: scanners retry them) ----------

class ActorFields(Envelope):
    operator: str | None = Field(default=None, max_length=64)
    device: str | None = Field(default=None, max_length=64)


class StartIn(ActorFields):
    pass


class AssignIn(Envelope):
    assigned_to: str | None = Field(default=None, max_length=64)


class CancelIn(ActorFields):
    reason: str | None = Field(default=None, max_length=64)


class CloseIn(ActorFields):
    reason: str | None = Field(default=None, max_length=64)


class ConfirmIn(ActorFields):
    qty: Decimal
    uom: str | None = Field(default=None, max_length=16)
    batch: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=64)  # where it goes (receive, move to)
    from_location: str | None = Field(default=None, max_length=64)
    container_id: str | None = Field(default=None, max_length=64)
    reason: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)
    supervisor_badge: str | None = Field(default=None, max_length=128)


class ApproveIn(ActorFields):
    reason: str = Field(max_length=64)
    note: str | None = Field(default=None, max_length=500)
    supervisor_badge: str | None = Field(default=None, max_length=128)


class RecountIn(ActorFields):
    pass


class ShortIn(ActorFields):
    """What was actually found, and why the rest is not coming."""
    qty: Decimal = Field(default=Decimal(0), ge=0)
    uom: str | None = Field(default=None, max_length=16)
    reason: Literal["not_found", "short_on_shelf", "damaged", "location_unreadable", "customer_cancelled"]
    note: str | None = Field(default=None, max_length=500)
    supervisor_badge: str | None = Field(default=None, max_length=128)


Priority = Literal["low", "normal", "high"]
