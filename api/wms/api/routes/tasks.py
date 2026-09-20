"""Everything is a task. The board, the scanner's task list, and the actions
that do the work."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import Conflict, FieldError, Forbidden, NotFound
from wms.api.schemas import Page
from wms.api.schemas_tasks import (
    ApproveIn, AssignIn, CancelIn, CloseIn, ConfirmIn, RecountIn, ShortIn, StartIn, TaskOut, TaskReply,
    blind, line_out, task_out,
)
from wms.models import Task, TaskLine, Warehouse
from wms.services import access, stock
from wms.services import tasks as engine

router = APIRouter(tags=["tasks"])

LOAD = (
    selectinload(Task.lines).selectinload(TaskLine.product),
    selectinload(Task.lines).selectinload(TaskLine.from_location),
    selectinload(Task.lines).selectinload(TaskLine.to_location),
)


def get_task(db, id: int, who: Principal) -> tuple[Task, Warehouse]:
    task = db.execute(select(Task).options(*LOAD).where(Task.id == id)).scalar_one_or_none()
    if task is None:
        raise NotFound(f"no task {id}")
    wh = db.get(Warehouse, task.warehouse_id)
    authorise(who, warehouse=wh.code, owner=task.owner)
    return task, wh


def get_line(task: Task, line_no: int) -> TaskLine:
    for l in task.lines:
        if l.line_no == line_no:
            return l
    raise NotFound(f"task {task.id} has no line {line_no}")


def actor_for(db, who: Principal, body, wh: Warehouse) -> engine.Actor:
    supervisor = None
    badge = getattr(body, "supervisor_badge", None)
    if badge:
        op = access.find_supervisor_by_badge(db, badge, wh.code)
        if op is None:
            raise Forbidden("that badge is not a supervisor for this warehouse")
        supervisor = op.code
    return engine.Actor(
        name=getattr(body, "operator", None) or who.name, device=getattr(body, "device", None),
        api_client_id=who.api_client_id, supervisor=supervisor,
    )


def run(db, who, request, body, task, fn) -> object:
    """Run an action under the envelope, mapping engine errors to API errors."""
    def work():
        try:
            line = fn()
        except stock.RuleError as e:
            raise FieldError(e.field, e.message) from e
        except engine.TaskError as e:
            raise Conflict(e.code, e.message) from e
        db.flush()
        db.refresh(task)
        wh = db.get(Warehouse, task.warehouse_id)
        return TaskReply(message_id=body.message_id, wms_id=str(task.id), status="accepted",
                         task=task_out(task, wh), line=line_out(task, line, blind_counts=blind(wh)) if line is not None else None)

    return envelope.handle(db, who, body.message_id, request.url.path, work, owner=body.owner)


@router.get("/tasks", response_model=Page[TaskOut])
def list_tasks(
    db: DB, warehouse: str = Query(), status: str | None = None, type: str | None = None,
    assigned_to: str | None = None, source_ref: str | None = None, owner: str = "DEFAULT",
    limit: int = Query(default=200, le=2000), offset: int = 0, who: Principal = require("tasks:read"),
):
    authorise(who, warehouse=warehouse, owner=owner)
    wh = db.execute(select(Warehouse).where(Warehouse.code == warehouse)).scalar_one_or_none()
    if wh is None:
        raise FieldError("warehouse", f"unknown warehouse {warehouse}")
    q = select(Task).options(*LOAD).where(Task.warehouse_id == wh.id, Task.owner == owner)
    if status:
        q = q.where(Task.status.in_(status.split(",")))
    if type:
        q = q.where(Task.type.in_(type.split(",")))
    if assigned_to:
        q = q.where(Task.assigned_to == assigned_to)
    if source_ref:
        q = q.where(Task.source_ref == source_ref)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(engine.priority_order(Task.priority), Task.id).limit(limit).offset(offset)
    ).scalars().all()
    return Page(items=[task_out(t, wh) for t in rows], total=total)


@router.get("/tasks/{id}", response_model=TaskOut)
def get_task_detail(id: int, db: DB, who: Principal = require("tasks:read")):
    task, wh = get_task(db, id, who)
    return task_out(task, wh)


@router.post("/tasks/{id}/start", status_code=202, response_model=TaskReply)
def start_task(id: int, body: StartIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    task, wh = get_task(db, id, who)
    actor = actor_for(db, who, body, wh)
    return run(db, who, request, body, task, lambda: engine.start(db, task, actor))


@router.post("/tasks/{id}/assign", status_code=202, response_model=TaskReply)
def assign_task(id: int, body: AssignIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    task, wh = get_task(db, id, who)
    return run(db, who, request, body, task, lambda: engine.assign(db, task, body.assigned_to))


@router.post("/tasks/{id}/cancel", status_code=202, response_model=TaskReply)
def cancel_task(id: int, body: CancelIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    task, wh = get_task(db, id, who)
    actor = actor_for(db, who, body, wh)
    return run(db, who, request, body, task, lambda: engine.cancel(db, task, body.reason, actor))


@router.post("/tasks/{id}/close", status_code=202, response_model=TaskReply)
def close_task(id: int, body: CloseIn, request: Request, db: DB, who: Principal = require("tasks:write")):
    """Close short: what is not done stays undone and the document says so."""
    task, wh = get_task(db, id, who)
    actor = actor_for(db, who, body, wh)
    return run(db, who, request, body, task, lambda: engine.close_short(db, task, body.reason, actor))


@router.post("/tasks/{id}/lines/{line_no}/confirm", status_code=202, response_model=TaskReply)
def confirm_line(id: int, line_no: int, body: ConfirmIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    task, wh = get_task(db, id, who)
    line = get_line(task, line_no)
    actor = actor_for(db, who, body, wh)

    def do():
        engine.confirm(db, task, line, qty=body.qty, uom=body.uom, actor=actor, batch=body.batch,
                       to_location=body.location, from_location=body.from_location,
                       container_id=body.container_id, reason=body.reason, note=body.note)
        return line

    return run(db, who, request, body, task, do)


@router.post("/tasks/{id}/lines/{line_no}/short", status_code=202, response_model=TaskReply)
def short_line(id: int, line_no: int, body: ShortIn, request: Request, db: DB,
               who: Principal = require("tasks:write")):
    """Short pick: take what is there, say why, and let a supervisor sign it off.
    A quantity that looks wrong raises a count task for that shelf."""
    task, wh = get_task(db, id, who)
    line = get_line(task, line_no)
    actor = actor_for(db, who, body, wh)

    def do():
        engine.short_pick(db, task, line, qty=body.qty, reason=body.reason, actor=actor, note=body.note)
        return line

    return run(db, who, request, body, task, do)


@router.post("/tasks/{id}/lines/{line_no}/approve", status_code=202, response_model=TaskReply)
def approve_line(id: int, line_no: int, body: ApproveIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    """A supervisor accepts a count variance with a reason: ledger line + stock.adjusted."""
    task, wh = get_task(db, id, who)
    line = get_line(task, line_no)
    actor = actor_for(db, who, body, wh)
    if not actor.supervisor and not who.has_scope("tasks:approve"):
        raise Forbidden("approving a variance needs a supervisor badge or role")

    def do():
        engine.approve_variance(db, task, line, reason=body.reason, note=body.note, actor=actor)
        return line

    return run(db, who, request, body, task, do)


@router.post("/tasks/{id}/lines/{line_no}/recount", status_code=202, response_model=TaskReply)
def recount_line(id: int, line_no: int, body: RecountIn, request: Request, db: DB,
                 who: Principal = require("tasks:write")):
    task, wh = get_task(db, id, who)
    line = get_line(task, line_no)

    def do():
        engine.recount(db, task, line)
        return line

    return run(db, who, request, body, task, do)
