import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type {
  Accepted, Page, ProductionComponent, ProductionOrder, ProductionStatus, Task,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDateTime, fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  Section, SegmentedChoice, StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

/* Components allocate like delivery lines, but by component line. */
interface ComponentAllocation {
  line: number; sku: string; qty_requested: string; qty_allocated: string; uom: string; short: string;
}
interface ProductionAccepted extends Accepted { allocation: ComponentAllocation[] }

type Filter = "all" | "issuing" | "in_production" | "complete" | "cancelled";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "issuing", label: "Issuing" },
  { value: "in_production", label: "In production" },
  { value: "complete", label: "Complete" },
  { value: "cancelled", label: "Cancelled" },
];

const TASK_STATUS: Record<string, string> = {
  waiting: "Waiting", in_progress: "In progress", needs_supervisor: "Needs a supervisor",
  done: "Done", cancelled: "Cancelled",
};

type Priority = "low" | "normal" | "high";
type Mode = "detail" | "create";

function isToday(iso: string | null, now = new Date()) {
  return !!iso && new Date(iso).toDateString() === now.toDateString();
}

/* Quantities are decimals. Add them by their smallest unit, never as floats. */
function decimals(v: string) {
  const i = v.indexOf(".");
  return i < 0 ? 0 : v.length - i - 1;
}
function sumQty(values: string[]): string {
  if (values.length === 0) return "0";
  const dp = values.reduce((n, v) => Math.max(n, decimals(v)), 0);
  const f = 10 ** dp;
  const units = values.reduce((n, v) => n + Math.round(Number(v) * f), 0);
  return dp === 0 ? String(units) : (units / f).toFixed(dp).replace(/\.?0+$/, "");
}
/** 0–100 for a progress bar. Only ever a bar width, never a shown quantity. */
function percent(part: string, whole: string): number {
  const w = Number(whole);
  if (!w) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(part) / w) * 100)));
}

function issued(components: ProductionComponent[]): number {
  return components.filter((c) => Number(c.qty_issued) > 0 && Number(c.short) <= 0).length;
}
function isShort(o: ProductionOrder): boolean {
  return o.components.some((c) => Number(c.short) > 0);
}

function statusPill(status: ProductionStatus) {
  switch (status) {
    case "issuing": return <Pill tone="info">Issuing</Pill>;
    case "in_production": return <Pill tone="info">In production</Pill>;
    case "complete": return <Pill tone="ok">Complete</Pill>;
    case "cancelled": return <Pill tone="muted">Cancelled</Pill>;
    default: return <Pill tone="info">New</Pill>;
  }
}

function taskLinePill(status: string) {
  switch (status) {
    case "done": return <Pill tone="ok">Done</Pill>;
    case "short": return <Pill tone="warn">Short</Pill>;
    case "variance": return <Pill tone="warn">Variance</Pill>;
    case "cancelled": return <Pill tone="muted">Cancelled</Pill>;
    default: return <Pill tone="info">Open</Pill>;
  }
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <span className="block h-1.5 w-full rounded-full bg-line overflow-hidden">
      <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
    </span>
  );
}

function allocationNotice(rows: ComponentAllocation[]) {
  const short = rows.filter((r) => Number(r.short) > 0);
  if (short.length === 0) {
    return <Notice tone="ok">{`All ${plural(rows.length, "component")} allocated`}</Notice>;
  }
  const words = short.map((r) => `${r.sku} short ${fmtQty(r.short, r.uom)}`).join(" · ");
  return <Notice tone="gold">{`${rows.length - short.length} of ${rows.length} components allocated · ${words}`}</Notice>;
}

/* --- issue task ---------------------------------------------------------- */

function IssueTask({ task }: { task: Task }) {
  return (
    <>
      <Muted className="text-sm leading-5">
        {task.assigned_to ?? "unassigned"} · {task.device ?? "no device"} · {TASK_STATUS[task.status] ?? task.status} · {task.progress.done} of {task.progress.total} lines
      </Muted>
      <div className="flex flex-col rounded-lg border border-line">
        {task.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines on the issue task yet.</div>}
        {task.lines.map((l) => (
          <div key={l.line_no} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
            <span className="truncate">
              {l.sku} · {l.name}
              {l.from_location ? <Muted> · {l.from_location}</Muted> : null}
            </span>
            <span className="shrink-0 flex items-center gap-2">
              <span className="text-ink">{fmtQty(l.actual_qty ?? "0")} / {l.expected_qty ? fmtQty(l.expected_qty) : "?"} {l.uom}</span>
              {taskLinePill(l.status)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* --- detail panel -------------------------------------------------------- */

function OrderDetail({ order, write, reload }: {
  order: ProductionOrder; write: boolean; reload: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const action = useAction();
  const made = Number(order.output.qty_received) > 0;

  const cancel = async () => {
    if (!window.confirm(`Cancel ${order.external_ref}? The components go back to stock. Nothing is deleted.`)) return;
    const out = await action.run(() => api.message<Accepted>(
      `/v1/production-orders/${encodeURIComponent(order.external_ref)}/cancel`,
      { reason: "cancelled from the desktop" },
    ));
    if (out) await reload();
  };

  return (
    <>
      <DetailHeader
        eyebrow="Production order"
        title={order.external_ref}
        subtitle={`${order.output.sku} · batch ${order.output.batch ?? "from the order QR"}`}
      />
      <div className="flex flex-col gap-2">
        <ProgressBar pct={percent(order.output.qty_received, order.output.qty)} />
        <Muted className="text-xs leading-4">
          {fmtQty(order.output.qty_received)} of {fmtQty(order.output.qty, order.output.uom)} made
        </Muted>
      </div>
      <KeyValue items={[
        { label: "Required by", value: fmtDateTime(order.required_by) },
        { label: "Priority", value: order.priority },
        { label: "Makes", value: order.output.name },
        { label: "Pallets back", value: String(order.receipts.length) },
      ]} />
      <Section title="Components issued">
        <div className="flex flex-col rounded-lg border border-line">
          {order.components.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No components on this order.</div>}
          {order.components.map((c) => (
            <div key={c.line} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">
                {c.sku} · {c.name}
                {Number(c.short) > 0 ? <span className="text-gold"> · short {fmtQty(c.short)}</span> : null}
              </span>
              <span className="shrink-0 text-ink">
                {fmtQty(c.qty_issued)} / {fmtQty(c.qty_requested, c.uom)} → {c.deliver_to}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Receipts pallet by pallet">
        <div className="flex flex-col rounded-lg border border-line">
          {order.receipts.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing has come back from the line yet.</div>}
          {order.receipts.map((p) => (
            <div key={p.wms_id} className="flex flex-col gap-0.5 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <div className="flex justify-between items-center gap-3">
                <span className="truncate">{fmtQty(p.qty, p.uom)} → {p.location}</span>
                <Muted className="shrink-0">{p.operator ?? "unknown"} · {fmtWhen(p.created_at)}</Muted>
              </div>
              <span className="text-xs leading-4">
                <Muted>batch {p.batch ?? "—"}</Muted>
                {p.supervisor ? <span className="text-gold"> · supervisor {p.supervisor}</span> : null}
                {!p.event_sent ? <Muted> · the ERP counted this one</Muted> : null}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Issue task">
        {order.issue_task
          ? <IssueTask task={order.issue_task} />
          : <Muted className="text-sm">No issue task yet. One is raised as soon as the components are reserved.</Muted>}
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {made && <Muted className="text-xs leading-4">Finished goods have already come back</Muted>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button variant="quiet" onClick={() => navigate("/tasks")}>View issue task</Button>
        {write && !made && order.status !== "cancelled" && (
          <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel order</Button>
        )}
      </div>
    </>
  );
}

/* --- create form --------------------------------------------------------- */

interface DraftComponent { sku: string; qty: string; uom: string; batch: string; deliverTo: string }
const emptyComponent = (): DraftComponent => ({ sku: "", qty: "", uom: "EA", batch: "", deliverTo: "" });

function NewOrderForm({ warehouse, onCancel, onCreated }: {
  warehouse: string;
  onCancel: () => void;
  onCreated: (ref: string, allocation: ComponentAllocation[]) => Promise<void>;
}) {
  const action = useAction();
  const [ref, setRef] = useState("");
  const [requiredBy, setRequiredBy] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [sku, setSku] = useState("");
  const [batch, setBatch] = useState("");
  const [qty, setQty] = useState("");
  const [uom, setUom] = useState("EA");
  const [components, setComponents] = useState<DraftComponent[]>([emptyComponent()]);

  const setComponent = (i: number, patch: Partial<DraftComponent>) =>
    setComponents((cur) => cur.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeComponent = (i: number) =>
    setComponents((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : cur));

  const filled = components.filter((c) => c.sku.trim() && c.qty.trim() && c.deliverTo.trim());
  const ready = ref.trim().length > 0 && sku.trim().length > 0 && qty.trim().length > 0 && filled.length > 0;

  const create = async () => {
    const out = await action.run(() => api.message<ProductionAccepted>("/v1/production-orders", {
      external_ref: ref.trim(),
      warehouse,
      required_by: requiredBy || null,
      priority,
      output: {
        sku: sku.trim(), batch: batch.trim() || null, qty: qty.trim(), uom: uom.trim() || "EA",
      },
      components: filled.map((c, i) => ({
        line: i + 1, sku: c.sku.trim(), batch: c.batch.trim() || null,
        qty: c.qty.trim(), uom: c.uom.trim() || "EA", deliver_to: c.deliverTo.trim(),
      })),
    }));
    if (out) await onCreated(ref.trim(), out.allocation ?? []);
  };

  return (
    <>
      <DetailHeader
        eyebrow="Production order"
        title="New production order"
        subtitle="The components are reserved and one issue task walks them to the line. The ERP usually sends these; this is the by-hand door."
      />
      <div className="flex flex-col gap-3">
        <Field label="Reference" hint="The order number the ERP uses" error={action.fieldErrors.external_ref}>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PRD-1000456" aria-label="Reference" autoFocus />
        </Field>
        <Field label="Required by" error={action.fieldErrors.required_by}>
          <Input type="datetime-local" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} aria-label="Required by" />
        </Field>
        <Field label="Priority">
          <SegmentedChoice
            value={priority}
            options={[{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }]}
            onChange={setPriority}
          />
        </Field>
      </div>
      <Section title="Makes">
        <div className="grid grid-cols-[1fr_90px_72px_60px] gap-1.5 items-center">
          <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" aria-label="Output SKU" />
          <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="Batch" aria-label="Output batch" />
          <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" inputMode="decimal" aria-label="Output qty" />
          <Input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="UOM" aria-label="Output UOM" />
        </div>
        {action.fieldErrors["output.sku"] && <span className="text-xs leading-4 text-gold">{action.fieldErrors["output.sku"]}</span>}
        <Muted className="text-xs leading-4">Leave the batch blank and the scanner reads it off the pallet as each one comes back.</Muted>
      </Section>
      <Section
        title="Components"
        action={<Button small onClick={() => setComponents((cur) => [...cur, emptyComponent()])}>Add component</Button>}
      >
        <div className="flex flex-col gap-2">
          {components.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_72px_56px_80px_32px] gap-1.5 items-center">
              <Input value={c.sku} onChange={(e) => setComponent(i, { sku: e.target.value })} placeholder="SKU" aria-label={`Component SKU ${i + 1}`} />
              <Input value={c.qty} onChange={(e) => setComponent(i, { qty: e.target.value })} placeholder="Qty" inputMode="decimal" aria-label={`Component qty ${i + 1}`} />
              <Input value={c.uom} onChange={(e) => setComponent(i, { uom: e.target.value })} placeholder="UOM" aria-label={`Component UOM ${i + 1}`} />
              <Input value={c.batch} onChange={(e) => setComponent(i, { batch: e.target.value })} placeholder="Batch" aria-label={`Component batch ${i + 1}`} />
              <Button variant="ghost" small className="!px-0" onClick={() => removeComponent(i)} disabled={components.length === 1} aria-label={`Remove component ${i + 1}`}>×</Button>
              <Input
                className="col-span-4"
                value={c.deliverTo}
                onChange={(e) => setComponent(i, { deliverTo: e.target.value })}
                placeholder="Deliver to"
                aria-label={`Deliver to ${i + 1}`}
              />
            </div>
          ))}
        </div>
        {action.fieldErrors.components && <span className="text-xs leading-4 text-gold">{action.fieldErrors.components}</span>}
        <Muted className="text-xs leading-4">Deliver to must be a real line-side location in this warehouse.</Muted>
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()} disabled={action.busy || !ready}>Create and allocate</Button>
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function Production() {
  const { warehouse, can } = useAuth();
  const write = can("tasks:write");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("detail");
  const [allocation, setAllocation] = useState<{ ref: string; rows: ComponentAllocation[] } | null>(null);

  const code = warehouse?.code;
  const list = useApi<Page<ProductionOrder>>(
    () => api.get<Page<ProductionOrder>>("/v1/production-orders", { warehouse: code, limit: 500 }),
    [code],
  );
  const detail = useApi<ProductionOrder>(
    selectedRef ? () => api.get<ProductionOrder>(`/v1/production-orders/${encodeURIComponent(selectedRef)}`) : null,
    [selectedRef],
  );

  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  const waiting = items.filter((o) => o.status === "issuing" || o.status === "new");
  const waitingLines = waiting.reduce((n, o) => n + o.components.length - issued(o.components), 0);
  const running = items.filter((o) => o.status === "in_production");
  const atTheLine = running.reduce((n, o) => n + o.components.filter((c) => Number(c.qty_issued) > 0).length, 0);
  const receivedToday = items.filter((o) => isToday(o.completed_at));
  const receivedQty = sumQty(receivedToday.map((o) => o.output.qty_received));
  const receivedUom = new Set(receivedToday.map((o) => o.output.uom)).size === 1 ? receivedToday[0].output.uom : undefined;
  const short = items.filter((o) => isShort(o) && o.status !== "cancelled");

  const rows = items.filter((o) => {
    switch (filter) {
      case "all": return true;
      case "issuing": return o.status === "issuing" || o.status === "new";
      default: return o.status === filter;
    }
  });

  const columns: Column<ProductionOrder>[] = [
    { key: "ref", header: "Order", width: "150px", render: (o) => <b>{o.external_ref}</b> },
    { key: "makes", header: "Makes", render: (o) => <>{o.output.sku} <Muted>· {o.output.name}</Muted></> },
    { key: "batch", header: "Batch", width: "100px", render: (o) => o.output.batch ?? <Muted>—</Muted> },
    {
      key: "qty", header: "Quantity", width: "140px",
      render: (o) => `${fmtQty(o.output.qty_received)} / ${fmtQty(o.output.qty, o.output.uom)}`,
    },
    {
      key: "components", header: "Components", width: "150px",
      render: (o) => <Muted>{issued(o.components)}/{o.components.length} lines issued</Muted>,
    },
    { key: "required", header: "Required", width: "130px", render: (o) => fmtDateTime(o.required_by) },
    {
      key: "status", header: "Status", width: "160px",
      render: (o) => (
        <span className="flex items-center gap-1.5">
          {statusPill(o.status)}
          {isShort(o) && o.status !== "cancelled" && <Pill tone="warn">Short</Pill>}
        </span>
      ),
    },
  ];

  const select = (ref: string) => { setSelectedRef(ref); setMode("detail"); };
  const reloadAll = async () => { await list.reload(); await detail.reload(); };

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Warehouse"} · making things`}
          accent="Production"
          title="orders"
          actions={write ? <Button variant="primary" onClick={() => { setAllocation(null); setMode("create"); }}>Create order</Button> : null}
        />

        <div className="grid grid-cols-4 gap-4">
          <StatTile
            label="Waiting to issue"
            value={String(waiting.length)}
            hint={waitingLines > 0 ? `${plural(waitingLines, "component line")} to walk` : "nothing to walk"}
          />
          <StatTile
            label="In production"
            value={String(running.length)}
            hint={`${plural(atTheLine, "component")} at the line`}
          />
          <StatTile
            label="Received today"
            value={String(receivedToday.length)}
            hint={receivedToday.length > 0 ? `${fmtQty(receivedQty, receivedUom)} back` : "nothing back yet"}
          />
          <StatTile
            label="Short components"
            value={String(short.length)}
            tone={short.length > 0 ? "gold" : undefined}
            hint={short.length > 0
              ? `${short[0].external_ref} · ${short[0].components.find((c) => Number(c.short) > 0)?.sku ?? ""}`
              : "everything went to the line"}
          />
        </div>

        <div className="flex items-center gap-1">
          {FILTERS.map((f) => <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</Chip>)}
        </div>

        {list.error && <Notice tone="gold">{list.error}</Notice>}
        <Table
          columns={columns}
          rows={rows}
          rowKey={(o) => o.external_ref}
          onRowClick={(o) => select(o.external_ref)}
          selectedKey={mode === "detail" ? selectedRef : null}
          empty={list.loading ? "Loading…" : filter === "all"
            ? "No production orders. They arrive from the ERP, or create one here."
            : "Nothing here with that status."}
        />
        <Muted className="text-xs leading-4">
          Components sit at their line-side location until the line consumes them. The line is outside the WMS, so a count or an ERP adjustment squares it up.
        </Muted>
      </Main>

      <DetailPanel>
        {mode === "create" && (
          <NewOrderForm
            warehouse={code ?? ""}
            onCancel={() => setMode("detail")}
            onCreated={async (ref, allocationRows) => {
              setAllocation({ ref, rows: allocationRows });
              await list.reload();
              setSelectedRef(ref);
              setMode("detail");
            }}
          />
        )}
        {mode === "detail" && allocation && allocation.ref === selectedRef && allocation.rows.length > 0 && allocationNotice(allocation.rows)}
        {mode === "detail" && detail.data && (
          <OrderDetail key={detail.data.external_ref} order={detail.data} write={write} reload={reloadAll} />
        )}
        {mode === "detail" && !detail.data && detail.loading && <Muted className="text-sm">Loading…</Muted>}
        {mode === "detail" && !detail.data && !detail.loading && detail.error && <Notice tone="gold">{detail.error}</Notice>}
        {mode === "detail" && !detail.data && !detail.loading && !detail.error && (
          <DetailHeader eyebrow="Production order" title="—" subtitle="Pick an order to see the components issued and every pallet that came back." />
        )}
      </DetailPanel>
    </>
  );
}
