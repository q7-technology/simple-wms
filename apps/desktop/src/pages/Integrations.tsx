import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { ApiClientRow, OutboundEvent, Page, PrintPoint, Subscriber } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  Section, Select, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

const SCOPES = [
  "*", "master:read", "master:write", "stock:read", "stock:write", "tasks:read", "tasks:write",
  "integration:read", "integration:admin", "access:read", "access:admin",
];

/** A supplier's own carton label is nobody's standard, so a site writes its own. */
interface ScanPattern {
  wms_id: string; warehouse: string | null; name: string; pattern: string; type: string;
  order: number; fields: string[]; note: string | null; active: boolean;
  created_by: string | null; created_at: string;
}
interface UnknownScan { raw: string; seen: number; last_seen_at: string; expecting: string | null }
interface TryReply { matches: boolean; fields: Record<string, string> }

const PATTERN_TYPES: { value: string; label: string }[] = [
  { value: "product", label: "Product" },
  { value: "location", label: "Location" },
  { value: "container", label: "Container" },
  { value: "operator", label: "Operator" },
  { value: "receipt", label: "Receipt" },
  { value: "delivery", label: "Delivery" },
  { value: "production_order", label: "Production order" },
  { value: "task", label: "Task" },
];
const PATTERN_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(PATTERN_TYPES.map((t) => [t.value, t.label]));

type Selection =
  | { kind: "none" }
  | { kind: "key"; id: string }
  | { kind: "subscriber"; id: string }
  | { kind: "pattern"; id: string }
  | { kind: "new-key" }
  | { kind: "new-subscriber" }
  | { kind: "new-pattern"; raw: string };

type EventFilter = "all" | "pending" | "failed" | "delivered";

/** "a, b , c" → ["a", "b", "c"]. */
function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function shortEventId(id: string) {
  return `evt-…${id.slice(-4)}`;
}

function subscriberPill(s: Subscriber) {
  switch (s.status) {
    case "ok": return <Pill tone="ok">OK</Pill>;
    case "retrying": return <Pill tone="warn">Retrying</Pill>;
    case "failed": return <Pill tone="warn">Failed</Pill>;
    default: return <Pill tone="muted">Idle</Pill>;
  }
}

function subscriberSentence(s: Subscriber): string {
  switch (s.status) {
    case "ok": return `Delivering · last ${fmtWhen(s.last_delivery_at)}`;
    case "retrying": return `Retrying · ${plural(s.pending, "event")} pending`;
    case "failed": return `Failed · ${plural(s.failed, "event")} given up, ${s.pending} pending`;
    default: return "Idle · nothing sent yet";
  }
}

function eventPill(e: OutboundEvent) {
  if (e.status === "delivered") return <Pill tone="ok">Delivered</Pill>;
  if (e.status === "failed") return <Pill tone="warn">Failed</Pill>;
  if (e.attempts > 0) return <Pill tone="warn">Retrying</Pill>;
  return <Pill tone="info">Queued</Pill>;
}

function canRetry(e: OutboundEvent) {
  return e.status === "failed" || (e.status === "pending" && e.attempts > 0);
}

/** A key or secret shown this once, with a copy button. */
function Reveal({ label, value }: { label: "key" | "secret"; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }
    } catch { /* clipboard blocked; the value is on screen */ }
  };
  return (
    <Notice tone="gold">
      <div className="flex flex-col gap-2">
        <span>Copy this {label} now. It is shown once and never stored.</span>
        <div className="flex items-center gap-2">
          <span className="mono text-ink break-all grow">{value}</span>
          <Button small variant="gold" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
        </div>
      </div>
    </Notice>
  );
}

/* --- API key detail ------------------------------------------------------ */

function KeyDetail({ row, admin, revealed, onRevealed, reload }: {
  row: ApiClientRow; admin: boolean; revealed: string | null; onRevealed: (key: string) => void; reload: () => Promise<void>;
}) {
  const action = useAction();
  const rotate = async () => {
    const out = await action.run(() => api.post<ApiClientRow>(`/v1/api-clients/${row.wms_id}/rotate`));
    if (out?.key) onRevealed(out.key);
    await reload();
  };
  const revoke = async () => {
    if (!window.confirm(`Revoke ${row.name}? Every call with this key fails from now on. This cannot be undone.`)) return;
    await action.run(() => api.post(`/v1/api-clients/${row.wms_id}/revoke`));
    await reload();
  };
  return (
    <>
      <DetailHeader
        eyebrow="API key"
        title={row.name}
        subtitle={`Created ${fmtDate(row.created_at)} · last used ${fmtWhen(row.last_used_at)} · key shown once`}
      />
      {revealed && <Reveal label="key" value={revealed} />}
      {!row.active && <Notice tone="gold">Revoked. Calls with this key are refused.</Notice>}
      <KeyValue items={[
        { label: "Scopes", value: row.scopes.join(", ") },
        { label: "Warehouses", value: row.warehouses.join(", ") },
        { label: "Owner", value: row.owner },
        { label: "IP allowlist", value: row.ip_allowlist.length ? row.ip_allowlist.join(", ") : "any" },
      ]} />
      <Section title="Message IDs">
        <KeyValue items={[
          { label: "Duplicates rejected (24 h)", value: String(row.duplicates_24h) },
          { label: "Last duplicate", value: fmtWhen(row.last_duplicate_at) },
        ]} />
        <Muted className="text-xs leading-4">A repeated message_id returns the original reply and does nothing.</Muted>
      </Section>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {admin && row.active && (
        <>
          <div className="grow" />
          <div className="flex gap-2 [&>*]:grow">
            <Button onClick={() => void rotate()} disabled={action.busy}>Rotate key</Button>
            <Button variant="gold" onClick={() => void revoke()} disabled={action.busy}>Revoke</Button>
          </div>
        </>
      )}
    </>
  );
}

/* --- subscriber detail --------------------------------------------------- */

function SubscriberDetail({ sub, admin, revealed, reload }: {
  sub: Subscriber; admin: boolean; revealed: string | null; reload: () => Promise<void>;
}) {
  const action = useAction();
  const [url, setUrl] = useState(sub.url);
  const [events, setEvents] = useState(sub.event_types.join(", "));
  const [warehouses, setWarehouses] = useState(sub.warehouses.join(", "));
  const [active, setActive] = useState(sub.active);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaved(false);
    const out = await action.run(() => api.post<Subscriber>("/v1/subscribers", {
      name: sub.name, url: url.trim(), event_types: splitList(events), warehouses: splitList(warehouses),
      owner: sub.owner, active,
    }));
    if (out) { setSaved(true); await reload(); }
  };

  return (
    <>
      <DetailHeader eyebrow="Subscriber" title={sub.name} subtitle={subscriberSentence(sub)} />
      {revealed && <Reveal label="secret" value={revealed} />}
      <Section title="Webhook">
        <div className="flex flex-col gap-3">
          <Field label="URL" error={action.fieldErrors.url}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} readOnly={!admin} />
          </Field>
          <Field label="HMAC secret" hint="Set on create; send a new one to replace it">
            <Input value="••••••••" readOnly aria-label="HMAC secret" />
          </Field>
          <Field label="Event types" hint="Comma separated. Exact names, transfer.* or *" error={action.fieldErrors.event_types}>
            <Input value={events} onChange={(e) => setEvents(e.target.value)} readOnly={!admin} />
          </Field>
          <Field label="Warehouses" hint="Codes, or * for all" error={action.fieldErrors.warehouses}>
            <Input value={warehouses} onChange={(e) => setWarehouses(e.target.value)} readOnly={!admin} />
          </Field>
          <Toggle checked={active} onChange={setActive} label="Active" hint="Paused subscribers keep queueing; nothing is sent" disabled={!admin} />
        </div>
      </Section>
      <KeyValue items={[
        { label: "Owner", value: sub.owner },
        { label: "Queue", value: `${sub.pending} pending · ${sub.failed} failed` },
      ]} />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {saved && !action.error && <Notice tone="ok">Saved.</Notice>}
      {admin && (
        <>
          <div className="grow" />
          <div className="flex gap-2 [&>*]:grow">
            <Button variant="primary" onClick={() => void save()} disabled={action.busy || !url.trim()}>Save</Button>
          </div>
        </>
      )}
    </>
  );
}

/* --- create forms -------------------------------------------------------- */

function NewKeyForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (row: ApiClientRow) => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [warehouses, setWarehouses] = useState("*");
  const [owner, setOwner] = useState("DEFAULT");
  const [ips, setIps] = useState("");

  const toggleScope = (s: string) => setScopes((cur) => {
    if (cur.includes(s)) return cur.filter((x) => x !== s);
    return s === "*" ? ["*"] : [...cur.filter((x) => x !== "*"), s];
  });

  const create = async () => {
    const out = await action.run(() => api.post<ApiClientRow>("/v1/api-clients", {
      name: name.trim(), scopes, warehouses: splitList(warehouses), owner: owner.trim(), ip_allowlist: splitList(ips),
    }));
    if (out) onCreated(out);
  };

  return (
    <>
      <DetailHeader eyebrow="API key" title="New key" subtitle="The key is shown once after it is created. Only its hash is stored." />
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="Who holds it, e.g. ERP bridge" error={action.fieldErrors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Scopes" hint="* is everything" error={action.fieldErrors.scopes}>
          <div className="flex gap-1 flex-wrap">
            {SCOPES.map((s) => <Chip key={s} active={scopes.includes(s)} onClick={() => toggleScope(s)}>{s === "*" ? "* everything" : s}</Chip>)}
          </div>
        </Field>
        <Field label="Warehouses" hint="Codes, comma separated, or *" error={action.fieldErrors.warehouses}>
          <Input value={warehouses} onChange={(e) => setWarehouses(e.target.value)} />
        </Field>
        <Field label="Owner" error={action.fieldErrors.owner}>
          <Input value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="IP allowlist" hint="Optional. Comma separated; empty means any" error={action.fieldErrors.ip_allowlist}>
          <Input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="10.0.5.20, 10.0.5.21" />
        </Field>
      </div>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()} disabled={action.busy || !name.trim() || scopes.length === 0}>Create key</Button>
      </div>
    </>
  );
}

function NewSubscriberForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (row: Subscriber) => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [warehouses, setWarehouses] = useState("*");
  const [owner, setOwner] = useState("*");
  const [secret, setSecret] = useState("");
  const secretShort = secret.length > 0 && secret.length < 16;

  const create = async () => {
    const body: Record<string, unknown> = {
      name: name.trim(), url: url.trim(), event_types: splitList(events), warehouses: splitList(warehouses),
      owner: owner.trim(), active: true,
    };
    if (secret) body.secret = secret;
    const out = await action.run(() => api.post<Subscriber>("/v1/subscribers", body));
    if (out) onCreated(out);
  };

  return (
    <>
      <DetailHeader eyebrow="Subscriber" title="New subscriber" subtitle="Events matching the types below are queued for this URL and retried until answered." />
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="Creating with an existing name updates it" error={action.fieldErrors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="URL" error={action.fieldErrors.url}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Event types" hint="Comma separated, e.g. delivery.shipped, transfer.*" error={action.fieldErrors.event_types}>
          <Input value={events} onChange={(e) => setEvents(e.target.value)} />
        </Field>
        <Field label="Warehouses" hint="Codes, comma separated, or *" error={action.fieldErrors.warehouses}>
          <Input value={warehouses} onChange={(e) => setWarehouses(e.target.value)} />
        </Field>
        <Field label="Owner" error={action.fieldErrors.owner}>
          <Input value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="Secret" hint="Optional, 16 characters or more. Generated if left blank" error={action.fieldErrors.secret ?? (secretShort ? "At least 16 characters" : undefined)}>
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      </div>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        <Button onClick={onCancel} disabled={action.busy}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => void create()}
          disabled={action.busy || !name.trim() || !url.trim() || splitList(events).length === 0 || secretShort}
        >
          Add subscriber
        </Button>
      </div>
    </>
  );
}

/* --- scan pattern detail -------------------------------------------------- */

/** "Matches · sku ABC123 · batch B2601 · qty 24" */
function matchSentence(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k} ${v}`);
  return ["Matches", ...parts].join(" · ");
}

function PatternForm({ row, startRaw, onSaved, onCancel, reload }: {
  row: ScanPattern | null; startRaw: string;
  onSaved: (row: ScanPattern) => void; onCancel: () => void; reload: () => Promise<void>;
}) {
  const { warehouses, warehouse } = useAuth();
  const save = useAction();
  const trying = useAction();
  const [name, setName] = useState(row?.name ?? "");
  const [type, setType] = useState(row?.type ?? "product");
  const [pattern, setPattern] = useState(row?.pattern ?? "");
  const [order, setOrder] = useState(String(row?.order ?? 100));
  const [warehouseCode, setWarehouseCode] = useState(
    row ? (row.warehouse ?? "") : (warehouse?.code ?? ""),
  );
  const [note, setNote] = useState(row?.note ?? "");
  const [active, setActive] = useState(row?.active ?? true);
  const [raw, setRaw] = useState(startRaw);
  const [result, setResult] = useState<TryReply | null>(null);
  const [saved, setSaved] = useState(false);

  const patternError = save.fieldErrors.pattern ?? trying.fieldErrors.pattern;

  const doSave = async () => {
    setSaved(false);
    const out = await save.run(() => api.post<ScanPattern>("/v1/scan-patterns", {
      warehouse: warehouseCode || null,
      name: name.trim(),
      pattern,
      type,
      order: Number(order) || 0,
      note: note.trim() || null,
      active,
    }));
    if (out) { setSaved(true); await reload(); onSaved(out); }
  };

  const doTry = async () => {
    setResult(null);
    const out = await trying.run(() => api.post<TryReply>("/v1/scan-patterns/try", { pattern, raw }));
    if (out) setResult(out);
  };

  const turnOff = async () => {
    if (!row) return;
    if (!window.confirm(`Turn off ${row.name}? Scans it used to read fall through to the plain lookup.`)) return;
    await save.run(() => api.post(`/v1/scan-patterns/${row.wms_id}/deactivate`));
    setActive(false);
    await reload();
  };

  return (
    <>
      <DetailHeader
        eyebrow="Scan pattern"
        title={row?.name ?? "New pattern"}
        subtitle="A regular expression with named parts. The names say what the WMS found."
      />
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="Whose label it is, e.g. Supplier Co carton" error={save.fieldErrors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!row} />
        </Field>
        <Field label="Reads" hint="What a match is" error={save.fieldErrors.type}>
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {PATTERN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Pattern" hint="Named parts only: sku, gtin, batch, qty, uom, location, container_id, sscc, badge, operator, ref, po, serial" error={patternError}>
          <Input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)$" />
        </Field>
        <Field label="Order" hint="Lowest is tried first" error={save.fieldErrors.order}>
          <Input type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
        </Field>
        <Field label="Warehouse" error={save.fieldErrors.warehouse}>
          <Select value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)}>
            <option value="">All warehouses</option>
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}
          </Select>
        </Field>
        <Field label="Note" hint="Optional" error={save.fieldErrors.note}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Toggle checked={active} onChange={setActive} label="Active" hint="Only active patterns are tried by a scanner" />
      </div>

      <Section title="Try it">
        <div className="flex flex-col gap-3">
          <Field label="Try it against" hint="Paste a scan from the list of unread ones">
            <Input className="mono" value={raw} onChange={(e) => setRaw(e.target.value)} />
          </Field>
          <div className="flex">
            <Button onClick={() => void doTry()} disabled={trying.busy || !pattern || !raw}>Try</Button>
          </div>
          {result?.matches
            ? <Notice tone="ok">{matchSentence(result.fields)}</Notice>
            : <Muted className="text-sm">No match yet.</Muted>}
        </div>
      </Section>

      {save.error && !patternError && <Notice tone="gold">{save.error}</Notice>}
      {trying.error && !patternError && <Notice tone="gold">{trying.error}</Notice>}
      {saved && !save.error && <Notice tone="ok">Saved.</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        {row && row.active
          ? <Button variant="gold" onClick={() => void turnOff()} disabled={save.busy}>Turn off</Button>
          : <Button onClick={onCancel} disabled={save.busy}>Cancel</Button>}
        <Button variant="primary" onClick={() => void doSave()} disabled={save.busy || !name.trim() || !pattern}>Save</Button>
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function Integrations() {
  const { can, warehouse } = useAuth();
  const admin = can("integration:admin");
  const writesMaster = can("master:write");
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  // Rows handed back by create, kept until the list catches up.
  const [freshKey, setFreshKey] = useState<ApiClientRow | null>(null);
  const [freshSub, setFreshSub] = useState<Subscriber | null>(null);
  const [freshPattern, setFreshPattern] = useState<ScanPattern | null>(null);
  const [filter, setFilter] = useState<EventFilter>("all");
  const retry = useAction();

  const clients = useApi<Page<ApiClientRow>>(() => api.get<Page<ApiClientRow>>("/v1/api-clients"), []);
  const subscribers = useApi<Page<Subscriber>>(() => api.get<Page<Subscriber>>("/v1/subscribers"), []);
  // A summary only; the Printing screen manages them. A failed load shows the empty state.
  const printPoints = useApi<Page<PrintPoint>>(
    warehouse ? () => api.get<Page<PrintPoint>>("/v1/print-points", { warehouse: warehouse.code }) : null,
    [warehouse?.code],
  );
  const printPointRows = printPoints.data?.items ?? [];
  const patterns = useApi<Page<ScanPattern>>(
    () => api.get<Page<ScanPattern>>("/v1/scan-patterns", { warehouse: warehouse?.code }),
    [warehouse?.code],
  );
  const unknown = useApi<Page<UnknownScan>>(
    () => api.get<Page<UnknownScan>>("/v1/scan-patterns/unknown", { warehouse: warehouse?.code }),
    [warehouse?.code],
  );
  const events = useApi<Page<OutboundEvent>>(
    () => api.get<Page<OutboundEvent>>("/v1/events", { status: filter === "all" ? undefined : filter, limit: 50 }),
    [filter],
  );

  const select = (s: Selection) => { setSelection(s); setRevealed(null); };

  const retryNow = async (e: OutboundEvent) => {
    await retry.run(() => api.post(`/v1/events/${e.wms_id}/retry`));
    await events.reload();
    await subscribers.reload();
  };

  const keyColumns: Column<ApiClientRow>[] = [
    { key: "name", header: "Name", width: "140px", render: (r) => <b>{r.name}</b> },
    { key: "prefix", header: "Key", width: "130px", render: (r) => <span className="mono">{r.key_prefix}…</span> },
    { key: "scopes", header: "Scopes", render: (r) => r.scopes.join(", ") },
    { key: "used", header: "Last used", width: "110px", render: (r) => <Muted>{fmtWhen(r.last_used_at)}</Muted> },
    { key: "status", header: "Status", width: "90px", render: (r) => r.active ? <Pill tone="info">Active</Pill> : <Pill tone="muted">Revoked</Pill> },
  ];

  const subscriberColumns: Column<Subscriber>[] = [
    { key: "name", header: "Name", width: "140px", render: (r) => <b>{r.name}</b> },
    { key: "events", header: "Events", render: (r) => r.event_types.join(", ") },
    { key: "last", header: "Last", width: "110px", render: (r) => <Muted>{fmtWhen(r.last_delivery_at)}</Muted> },
    { key: "status", header: "Status", width: "90px", render: subscriberPill },
  ];

  const printColumns: Column<PrintPoint>[] = [
    { key: "event", header: "Event", width: "150px", render: (r) => r.event_type },
    { key: "template", header: "Template", render: (r) => <>{r.template} <Muted>{r.version}</Muted></> },
    { key: "printer", header: "Printer", width: "150px", render: (r) => r.printer },
    {
      key: "copies", header: "Copies", width: "70px",
      render: (r) => <>{r.copies}{(!r.active || r.copies === 0) && <Muted> · off</Muted>}</>,
    },
  ];

  const patternColumns: Column<ScanPattern>[] = [
    { key: "name", header: "Name", width: "160px", render: (r) => <b>{r.name}</b> },
    { key: "type", header: "Reads", width: "130px", render: (r) => PATTERN_TYPE_LABEL[r.type] ?? r.type },
    { key: "fields", header: "Finds", width: "150px", render: (r) => r.fields.join(", ") },
    { key: "pattern", header: "Pattern", render: (r) => <span className="mono">{r.pattern}</span> },
    { key: "order", header: "Order", width: "70px", render: (r) => String(r.order) },
    { key: "warehouse", header: "Warehouse", width: "110px", render: (r) => r.warehouse ?? <Muted>All</Muted> },
    { key: "status", header: "Status", width: "70px", render: (r) => r.active ? <Pill tone="info">On</Pill> : <Pill tone="muted">Off</Pill> },
  ];

  const unknownColumns: Column<UnknownScan>[] = [
    { key: "raw", header: "Scan", render: (r) => <span className="mono">{r.raw}</span> },
    { key: "seen", header: "Times seen", width: "100px", render: (r) => String(r.seen) },
    { key: "last", header: "Last seen", width: "110px", render: (r) => <Muted>{fmtWhen(r.last_seen_at)}</Muted> },
    { key: "expecting", header: "Expected", width: "120px", render: (r) => r.expecting ?? <Muted>—</Muted> },
    {
      key: "actions", header: "", width: "140px", align: "right",
      render: (r) => writesMaster
        ? <Button small onClick={() => select({ kind: "new-pattern", raw: r.raw })}>Write a pattern</Button>
        : null,
    },
  ];

  const eventColumns: Column<OutboundEvent>[] = [
    { key: "id", header: "Event ID", width: "120px", render: (r) => <span className="mono">{shortEventId(r.event_id)}</span> },
    { key: "type", header: "Type", width: "180px", render: (r) => r.event_type },
    { key: "sub", header: "Subscriber", width: "130px", render: (r) => r.subscriber },
    { key: "attempts", header: "Attempts", width: "90px", render: (r) => String(r.attempts) },
    { key: "next", header: "Next try", width: "100px", render: (r) => <Muted>{fmtWhen(r.next_attempt_at)}</Muted> },
    { key: "status", header: "Status", width: "100px", render: eventPill },
    {
      key: "ref", header: "Reference",
      render: (r) => <>{r.external_ref ?? <Muted>—</Muted>}{r.last_error ? <Muted> · {r.last_error}</Muted> : null}</>,
    },
    {
      key: "actions", header: "", width: "100px", align: "right",
      render: (r) => admin && canRetry(r)
        ? <Button small onClick={() => void retryNow(r)} disabled={retry.busy}>Retry now</Button>
        : null,
    },
  ];

  const selectedKey = selection.kind === "key"
    ? clients.data?.items.find((c) => c.wms_id === selection.id) ?? (freshKey?.wms_id === selection.id ? freshKey : null)
    : null;
  const selectedSub = selection.kind === "subscriber"
    ? subscribers.data?.items.find((s) => s.wms_id === selection.id) ?? (freshSub?.wms_id === selection.id ? freshSub : null)
    : null;
  const selectedPattern = selection.kind === "pattern"
    ? patterns.data?.items.find((p) => p.wms_id === selection.id)
      ?? (freshPattern?.wms_id === selection.id ? freshPattern : null)
    : null;
  const selectedRowKey =
    selection.kind === "key" || selection.kind === "subscriber" || selection.kind === "pattern"
      ? selection.id : null;

  return (
    <>
      <Main>
        <PageHeader
          eyebrow="API in, events out"
          accent="Integrations"
          title="and printing"
          actions={<>
            {writesMaster && <Button onClick={() => select({ kind: "new-pattern", raw: "" })}>New pattern</Button>}
            {admin && <>
              <Button onClick={() => select({ kind: "new-subscriber" })}>Add subscriber</Button>
              <Button variant="primary" onClick={() => select({ kind: "new-key" })}>Create API key</Button>
            </>}
          </>}
        />

        <Section title="API keys (who may call in)">
          {clients.error && <Notice tone="gold">{clients.error}</Notice>}
          <Table
            columns={keyColumns}
            rows={clients.data?.items ?? []}
            rowKey={(r) => r.wms_id}
            onRowClick={(r) => select({ kind: "key", id: r.wms_id })}
            selectedKey={selectedRowKey}
            empty={clients.loading ? "Loading…" : "No API keys yet. Create one for each system that calls in."}
          />
        </Section>

        <Section title="Subscribers (who gets which events)">
          {subscribers.error && <Notice tone="gold">{subscribers.error}</Notice>}
          <Table
            columns={subscriberColumns}
            rows={subscribers.data?.items ?? []}
            rowKey={(r) => r.wms_id}
            onRowClick={(r) => select({ kind: "subscriber", id: r.wms_id })}
            selectedKey={selectedRowKey}
            empty={subscribers.loading ? "Loading…" : "No subscribers yet. Add one to start sending events."}
          />
        </Section>

        <Section title="Print points (event → template → printer)">
          <Table
            columns={printColumns}
            rows={printPointRows}
            rowKey={(r) => r.wms_id}
            empty={
              printPoints.loading ? "Loading…"
                : warehouse
                  ? "No print points yet. Add one on the Printing screen to print a label the moment an event happens."
                  : "Choose a warehouse to see its print points."
            }
          />
          <Muted className="text-xs leading-4">
            Manage them on the <Link to="/printing">Printing screen</Link>.
          </Muted>
        </Section>

        <Section title="Scan patterns (the labels only your site prints)">
          {patterns.error && <Notice tone="gold">{patterns.error}</Notice>}
          <Table
            columns={patternColumns}
            rows={patterns.data?.items ?? []}
            rowKey={(r) => r.wms_id}
            onRowClick={(r) => select({ kind: "pattern", id: r.wms_id })}
            selectedKey={selectedRowKey}
            empty={patterns.loading ? "Loading…" : "No patterns yet. Every scan the WMS cannot read is listed below; that is where a pattern comes from."}
          />
          <Muted className="text-xs leading-4">Tried after GS1 and JSON, before the plain lookup.</Muted>
        </Section>

        <Section title="Scans nothing could read">
          {unknown.error && <Notice tone="gold">{unknown.error}</Notice>}
          <Table
            columns={unknownColumns}
            rows={unknown.data?.items ?? []}
            rowKey={(r) => r.raw}
            empty={unknown.loading ? "Loading…" : "Nothing unread. Every scan so far has been understood."}
          />
        </Section>

        <Section
          title="Event queue (durable · retried until answered)"
          action={
            <div className="flex items-center gap-1">
              <Chip active={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
              <Chip active={filter === "pending"} onClick={() => setFilter("pending")}>Retrying</Chip>
              <Chip active={filter === "failed"} onClick={() => setFilter("failed")}>Failed</Chip>
              <Chip active={filter === "delivered"} onClick={() => setFilter("delivered")}>Delivered</Chip>
            </div>
          }
        >
          {events.error && <Notice tone="gold">{events.error}</Notice>}
          {retry.error && <Notice tone="gold">{retry.error}</Notice>}
          <Table
            columns={eventColumns}
            rows={events.data?.items ?? []}
            rowKey={(r) => r.wms_id}
            empty={events.loading ? "Loading…" : filter === "all" ? "Nothing queued. Events appear here the moment something happens." : "Nothing here with that status."}
          />
          <Muted className="text-xs leading-4">Newest 50. Every event is signed per subscriber and retried with backoff (1 min, 5, 30, 2 h) until answered.</Muted>
        </Section>
      </Main>

      <DetailPanel>
        {selection.kind === "new-key" && (
          <NewKeyForm
            onCancel={() => select({ kind: "none" })}
            onCreated={(row) => {
              setFreshKey(row);
              setSelection({ kind: "key", id: row.wms_id });
              setRevealed(row.key ? { id: row.wms_id, value: row.key } : null);
              void clients.reload();
            }}
          />
        )}
        {selection.kind === "new-subscriber" && (
          <NewSubscriberForm
            onCancel={() => select({ kind: "none" })}
            onCreated={(row) => {
              setFreshSub(row);
              setSelection({ kind: "subscriber", id: row.wms_id });
              setRevealed(row.secret ? { id: row.wms_id, value: row.secret } : null);
              void subscribers.reload();
            }}
          />
        )}
        {selection.kind === "key" && selectedKey && (
          <KeyDetail
            key={selectedKey.wms_id}
            row={selectedKey}
            admin={admin}
            revealed={revealed?.id === selectedKey.wms_id ? revealed.value : null}
            onRevealed={(k) => setRevealed({ id: selectedKey.wms_id, value: k })}
            reload={clients.reload}
          />
        )}
        {selection.kind === "subscriber" && selectedSub && (
          <SubscriberDetail
            key={selectedSub.wms_id}
            sub={selectedSub}
            admin={admin}
            revealed={revealed?.id === selectedSub.wms_id ? revealed.value : null}
            reload={subscribers.reload}
          />
        )}
        {selection.kind === "new-pattern" && (
          <PatternForm
            key={`new-pattern:${selection.raw}`}
            row={null}
            startRaw={selection.raw}
            onCancel={() => select({ kind: "none" })}
            onSaved={(row) => { setFreshPattern(row); setSelection({ kind: "pattern", id: row.wms_id }); }}
            reload={patterns.reload}
          />
        )}
        {selection.kind === "pattern" && selectedPattern && (
          <PatternForm
            key={selectedPattern.wms_id}
            row={selectedPattern}
            startRaw=""
            onCancel={() => select({ kind: "none" })}
            onSaved={(row) => setFreshPattern(row)}
            reload={patterns.reload}
          />
        )}
        {(selection.kind === "none" || (selection.kind === "key" && !selectedKey) || (selection.kind === "subscriber" && !selectedSub) || (selection.kind === "pattern" && !selectedPattern)) && (
          <DetailHeader eyebrow="Integrations" title="—" subtitle="Pick a key or a subscriber to see its details. Other systems only ever talk to the API." />
        )}
      </DetailPanel>
    </>
  );
}
