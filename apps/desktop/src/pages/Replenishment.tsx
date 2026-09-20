import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { Accepted, Page, Product, StockBySku, Task, TaskLine, TaskReply } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  Section, StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

type Filter = "all" | "replenish" | "count" | "supervisor";
type Selection = { kind: "none" } | { kind: "task"; id: string } | { kind: "new-count" } | { kind: "new-replen" };
type Priority = Task["priority"];

const SOURCE: Record<string, string> = { min_max: "Min/max", api: "API · ERP", manual: "Manual", count: "Cycle count" };
const REASONS: { value: string; label: string }[] = [
  { value: "count_variance", label: "Count variance" },
  { value: "damaged", label: "Damaged" },
  { value: "found", label: "Found" },
  { value: "data_entry_error", label: "Data entry error" },
];
const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" },
];
/** How many products with a min we check the pick face for. Enough for the tile, not a full scan. */
const BELOW_MIN_SAMPLE = 25;

/** "a, b , c" → ["a", "b", "c"]. */
function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/** A variance with its sign: "−2" or "+1". */
function signed(qty: string | null | undefined): string {
  if (qty === null || qty === undefined || qty === "") return "—";
  const n = Number(qty);
  return n > 0 ? `+${fmtQty(qty)}` : fmtQty(qty);
}

/** ["a", "b", "c"] → "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function varianceLine(task: Task): TaskLine | null {
  return task.lines.find((l) => l.status === "variance") ?? null;
}

/** The line a row summarises: the variance on a count, else the first line. */
function primaryLine(task: Task): TaskLine | null {
  return varianceLine(task) ?? task.lines[0] ?? null;
}

function sourceLabel(task: Task): string {
  if (task.type === "count") return SOURCE.count;
  return SOURCE[task.source_type ?? ""] ?? task.source_type ?? "—";
}

function statusPill(task: Task) {
  switch (task.status) {
    case "waiting": return <Pill tone="info">Waiting</Pill>;
    case "in_progress": return <Pill tone="info">In progress</Pill>;
    case "needs_supervisor": {
      const v = varianceLine(task);
      return <Pill tone="warn">{v ? `Variance ${signed(v.variance)}` : "Needs a supervisor"}</Pill>;
    }
    case "done": return <Pill tone="ok">Done</Pill>;
    default: return <Pill tone="muted">Cancelled</Pill>;
  }
}

function operatorCell(task: Task) {
  if (task.assigned_to) {
    const tail = task.device ? task.device : task.status === "needs_supervisor" ? "approve?" : null;
    return <Muted>{tail ? `${task.assigned_to} · ${tail}` : task.assigned_to}</Muted>;
  }
  if (task.priority === "high") return <span className="text-gold">Priority: high</span>;
  return <Muted>—</Muted>;
}

function pickfaceOnHand(stock: StockBySku): number {
  return stock.locations.filter((l) => l.zone === "PICKFACE").reduce((n, l) => n + Number(l.on_hand), 0);
}

/* --- panel: lines of a task ---------------------------------------------- */

function LineList({ task }: { task: Task }) {
  return (
    <div className="flex flex-col rounded-lg border border-line">
      {task.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines.</div>}
      {task.lines.map((l) => (
        <div key={l.line_no} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
          <span className="truncate">
            {l.sku} <Muted>· {l.name}</Muted>
            <br />
            <Muted className="text-xs leading-4">{task.type === "count" ? l.from_location ?? "—" : `${l.from_location ?? "FIFO"} → ${l.to_location ?? "—"}`}</Muted>
          </span>
          <span className="shrink-0 text-ink">
            {task.type === "count" && l.actual_qty !== null ? `${fmtQty(l.actual_qty)} of ${fmtQty(l.expected_qty)}` : fmtQty(l.expected_qty, l.uom)}
            {l.status !== "open" && <Muted> · {l.status.replace(/_/g, " ")}</Muted>}
          </span>
        </div>
      ))}
    </div>
  );
}

/* --- panel: a count line with a variance -------------------------------- */

function VarianceDetail({ task, line, product, reload }: { task: Task; line: TaskLine; product: Product | null; reload: () => Promise<void> }) {
  const { can } = useAuth();
  const action = useAction();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const location = line.from_location ?? line.to_location ?? "—";
  const min = product?.pickface_min ?? null;

  const approve = async () => {
    if (!reason) return;
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${task.wms_id}/lines/${line.line_no}/approve`, {
      reason, note: note.trim() || null,
    }));
    if (out) await reload();
  };
  const recount = async () => {
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${task.wms_id}/lines/${line.line_no}/recount`, {}));
    if (out) await reload();
  };

  const canWrite = can("tasks:write");
  const canApprove = can("tasks:approve");

  return (
    <>
      <DetailHeader
        eyebrow="Cycle count · variance"
        title={task.source_ref ?? task.title}
        subtitle={`${location} · counted by ${task.assigned_to ?? "—"} · ${fmtWhen(line.completed_at ?? task.started_at)}`}
      />
      <KeyValue items={[
        { label: "Expected", value: fmtQty(line.expected_qty, line.uom) },
        { label: "Counted", value: <span className="text-gold">{fmtQty(line.actual_qty, line.uom)}</span> },
        { label: "Variance", value: <span className="text-gold">{signed(line.variance)} {line.uom}</span> },
        { label: "Recount", value: "Not yet" },
      ]} />
      <Section title="Adjust with a reason">
        <div className="flex flex-col gap-3">
          <Field label="Reason">
            <div className="flex gap-1 flex-wrap">
              {REASONS.map((r) => (
                <Chip key={r.value} active={reason === r.value} onClick={() => setReason(r.value)}>{r.label}</Chip>
              ))}
            </div>
          </Field>
          <Field label="Note" error={action.fieldErrors.note}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>
          <Muted className="text-xs leading-4">Approving writes a ledger line and sends stock.adjusted to the ERP</Muted>
        </div>
      </Section>
      <Section title="Min / max rules for this location">
        <KeyValue items={[
          { label: `${line.sku} min / max`, value: `${fmtQty(min)} / ${fmtQty(product?.pickface_max)}` },
          { label: "Source", value: "Same product, FIFO" },
          { label: "Replenish when", value: min ? `Below ${fmtQty(min)} at end of pick` : "No min set" },
        ]} />
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {(canWrite || canApprove) && (
        <>
          <div className="grow" />
          <div className="flex gap-2 [&>*]:grow">
            {canWrite && <Button onClick={() => void recount()} disabled={action.busy}>Ask for recount</Button>}
            {canApprove && (
              <Button variant="primary" onClick={() => void approve()} disabled={action.busy || !reason}>Approve adjustment</Button>
            )}
          </div>
        </>
      )}
    </>
  );
}

/* --- panel: a replenish task or a count still in progress --------------- */

function TaskDetail({ task, reload }: { task: Task; reload: () => Promise<void> }) {
  const { can } = useAuth();
  const action = useAction();
  const isCount = task.type === "count";
  const cancel = async () => {
    if (!window.confirm(`Cancel ${task.source_ref ?? task.title}? It stays in the history as cancelled.`)) return;
    const out = await action.run(() => api.message<Accepted>(`/v1/tasks/${task.wms_id}/cancel`, { reason: "Cancelled from the desktop" }));
    if (out) await reload();
  };
  const operator = task.assigned_to ? `${task.assigned_to}${task.device ? ` · ${task.device}` : ""}` : "Unassigned";
  return (
    <>
      <DetailHeader
        eyebrow={isCount ? "Cycle count" : "Replenishment"}
        title={task.source_ref ?? task.title}
        subtitle={`${task.title} · ${task.progress.done} of ${plural(task.progress.total, "line")} done`}
      />
      <Section title="Lines">
        <LineList task={task} />
      </Section>
      <KeyValue items={[
        { label: "Priority", value: task.priority.charAt(0).toUpperCase() + task.priority.slice(1) },
        { label: "Source", value: sourceLabel(task) },
        { label: "Operator", value: operator },
        { label: "Created", value: fmtWhen(task.created_at) },
      ]} />
      {task.note && <Muted className="text-xs leading-4">{task.note}</Muted>}
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {can("tasks:write") && task.status !== "done" && task.status !== "cancelled" && (
        <>
          <div className="grow" />
          <div className="flex gap-2 [&>*]:grow">
            <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel task</Button>
          </div>
        </>
      )}
    </>
  );
}

/* --- panel: forms -------------------------------------------------------- */

function NewCountForm({ warehouse, onCancel, onCreated }: { warehouse: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const action = useAction();
  const [locations, setLocations] = useState("");
  const [zone, setZone] = useState("");
  const [sku, setSku] = useState("");
  const locs = splitList(locations);
  const ready = locs.length > 0 || zone.trim().length > 0;

  const create = async () => {
    const body: Record<string, unknown> = { warehouse, owner: "DEFAULT", sku: sku.trim() || null, priority: "normal" };
    if (locs.length > 0) { body.locations = locs; body.zone = null; } else { body.locations = null; body.zone = zone.trim(); }
    const out = await action.run(() => api.message<Accepted>("/v1/counts", body));
    if (out) onCreated(out.wms_id);
  };

  return (
    <>
      <DetailHeader eyebrow="Cycle count" title="Start cycle count" subtitle="Blind: the expected quantity is hidden until the shelf is counted." />
      <div className="flex flex-col gap-3">
        <Field label="Locations" hint="Comma separated, e.g. PF-01-02-A, PF-01-03-B" error={action.fieldErrors.locations}>
          <Input value={locations} onChange={(e) => setLocations(e.target.value)} autoFocus />
        </Field>
        <Field label="or zone" hint="Every active shelf in the zone" error={action.fieldErrors.zone}>
          <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="PICKFACE" disabled={locs.length > 0} />
        </Field>
        <Field label="SKU" hint="Optional. Count only this product" error={action.fieldErrors.sku}>
          <Input value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
      </div>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()} disabled={action.busy || !ready}>Start count</Button>
      </div>
    </>
  );
}

function NewReplenForm({ warehouse, onCancel, onCreated }: { warehouse: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const action = useAction();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("");
  const [uom, setUom] = useState("EA");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const ready = sku.trim() && qty.trim() && Number(qty) > 0 && uom.trim() && to.trim();

  const create = async () => {
    const out = await action.run(() => api.message<Accepted>("/v1/replenishments", {
      warehouse, owner: "DEFAULT", priority, source: "manual",
      lines: [{ line: 1, sku: sku.trim(), qty: qty.trim(), uom: uom.trim(), to_location: to.trim(), from_location: from.trim() || null, batch: null }],
    }));
    if (out) onCreated(out.wms_id);
  };

  return (
    <>
      <DetailHeader eyebrow="Replenishment" title="Raise replenishment" subtitle="One move task, confirmed on the scanner." />
      <div className="flex flex-col gap-3">
        <Field label="SKU" error={action.fieldErrors["lines.0.sku"] ?? action.fieldErrors.sku}>
          <Input value={sku} onChange={(e) => setSku(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" error={action.fieldErrors["lines.0.qty"] ?? action.fieldErrors.qty}>
            <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Unit" error={action.fieldErrors["lines.0.uom"] ?? action.fieldErrors.uom}>
            <Input value={uom} onChange={(e) => setUom(e.target.value)} />
          </Field>
        </div>
        <Field label="To location" hint="The pick face to fill" error={action.fieldErrors["lines.0.to_location"] ?? action.fieldErrors.to_location}>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="PF-01-02-A" />
        </Field>
        <Field label="From location" hint="Leave blank for FIFO: the oldest stock in the warehouse" error={action.fieldErrors["lines.0.from_location"] ?? action.fieldErrors.from_location}>
          <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="FIFO" />
        </Field>
        <Field label="Priority">
          <div className="flex gap-1 flex-wrap">
            {PRIORITIES.map((p) => <Chip key={p.value} active={priority === p.value} onClick={() => setPriority(p.value)}>{p.label}</Chip>)}
          </div>
        </Field>
      </div>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()} disabled={action.busy || !ready}>Raise replenishment</Button>
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function Replenishment() {
  const { warehouse, can } = useAuth();
  const code = warehouse?.code;
  const [filter, setFilter] = useState<Filter>("all");
  const [selection, setSelection] = useState<Selection>({ kind: "none" });

  const tasks = useApi<Page<Task>>(
    code ? () => api.get<Page<Task>>("/v1/tasks", {
      warehouse: code, type: "replenish,count", status: "waiting,in_progress,needs_supervisor", limit: 500,
    }) : null,
    [code],
  );
  const products = useApi<Page<Product>>(() => api.get<Page<Product>>("/v1/products", { limit: 5000 }), []);

  const withMin = useMemo(
    () => (products.data?.items ?? []).filter((p) => p.active && p.pickface_min).slice(0, BELOW_MIN_SAMPLE),
    [products.data],
  );
  const belowMin = useApi<number>(
    code && withMin.length > 0 ? async () => {
      const stock = await Promise.all(withMin.map((p) => api.get<StockBySku>("/v1/stock", { sku: p.sku, warehouse: code }).catch(() => null)));
      return stock.filter((s, i) => s !== null && pickfaceOnHand(s) < Number(withMin[i].pickface_min)).length;
    } : null,
    [withMin, code],
  );

  const all = tasks.data?.items ?? [];
  const replens = all.filter((t) => t.type === "replenish");
  const counts = all.filter((t) => t.type === "count");
  const variances = counts.flatMap((t) => t.lines.filter((l) => l.status === "variance"));
  const countsDue = counts.filter((t) => t.status === "waiting" || t.status === "in_progress");
  const firstCountLocation = countsDue[0]?.lines[0]?.from_location ?? null;

  const rows = all.filter((t) => {
    if (filter === "replenish") return t.type === "replenish";
    if (filter === "count") return t.type === "count";
    if (filter === "supervisor") return t.status === "needs_supervisor" || t.needs_supervisor;
    return true;
  });

  const selected = selection.kind === "task" ? all.find((t) => t.wms_id === selection.id) ?? null : null;
  const selectedVariance = selected?.type === "count" ? varianceLine(selected) : null;
  const selectedProduct = selectedVariance
    ? products.data?.items.find((p) => p.sku === selectedVariance.sku) ?? null
    : null;

  const productMap = useMemo(() => new Map((products.data?.items ?? []).map((p) => [p.sku, p])), [products.data]);

  const columns: Column<Task>[] = [
    { key: "task", header: "Task", width: "130px", render: (t) => <b>{t.source_ref ?? t.title}</b> },
    {
      key: "product", header: "Product", width: "220px",
      render: (t) => {
        const l = primaryLine(t);
        if (!l) return <Muted>—</Muted>;
        if (t.type === "count") return <Muted>{l.from_location ?? l.to_location ?? "—"} · count</Muted>;
        return <Muted>{l.sku} · {l.name || productMap.get(l.sku)?.name || ""}</Muted>;
      },
    },
    {
      key: "from", header: "From", width: "140px",
      render: (t) => { const l = primaryLine(t); return t.type === "count" ? "—" : l?.from_location ?? "FIFO"; },
    },
    { key: "to", header: "To", width: "140px", render: (t) => (t.type === "count" ? "—" : primaryLine(t)?.to_location ?? "—") },
    {
      key: "qty", header: "Qty", width: "110px",
      render: (t) => {
        const l = primaryLine(t);
        if (!l) return "—";
        if (t.type === "count") return l.actual_qty !== null ? `${fmtQty(l.actual_qty)} of ${fmtQty(l.expected_qty)}` : "—";
        return fmtQty(l.expected_qty, l.uom);
      },
    },
    { key: "source", header: "Source", width: "130px", render: sourceLabel },
    { key: "status", header: "Status", width: "120px", render: statusPill },
    { key: "operator", header: "Operator", render: operatorCell },
  ];

  const created = async (id: string) => {
    await tasks.reload();
    setSelection({ kind: "task", id });
  };

  const writer = can("tasks:write");

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Warehouse"} · pick face`}
          accent="Replenishment"
          title="and counts"
          actions={writer && code ? <>
            <Button onClick={() => setSelection({ kind: "new-count" })}>Start cycle count</Button>
            <Button variant="primary" onClick={() => setSelection({ kind: "new-replen" })}>Raise replenishment</Button>
          </> : undefined}
        />

        <div className="grid grid-cols-4 gap-4">
          <StatTile
            label="Below minimum"
            value={withMin.length === 0 ? (products.loading ? "…" : "—") : belowMin.loading || belowMin.data === null ? "…" : String(belowMin.data)}
            hint={withMin.length === 0 && !products.loading ? "no min / max set" : "pick face locations"}
          />
          <StatTile
            label="Replen tasks open"
            value={String(replens.length)}
            hint={`${replens.filter((t) => t.status === "in_progress").length} in progress`}
          />
          <StatTile label="Counts due today" value={String(countsDue.length)} hint={firstCountLocation ?? "—"} />
          <StatTile
            label="Variances to approve"
            value={String(variances.length)}
            tone={variances.length > 0 ? "gold" : undefined}
            hint={variances.length > 0 ? joinList(variances.map((l) => `${signed(l.variance)} ${l.uom}`)) : "nothing waiting"}
          />
        </div>

        <div className="flex items-center gap-1">
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
          <Chip active={filter === "replenish"} onClick={() => setFilter("replenish")}>Replenishment</Chip>
          <Chip active={filter === "count"} onClick={() => setFilter("count")}>Counts</Chip>
          <Chip active={filter === "supervisor"} onClick={() => setFilter("supervisor")}>Needs a supervisor</Chip>
        </div>

        {tasks.error && <Notice tone="gold">{tasks.error}</Notice>}
        {tasks.loading && !tasks.data && <Muted className="text-sm">Loading…</Muted>}
        <Table
          columns={columns}
          rows={rows}
          rowKey={(t) => t.wms_id}
          onRowClick={(t) => setSelection({ kind: "task", id: t.wms_id })}
          selectedKey={selection.kind === "task" ? selection.id : null}
          empty={tasks.loading ? "Loading…"
            : filter === "all" ? "Nothing open. Replenishments arrive from min/max, the ERP or the button above; counts from Start cycle count."
            : filter === "supervisor" ? "No variances waiting. Counts that match write nothing."
            : "Nothing open with that filter."}
        />
        <Muted className="text-xs leading-4">Open replenish and count tasks in this warehouse. The scanner works them; the ledger only moves when a line is confirmed.</Muted>
      </Main>

      <DetailPanel>
        {selection.kind === "new-count" && code && (
          <NewCountForm warehouse={code} onCancel={() => setSelection({ kind: "none" })} onCreated={(id) => void created(id)} />
        )}
        {selection.kind === "new-replen" && code && (
          <NewReplenForm warehouse={code} onCancel={() => setSelection({ kind: "none" })} onCreated={(id) => void created(id)} />
        )}
        {selected && selectedVariance && (
          <VarianceDetail key={`${selected.wms_id}/${selectedVariance.line_no}`} task={selected} line={selectedVariance} product={selectedProduct} reload={tasks.reload} />
        )}
        {selected && !selectedVariance && <TaskDetail key={selected.wms_id} task={selected} reload={tasks.reload} />}
        {(selection.kind === "none" || (selection.kind === "task" && !selected)) && (
          <DetailHeader
            eyebrow="Replenishment"
            title="—"
            subtitle="Pick a task to see its lines. A count with a variance waits here for a supervisor."
          />
        )}
      </DetailPanel>
    </>
  );
}
