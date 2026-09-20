import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Accepted, Page, Task, Transfer, TransferLine, TransferStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Eyebrow, Field, Input, KeyValue, Muted, Notice, PageHeader,
  Pill, Section, SegmentedChoice, Select, StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

/* A transfer allocates like a delivery, but by transfer line. */
interface TransferAllocation {
  line: number; sku: string; qty_requested: string; qty_allocated: string; uom: string; short: string;
}
interface TransferAccepted extends Accepted { allocation: TransferAllocation[] }

type Direction = "all" | "out" | "in";
const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "all", label: "All" }, { value: "out", label: "Outbound" }, { value: "in", label: "Inbound" },
];

type Filter = "all" | "picking" | "in_transit" | "arrived" | "variance" | "closed" | "cancelled";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "picking", label: "Picking" },
  { value: "in_transit", label: "In transit" },
  { value: "arrived", label: "Arrived" },
  { value: "variance", label: "Variance" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

/* The groups behind the chips. Picking covers everything still at the sender. */
const PICKING: TransferStatus[] = ["new", "allocated", "picking", "picked"];
const ARRIVED: TransferStatus[] = ["receiving", "received"];

const VARIANCE_REASONS = ["lost_in_transit", "damaged_in_transit", "never_shipped", "found_later"];

const TASK_STATUS: Record<string, string> = {
  waiting: "waiting", in_progress: "in progress", needs_supervisor: "needs a supervisor",
  done: "done", cancelled: "cancelled",
};

type Priority = "low" | "normal" | "high";
type Mode = "detail" | "create";

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Local calendar date as YYYY-MM-DD. */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

function sharedUom(lines: { uom: string }[]): string | undefined {
  const set = new Set(lines.map((l) => l.uom));
  return set.size === 1 ? [...set][0] : undefined;
}

function reasonWords(reason: string) {
  const words = reason.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function statusPill(status: TransferStatus) {
  switch (status) {
    case "allocated":
    case "picking": return <Pill tone="info">Picking</Pill>;
    case "picked": return <Pill tone="info">Picked</Pill>;
    case "in_transit": return <Pill tone="info">In transit</Pill>;
    case "receiving": return <Pill tone="info">Receiving</Pill>;
    case "received": return <Pill tone="ok">Received</Pill>;
    case "variance": return <Pill tone="warn">Variance</Pill>;
    case "closed": return <Pill tone="muted">Closed</Pill>;
    case "cancelled": return <Pill tone="muted">Cancelled</Pill>;
    default: return <Pill tone="info">New</Pill>;
  }
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <span className="block h-1.5 w-full rounded-full bg-line overflow-hidden">
      <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
    </span>
  );
}

function allocationNotice(rows: TransferAllocation[]) {
  const short = rows.filter((r) => Number(r.short) > 0);
  if (short.length === 0) {
    return <Notice tone="ok">{`All ${plural(rows.length, "line")} allocated`}</Notice>;
  }
  const words = short.map((r) => `${r.sku} short ${fmtQty(r.short, r.uom)}`).join(" · ");
  return <Notice tone="gold">{`${rows.length - short.length} of ${rows.length} lines allocated · ${words}`}</Notice>;
}

/* --- the two legs -------------------------------------------------------- */

function Leg({ label, task }: { label: string; task: Task | null }) {
  if (!task) {
    return (
      <div className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
        <span className="truncate">{label}</span>
        <Muted className="shrink-0">Not started</Muted>
      </div>
    );
  }
  const pct = task.progress.total > 0 ? Math.round((task.progress.done / task.progress.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
      <span className="truncate">
        {task.title} · {TASK_STATUS[task.status] ?? task.status} · {task.assigned_to ?? "unassigned"}
      </span>
      <ProgressBar pct={pct} />
      <Muted className="text-xs leading-4">{task.progress.done} of {task.progress.total} lines</Muted>
    </div>
  );
}

/* --- detail panel -------------------------------------------------------- */

function TransferDetail({ transfer, write, reload }: {
  transfer: Transfer; write: boolean; reload: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const action = useAction();
  const [form, setForm] = useState<"none" | "ship" | "variance">("none");
  const [carrier, setCarrier] = useState(transfer.carrier ?? transfer.carrier_hint ?? "");
  const [tracking, setTracking] = useState(transfer.tracking_no ?? "");
  const [reason, setReason] = useState(VARIANCE_REASONS[0]);
  const [note, setNote] = useState("");

  const ref = encodeURIComponent(transfer.external_ref);
  const uom = sharedUom(transfer.lines);
  const requested = sumQty(transfer.lines.map((l) => l.qty_requested));
  const received = sumQty(transfer.lines.map((l) => l.qty_received));
  const beforeShipping = PICKING.includes(transfer.status);

  const ship = async () => {
    const out = await action.run(() => api.message<Accepted>(`/v1/transfers/${ref}/ship`, {
      carrier: carrier.trim() || null, tracking_no: tracking.trim() || null,
    }));
    if (out) { setForm("none"); await reload(); }
  };

  const closeVariance = async () => {
    const out = await action.run(() => api.message<Accepted>(`/v1/transfers/${ref}/close-variance`, {
      reason, note: note.trim() || null,
    }));
    if (out) { setForm("none"); await reload(); }
  };

  const cancel = async () => {
    if (!window.confirm(`Cancel ${transfer.external_ref}? The reservations go back at the sender. Nothing is deleted.`)) return;
    const out = await action.run(() => api.message<Accepted>(`/v1/transfers/${ref}/cancel`, {
      reason: "cancelled from the desktop",
    }));
    if (out) await reload();
  };

  const footer = () => {
    if (PICKING.includes(transfer.status) && transfer.status !== "picked") {
      return <Button variant="primary" onClick={() => navigate("/tasks")}>View pick task</Button>;
    }
    if (transfer.status === "picked") {
      return <Button variant="primary" onClick={() => setForm(form === "ship" ? "none" : "ship")}>Ship</Button>;
    }
    if (transfer.status === "in_transit" || transfer.status === "receiving") {
      return <Button variant="primary" onClick={() => navigate("/tasks")}>View receive task</Button>;
    }
    if (transfer.status === "variance") {
      return <Button variant="gold" onClick={() => setForm(form === "variance" ? "none" : "variance")}>Close variance</Button>;
    }
    return null;
  };

  return (
    <>
      <DetailHeader
        eyebrow="Transfer"
        title={transfer.external_ref}
        subtitle={`${transfer.from_warehouse} → ${transfer.to_warehouse} · ${plural(transfer.lines.length, "line")}`}
      />
      <div className="flex flex-col gap-2">
        <ProgressBar pct={percent(received, requested)} />
        <Muted className="text-xs leading-4">{fmtQty(received)} of {fmtQty(requested, uom)} received</Muted>
      </div>
      <KeyValue items={[
        { label: "Required by", value: fmtDate(transfer.required_by) },
        { label: "Carrier", value: transfer.carrier ?? transfer.carrier_hint ?? "—" },
        { label: "Tracking", value: transfer.tracking_no ? <span className="mono">{transfer.tracking_no}</span> : "—" },
        { label: "In transit at", value: transfer.in_transit_location ?? "—" },
      ]} />
      <Section title="Lines">
        <div className="flex flex-col rounded-lg border border-line">
          {transfer.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines on this transfer.</div>}
          {transfer.lines.map((l) => (
            <div key={l.line} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">
                {l.sku} · {l.name}
                {Number(l.variance) !== 0 ? <span className="text-gold"> · {fmtQty(l.variance, l.uom)}</span> : null}
              </span>
              <span className="shrink-0 text-ink">
                {fmtQty(l.qty_received)} / {fmtQty(l.qty_shipped)} of {fmtQty(l.qty_requested, l.uom)}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Both legs">
        <div className="flex flex-col rounded-lg border border-line">
          <Leg label={`Pick at ${transfer.from_warehouse}`} task={transfer.pick_task} />
          <Leg label={`Receive at ${transfer.to_warehouse}`} task={transfer.receive_task} />
        </div>
      </Section>
      {write && form === "ship" && (
        <form
          className="flex flex-col gap-3 rounded-md border border-line p-3"
          onSubmit={(e) => { e.preventDefault(); void ship(); }}
        >
          <Eyebrow tone="muted">Ship this transfer</Eyebrow>
          <Field label="Carrier" error={action.fieldErrors.carrier}>
            <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Toll" aria-label="Carrier" autoFocus />
          </Field>
          <Field label="Tracking number" error={action.fieldErrors.tracking_no}>
            <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="TOLL-99123" aria-label="Tracking number" />
          </Field>
          <Muted className="text-xs leading-4">Shipping moves the stock off the bench into the in-transit bucket at {transfer.to_warehouse}.</Muted>
          <div className="flex gap-2 [&>*]:grow">
            <Button small type="button" onClick={() => setForm("none")} disabled={action.busy}>Cancel</Button>
            <Button small type="submit" variant="primary" disabled={action.busy}>Ship transfer</Button>
          </div>
        </form>
      )}
      {write && form === "variance" && (
        <form
          className="flex flex-col gap-3 rounded-md border border-line p-3"
          onSubmit={(e) => { e.preventDefault(); void closeVariance(); }}
        >
          <Eyebrow tone="muted">Close the variance</Eyebrow>
          <Field label="Reason" error={action.fieldErrors.reason}>
            <SegmentedChoice
              value={reason}
              options={VARIANCE_REASONS.map((r) => ({ value: r, label: reasonWords(r) }))}
              onChange={setReason}
            />
          </Field>
          <Field label="Note" error={action.fieldErrors.note}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="One carton crushed on arrival" aria-label="Note" />
          </Field>
          <Muted className="text-xs leading-4">Writes whatever is left in the bucket off with a reason, one stock.adjusted per ledger line.</Muted>
          <div className="flex gap-2 [&>*]:grow">
            <Button small type="button" onClick={() => setForm("none")} disabled={action.busy}>Keep open</Button>
            <Button small type="submit" variant="gold" disabled={action.busy}>Write it off</Button>
          </div>
        </form>
      )}
      {write && beforeShipping && (
        <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel transfer</Button>
      )}
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">{footer()}</div>
    </>
  );
}

/* --- create form --------------------------------------------------------- */

interface DraftLine { sku: string; qty: string; uom: string; batch: string }
const emptyLine = (): DraftLine => ({ sku: "", qty: "", uom: "EA", batch: "" });

function NewTransferForm({ from, codes, onCancel, onCreated }: {
  from: string;
  codes: { code: string; name: string }[];
  onCancel: () => void;
  onCreated: (ref: string, allocation: TransferAllocation[]) => Promise<void>;
}) {
  const action = useAction();
  const [ref, setRef] = useState("");
  const [fromWarehouse, setFromWarehouse] = useState(from);
  const [toWarehouse, setToWarehouse] = useState(codes.find((w) => w.code !== from)?.code ?? "");
  const [requiredBy, setRequiredBy] = useState(localDate());
  const [priority, setPriority] = useState<Priority>("normal");
  const [carrierHint, setCarrierHint] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : cur));

  const sameEnds = fromWarehouse !== "" && fromWarehouse === toWarehouse;
  const filled = lines.filter((l) => l.sku.trim() && l.qty.trim());
  const ready = ref.trim().length > 0 && !sameEnds && toWarehouse !== "" && filled.length > 0;

  const create = async () => {
    const out = await action.run(() => api.message<TransferAccepted>("/v1/transfers", {
      external_ref: ref.trim(),
      from_warehouse: fromWarehouse,
      to_warehouse: toWarehouse,
      required_by: requiredBy || null,
      priority,
      carrier_hint: carrierHint.trim() || null,
      lines: filled.map((l, i) => ({
        line: i + 1, sku: l.sku.trim(), batch: l.batch.trim() || null,
        qty: l.qty.trim(), uom: l.uom.trim() || "EA",
      })),
    }));
    if (out) await onCreated(ref.trim(), out.allocation ?? []);
  };

  return (
    <>
      <DetailHeader
        eyebrow="Transfer"
        title="New transfer"
        subtitle="Stock is reserved at the sender and the pick leg is raised. The receiving leg opens when it ships."
      />
      <div className="flex flex-col gap-3">
        <Field label="Reference" hint="The stock transfer order number" error={action.fieldErrors.external_ref}>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="STO-4500012" aria-label="Reference" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From warehouse" error={action.fieldErrors.from_warehouse}>
            <Select value={fromWarehouse} onChange={(e) => setFromWarehouse(e.target.value)} aria-label="From warehouse">
              {codes.map((w) => <option key={w.code} value={w.code}>{w.code}</option>)}
            </Select>
          </Field>
          <Field
            label="To warehouse"
            error={sameEnds ? "A transfer needs two different warehouses" : action.fieldErrors.to_warehouse}
          >
            <Select value={toWarehouse} onChange={(e) => setToWarehouse(e.target.value)} aria-label="To warehouse">
              {codes.length === 0 && <option value="">No warehouses yet</option>}
              {codes.map((w) => <option key={w.code} value={w.code}>{w.code}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Required by" error={action.fieldErrors.required_by}>
            <Input type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} aria-label="Required by" />
          </Field>
          <Field label="Carrier hint" error={action.fieldErrors.carrier_hint}>
            <Input value={carrierHint} onChange={(e) => setCarrierHint(e.target.value)} placeholder="Own truck" aria-label="Carrier hint" />
          </Field>
        </div>
        <Field label="Priority">
          <SegmentedChoice
            value={priority}
            options={[{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }]}
            onChange={setPriority}
          />
        </Field>
      </div>
      <Section
        title="Lines"
        action={<Button small onClick={() => setLines((cur) => [...cur, emptyLine()])}>Add line</Button>}
      >
        <div className="flex flex-col gap-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_72px_60px_90px_32px] gap-1.5 items-center">
              <Input value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} placeholder="SKU" aria-label={`SKU ${i + 1}`} />
              <Input value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} placeholder="Qty" inputMode="decimal" aria-label={`Qty ${i + 1}`} />
              <Input value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} placeholder="UOM" aria-label={`UOM ${i + 1}`} />
              <Input value={l.batch} onChange={(e) => setLine(i, { batch: e.target.value })} placeholder="Batch" aria-label={`Batch ${i + 1}`} />
              <Button variant="ghost" small className="!px-0" onClick={() => removeLine(i)} disabled={lines.length === 1} aria-label={`Remove line ${i + 1}`}>×</Button>
            </div>
          ))}
        </div>
        {action.fieldErrors.lines && <span className="text-xs leading-4 text-gold">{action.fieldErrors.lines}</span>}
        <Muted className="text-xs leading-4">Batch and received date travel with the stock, so FIFO survives the trip.</Muted>
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

export function Transfers() {
  const { warehouse, warehouses, can } = useAuth();
  const write = can("tasks:write");
  const [direction, setDirection] = useState<Direction>("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("detail");
  const [allocation, setAllocation] = useState<{ ref: string; rows: TransferAllocation[] } | null>(null);

  const code = warehouse?.code;
  const list = useApi<Page<Transfer>>(
    () => api.get<Page<Transfer>>("/v1/transfers", {
      warehouse: code, limit: 500, direction: direction === "all" ? undefined : direction,
    }),
    [code, direction],
  );
  const detail = useApi<Transfer>(
    selectedRef ? () => api.get<Transfer>(`/v1/transfers/${encodeURIComponent(selectedRef)}`) : null,
    [selectedRef],
  );

  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  const picking = items.filter((t) => t.status === "allocated" || t.status === "picking");
  const pickingRoutes = new Set(picking.map((t) => `${t.from_warehouse} → ${t.to_warehouse}`));
  const inTransit = items.filter((t) => t.status === "in_transit");
  const nextDue = [...inTransit].sort((a, b) => (a.required_by ?? "9999").localeCompare(b.required_by ?? "9999"))[0];
  const arrivedToday = items.filter(
    (t) => (t.status === "received" || t.status === "closed") && isToday(t.received_at),
  );
  const lastArrival = [...arrivedToday].sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""))[0];
  const variance = items.filter((t) => t.status === "variance");
  const varianceLines = variance.flatMap((t) => t.lines);
  const varianceQty = sumQty(varianceLines.map((l) => l.variance));

  const rows = items.filter((t) => {
    switch (filter) {
      case "all": return true;
      case "picking": return PICKING.includes(t.status);
      case "arrived": return ARRIVED.includes(t.status);
      case "in_transit": return t.status === "in_transit";
      case "variance": return t.status === "variance";
      case "closed": return t.status === "closed";
      case "cancelled": return t.status === "cancelled";
      default: return true;
    }
  });

  const qtyCell = (lines: TransferLine[]) => fmtQty(sumQty(lines.map((l) => l.qty_requested)), sharedUom(lines));

  const columns: Column<Transfer>[] = [
    { key: "ref", header: "Transfer", width: "140px", render: (t) => <b>{t.external_ref}</b> },
    { key: "from", header: "From", width: "120px", render: (t) => t.from_warehouse },
    { key: "to", header: "To", width: "120px", render: (t) => t.to_warehouse },
    { key: "lines", header: "Lines", width: "70px", render: (t) => String(t.lines.length) },
    { key: "qty", header: "Qty", width: "110px", render: (t) => qtyCell(t.lines) },
    { key: "required", header: "Required", width: "100px", render: (t) => fmtDate(t.required_by) },
    { key: "status", header: "Status", width: "120px", render: (t) => statusPill(t.status) },
    {
      key: "progress", header: "Progress", width: "120px",
      render: (t) => (
        <ProgressBar pct={percent(sumQty(t.lines.map((l) => l.qty_received)), sumQty(t.lines.map((l) => l.qty_requested)))} />
      ),
    },
  ];

  const select = (ref: string) => { setSelectedRef(ref); setMode("detail"); };
  const reloadAll = async () => { await list.reload(); await detail.reload(); };

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Warehouse"} · stock on the move`}
          accent="Transfers"
          title="between sites"
          actions={write ? <Button variant="primary" onClick={() => { setAllocation(null); setMode("create"); }}>Create transfer</Button> : null}
        />

        <div className="grid grid-cols-4 gap-4">
          <StatTile
            label="Picking"
            value={String(picking.length)}
            hint={pickingRoutes.size === 1 ? [...pickingRoutes][0] : "at the sender"}
          />
          <StatTile
            label="In transit"
            value={String(inTransit.length)}
            hint={nextDue?.required_by
              ? `next due ${fmtDate(nextDue.required_by)}`
              : nextDue?.carrier ?? nextDue?.carrier_hint ?? "nothing on the road"}
          />
          <StatTile
            label="Arrived today"
            value={String(arrivedToday.length)}
            hint={lastArrival
              ? `last into ${lastArrival.to_warehouse} ${fmtWhen(lastArrival.received_at)}`
              : "nothing in yet"}
          />
          <StatTile
            label="Variance"
            value={String(variance.length)}
            tone={variance.length > 0 ? "gold" : undefined}
            hint={variance.length > 0 ? fmtQty(varianceQty, sharedUom(varianceLines)) : "nothing outstanding"}
          />
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {DIRECTIONS.map((d) => (
            <Chip key={d.value} active={direction === d.value} onClick={() => setDirection(d.value)}>{d.label}</Chip>
          ))}
          <span className="w-4" />
          {FILTERS.map((f) => <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</Chip>)}
        </div>

        {list.error && <Notice tone="gold">{list.error}</Notice>}
        <Table
          columns={columns}
          rows={rows}
          rowKey={(t) => t.external_ref}
          onRowClick={(t) => select(t.external_ref)}
          selectedKey={mode === "detail" ? selectedRef : null}
          empty={list.loading ? "Loading…" : filter === "all"
            ? "No transfers. Raise one here, or the ERP sends them."
            : "Nothing here with that status."}
        />
        <Muted className="text-xs leading-4">
          Both ends see a transfer. Leg one is a pick at the sender, leg two a put-away at the receiver; in between the stock sits in the in-transit bucket and counts as on hand there.
        </Muted>
      </Main>

      <DetailPanel>
        {mode === "create" && (
          <NewTransferForm
            from={code ?? ""}
            codes={warehouses.map((w) => ({ code: w.code, name: w.name }))}
            onCancel={() => setMode("detail")}
            onCreated={async (ref, rows2) => {
              setAllocation({ ref, rows: rows2 });
              await list.reload();
              setSelectedRef(ref);
              setMode("detail");
            }}
          />
        )}
        {mode === "detail" && allocation && allocation.ref === selectedRef && allocation.rows.length > 0 && allocationNotice(allocation.rows)}
        {mode === "detail" && detail.data && (
          <TransferDetail key={detail.data.external_ref} transfer={detail.data} write={write} reload={reloadAll} />
        )}
        {mode === "detail" && !detail.data && detail.loading && <Muted className="text-sm">Loading…</Muted>}
        {mode === "detail" && !detail.data && !detail.loading && detail.error && <Notice tone="gold">{detail.error}</Notice>}
        {mode === "detail" && !detail.data && !detail.loading && !detail.error && (
          <DetailHeader eyebrow="Transfer" title="—" subtitle="Pick a transfer to see its lines, both legs and anything still in transit." />
        )}
      </DetailPanel>
    </>
  );
}
