import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type {
  Delivery, DeliveryLine, DeliveryPackage, DeliveryStatus, Task, TaskLine,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtDateTime, fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Card, Chip, Eyebrow, Field, Input, KeyValue, Muted, Notice, Pill, Section, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

const SHORT_REASONS: Record<string, string> = {
  not_found: "not found", short_on_shelf: "short on shelf", damaged: "damaged",
  location_unreadable: "location unreadable", customer_cancelled: "customer cancelled",
};

const TASK_STATUS: Record<string, string> = {
  waiting: "Waiting", in_progress: "In progress", needs_supervisor: "Needs a supervisor",
  done: "Done", cancelled: "Cancelled",
};

const PACKAGE_TYPES = ["carton", "pallet", "tote", "satchel"];

/* The printer is asked for once and remembered, not stored per screen. */
const PRINTER_KEY = "wms.printer";
function readPrinter(): string {
  try { return window.localStorage.getItem(PRINTER_KEY) ?? ""; } catch { return ""; }
}
function rememberPrinter(name: string) {
  try { window.localStorage.setItem(PRINTER_KEY, name); } catch { /* private mode */ }
}

type PrintKind = "cartons" | "pick-list" | "packing-slip";
const PRINT_LABEL: Record<PrintKind, string> = {
  cartons: "carton labels", "pick-list": "pick list", "packing-slip": "packing slip",
};

/* Quantities are decimals. Work in their smallest unit, never as floats. */
function decimals(v: string) {
  const i = v.indexOf(".");
  return i < 0 ? 0 : v.length - i - 1;
}
function addQty(values: string[]): string {
  if (values.length === 0) return "0";
  const dp = values.reduce((n, v) => Math.max(n, decimals(v)), 0);
  const f = 10 ** dp;
  const units = values.reduce((n, v) => n + Math.round(Number(v) * f), 0);
  return dp === 0 ? String(units) : (units / f).toFixed(dp).replace(/\.?0+$/, "");
}
function subQty(a: string, b: string): string {
  const dp = Math.max(decimals(a), decimals(b));
  const f = 10 ** dp;
  const units = Math.round(Number(a) * f) - Math.round(Number(b) * f);
  return dp === 0 ? String(units) : (units / f).toFixed(dp).replace(/\.?0+$/, "");
}

function reasonWords(reason: string) {
  return SHORT_REASONS[reason] ?? reason.replace(/_/g, " ");
}

function firstError(errors: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) if (errors[k]) return errors[k];
  return undefined;
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

function linePill(l: DeliveryLine) {
  const ordered = Number(l.qty_ordered);
  if (ordered > 0 && Number(l.qty_shipped) >= ordered) return <Pill tone="ok">Complete</Pill>;
  if (l.short_reason) return <Pill tone="warn">Short · {reasonWords(l.short_reason)}</Pill>;
  if (Number(l.qty_picked) >= ordered && ordered > 0) return <Pill tone="ok">Picked</Pill>;
  if (Number(l.qty_picked) > 0) return <Pill tone="info">In progress</Pill>;
  return <Pill tone="info">Waiting</Pill>;
}

function taskLinePill(l: TaskLine) {
  switch (l.status) {
    case "done": return <Pill tone="ok">Done</Pill>;
    case "short": return <Pill tone="warn">Short</Pill>;
    case "variance": return <Pill tone="warn">Variance {fmtQty(l.variance)}</Pill>;
    case "cancelled": return <Pill tone="muted">Cancelled</Pill>;
    default: return <Pill tone="info">Open</Pill>;
  }
}

function eventPill(status: string) {
  if (status === "delivered") return <Pill tone="ok">Delivered</Pill>;
  if (status === "failed") return <Pill tone="warn">Failed</Pill>;
  return <Pill tone="info">{status === "pending" ? "Queued" : status}</Pill>;
}

function dims(p: DeliveryPackage): string {
  if (!p.length_cm || !p.width_cm || !p.height_cm) return "—";
  return `${fmtQty(p.length_cm)} × ${fmtQty(p.width_cm)} × ${fmtQty(p.height_cm)} cm`;
}

function contents(p: DeliveryPackage): string {
  if (p.lines.length === 0) return "—";
  return p.lines.map((l) => `${l.sku}${l.batch ? ` · ${l.batch}` : ""} × ${fmtQty(l.qty, l.uom)}`).join(", ");
}

/** What is picked and not yet in a carton, per delivery line. */
function leftToPack(delivery: Delivery, line: DeliveryLine): string {
  const packed = addQty(
    delivery.packages.flatMap((p) => p.lines.filter((l) => l.delivery_line === line.delivery_line).map((l) => l.qty)),
  );
  return subQty(line.qty_picked, packed);
}

/* --- pack ---------------------------------------------------------------- */

interface PackLine { delivery_line: number; sku: string; uom: string; qty: string }

function PackForm({ delivery, onCancel, reload }: {
  delivery: Delivery; onCancel: () => void; reload: () => Promise<void>;
}) {
  const { user } = useAuth();
  const action = useAction();
  const nextNo = delivery.packages.reduce((n, p) => Math.max(n, p.package_no), 0) + 1;
  const [packageNo, setPackageNo] = useState(String(nextNo));
  const [type, setType] = useState("carton");
  const [weight, setWeight] = useState("");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [packedBy, setPackedBy] = useState(user?.username ?? "");
  const [complete, setComplete] = useState(false);
  const [lines, setLines] = useState<PackLine[]>(() =>
    delivery.lines
      .map((l) => ({ delivery_line: l.delivery_line, sku: l.sku, uom: l.uom, qty: leftToPack(delivery, l) }))
      .filter((l) => Number(l.qty) > 0),
  );

  const setQty = (n: number, qty: string) =>
    setLines((cur) => cur.map((l) => (l.delivery_line === n ? { ...l, qty } : l)));

  const filled = lines.filter((l) => l.qty.trim() && Number(l.qty) > 0);

  const pack = async () => {
    const out = await action.run(() => api.message(`/v1/deliveries/${encodeURIComponent(delivery.external_ref)}/pack`, {
      warehouse: delivery.warehouse,
      packed_by: packedBy.trim() || null,
      complete,
      packages: [{
        package_no: Number(packageNo),
        type,
        weight_kg: weight.trim() || null,
        length_cm: length.trim() || null,
        width_cm: width.trim() || null,
        height_cm: height.trim() || null,
        lines: filled.map((l) => ({ delivery_line: l.delivery_line, sku: l.sku, qty: l.qty.trim(), uom: l.uom })),
      }],
    }));
    if (out) { await reload(); onCancel(); }
  };

  return (
    <Card className="p-5 flex flex-col gap-4">
      <Eyebrow tone="muted">Pack a carton</Eyebrow>
      <div className="grid grid-cols-[100px_1fr] gap-3 items-end">
        <Field label="Package no." error={firstError(action.fieldErrors, "package_no", "packages.0.package_no")}>
          <Input value={packageNo} onChange={(e) => setPackageNo(e.target.value)} inputMode="numeric" aria-label="Package number" />
        </Field>
        <Field label="Type">
          <div className="flex gap-1 flex-wrap h-10 items-center">
            {PACKAGE_TYPES.map((t) => <Chip key={t} active={type === t} onClick={() => setType(t)}>{t}</Chip>)}
          </div>
        </Field>
      </div>
      <div className="grid grid-cols-5 gap-3">
        <Field label="Weight (kg)" error={firstError(action.fieldErrors, "weight_kg", "packages.0.weight_kg")}>
          <Input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" placeholder="8.4" aria-label="Weight kg" />
        </Field>
        <Field label="Length (cm)">
          <Input value={length} onChange={(e) => setLength(e.target.value)} inputMode="decimal" placeholder="40" aria-label="Length cm" />
        </Field>
        <Field label="Width (cm)">
          <Input value={width} onChange={(e) => setWidth(e.target.value)} inputMode="decimal" placeholder="30" aria-label="Width cm" />
        </Field>
        <Field label="Height (cm)">
          <Input value={height} onChange={(e) => setHeight(e.target.value)} inputMode="decimal" placeholder="25" aria-label="Height cm" />
        </Field>
        <Field label="Packed by" error={firstError(action.fieldErrors, "packed_by")}>
          <Input value={packedBy} onChange={(e) => setPackedBy(e.target.value)} placeholder="op-017" aria-label="Packed by" />
        </Field>
      </div>
      <Section title="What goes in">
        {lines.length === 0 ? (
          <Muted className="text-sm">Everything picked is already in a carton.</Muted>
        ) : (
          <div className="flex flex-col gap-2">
            {lines.map((l) => (
              <div key={l.delivery_line} className="grid grid-cols-[80px_1fr_120px] gap-2 items-center text-sm leading-5">
                <Muted>Line {l.delivery_line}</Muted>
                <span>{l.sku}</span>
                <Input
                  value={l.qty}
                  onChange={(e) => setQty(l.delivery_line, e.target.value)}
                  inputMode="decimal"
                  aria-label={`Pack qty line ${l.delivery_line}`}
                />
              </div>
            ))}
          </div>
        )}
      </Section>
      <Toggle
        checked={complete}
        onChange={setComplete}
        label="This is the last carton"
        hint="Closes the packing and the delivery becomes packed"
      />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="flex gap-2">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void pack()} disabled={action.busy || filled.length === 0}>Pack carton</Button>
      </div>
    </Card>
  );
}

/* --- ship ---------------------------------------------------------------- */

function ShipForm({ delivery, onCancel, reload }: {
  delivery: Delivery; onCancel: () => void; reload: () => Promise<void>;
}) {
  const { user } = useAuth();
  const action = useAction();
  const [carrier, setCarrier] = useState(delivery.carrier ?? delivery.carrier_hint ?? "");
  const [tracking, setTracking] = useState(delivery.tracking_no ?? "");
  const [shippedBy, setShippedBy] = useState(user?.username ?? "");

  const ship = async () => {
    const out = await action.run(() => api.message(`/v1/deliveries/${encodeURIComponent(delivery.external_ref)}/ship`, {
      warehouse: delivery.warehouse,
      carrier: carrier.trim(),
      tracking_no: tracking.trim() || null,
      shipped_by: shippedBy.trim() || null,
    }));
    if (out) { await reload(); onCancel(); }
  };

  return (
    <Card className="p-5 flex flex-col gap-4">
      <Eyebrow tone="muted">Ship this delivery</Eyebrow>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Carrier" error={firstError(action.fieldErrors, "carrier")}>
          <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Toll" aria-label="Carrier" autoFocus />
        </Field>
        <Field label="Tracking number" error={firstError(action.fieldErrors, "tracking_no")}>
          <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="TOLL-99123" aria-label="Tracking number" />
        </Field>
        <Field label="Shipped by" error={firstError(action.fieldErrors, "shipped_by")}>
          <Input value={shippedBy} onChange={(e) => setShippedBy(e.target.value)} placeholder="op-017" aria-label="Shipped by" />
        </Field>
      </div>
      {delivery.short && <Notice tone="gold">This delivery is short. It can only ship if short shipping is allowed on the order.</Notice>}
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="flex gap-2">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void ship()} disabled={action.busy || !carrier.trim()}>Ship delivery</Button>
      </div>
    </Card>
  );
}

/* --- pick task ----------------------------------------------------------- */

function PickTask({ task }: { task: Task }) {
  return (
    <>
      <Muted className="text-sm leading-5">
        {task.assigned_to ?? "unassigned"} · {task.device ?? "no device"} · {TASK_STATUS[task.status] ?? task.status} · {task.progress.done} of {task.progress.total} lines
      </Muted>
      <div className="flex flex-col rounded-lg border border-line">
        {task.lines.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No lines on the pick task yet.</div>}
        {task.lines.map((l) => (
          <div key={l.line_no} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
            <span className="truncate">
              {l.sku} · {l.name}
              {l.from_location ? <Muted> · {l.from_location}</Muted> : null}
            </span>
            <span className="shrink-0 flex items-center gap-2">
              <span className="text-ink">{fmtQty(l.actual_qty ?? "0")} / {l.expected_qty ? fmtQty(l.expected_qty) : "?"} {l.uom}</span>
              {taskLinePill(l)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function DeliveryDetail() {
  const { ref = "" } = useParams();
  const [params] = useSearchParams();
  const { can } = useAuth();
  const write = can("tasks:write");
  const action = useAction();
  const [form, setForm] = useState<"none" | "pack" | "ship">(() => {
    const a = params.get("action");
    return a === "pack" || a === "ship" ? a : "none";
  });

  const detail = useApi<Delivery>(() => api.get<Delivery>(`/v1/deliveries/${encodeURIComponent(ref)}`), [ref]);
  const d = detail.data;

  const canPrint = can("printing:write");
  const [printer, setPrinter] = useState(readPrinter);
  const [printKind, setPrintKind] = useState<PrintKind | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [printed, setPrinted] = useState<{ tone: "ok" | "gold"; text: string } | null>(null);
  const arm = (kind: PrintKind) => { setPrintKind((k) => (k === kind ? null : kind)); setPrinted(null); };

  /** A carton label per package, or the one document the button asked for. */
  async function sendPrint() {
    const name = printer.trim();
    if (!name || !d || !printKind) return;
    rememberPrinter(name);
    setPrintBusy(true);
    setPrinted(null);
    const jobs = printKind === "cartons"
      ? d.packages.map((p) => ({
        template: "carton-label",
        reference: { type: "delivery", ref: d.external_ref, package_no: p.package_no },
      }))
      : [{ template: printKind, reference: { type: "delivery", ref: d.external_ref } }];
    let sent = 0;
    let firstFailure: string | null = null;
    for (const job of jobs) {
      try {
        await api.message("/v1/print-jobs", {
          warehouse: d.warehouse, template: job.template, printer: name, copies: 1, reference: job.reference,
        });
        sent += 1;
      } catch (e) {
        if (!firstFailure) firstFailure = e instanceof ApiError ? e.message : "Could not reach the WMS";
      }
    }
    const failed = jobs.length - sent;
    const what = printKind === "cartons" ? plural(sent, "carton label") : `the ${PRINT_LABEL[printKind]}`;
    setPrintBusy(false);
    setPrintKind(null);
    setPrinted({
      tone: failed > 0 ? "gold" : "ok",
      text: failed > 0
        ? `Sent ${what} to ${name}. ${failed} failed: ${firstFailure}`
        : `Sent ${what} to ${name}.`,
    });
  }

  const cancel = async () => {
    if (!d) return;
    if (!window.confirm(`Cancel ${d.external_ref}? The reservations go back and delivery.cancelled is sent. Nothing is deleted.`)) return;
    const out = await action.run(() => api.message(
      `/v1/deliveries/${encodeURIComponent(d.external_ref)}/cancel`,
      { reason: "cancelled from the desktop" },
    ));
    if (out) await detail.reload();
  };

  const lineColumns: Column<DeliveryLine>[] = [
    { key: "line", header: "Line", width: "70px", render: (l) => String(l.delivery_line) },
    { key: "sku", header: "SKU", width: "120px", render: (l) => <b>{l.sku}</b> },
    { key: "name", header: "Name", render: (l) => <Muted>{l.name}</Muted> },
    { key: "batch", header: "Batch", width: "110px", render: (l) => l.batch ?? <Muted>—</Muted> },
    { key: "ordered", header: "Ordered", width: "100px", render: (l) => fmtQty(l.qty_ordered, l.uom) },
    { key: "allocated", header: "Allocated", width: "100px", render: (l) => fmtQty(l.qty_allocated) },
    { key: "picked", header: "Picked", width: "90px", render: (l) => fmtQty(l.qty_picked) },
    { key: "shipped", header: "Shipped", width: "90px", render: (l) => fmtQty(l.qty_shipped) },
    { key: "status", header: "Status", width: "190px", render: (l) => linePill(l) },
  ];

  const packageColumns: Column<DeliveryPackage>[] = [
    { key: "no", header: "Package", width: "90px", render: (p) => <b>{p.package_no}</b> },
    { key: "type", header: "Type", width: "100px", render: (p) => p.type },
    { key: "weight", header: "Weight (kg)", width: "110px", render: (p) => fmtQty(p.weight_kg) },
    { key: "dims", header: "Dimensions", width: "170px", render: (p) => dims(p) },
    { key: "sscc", header: "SSCC", width: "180px", render: (p) => p.sscc ? <span className="mono">{p.sscc}</span> : <Muted>—</Muted> },
    { key: "contents", header: "Contents", render: (p) => contents(p) },
    { key: "packed_by", header: "Packed by", width: "120px", render: (p) => <Muted>{p.packed_by ?? "—"}</Muted> },
  ];

  type EventRow = Delivery["events"][number];
  const eventColumns: Column<EventRow>[] = [
    { key: "event", header: "Event", width: "220px", render: (e) => e.event_type },
    { key: "subscriber", header: "Subscriber", render: (e) => e.subscriber },
    { key: "status", header: "Status", width: "130px", render: (e) => eventPill(e.status) },
    { key: "when", header: "When", width: "120px", render: (e) => <Muted>{fmtWhen(e.at)}</Muted> },
  ];

  return (
    <Main>
      <div className="flex items-center gap-3">
        <Link
          to="/deliveries"
          aria-label="Back to deliveries"
          className="w-10 h-10 shrink-0 flex items-center justify-center rounded-md border border-line no-underline"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ccd6f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
          </svg>
        </Link>
        <div className="flex flex-col gap-1 min-w-0">
          <Eyebrow>Delivery</Eyebrow>
          <h1 className="m-0 text-[30px] leading-9 font-bold truncate">
            <span className="text-brand">{ref}</span>{d ? ` ${d.ship_to.name}` : ""}
          </h1>
        </div>
        <div className="grow" />
        {d && statusPill(d.status)}
        {d?.short && d.status !== "cancelled" && <Pill tone="warn">Short</Pill>}
      </div>

      {detail.loading && !d && <Muted className="text-sm">Loading…</Muted>}
      {detail.error && <Notice tone="gold">{detail.error}</Notice>}

      {d && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card className="p-5 flex flex-col gap-1">
              <Eyebrow tone="muted">Ship to</Eyebrow>
              <span className="text-sm leading-5">{d.ship_to.name}</span>
              <Muted className="text-sm leading-5">{d.ship_to.address ?? "—"}</Muted>
              <Muted className="text-sm leading-5">
                {[d.ship_to.suburb, d.ship_to.state, d.ship_to.postcode].filter(Boolean).join(" ") || "—"}
              </Muted>
              <Muted className="text-xs leading-4">{d.ship_to.country ?? "AU"} · short {d.allow_short ? "allowed" : "not allowed"}</Muted>
            </Card>
            <Card className="p-5 flex flex-col gap-3">
              <Eyebrow tone="muted">Timing</Eyebrow>
              <KeyValue items={[
                { label: "Created", value: fmtDateTime(d.created_at) },
                { label: "Required by", value: fmtDate(d.required_by) },
                { label: "Allocated", value: fmtDateTime(d.allocated_at) },
                { label: "Picked", value: fmtDateTime(d.picked_at) },
                { label: "Packed", value: fmtDateTime(d.packed_at) },
                { label: "Shipped", value: fmtDateTime(d.shipped_at) },
              ]} />
            </Card>
            <Card className="p-5 flex flex-col gap-1">
              <Eyebrow tone="muted">Carrier</Eyebrow>
              <span className="text-sm leading-5">{d.carrier ?? d.carrier_hint ?? "Not booked yet"}</span>
              <span className="text-sm leading-5 mono">{d.tracking_no ?? "—"}</span>
              <Muted className="text-sm leading-5">{d.pick_mode} pick · {d.priority} priority</Muted>
              <Muted className="text-xs leading-4">Staging {d.staging_location ?? "—"}</Muted>
            </Card>
          </div>

          <Section title="Lines">
            <Table columns={lineColumns} rows={d.lines} rowKey={(l) => String(l.delivery_line)} empty="No lines on this delivery." />
          </Section>

          <Section title="Packages">
            <Table columns={packageColumns} rows={d.packages} rowKey={(p) => String(p.package_no)} empty="Nothing packed yet." />
          </Section>

          <Section title="Pick task">
            {d.task ? <PickTask task={d.task} /> : <Muted className="text-sm">No pick task yet. One is raised as soon as the delivery is allocated.</Muted>}
          </Section>

          <Section title="Events sent">
            <Table columns={eventColumns} rows={d.events} rowKey={(e) => `${e.event_type}/${e.subscriber}/${e.at}`} empty="Nothing sent yet." />
          </Section>

          {form === "pack" && <PackForm key={d.packages.length} delivery={d} onCancel={() => setForm("none")} reload={detail.reload} />}
          {form === "ship" && <ShipForm delivery={d} onCancel={() => setForm("none")} reload={detail.reload} />}

          {action.error && <Notice tone="gold">{action.error}</Notice>}
          {printed && <Notice tone={printed.tone}>{printed.text}</Notice>}

          {canPrint && printKind && (
            <form
              className="flex gap-3 items-end flex-wrap rounded-md border border-line p-3"
              onSubmit={(e) => { e.preventDefault(); void sendPrint(); }}
            >
              <Field label="Printer" className="w-[220px]">
                <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Packing bench 2" autoFocus />
              </Field>
              <Button type="submit" variant="primary" disabled={printBusy || !printer.trim()}>
                {printBusy ? "Printing…" : "Print"}
              </Button>
              <Button type="button" onClick={() => setPrintKind(null)}>Cancel</Button>
              <Muted className="text-sm">
                {printKind === "cartons" ? `${plural(d.packages.length, "carton label")} · one job each` : `One ${PRINT_LABEL[printKind]}`}
              </Muted>
            </form>
          )}

          {(write || canPrint) && (
            <div className="flex gap-2">
              {write && d.status !== "shipped" && d.status !== "cancelled" && (
                <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel delivery</Button>
              )}
              {write && (d.status === "picked" || d.status === "packing") && (
                <Button variant="primary" onClick={() => setForm(form === "pack" ? "none" : "pack")}>Pack</Button>
              )}
              {write && d.status === "packed" && (
                <Button variant="primary" onClick={() => setForm(form === "ship" ? "none" : "ship")}>Ship</Button>
              )}
              {canPrint && (
                <>
                  <Button
                    onClick={() => arm("cartons")}
                    disabled={d.packages.length === 0}
                    title={d.packages.length === 0 ? "Nothing has been packed yet" : undefined}
                  >
                    Print labels
                  </Button>
                  <Button onClick={() => arm("pick-list")}>Print pick list</Button>
                  <Button onClick={() => arm("packing-slip")}>Print packing slip</Button>
                </>
              )}
            </div>
          )}

          <Muted className="text-xs leading-4">
            {plural(d.lines.length, "line")} · {plural(d.packages.length, "package")} · everything here is <span className="mono">GET /v1/deliveries/{d.external_ref}</span>. Cancelling gives the reservations back; nothing is deleted.
          </Muted>
        </>
      )}
    </Main>
  );
}
