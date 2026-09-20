import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { AllocationRow, Delivery, DeliveryAccepted, DeliveryLine, DeliveryStatus, Page } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  SearchInput, Section, SegmentedChoice, StatTile, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

type Filter = "all" | "allocated" | "picking" | "packed" | "shipped" | "short" | "cancelled";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "allocated", label: "Waiting to pick" },
  { value: "picking", label: "Picking" },
  { value: "packed", label: "Packed" },
  { value: "shipped", label: "Shipped" },
  { value: "short", label: "Short" },
  { value: "cancelled", label: "Cancelled" },
];

type Mode = "detail" | "create";
type PickMode = "single" | "batch" | "auto";
type Priority = "low" | "normal" | "high";

const PICK_MODES: { value: PickMode; label: string; soon?: string }[] = [
  { value: "single", label: "Single" },
  { value: "batch", label: "Batch" },
  { value: "auto", label: "Auto" },
];

const SHORT_REASONS: Record<string, string> = {
  not_found: "not found", short_on_shelf: "short on shelf", damaged: "damaged",
  location_unreadable: "location unreadable", customer_cancelled: "customer cancelled",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Local calendar date as YYYY-MM-DD. */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Saturday 20 Sep", the way the whiteboard says it. */
function dayLabel(d = new Date()) {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
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
  return SHORT_REASONS[reason] ?? reason.replace(/_/g, " ");
}

function statusPill(status: DeliveryStatus) {
  switch (status) {
    case "allocated": return <Pill tone="info">Waiting</Pill>;
    case "picking": return <Pill tone="info">Picking</Pill>;
    case "picked": return <Pill tone="info">Picked</Pill>;
    case "packing": return <Pill tone="info">Packing</Pill>;
    case "packed": return <Pill tone="info">Packed</Pill>;
    case "shipped": return <Pill tone="ok">Shipped</Pill>;
    case "cancelled": return <Pill tone="muted">Cancelled</Pill>;
    default: return <Pill tone="info">New</Pill>;
  }
}

function eventPill(status: string) {
  if (status === "delivered") return <Pill tone="ok">Delivered</Pill>;
  if (status === "failed") return <Pill tone="warn">Failed</Pill>;
  return <Pill tone="info">{status === "pending" ? "Queued" : status}</Pill>;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <span className="block h-1.5 w-full rounded-full bg-line overflow-hidden">
      <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
    </span>
  );
}

function allocationNotice(rows: AllocationRow[]) {
  const short = rows.filter((r) => Number(r.short) > 0);
  if (short.length === 0) {
    return <Notice tone="ok">{`All ${plural(rows.length, "line")} allocated`}</Notice>;
  }
  const words = short.map((r) => `${r.sku} short ${fmtQty(r.short, r.uom)}`).join(" · ");
  return <Notice tone="gold">{`${rows.length - short.length} of ${rows.length} lines allocated · ${words}`}</Notice>;
}

/* --- detail panel -------------------------------------------------------- */

function DeliveryDetailPanel({ delivery, write, reload }: {
  delivery: Delivery; write: boolean; reload: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const action = useAction();
  const ordered = sumQty(delivery.lines.map((l) => l.qty_ordered));
  const picked = sumQty(delivery.lines.map((l) => l.qty_picked));
  const uom = sharedUom(delivery.lines);
  const full = `/deliveries/${encodeURIComponent(delivery.external_ref)}`;
  const openStill = delivery.status !== "shipped" && delivery.status !== "cancelled";

  const cancel = async () => {
    if (!window.confirm(`Cancel ${delivery.external_ref}? The reservations go back and delivery.cancelled is sent. Nothing is deleted.`)) return;
    const out = await action.run(() => api.message(
      `/v1/deliveries/${encodeURIComponent(delivery.external_ref)}/cancel`,
      { reason: "cancelled from the desktop" },
    ));
    if (out) await reload();
  };

  const primary = () => {
    switch (delivery.status) {
      case "allocated":
      case "picking":
        return <Button variant="primary" onClick={() => navigate("/tasks")}>View pick task</Button>;
      case "picked":
      case "packing":
        return <Button variant="primary" onClick={() => navigate(`${full}?action=pack`)}>Pack</Button>;
      case "packed":
        return <Button variant="primary" onClick={() => navigate(`${full}?action=ship`)}>Ship</Button>;
      case "shipped":
        return <Button variant="primary" disabled>Shipped</Button>;
      case "cancelled":
        return <Button variant="primary" disabled>Cancelled</Button>;
      default:
        return <Button variant="primary" disabled>Waiting on allocation</Button>;
    }
  };

  return (
    <>
      <DetailHeader
        eyebrow="Delivery"
        title={delivery.external_ref}
        subtitle={`${delivery.ship_to.name} · ${plural(delivery.lines.length, "line")} · ${delivery.priority} priority`}
      />
      <div className="flex flex-col gap-2">
        <ProgressBar pct={percent(picked, ordered)} />
        <Muted className="text-xs leading-4">{fmtQty(picked)} of {fmtQty(ordered, uom)} picked</Muted>
      </div>
      <KeyValue items={[
        { label: "Required by", value: fmtDate(delivery.required_by) },
        { label: "Pick mode", value: delivery.pick_mode },
        { label: "Carrier", value: delivery.carrier ?? delivery.carrier_hint ?? "—" },
        { label: "Allow short", value: delivery.allow_short ? "Yes" : "No" },
      ]} />
      <Section title="Lines">
        <div className="flex flex-col rounded-lg border border-line">
          {delivery.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines on this delivery.</div>}
          {delivery.lines.map((l) => (
            <div key={l.delivery_line} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">
                {l.sku} · {l.name}
                {l.short_reason ? <span className="text-gold"> · {reasonWords(l.short_reason)}</span> : null}
              </span>
              <span className="shrink-0 text-ink">{fmtQty(l.qty_picked)} / {fmtQty(l.qty_ordered, l.uom)}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Events sent">
        <div className="flex flex-col rounded-lg border border-line">
          {delivery.events.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing sent yet.</div>}
          {delivery.events.map((e, i) => (
            <div key={i} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">{e.event_type} → {e.subscriber}</span>
              {eventPill(e.status)}
            </div>
          ))}
        </div>
      </Section>
      {write && openStill && (
        <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel delivery</Button>
      )}
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button variant="quiet" onClick={() => navigate(full)}>Open full page</Button>
        {primary()}
      </div>
    </>
  );
}

/* --- create form --------------------------------------------------------- */

interface DraftLine { sku: string; qty: string; uom: string; batch: string }
const emptyLine = (): DraftLine => ({ sku: "", qty: "", uom: "EA", batch: "" });

function NewDeliveryForm({ warehouse, onCancel, onCreated }: {
  warehouse: string;
  onCancel: () => void;
  onCreated: (ref: string, allocation: AllocationRow[]) => Promise<void>;
}) {
  const action = useAction();
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [suburb, setSuburb] = useState("");
  const [state, setState] = useState("");
  const [postcode, setPostcode] = useState("");
  const [requiredBy, setRequiredBy] = useState(localDate());
  const [priority, setPriority] = useState<Priority>("normal");
  const [pickMode, setPickMode] = useState<PickMode>("single");
  const [allowShort, setAllowShort] = useState(true);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : cur));

  const filled = lines.filter((l) => l.sku.trim() && l.qty.trim());
  const ready = ref.trim().length > 0 && name.trim().length > 0 && filled.length > 0;

  const create = async () => {
    const out = await action.run(() => api.message<DeliveryAccepted>("/v1/deliveries", {
      external_ref: ref.trim(), warehouse, owner: "DEFAULT",
      pick_mode: pickMode, priority, required_by: requiredBy || null,
      ship_to: {
        name: name.trim(),
        address: address.trim() || null,
        suburb: suburb.trim() || null,
        state: state.trim() || null,
        postcode: postcode.trim() || null,
      },
      allow_short: allowShort,
      lines: filled.map((l, i) => ({
        delivery_line: (i + 1) * 10, sku: l.sku.trim(), batch: l.batch.trim() || null,
        qty: l.qty.trim(), uom: l.uom.trim() || "EA",
      })),
    }));
    if (out) await onCreated(ref.trim(), out.allocation ?? []);
  };

  return (
    <>
      <DetailHeader
        eyebrow="Delivery"
        title="New delivery"
        subtitle="Stock is reserved as soon as this is saved and one pick task is raised. The ERP usually sends these; this is the by-hand door."
      />
      <div className="flex flex-col gap-3">
        <Field label="Reference" hint="The order number the customer sees" error={action.fieldErrors.external_ref}>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="0080012345" aria-label="Reference" autoFocus />
        </Field>
        <Field label="Ship to" error={action.fieldErrors["ship_to.name"]}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Auto Parts" aria-label="Ship to name" />
        </Field>
        <Field label="Address" error={action.fieldErrors["ship_to.address"]}>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 Example St" aria-label="Address" />
        </Field>
        <div className="grid grid-cols-[1fr_80px_90px] gap-2">
          <Field label="Suburb">
            <Input value={suburb} onChange={(e) => setSuburb(e.target.value)} placeholder="Geelong" aria-label="Suburb" />
          </Field>
          <Field label="State">
            <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="VIC" aria-label="State" />
          </Field>
          <Field label="Postcode">
            <Input value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="3220" aria-label="Postcode" inputMode="numeric" />
          </Field>
        </div>
        <Field label="Required by" error={action.fieldErrors.required_by}>
          <Input type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} aria-label="Required by" />
        </Field>
        <Field label="Priority">
          <SegmentedChoice
            value={priority}
            options={[{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }]}
            onChange={setPriority}
          />
        </Field>
        <Field label="Pick mode" hint="Auto lets the WMS decide by order size and zone">
          <div className="flex gap-1 flex-wrap">
            {PICK_MODES.map((m) => m.soon ? (
              <span
                key={m.value}
                title={m.soon}
                className="inline-block rounded-full border border-line px-2 py-0.5 text-xs leading-4 font-semibold text-muted/50 cursor-not-allowed"
              >
                {m.label}
              </span>
            ) : (
              <Chip key={m.value} active={pickMode === m.value} onClick={() => setPickMode(m.value)}>{m.label}</Chip>
            ))}
          </div>
        </Field>
        <Toggle
          checked={allowShort}
          onChange={setAllowShort}
          label="Allow short"
          hint="Off means the order cannot ship until every line is filled"
        />
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
        <Muted className="text-xs leading-4">Leave batch blank and the WMS reserves the oldest stock first.</Muted>
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

export function Deliveries() {
  const { warehouse, can } = useAuth();
  const navigate = useNavigate();
  const write = can("tasks:write");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("detail");
  const [allocation, setAllocation] = useState<{ ref: string; rows: AllocationRow[] } | null>(null);

  const code = warehouse?.code;
  const list = useApi<Page<Delivery>>(() => api.get<Page<Delivery>>("/v1/deliveries", { warehouse: code, limit: 500 }), [code]);
  const detail = useApi<Delivery>(
    selectedRef ? () => api.get<Delivery>(`/v1/deliveries/${encodeURIComponent(selectedRef)}`) : null,
    [selectedRef],
  );

  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  const waiting = items.filter((d) => d.status === "allocated");
  const waitingHigh = waiting.filter((d) => d.priority === "high").length;
  const pickingNow = items.filter((d) => d.status === "picking");
  const operators = new Set(pickingNow.map((d) => d.task?.assigned_to).filter(Boolean)).size;
  const packed = items.filter((d) => d.status === "packed" || d.status === "packing");
  const packedShort = packed.filter((d) => d.short).length;
  const shippedToday = items.filter((d) => d.status === "shipped" && isToday(d.shipped_at));
  const lastShipped = [...shippedToday].sort((a, b) => (b.shipped_at ?? "").localeCompare(a.shipped_at ?? ""))[0];

  const needle = search.trim().toLowerCase();
  const rows = items.filter((d) => {
    const matches = !needle
      || d.external_ref.toLowerCase().includes(needle)
      || d.ship_to.name.toLowerCase().includes(needle)
      || d.lines.some((l) => l.sku.toLowerCase().includes(needle));
    if (!matches) return false;
    switch (filter) {
      case "all": return true;
      case "short": return d.short && d.status !== "cancelled";
      case "packed": return d.status === "packed" || d.status === "packing";
      default: return d.status === filter;
    }
  });

  const qtyCell = (lines: DeliveryLine[]) => fmtQty(sumQty(lines.map((l) => l.qty_ordered)), sharedUom(lines));

  const columns: Column<Delivery>[] = [
    { key: "ref", header: "Delivery", width: "140px", render: (d) => <b>{d.external_ref}</b> },
    {
      key: "ship_to", header: "Ship to",
      render: (d) => <>{d.ship_to.name}{d.ship_to.suburb ? <Muted> · {d.ship_to.suburb}</Muted> : null}</>,
    },
    { key: "lines", header: "Lines", width: "70px", render: (d) => String(d.lines.length) },
    { key: "qty", header: "Qty", width: "110px", render: (d) => qtyCell(d.lines) },
    { key: "required", header: "Required", width: "100px", render: (d) => fmtDate(d.required_by) },
    {
      key: "priority", header: "Priority", width: "90px",
      render: (d) => d.priority === "high" ? <Pill tone="warn">High</Pill> : <Muted>Normal</Muted>,
    },
    {
      key: "status", header: "Status", width: "160px",
      render: (d) => (
        <span className="flex items-center gap-1.5">
          {statusPill(d.status)}
          {d.short && d.status !== "cancelled" && <Pill tone="warn">Short</Pill>}
        </span>
      ),
    },
    {
      key: "progress", header: "Picked", width: "120px",
      render: (d) => (
        <ProgressBar pct={percent(sumQty(d.lines.map((l) => l.qty_picked)), sumQty(d.lines.map((l) => l.qty_ordered)))} />
      ),
    },
  ];

  const select = (ref: string) => { setSelectedRef(ref); setMode("detail"); };
  const reloadAll = async () => { await list.reload(); await detail.reload(); };

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Warehouse"} · ${dayLabel()}`}
          accent="Deliveries"
          title="today"
          actions={<>
            <Button variant="quiet" onClick={() => navigate("/deliveries/batches")}>Batch pick</Button>
            <Button variant="gold" onClick={() => navigate("/import")}>Import CSV</Button>
            {write && <Button variant="primary" onClick={() => { setAllocation(null); setMode("create"); }}>Create delivery</Button>}
          </>}
        />

        <div className="grid grid-cols-4 gap-4">
          <StatTile
            label="Waiting to pick"
            value={String(waiting.length)}
            hint={waitingHigh > 0 ? `${waitingHigh} high priority` : "nothing urgent"}
          />
          <StatTile
            label="Picking now"
            value={String(pickingNow.length)}
            hint={operators > 0 ? `${plural(operators, "operator")} on the floor` : "nobody has started yet"}
          />
          <StatTile
            label="Packed, not shipped"
            value={String(packed.length)}
            hint={packedShort > 0 ? `${packedShort} short` : "waiting on the carrier"}
          />
          <StatTile
            label="Shipped today"
            value={String(shippedToday.length)}
            hint={lastShipped?.carrier ? `last with ${lastShipped.carrier}` : plural(shippedToday.length, "order")}
          />
        </div>

        <div className="flex items-center gap-2">
          <SearchInput
            className="w-[320px]"
            placeholder="Search reference, customer or SKU"
            aria-label="Search deliveries"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {FILTERS.map((f) => <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</Chip>)}
        </div>

        {list.error && <Notice tone="gold">{list.error}</Notice>}
        <Table
          columns={columns}
          rows={rows}
          rowKey={(d) => d.external_ref}
          onRowClick={(d) => select(d.external_ref)}
          selectedKey={mode === "detail" ? selectedRef : null}
          empty={list.loading ? "Loading…" : filter === "all" && !needle
            ? "No deliveries yet. They arrive from the ERP, or create one here."
            : "Nothing here with that status."}
        />
        <Muted className="text-xs leading-4">Deliveries arrive from the ERP as <span className="mono">POST /v1/deliveries</span>. Stock is reserved as each one lands and a pick task is raised in walk order.</Muted>
      </Main>

      <DetailPanel>
        {mode === "create" && (
          <NewDeliveryForm
            warehouse={code ?? ""}
            onCancel={() => setMode("detail")}
            onCreated={async (ref, rows) => {
              setAllocation({ ref, rows });
              await list.reload();
              setSelectedRef(ref);
              setMode("detail");
            }}
          />
        )}
        {mode === "detail" && allocation && allocation.ref === selectedRef && allocation.rows.length > 0 && allocationNotice(allocation.rows)}
        {mode === "detail" && detail.data && (
          <DeliveryDetailPanel key={detail.data.external_ref} delivery={detail.data} write={write} reload={reloadAll} />
        )}
        {mode === "detail" && !detail.data && detail.loading && <Muted className="text-sm">Loading…</Muted>}
        {mode === "detail" && !detail.data && !detail.loading && detail.error && <Notice tone="gold">{detail.error}</Notice>}
        {mode === "detail" && !detail.data && !detail.loading && !detail.error && (
          <DetailHeader eyebrow="Delivery" title="—" subtitle="Pick a delivery to see its lines, how far the pick has got and what was sent to the ERP." />
        )}
      </DetailPanel>
    </>
  );
}
