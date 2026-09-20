import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Accepted, Page, Task, TaskLine, TaskReply, TaskStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill, Section,
} from "../ui";
import { Main } from "../ui/Shell";

const TYPE_LABEL: Record<string, string> = {
  receive: "Receive", putaway: "Put away", pick: "Pick", pack: "Pack", ship: "Ship", move: "Move",
  count: "Count", replenish: "Replenish", transfer_out: "Transfer out", transfer_in: "Transfer in",
  production_issue: "Issue to production", production_receipt: "Production receipt",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  waiting: "Waiting", in_progress: "In progress", needs_supervisor: "Needs a supervisor", done: "Done", cancelled: "Cancelled",
};

const REASONS: { value: string; label: string }[] = [
  { value: "count_variance", label: "Count variance" },
  { value: "damaged", label: "Damaged" },
  { value: "found", label: "Found" },
  { value: "data_entry_error", label: "Data entry error" },
];

type ColumnKey = "waiting" | "in_progress" | "needs_supervisor" | "done";
const COLUMNS: { key: ColumnKey; label: string; empty: string }[] = [
  { key: "waiting", label: "Waiting", empty: "Nothing waiting. New orders and receipts land here." },
  { key: "in_progress", label: "In progress", empty: "Nobody has started a task yet." },
  { key: "needs_supervisor", label: "Needs a supervisor", empty: "Nothing to approve." },
  { key: "done", label: "Done today", empty: "Nothing finished yet today." },
];
const SHOWN_PER_COLUMN = 8;

type Mode = "task" | "assign" | "create";

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/** "a, b , c" → ["a", "b", "c"]. */
function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function typeLabel(type: string) {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

function isToday(iso: string | null, now = new Date()) {
  return !!iso && new Date(iso).toDateString() === now.toDateString();
}

function minutesSince(iso: string | null, now = Date.now()) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** 29 → "29 min", 70 → "1 h 10 min". */
function fmtMinutes(m: number) {
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function shortBy(l: TaskLine): string {
  return String(Number(l.expected_qty ?? 0) - Number(l.actual_qty ?? 0));
}

/** The one-line story under a card in the "Needs a supervisor" column. */
function supervisorLine(t: Task): string {
  const variance = t.lines.find((l) => l.status === "variance");
  if (variance) {
    return `${fmtQty(variance.variance, variance.uom)} at ${variance.from_location ?? variance.to_location ?? "?"} · approve or recount`;
  }
  const short = t.lines.find((l) => l.status === "short");
  if (short) return `${fmtQty(shortBy(short), short.uom)} ${short.sku} not found · approve or recount`;
  return t.note ?? "over tolerance · accept?";
}

function secondLine(t: Task, column: ColumnKey): string {
  switch (column) {
    case "waiting":
      return `${plural(t.lines.length, "line")} · ${t.source_type ? t.source_type.replace(/_/g, " ") : typeLabel(t.type).toLowerCase()}`;
    case "in_progress":
      return `${t.assigned_to ?? "unassigned"} · line ${Math.min(t.progress.done + 1, Math.max(t.progress.total, 1))} of ${t.progress.total} · ${fmtMinutes(minutesSince(t.started_at))}`;
    case "needs_supervisor":
      return supervisorLine(t);
    case "done":
      return `${t.assigned_to ?? "—"} · ${fmtWhen(t.completed_at)}`;
  }
}

function linePill(l: TaskLine) {
  switch (l.status) {
    case "done": return <Pill tone="ok">Done</Pill>;
    case "short": return <Pill tone="warn">Short</Pill>;
    case "variance": return <Pill tone="warn">Variance {fmtQty(l.variance)}</Pill>;
    case "cancelled": return <Pill tone="muted">Cancelled</Pill>;
    default: return <Pill tone="info">Open</Pill>;
  }
}

/* --- board ---------------------------------------------------------------- */

function TaskCard({ task, column, selected, onClick }: { task: Task; column: ColumnKey; selected: boolean; onClick: () => void }) {
  const gold = column === "needs_supervisor";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
      className={cx(
        "card p-4 flex flex-col gap-1 cursor-pointer hover:bg-brand-tint",
        gold && "border-gold-line",
        column === "in_progress" && "border-line-strong",
        selected && "bg-brand-tint",
      )}
    >
      <span className={cx("text-sm leading-5 font-semibold truncate", gold ? "text-gold" : "text-ink")}>{task.title}</span>
      <span className="text-xs leading-4 text-muted">{secondLine(task, column)}</span>
    </div>
  );
}

function BoardColumn({ column, tasks, selectedId, onSelect, loading }: {
  column: typeof COLUMNS[number]; tasks: Task[]; selectedId: string | null; onSelect: (id: string) => void; loading: boolean;
}) {
  const shown = tasks.slice(0, SHOWN_PER_COLUMN);
  const more = tasks.length - shown.length;
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <span className="eyebrow text-muted">{column.label} · {tasks.length}</span>
      {loading && tasks.length === 0 && <Muted className="text-sm">Loading…</Muted>}
      {!loading && tasks.length === 0 && <Muted className="text-sm">{column.empty}</Muted>}
      {shown.map((t) => (
        <TaskCard key={t.wms_id} task={t} column={column.key} selected={t.wms_id === selectedId} onClick={() => onSelect(t.wms_id)} />
      ))}
      {more > 0 && <span className="text-xs leading-4 text-muted">+{more} more</span>}
    </div>
  );
}

/* --- detail panel -------------------------------------------------------- */

function ApproveForm({ taskId, line, reload }: { taskId: string; line: TaskLine; reload: () => Promise<void> }) {
  const action = useAction();
  const [reason, setReason] = useState("count_variance");
  const [note, setNote] = useState("");

  const approve = async () => {
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${taskId}/lines/${line.line_no}/approve`, {
      reason, note: note.trim() || null,
    }));
    if (out) await reload();
  };
  const recount = async () => {
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${taskId}/lines/${line.line_no}/recount`, {}));
    if (out) await reload();
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gold-line p-3">
      <span className="text-xs leading-4 text-gold">Approve with a reason</span>
      <div className="flex gap-1 flex-wrap">
        {REASONS.map((r) => <Chip key={r.value} active={reason === r.value} onClick={() => setReason(r.value)}>{r.label}</Chip>)}
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="flex gap-2 [&>*]:grow">
        <Button small variant="primary" onClick={() => void approve()} disabled={action.busy}>Approve adjustment</Button>
        <Button small onClick={() => void recount()} disabled={action.busy}>Ask for recount</Button>
      </div>
    </div>
  );
}

function TaskDetail({ task, write, approve, reload }: { task: Task; write: boolean; approve: boolean; reload: () => Promise<void> }) {
  const action = useAction();
  const open = task.status !== "done" && task.status !== "cancelled";

  const cancel = async () => {
    if (!window.confirm(`Cancel ${task.title}? It stays in the history as cancelled.`)) return;
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${task.wms_id}/cancel`, { reason: "cancelled from the board" }));
    if (out) await reload();
  };
  const closeShort = async () => {
    if (!window.confirm(`Close ${task.title} short? Open lines become short and the receipt closes short.`)) return;
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${task.wms_id}/close`, { reason: "supplier_short" }));
    if (out) await reload();
  };

  return (
    <>
      <DetailHeader
        eyebrow={typeLabel(task.type)}
        title={task.source_ref ?? task.title}
        subtitle={`${STATUS_LABEL[task.status]} · ${task.assigned_to ?? "unassigned"} · ${task.device ?? "—"}`}
      />
      {task.status === "needs_supervisor" && task.note && <Notice tone="gold">{task.note}</Notice>}
      <KeyValue items={[
        { label: "Priority", value: task.priority },
        { label: "Created", value: fmtWhen(task.created_at) },
        { label: "Started", value: fmtWhen(task.started_at) },
        { label: "Progress", value: `${task.progress.done} / ${task.progress.total}` },
      ]} />
      <Section title="Lines">
        <div className="flex flex-col rounded-lg border border-line">
          {task.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines on this task.</div>}
          {task.lines.map((l) => (
            <div key={l.line_no} className="flex flex-col gap-2 px-3 py-2.5 row-line last:border-b-0">
              <div className="flex justify-between items-center gap-3 text-sm leading-5">
                <span className="truncate">{l.sku} · {l.name}</span>
                <span className="shrink-0 flex items-center gap-2">
                  <span className="text-ink">{fmtQty(l.actual_qty ?? "0")} / {l.expected_qty ? fmtQty(l.expected_qty) : "?"} {l.uom}</span>
                  {linePill(l)}
                </span>
              </div>
              {l.status === "variance" && approve && open && <ApproveForm taskId={task.wms_id} line={l} reload={reload} />}
            </div>
          ))}
        </div>
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {write && open && (
        <>
          <div className="grow" />
          <div className="flex gap-2 [&>*]:grow">
            <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel task</Button>
            {task.type === "receive" && <Button onClick={() => void closeShort()} disabled={action.busy}>Close short</Button>}
          </div>
        </>
      )}
    </>
  );
}

function AssignForm({ task, onDone, onCancel }: { task: Task; onDone: () => Promise<void>; onCancel: () => void }) {
  const action = useAction();
  const [code, setCode] = useState(task.assigned_to ?? "");
  const submit = async () => {
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${task.wms_id}/assign`, { assigned_to: code.trim() }));
    if (out) await onDone();
  };
  return (
    <>
      <DetailHeader eyebrow="Assign" title={task.title} subtitle="Hand this task to an operator. It shows on their scanner straight away." />
      <Field label="Operator code" hint="e.g. op-017" error={action.fieldErrors.assigned_to}>
        <Input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Operator code" autoFocus />
      </Field>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Back</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={action.busy || !code.trim()}>Assign</Button>
      </div>
    </>
  );
}

function CountForm({ warehouse, onDone, onCancel }: { warehouse: string; onDone: (id: string) => Promise<void>; onCancel: () => void }) {
  const action = useAction();
  const [locations, setLocations] = useState("");
  const [zone, setZone] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const ready = splitList(locations).length > 0 || zone.trim().length > 0;

  const create = async () => {
    const out = await action.run(() => api.message<Accepted>("/v1/counts", {
      warehouse, owner: "DEFAULT", locations: splitList(locations), zone: zone.trim() || null, sku: null, priority,
    }));
    if (out) await onDone(out.wms_id);
  };

  return (
    <>
      <DetailHeader eyebrow="Create task" title="Blind count" subtitle="Count a few shelves or a whole zone. Expected quantities stay hidden until each line is counted." />
      <div className="flex flex-col gap-3">
        <Field label="Locations" hint="Codes, comma separated" error={action.fieldErrors.locations}>
          <Input value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="PF-01-02-A, PF-01-03-B" aria-label="Locations" autoFocus />
        </Field>
        <Field label="Zone" hint="Or every active shelf in a zone" error={action.fieldErrors.zone}>
          <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="PICKFACE" aria-label="Zone" />
        </Field>
        <Field label="Priority">
          <div className="flex gap-1 flex-wrap">
            {(["low", "normal", "high"] as const).map((p) => <Chip key={p} active={priority === p} onClick={() => setPriority(p)}>{p}</Chip>)}
          </div>
        </Field>
      </div>
      <Muted className="text-xs leading-4">Picks, receipts and replenishments are raised by their documents. A count is the one task you start from here.</Muted>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()} disabled={action.busy || !ready}>Create count</Button>
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function TaskBoard() {
  const { warehouse, can } = useAuth();
  const write = can("tasks:write");
  const approve = can("tasks:approve");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("task");

  const code = warehouse?.code;
  const tasks = useApi<Page<Task>>(
    () => api.get<Page<Task>>("/v1/tasks", { warehouse: code, status: "waiting,in_progress,needs_supervisor,done", limit: 500 }),
    [code],
  );
  const reload = tasks.reload;
  useEffect(() => {
    const id = window.setInterval(() => { void reload(); }, 30_000);
    return () => window.clearInterval(id);
  }, [reload]);

  const items = useMemo(() => tasks.data?.items ?? [], [tasks.data]);
  const grouped = useMemo<Record<ColumnKey, Task[]>>(() => ({
    waiting: items.filter((t) => t.status === "waiting"),
    in_progress: items.filter((t) => t.status === "in_progress"),
    needs_supervisor: items.filter((t) => t.status === "needs_supervisor"),
    done: items.filter((t) => t.status === "done" && isToday(t.completed_at)),
  }), [items]);

  const selected = items.find((t) => t.wms_id === selectedId) ?? null;
  const selectedOpen = !!selected && selected.status !== "done" && selected.status !== "cancelled";
  const select = (id: string) => { setSelectedId(id); setMode("task"); };

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Warehouse"} · live`}
          accent="Task"
          title="board"
          actions={<>
            <Pill tone="info">{plural(grouped.in_progress.length, "task")} in progress</Pill>
            {write && <>
              <Button onClick={() => setMode("assign")} disabled={!selectedOpen} title={selectedOpen ? undefined : "Pick an open task first"}>Assign</Button>
              <Button variant="primary" onClick={() => setMode("create")}>Create task</Button>
            </>}
          </>}
        />
        {tasks.error && <Notice tone="gold">{tasks.error}</Notice>}
        <div className="grid grid-cols-4 gap-4 items-start">
          {COLUMNS.map((c) => (
            <BoardColumn
              key={c.key}
              column={c}
              tasks={grouped[c.key]}
              selectedId={selectedId}
              onSelect={select}
              loading={tasks.loading && !tasks.data}
            />
          ))}
        </div>
        <Muted className="text-xs leading-4">Refreshes every 30 seconds. The scanner works these same tasks through the API.</Muted>
      </Main>

      <DetailPanel>
        {mode === "create" && (
          <CountForm
            warehouse={code ?? ""}
            onCancel={() => setMode("task")}
            onDone={async (id) => { await reload(); setSelectedId(id); setMode("task"); }}
          />
        )}
        {mode === "assign" && selected && (
          <AssignForm
            key={selected.wms_id}
            task={selected}
            onCancel={() => setMode("task")}
            onDone={async () => { await reload(); setMode("task"); }}
          />
        )}
        {mode === "task" && selected && (
          <TaskDetail key={selected.wms_id} task={selected} write={write} approve={approve} reload={reload} />
        )}
        {(mode === "task" || mode === "assign") && !selected && (
          <DetailHeader eyebrow="Task" title="—" subtitle="Pick a task on the board to see its lines, approve a variance or hand it to someone." />
        )}
      </DetailPanel>
    </>
  );
}
