import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { Page, PrintJob, PrintJobStatus, PrintPoint, PrintTemplate, Warehouse } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDateTime, fmtWhen } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  Section, Select, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

/** The events in the contract's event table. A print point may be set for one
 * before any template names it in fires_on. */
const CONTRACT_EVENTS = [
  "delivery.allocated", "delivery.cancelled", "delivery.packed", "delivery.picked", "delivery.shipped",
  "production.components_issued", "production.received", "receipt.confirmed", "replenishment.completed",
  "stock.adjusted", "stock.moved", "transfer.received", "transfer.shipped",
];

/** Templates POST /v1/print-jobs can build from a reference. The rest are
 * printed by their print points. */
const ON_DEMAND_TEMPLATES = ["location-label", "product-label", "carton-label", "pick-list", "packing-slip"];

type JobFilter = "all" | PrintJobStatus;
type RefKind = "location" | "product" | "delivery";

type Selection =
  | { kind: "none" }
  | { kind: "point"; id: string }
  | { kind: "new-point" }
  | { kind: "print-now" };

/** Lists come back as a page; be kind to an API that hands back a bare array. */
function rows<T>(data: Page<T> | T[] | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : data.items ?? [];
}

function shortJobId(id: string): string {
  return `job-…${id.slice(-4)}`;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** "0080012345 · carton 1" */
function jobReference(job: PrintJob): string {
  const ref = text(job.reference?.ref) ?? "—";
  const pkg = text(job.reference?.package_no);
  return pkg ? `${ref} · carton ${pkg}` : ref;
}

function jobWhen(job: PrintJob): string {
  return fmtWhen(job.printed_at ?? job.sent_at ?? job.created_at);
}

function jobPill(job: PrintJob) {
  if (job.status === "printed") return <Pill tone="ok">Printed</Pill>;
  if (job.status === "accepted") return <Pill tone="info">Accepted</Pill>;
  if (job.status === "failed") return <Pill tone="warn">Failed</Pill>;
  if (job.attempts > 0) return <Pill tone="warn">Retrying</Pill>;
  return <Pill tone="info">Queued</Pill>;
}

function pointPill(point: PrintPoint) {
  return point.active && point.copies > 0 ? <Pill tone="info">On</Pill> : <Pill tone="muted">Off</Pill>;
}

function templateCell(template: string, version: string) {
  return <>{template} <Muted>{version}</Muted></>;
}

/** The whole print point as POST /v1/print-points takes it. */
function pointBody(point: PrintPoint, over: Partial<PrintPoint> = {}): Record<string, unknown> {
  const merged = { ...point, ...over };
  return {
    warehouse: merged.warehouse, event_type: merged.event_type, template: merged.template,
    printer: merged.printer, copies: merged.copies, owner: merged.owner, active: merged.active,
  };
}

/* --- panel: one print point ---------------------------------------------- */

function PointDetail({ point, templates, jobs, admin, reload }: {
  point: PrintPoint; templates: PrintTemplate[]; jobs: PrintJob[]; admin: boolean; reload: () => Promise<void>;
}) {
  const action = useAction();
  const [printer, setPrinter] = useState(point.printer);
  const [copies, setCopies] = useState(String(point.copies));
  const [saved, setSaved] = useState(false);
  const off = !point.active || point.copies === 0;

  const forTemplate = jobs.filter((j) => j.template === point.template);
  const latest = forTemplate[0] ?? null;
  const fields = templates.find((t) => t.template === point.template)?.fields ?? [];

  const save = async () => {
    setSaved(false);
    const out = await action.run(() => api.post<PrintPoint>("/v1/print-points",
      pointBody(point, { printer: printer.trim(), copies: Number(copies) || 0 })));
    if (out) { setSaved(true); await reload(); }
  };

  const turnOff = async () => {
    if (!window.confirm(`Turn off ${point.template} on ${point.event_type}? Nothing prints from this event until it is turned back on.`)) return;
    await action.run(() => api.post(`/v1/print-points/${point.wms_id}/deactivate`));
    await reload();
  };

  const turnOn = async () => {
    await action.run(() => api.post<PrintPoint>("/v1/print-points",
      pointBody(point, { printer: printer.trim(), copies: Number(copies) || 1, active: true })));
    await reload();
  };

  return (
    <>
      <DetailHeader
        eyebrow="Print point"
        title={point.event_type}
        subtitle={`${point.template} ${point.version} → ${point.printer}`}
      />
      {off && <Notice tone="gold">Off. This event prints nothing until it is turned back on.</Notice>}
      <KeyValue items={[
        { label: "Warehouse", value: point.warehouse ?? "All" },
        { label: "Copies", value: String(point.copies) },
        { label: "Owner", value: point.owner },
        { label: "Version", value: point.version },
        { label: "Created", value: fmtDateTime(point.created_at) },
      ]} />
      <Section title="Where it prints">
        <div className="flex flex-col gap-3">
          <Field label="Printer" hint="Printer names come from Platen" error={action.fieldErrors.printer}>
            <Input value={printer} onChange={(e) => setPrinter(e.target.value)} readOnly={!admin} />
          </Field>
          <Field label="Copies" hint="0 turns it off without losing the row" error={action.fieldErrors.copies}>
            <Input type="number" min={0} value={copies} onChange={(e) => setCopies(e.target.value)} readOnly={!admin} />
          </Field>
        </div>
      </Section>
      <Section title="What Platen receives">
        {latest ? (
          <div className="card p-4 max-h-72 overflow-auto">
            <pre className="mono m-0 text-xs leading-5">{JSON.stringify(latest.data, null, 2)}</pre>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Muted className="text-xs leading-4">No job yet. These are the fields this template sends.</Muted>
            <div className="card p-4 flex flex-col gap-1">
              {fields.length === 0
                ? <Muted className="text-sm">No fields listed for this template.</Muted>
                : fields.map((f) => <span key={f} className="mono text-xs leading-5">{f}</span>)}
            </div>
          </div>
        )}
        <Muted className="text-xs leading-4">Adding a field is a new version. Old versions keep working.</Muted>
      </Section>
      <Section title="Recent jobs for this template">
        <div className="flex flex-col rounded-lg border border-line">
          {forTemplate.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing printed yet from this template.</div>}
          {forTemplate.slice(0, 5).map((j) => (
            <div key={j.wms_id} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">{jobReference(j)}<br /><Muted className="text-xs leading-4">{j.printer} · {jobWhen(j)}</Muted></span>
              <span className="shrink-0">{jobPill(j)}</span>
            </div>
          ))}
        </div>
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {saved && !action.error && <Notice tone="ok">Saved.</Notice>}
      {admin && (
        <>
          <div className="grow" />
          <div className="flex gap-2 [&>*]:grow">
            {off
              ? <Button variant="gold" onClick={() => void turnOn()} disabled={action.busy}>Turn on</Button>
              : <Button variant="gold" onClick={() => void turnOff()} disabled={action.busy}>Turn off</Button>}
            <Button variant="primary" onClick={() => void save()} disabled={action.busy || !printer.trim()}>Save</Button>
          </div>
        </>
      )}
    </>
  );
}

/* --- panel: add a print point -------------------------------------------- */

function NewPointForm({ templates, warehouses, current, onCancel, onCreated }: {
  templates: PrintTemplate[]; warehouses: Warehouse[]; current: string | null;
  onCancel: () => void; onCreated: (row: PrintPoint) => void;
}) {
  const action = useAction();
  const [event, setEvent] = useState("");
  const [template, setTemplate] = useState("");
  const [printer, setPrinter] = useState("");
  const [copies, setCopies] = useState("1");
  const [warehouse, setWarehouse] = useState(current ?? "");
  const [active, setActive] = useState(true);

  const events = useMemo(() => {
    const all = new Set(CONTRACT_EVENTS);
    templates.forEach((t) => t.fires_on.forEach((e) => all.add(e)));
    return [...all].sort();
  }, [templates]);

  const pickEvent = (value: string) => {
    setEvent(value);
    const match = templates.find((t) => t.fires_on.includes(value));
    if (match) setTemplate(match.template);
  };

  const create = async () => {
    const out = await action.run(() => api.post<PrintPoint>("/v1/print-points", {
      warehouse: warehouse === "" ? null : warehouse,
      event_type: event, template, printer: printer.trim(), copies: Number(copies) || 0,
      owner: "*", active,
    }));
    if (out) onCreated(out);
  };

  return (
    <>
      <DetailHeader
        eyebrow="Print point"
        title="New print point"
        subtitle="Every outbound event runs its print points, whether anyone subscribes to it or not."
      />
      <div className="flex flex-col gap-3">
        <Field label="Event" hint="What has to happen before this prints" error={action.fieldErrors.event_type}>
          <Select value={event} onChange={(e) => pickEvent(e.target.value)}>
            <option value="">Choose an event</option>
            {events.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
        </Field>
        <Field label="Template" error={action.fieldErrors.template}>
          <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Choose a template</option>
            {templates.map((t) => <option key={t.template} value={t.template}>{t.template} {t.version}</option>)}
          </Select>
        </Field>
        <Field label="Printer" hint="Printer names come from Platen" error={action.fieldErrors.printer}>
          <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Packing bench 2" />
        </Field>
        <Field label="Copies" hint="0 turns it off without losing the row" error={action.fieldErrors.copies}>
          <Input type="number" min={0} value={copies} onChange={(e) => setCopies(e.target.value)} />
        </Field>
        <Field label="Warehouse" hint="All warehouses covers every one of them" error={action.fieldErrors.warehouse}>
          <Select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
            <option value="">All warehouses</option>
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}
          </Select>
        </Field>
        <Toggle checked={active} onChange={setActive} label="Active" hint="An inactive print point keeps its row and prints nothing" />
      </div>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => void create()}
          disabled={action.busy || !event || !template || !printer.trim()}
        >
          Add print point
        </Button>
      </div>
    </>
  );
}

/* --- panel: print one now ------------------------------------------------ */

function PrintNowForm({ warehouse, onCancel, onSent }: {
  warehouse: string | null; onCancel: () => void; onSent: () => Promise<void>;
}) {
  const action = useAction();
  const [template, setTemplate] = useState("location-label");
  const [kind, setKind] = useState<RefKind>("location");
  const [ref, setRef] = useState("");
  const [batch, setBatch] = useState("");
  const [qty, setQty] = useState("");
  const [pkg, setPkg] = useState("");
  const [printer, setPrinter] = useState("");
  const [copies, setCopies] = useState("1");
  const [sentTo, setSentTo] = useState<string | null>(null);

  const send = async () => {
    setSentTo(null);
    const reference: Record<string, unknown> = { type: kind, ref: ref.trim() };
    if (kind === "product") {
      if (batch.trim()) reference.batch = batch.trim();
      if (qty.trim()) reference.qty = qty.trim();
    }
    if (kind === "delivery" && pkg.trim()) reference.package_no = Number(pkg);
    const out = await action.run(() => api.message<PrintJob>("/v1/print-jobs", {
      warehouse, template, printer: printer.trim(), copies: Number(copies) || 1, reference,
    }));
    if (out) { setSentTo(printer.trim()); await onSent(); }
  };

  return (
    <>
      <DetailHeader
        eyebrow="Print something"
        title="One off"
        subtitle="The WMS builds the data for the template you name and queues the job."
      />
      <div className="flex flex-col gap-3">
        <Field label="Template" error={action.fieldErrors.template}>
          <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {ON_DEMAND_TEMPLATES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Muted className="text-xs leading-4">Pallet labels and transfer dockets are printed by their print points, not by hand.</Muted>
        <Field label="What" hint="What the label is about">
          <Select value={kind} onChange={(e) => setKind(e.target.value as RefKind)}>
            <option value="location">Location</option>
            <option value="product">Product</option>
            <option value="delivery">Delivery</option>
          </Select>
        </Field>
        {kind === "location" && (
          <Field label="Location code" error={action.fieldErrors.reference}>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PF-01-02-A" />
          </Field>
        )}
        {kind === "product" && (
          <>
            <Field label="SKU" error={action.fieldErrors.reference}>
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ABC123" />
            </Field>
            <Field label="Batch" hint="Optional">
              <Input value={batch} onChange={(e) => setBatch(e.target.value)} />
            </Field>
            <Field label="Qty" hint="Optional">
              <Input value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          </>
        )}
        {kind === "delivery" && (
          <>
            <Field label="Delivery reference" error={action.fieldErrors.reference}>
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="0080012345" />
            </Field>
            <Field label="Carton number" hint="Optional. Needed for a carton label">
              <Input type="number" min={1} value={pkg} onChange={(e) => setPkg(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Printer" hint="Printer names come from Platen" error={action.fieldErrors.printer}>
          <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Office" />
        </Field>
        <Field label="Copies" error={action.fieldErrors.copies}>
          <Input type="number" min={1} value={copies} onChange={(e) => setCopies(e.target.value)} />
        </Field>
      </div>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {sentTo && !action.error && <Notice tone="ok">Sent to {sentTo}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => void send()}
          disabled={action.busy || !ref.trim() || !printer.trim()}
        >
          Print
        </Button>
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function Printing() {
  const { can, warehouse, warehouses } = useAuth();
  const admin = can("integration:admin");
  const mayPrint = can("printing:write");
  const code = warehouse?.code ?? null;
  const platen = warehouse?.settings?.platen_url ?? null;

  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [filter, setFilter] = useState<JobFilter>("all");
  const [fresh, setFresh] = useState<PrintPoint | null>(null);
  const reprint = useAction();

  const templates = useApi<Page<PrintTemplate> | PrintTemplate[]>(
    () => api.get<Page<PrintTemplate>>("/v1/print-templates"), []);
  const points = useApi<Page<PrintPoint> | PrintPoint[]>(
    () => api.get<Page<PrintPoint>>("/v1/print-points", { warehouse: code ?? undefined }), [code]);
  const jobs = useApi<Page<PrintJob> | PrintJob[]>(
    () => api.get<Page<PrintJob>>("/v1/print-jobs", {
      warehouse: code ?? undefined, status: filter === "all" ? undefined : filter, limit: 50,
    }), [code, filter]);

  const templateList = rows(templates.data);
  const pointList = rows(points.data);
  const jobList = rows(jobs.data);

  const reprintJob = async (job: PrintJob) => {
    await reprint.run(() => api.message(`/v1/print-jobs/${job.wms_id}/reprint`, {}));
    await jobs.reload();
  };

  const pointColumns: Column<PrintPoint>[] = [
    { key: "event", header: "Event", width: "170px", render: (r) => r.event_type },
    { key: "template", header: "Template", render: (r) => templateCell(r.template, r.version) },
    { key: "printer", header: "Printer", width: "150px", render: (r) => r.printer },
    {
      key: "copies", header: "Copies", width: "90px",
      render: (r) => <>{r.copies}{(!r.active || r.copies === 0) && <Muted> · off</Muted>}</>,
    },
    { key: "warehouse", header: "Warehouse", width: "110px", render: (r) => r.warehouse ?? "All" },
    { key: "status", header: "Status", width: "80px", render: pointPill },
  ];

  const jobColumns: Column<PrintJob>[] = [
    { key: "job", header: "Job", width: "110px", render: (r) => <span className="mono">{shortJobId(r.job_id)}</span> },
    { key: "template", header: "Template", width: "160px", render: (r) => templateCell(r.template, r.version) },
    { key: "printer", header: "Printer", width: "140px", render: (r) => r.printer },
    {
      key: "ref", header: "Reference",
      render: (r) => (
        <span className="flex flex-col min-w-0">
          <span className="truncate">{jobReference(r)}</span>
          {r.last_error && <span className="text-gold text-xs leading-4 truncate">{r.last_error}</span>}
        </span>
      ),
    },
    { key: "copies", header: "Copies", width: "70px", render: (r) => String(r.copies) },
    { key: "status", header: "Status", width: "90px", render: jobPill },
    { key: "when", header: "When", width: "80px", render: (r) => <Muted>{jobWhen(r)}</Muted> },
    {
      key: "actions", header: "", width: "90px", align: "right",
      render: (r) => mayPrint
        ? <Button small onClick={() => void reprintJob(r)} disabled={reprint.busy}>Reprint</Button>
        : null,
    },
  ];

  const templateColumns: Column<PrintTemplate>[] = [
    { key: "template", header: "Template", width: "150px", render: (r) => r.template },
    { key: "version", header: "Version", width: "80px", render: (r) => <Muted>{r.version}</Muted> },
    {
      key: "fires", header: "Fires on", width: "200px",
      render: (r) => r.fires_on.length > 0 ? r.fires_on.join(", ") : <Muted>printed by hand</Muted>,
    },
    { key: "describe", header: "What it is", render: (r) => <Muted>{r.describe}</Muted> },
  ];

  const selected = selection.kind === "point"
    ? pointList.find((p) => p.wms_id === selection.id) ?? (fresh?.wms_id === selection.id ? fresh : null)
    : null;

  return (
    <>
      <Main>
        <PageHeader
          eyebrow="Templates and printers"
          accent="Printing"
          title="and Platen"
          actions={
            <>
              {mayPrint && <Button onClick={() => setSelection({ kind: "print-now" })}>Print something</Button>}
              {admin && <Button variant="primary" onClick={() => setSelection({ kind: "new-point" })}>Add print point</Button>}
            </>
          }
        />

        {platen
          ? <Muted className="text-xs leading-4">Sending to {platen}</Muted>
          : (
            <Notice tone="gold">
              No print service is set for {code ?? "this warehouse"}. Jobs will wait in the queue until a Platen URL is
              set on the Settings screen.
            </Notice>
          )}

        <Section title="Print points (event → template → printer)">
          {points.error && <Notice tone="gold">{points.error}</Notice>}
          <Table
            columns={pointColumns}
            rows={pointList}
            rowKey={(r) => r.wms_id}
            onRowClick={(r) => setSelection({ kind: "point", id: r.wms_id })}
            selectedKey={selection.kind === "point" ? selection.id : null}
            empty={points.loading ? "Loading…" : "No print points yet. Add one to print a label the moment an event happens."}
          />
        </Section>

        <Section
          title="Recent jobs"
          action={
            <div className="flex items-center gap-1">
              <Chip active={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
              <Chip active={filter === "pending"} onClick={() => setFilter("pending")}>Queued</Chip>
              <Chip active={filter === "accepted"} onClick={() => setFilter("accepted")}>Accepted</Chip>
              <Chip active={filter === "printed"} onClick={() => setFilter("printed")}>Printed</Chip>
              <Chip active={filter === "failed"} onClick={() => setFilter("failed")}>Failed</Chip>
            </div>
          }
        >
          {jobs.error && <Notice tone="gold">{jobs.error}</Notice>}
          {reprint.error && <Notice tone="gold">{reprint.error}</Notice>}
          <Table
            columns={jobColumns}
            rows={jobList}
            rowKey={(r) => r.wms_id}
            empty={jobs.loading ? "Loading…" : filter === "all"
              ? "Nothing printed yet. Jobs appear here as events fire their print points."
              : "Nothing here with that status."}
          />
          <Muted className="text-xs leading-4">
            Newest 50. A refused job is retried on the same backoff as events (1 min, 5, 30, 2 h), then marked failed for a reprint.
          </Muted>
        </Section>

        <Section title="Templates (every document type and its version)">
          {templates.error && <Notice tone="gold">{templates.error}</Notice>}
          <Table
            columns={templateColumns}
            rows={templateList}
            rowKey={(r) => r.template}
            empty={templates.loading ? "Loading…" : "No templates. The API lists every document type it can build."}
          />
          <Muted className="text-xs leading-4">
            The WMS renders nothing. It sends the template, the version and the JSON; Platen does the rendering.
          </Muted>
        </Section>
      </Main>

      <DetailPanel>
        {selection.kind === "new-point" && (
          <NewPointForm
            templates={templateList}
            warehouses={warehouses}
            current={code}
            onCancel={() => setSelection({ kind: "none" })}
            onCreated={(row) => {
              setFresh(row);
              setSelection({ kind: "point", id: row.wms_id });
              void points.reload();
            }}
          />
        )}
        {selection.kind === "print-now" && (
          <PrintNowForm
            warehouse={code}
            onCancel={() => setSelection({ kind: "none" })}
            onSent={jobs.reload}
          />
        )}
        {selection.kind === "point" && selected && (
          <PointDetail
            key={selected.wms_id}
            point={selected}
            templates={templateList}
            jobs={jobList}
            admin={admin}
            reload={points.reload}
          />
        )}
        {(selection.kind === "none" || (selection.kind === "point" && !selected)) && (
          <DetailHeader
            eyebrow="Printing"
            title="—"
            subtitle="Pick a print point to see the exact JSON Platen receives and what it has printed lately."
          />
        )}
      </DetailPanel>
    </>
  );
}
