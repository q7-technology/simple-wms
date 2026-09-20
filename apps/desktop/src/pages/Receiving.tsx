import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Accepted, Page, Receipt, ReceiptLine, TaskReply } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill, Section,
  StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

type Filter = "all" | "expected" | "arrived" | "receiving" | "complete" | "late";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" }, { value: "expected", label: "Expected" }, { value: "arrived", label: "Arrived" },
  { value: "receiving", label: "Receiving" }, { value: "complete", label: "Complete" }, { value: "late", label: "Late" },
];

type Mode = "detail" | "create";

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Local calendar date as YYYY-MM-DD. */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateOf(s: string | null): string | null {
  return s ? s.slice(0, 10) : null;
}

function isToday(iso: string | null, now = new Date()) {
  return !!iso && new Date(iso).toDateString() === now.toDateString();
}

/** Expected before today and still not put away. */
function isLate(r: Receipt, today: string) {
  const due = dateOf(r.expected_at);
  return !!due && due < today && (r.status === "expected" || r.status === "arrived");
}

function sharedUom(lines: { uom: string }[]): string | undefined {
  const set = new Set(lines.map((l) => l.uom));
  return set.size === 1 ? [...set][0] : undefined;
}

function statusPill(r: Receipt, today: string) {
  if (r.status === "expected" && isLate(r, today)) return <Pill tone="warn">Late</Pill>;
  switch (r.status) {
    case "expected": return <Pill tone="info">Expected</Pill>;
    case "arrived": return <Pill tone="info">Arrived</Pill>;
    case "receiving": return <Pill tone="info">Receiving</Pill>;
    case "complete": return <Pill tone="ok">Complete</Pill>;
    case "closed_short": return <Pill tone="warn">Closed short</Pill>;
    default: return <Pill tone="muted">Cancelled</Pill>;
  }
}

function nextStep(r: Receipt, today: string): string {
  if (r.status === "receiving") {
    const t = r.task;
    if (!t) return "Putting away";
    return `${t.assigned_to ?? "unassigned"} · line ${Math.min(t.progress.done + 1, Math.max(t.progress.total, 1))} of ${t.progress.total}`;
  }
  if (r.status === "arrived") return `Truck at ${r.dock ?? "the dock"}`;
  if (r.status === "expected" && isLate(r, today)) return "Chase supplier";
  if (r.status === "complete") return "Closed";
  if (r.status === "closed_short") return "Closed short";
  return "—";
}

function eventPill(status: string) {
  if (status === "delivered") return <Pill tone="ok">Delivered</Pill>;
  if (status === "failed") return <Pill tone="warn">Failed</Pill>;
  return <Pill tone="info">{status === "pending" ? "Queued" : status}</Pill>;
}

/* --- detail panel -------------------------------------------------------- */

function ReceiptDetail({ receipt, write, tolerance, reload }: {
  receipt: Receipt; write: boolean; tolerance: number | undefined; reload: () => Promise<void>;
}) {
  const action = useAction();
  const [dock, setDock] = useState(receipt.dock ?? "");
  const [carrier, setCarrier] = useState(receipt.carrier ?? "");
  const open = receipt.status === "expected" || receipt.status === "arrived" || receipt.status === "receiving";

  const markArrived = async () => {
    const out = await action.run(() => api.message<Accepted>(`/v1/receipts/${encodeURIComponent(receipt.external_ref)}/arrived`, {
      dock: dock.trim() || null, carrier: carrier.trim() || null,
    }));
    if (out) await reload();
  };
  const closeShort = async () => {
    if (!receipt.task) return;
    if (!window.confirm(`Close ${receipt.external_ref} short? Open lines become short and the ERP is told.`)) return;
    const out = await action.run(() => api.message<TaskReply>(`/v1/tasks/${receipt.task!.wms_id}/close`, { reason: "supplier_short" }));
    if (out) await reload();
  };

  return (
    <>
      <DetailHeader
        eyebrow="Expected receipt"
        title={receipt.external_ref}
        subtitle={`${receipt.supplier ?? "No supplier"} · ${plural(receipt.lines.length, "line")} · ref from ERP`}
      />
      <KeyValue items={[
        { label: "Dock", value: receipt.dock ?? "—" },
        { label: "Carrier", value: receipt.carrier ?? "—" },
        { label: "Over-receipt", value: tolerance === undefined ? "—" : `Up to ${tolerance} %` },
        { label: "Batch required", value: receipt.lines.some((l) => l.batch) ? "Yes" : "—" },
      ]} />
      {write && receipt.status === "expected" && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
          <span className="text-xs leading-4 text-muted">Truck arrived?</span>
          <div className="flex gap-2">
            <Input value={dock} onChange={(e) => setDock(e.target.value)} placeholder="Dock" aria-label="Dock" />
            <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Carrier" aria-label="Carrier" />
          </div>
          <Button small onClick={() => void markArrived()} disabled={action.busy}>Mark arrived</Button>
        </div>
      )}
      <Section title="Lines">
        <div className="flex flex-col rounded-lg border border-line">
          {receipt.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines on this receipt.</div>}
          {receipt.lines.map((l) => (
            <div key={l.line} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">{l.sku} · {l.name}{l.batch ? <Muted> · {l.batch}</Muted> : null}</span>
              <span className="shrink-0 text-ink">{fmtQty(l.received_qty)} / {fmtQty(l.expected_qty)}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Put away so far">
        <div className="flex flex-col rounded-lg border border-line">
          {receipt.putaways.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing put away yet.</div>}
          {receipt.putaways.map((p) => (
            <div key={p.ledger_id} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">{fmtQty(p.qty, p.uom)} {p.sku} → {p.location}</span>
              <Muted className="shrink-0">{p.actor} · {fmtWhen(p.at)}</Muted>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Events">
        <div className="flex flex-col rounded-lg border border-line">
          {receipt.events.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing sent yet.</div>}
          {receipt.events.map((e, i) => (
            <div key={i} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">{e.event_type} → {e.subscriber}</span>
              {eventPill(e.status)}
            </div>
          ))}
        </div>
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button disabled title="Printing comes with step 4">Print labels</Button>
        {write && open && receipt.task && (
          <Button variant="gold" onClick={() => void closeShort()} disabled={action.busy}>Close short</Button>
        )}
      </div>
    </>
  );
}

/* --- create form --------------------------------------------------------- */

interface DraftLine { sku: string; qty: string; uom: string; batch: string }
const emptyLine = (): DraftLine => ({ sku: "", qty: "", uom: "EA", batch: "" });

function NewReceiptForm({ warehouse, onCancel, onCreated }: {
  warehouse: string; onCancel: () => void; onCreated: (ref: string) => Promise<void>;
}) {
  const action = useAction();
  const [ref, setRef] = useState("");
  const [supplier, setSupplier] = useState("");
  const [expectedAt, setExpectedAt] = useState(localDate());
  const [dock, setDock] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : cur));

  const filled = lines.filter((l) => l.sku.trim() && l.qty.trim());
  const ready = ref.trim().length > 0 && filled.length > 0;

  const create = async () => {
    const out = await action.run(() => api.message<Accepted>("/v1/receipts", {
      external_ref: ref.trim(), warehouse, owner: "DEFAULT", supplier: supplier.trim() || null,
      expected_at: expectedAt || null, dock: dock.trim() || null,
      lines: filled.map((l, i) => ({
        line: i + 1, sku: l.sku.trim(), batch: l.batch.trim() || null, qty: l.qty.trim(), uom: l.uom.trim() || "EA",
      })),
    }));
    if (out) await onCreated(ref.trim());
  };

  return (
    <>
      <DetailHeader eyebrow="Expected receipt" title="New receipt" subtitle="One receive task is raised with a line per receipt line. The ERP usually sends these; this is the by-hand door." />
      <div className="flex flex-col gap-3">
        <Field label="Reference" hint="The PO or ASN number" error={action.fieldErrors.external_ref}>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PO-88818" aria-label="Reference" autoFocus />
        </Field>
        <Field label="Supplier" error={action.fieldErrors.supplier}>
          <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Supplier" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expected date" error={action.fieldErrors.expected_at}>
            <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} aria-label="Expected date" />
          </Field>
          <Field label="Dock" error={action.fieldErrors.dock}>
            <Input value={dock} onChange={(e) => setDock(e.target.value)} placeholder="Dock 1" aria-label="Dock" />
          </Field>
        </div>
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
        <Muted className="text-xs leading-4">Leave batch blank on a batch-tracked product and the scanner reads it off the label.</Muted>
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()} disabled={action.busy || !ready}>Create receipt</Button>
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function Receiving() {
  const { warehouse, can } = useAuth();
  const navigate = useNavigate();
  const write = can("tasks:write");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("detail");
  const today = localDate();

  const code = warehouse?.code;
  const list = useApi<Page<Receipt>>(() => api.get<Page<Receipt>>("/v1/receipts", { warehouse: code, limit: 500 }), [code]);
  const detail = useApi<Receipt>(
    selectedRef ? () => api.get<Receipt>(`/v1/receipts/${encodeURIComponent(selectedRef)}`) : null,
    [selectedRef],
  );

  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    return [...all].sort((a, b) => (a.expected_at ?? "9999").localeCompare(b.expected_at ?? "9999"));
  }, [list.data]);

  const expectedToday = items.filter((r) => dateOf(r.expected_at) === today);
  const suppliers = new Set(expectedToday.map((r) => r.supplier ?? "")).size;
  const arrived = items.filter((r) => r.status === "arrived");
  const putAway = items.filter((r) => r.status === "receiving" || isToday(r.closed_at));
  const putAwayQty = putAway.reduce((n, r) => n + Number(r.received_total), 0);
  const putAwayUom = sharedUom(putAway.flatMap((r) => r.lines)) ?? "EA";
  const late = items.filter((r) => isLate(r, today));

  const rows = items.filter((r) => {
    switch (filter) {
      case "all": return true;
      case "late": return isLate(r, today);
      case "complete": return r.status === "complete" || r.status === "closed_short";
      default: return r.status === filter;
    }
  });

  const qtyWithUom = (qty: string, lines: ReceiptLine[]) => fmtQty(qty, sharedUom(lines));

  const columns: Column<Receipt>[] = [
    { key: "ref", header: "Receipt", width: "130px", render: (r) => <b>{r.external_ref}</b> },
    { key: "supplier", header: "Supplier", render: (r) => r.supplier ?? <Muted>—</Muted> },
    { key: "lines", header: "Lines", width: "70px", render: (r) => String(r.lines.length) },
    { key: "expected", header: "Expected", width: "110px", render: (r) => qtyWithUom(r.expected_total, r.lines) },
    {
      key: "received", header: "Received", width: "110px",
      render: (r) => Number(r.received_total) > 0 ? qtyWithUom(r.received_total, r.lines) : <Muted>—</Muted>,
    },
    { key: "due", header: "Due", width: "100px", render: (r) => dateOf(r.expected_at) === today ? "Today" : fmtDate(r.expected_at) },
    { key: "status", header: "Status", width: "120px", render: (r) => statusPill(r, today) },
    { key: "next", header: "Next", width: "200px", render: (r) => <Muted>{nextStep(r, today)}</Muted> },
  ];

  const reloadAll = async () => { await list.reload(); await detail.reload(); };
  const select = (ref: string) => { setSelectedRef(ref); setMode("detail"); };

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Warehouse"} · inbound`}
          accent="Receiving"
          title="expected today"
          actions={<>
            <Button variant="gold" onClick={() => navigate("/import")}>Import ASN</Button>
            {write && <Button variant="primary" onClick={() => setMode("create")}>Create expected receipt</Button>}
          </>}
        />

        <div className="grid grid-cols-4 gap-4">
          <StatTile label="Expected today" value={String(expectedToday.length)} hint={`from ${plural(suppliers, "supplier")}`} />
          <StatTile label="Arrived, not put away" value={String(arrived.length)} hint="on the receiving dock" />
          <StatTile label="Put away today" value={fmtQty(putAwayQty)} hint={putAwayUom} />
          <StatTile
            label="Late"
            value={String(late.length)}
            tone={late.length > 0 ? "gold" : undefined}
            hint={late.length > 0 ? `${late[0].external_ref} · due ${fmtDate(late[0].expected_at)}` : "nothing overdue"}
          />
        </div>

        <div className="flex items-center gap-1">
          {FILTERS.map((f) => <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</Chip>)}
        </div>

        {list.error && <Notice tone="gold">{list.error}</Notice>}
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.external_ref}
          onRowClick={(r) => select(r.external_ref)}
          selectedKey={mode === "detail" ? selectedRef : null}
          empty={list.loading ? "Loading…" : filter === "all"
            ? "Nothing expected. Create a receipt or import an ASN and it lands here."
            : "Nothing here with that status."}
        />
        <Muted className="text-xs leading-4">Receipts arrive from the ERP as <span className="mono">POST /v1/receipts</span>. Each one is a receive task the scanner works line by line.</Muted>
      </Main>

      <DetailPanel>
        {mode === "create" && (
          <NewReceiptForm
            warehouse={code ?? ""}
            onCancel={() => setMode("detail")}
            onCreated={async (ref) => { await list.reload(); setSelectedRef(ref); setMode("detail"); }}
          />
        )}
        {mode === "detail" && detail.data && (
          <ReceiptDetail
            key={detail.data.external_ref}
            receipt={detail.data}
            write={write}
            tolerance={warehouse?.settings?.receipt_tolerance_pct}
            reload={reloadAll}
          />
        )}
        {mode === "detail" && !detail.data && detail.loading && <Muted className="text-sm">Loading…</Muted>}
        {mode === "detail" && !detail.data && !detail.loading && detail.error && <Notice tone="gold">{detail.error}</Notice>}
        {mode === "detail" && !detail.data && !detail.loading && !detail.error && (
          <DetailHeader eyebrow="Expected receipt" title="—" subtitle="Pick a receipt to see its lines, what has been put away and what was sent to the ERP." />
        )}
      </DetailPanel>
    </>
  );
}
