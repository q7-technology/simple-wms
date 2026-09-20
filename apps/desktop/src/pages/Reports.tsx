import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Page, ReportListing, ReportResult, Warehouse } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, fmtWhen } from "../lib/format";
import { useApi } from "../lib/useApi";
import {
  Button, Card, Chip, Eyebrow, Field, Input, Muted, Notice, PageHeader, SegmentedChoice, Select,
  StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

type Row = Record<string, string | number | null>;
type GroupBy = "location" | "product";

/** Movement types the ledger writes, in the words people use. */
const MOVEMENT: { value: string; label: string }[] = [
  { value: "receipt", label: "Receive" }, { value: "putaway", label: "Put away" },
  { value: "move", label: "Move" }, { value: "pick", label: "Pick" }, { value: "ship", label: "Ship" },
  { value: "adjustment", label: "Adjust" }, { value: "count", label: "Count" },
  { value: "replenish", label: "Replenish" }, { value: "transfer_out", label: "Transfer out" },
  { value: "transfer_in", label: "Transfer in" },
  { value: "production_issue", label: "Issue to production" },
  { value: "production_receipt", label: "Production receipt" },
];

/** A nicer header than the raw column name, where the plain one reads badly. */
const HEADERS: Record<string, string> = {
  sku: "SKU", uom: "UOM", gtin: "GTIN", sscc: "SSCC",
  qty_in: "Qty in", qty_out: "Qty out", qty_change: "Change", on_hand: "On hand",
  movement_type: "Movement", lines_per_hour: "Lines per hour", units_per_hour: "Units per hour",
  ledger_id: "Ledger", at: "When", day: "Day", received_at: "Received",
  first_at: "First pick", last_at: "Last pick", container_id: "Container",
};

/** Columns shown in the mono face: codes, not words. */
const MONO = new Set(["location", "ledger_id", "sscc", "container_id"]);
/** Columns that are text even when they look like a number. */
const TEXT = new Set(["sku", "batch", "ledger_id", "sscc", "container_id", "operator", "actor"]);

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T/;

/** The one chart each report earns: a day column and something to add up. */
const CHART: Record<string, { key: string; title: string }> = {
  movements: { key: "qty_in", title: "Quantity in per day" },
  shipped: { key: "units", title: "Units shipped per day" },
};

const CHART_HEIGHT = 120;
const MAX_TILES = 4;
const MAX_DAY_LABELS = 12;

/** "stock-on-hand" → "Stock on hand". */
function sentence(key: string): string {
  const words = key.replace(/[-_]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function headerLabel(key: string): string {
  return HEADERS[key] ?? sentence(key);
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

/** Owners are only asked for where a warehouse holds stock for more than one. */
function multiOwner(w: Warehouse | null): boolean {
  const settings = w?.settings as unknown as Record<string, unknown> | undefined;
  return settings?.multi_owner === true;
}

/** Hand the browser a file to save. */
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function queryString(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** The same report as CSV, behind the bearer token, so fetch it by hand. */
async function downloadCsv(report: string, params: Record<string, string>) {
  const qs = queryString({ ...params, format: "csv" });
  const res = await fetch(`/v1/reports/${encodeURIComponent(report)}?${qs}`, {
    headers: { Accept: "text/csv", Authorization: `Bearer ${api.session?.token ?? ""}` },
  });
  if (!res.ok) throw new Error(`Could not download the ${report} report (HTTP ${res.status})`);
  saveText(`${report}.csv`, await res.text());
}

/** A totals figure: decimal strings grouped, counts as they came. */
function totalValue(v: string | number): string {
  if (typeof v === "string") return DECIMAL.test(v) ? fmtQty(v) : v;
  return String(v);
}

function cellValue(key: string, v: string | number | null) {
  if (v === null || v === "") return <Muted>—</Muted>;
  let text: string;
  if (typeof v === "number") text = fmtQty(v);
  else if (STAMP.test(v)) text = fmtWhen(v);
  else if (DAY.test(v)) text = fmtDate(v);
  else if (DECIMAL.test(v)) text = fmtQty(v);
  else text = v;
  if (key === "sku") return <b>{text}</b>;
  if (MONO.has(key)) return <span className="mono">{text}</span>;
  return text;
}

/** Right-align a column only when every value in it is a number. */
function isNumeric(key: string, rows: Row[]): boolean {
  if (TEXT.has(key) || key === "day") return false;
  let seen = false;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === "") continue;
    if (typeof v !== "number" && !DECIMAL.test(String(v))) return false;
    seen = true;
  }
  return seen;
}

/* --- the one chart ------------------------------------------------------- */

function DayChart({ title, days }: { title: string; days: { day: string; value: number }[] }) {
  const max = days.reduce((n, d) => Math.max(n, d.value), 0);
  return (
    <Card className="p-5 flex flex-col gap-3">
      <Eyebrow>{title}</Eyebrow>
      <div className="flex items-end gap-1.5" style={{ height: CHART_HEIGHT }}>
        {days.map((d) => (
          <div
            key={d.day}
            title={`${fmtDate(d.day)} · ${fmtQty(Math.round(d.value * 100) / 100)}`}
            className="grow basis-0 rounded-t bg-brand"
            style={{ height: max > 0 ? Math.max(2, Math.round((d.value / max) * CHART_HEIGHT)) : 2 }}
          />
        ))}
      </div>
      <div className="flex justify-between gap-1.5 text-xs leading-4 text-muted">
        {days.length <= MAX_DAY_LABELS
          ? days.map((d) => <span key={d.day} className="grow basis-0 truncate text-center">{fmtDate(d.day)}</span>)
          : <><span>{fmtDate(days[0].day)}</span><span>{fmtDate(days[days.length - 1].day)}</span></>}
      </div>
    </Card>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function Reports() {
  const { warehouse, warehouses, can } = useAuth();
  const mayRead = can("stock:read");

  const listing = useApi<Page<ReportListing>>(
    mayRead ? () => api.get<Page<ReportListing>>("/v1/reports") : null,
    [mayRead],
  );
  const listed = useMemo(() => listing.data?.items ?? [], [listing.data]);

  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (chosen !== null || listed.length === 0) return;
    setChosen(listed.find((r) => r.report === "stock-on-hand")?.report ?? listed[0].report);
  }, [listed, chosen]);
  const report = listed.find((r) => r.report === chosen) ?? null;
  const filters = report?.filters ?? [];
  const has = (name: string) => filters.includes(name);

  const [code, setCode] = useState(warehouse?.code ?? "");
  useEffect(() => { if (warehouse?.code) setCode(warehouse.code); }, [warehouse?.code]);
  const chosenWarehouse = warehouses.find((w) => w.code === code) ?? warehouse;
  const asksOwner = multiOwner(chosenWarehouse ?? null);

  const [owner, setOwner] = useState("DEFAULT");
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [sku, setSku] = useState("");
  const [zone, setZone] = useState("");
  const [movementType, setMovementType] = useState("");
  const [reason, setReason] = useState("");
  const [operator, setOperator] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("location");

  const params = useMemo(() => {
    const p: Record<string, string> = { warehouse: code, owner: (asksOwner && owner.trim()) || "DEFAULT" };
    if (has("from") && from) p.from = from;
    if (has("to") && to) p.to = to;
    if (has("sku") && sku.trim()) p.sku = sku.trim();
    if (has("zone") && zone.trim()) p.zone = zone.trim();
    if (has("movement_type") && movementType) p.movement_type = movementType;
    if (has("reason") && reason.trim()) p.reason = reason.trim();
    if (has("operator") && operator.trim()) p.operator = operator.trim();
    if (has("group_by")) p.group_by = groupBy;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, asksOwner, owner, filters.join(","), from, to, sku, zone, movementType, reason, operator, groupBy]);

  const result = useApi<ReportResult>(
    chosen && code && mayRead ? () => api.get<ReportResult>(`/v1/reports/${encodeURIComponent(chosen)}`, params) : null,
    [chosen, code, mayRead, params],
  );

  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const runDownload = async () => {
    if (!chosen) return;
    setCsvError(null);
    setCsvBusy(true);
    try {
      await downloadCsv(chosen, params);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : "Could not reach the WMS");
    } finally {
      setCsvBusy(false);
    }
  };

  const data = result.data;
  const rows = data?.rows ?? [];

  const columns: Column<Row>[] = useMemo(
    () => (data?.columns ?? []).map((key) => ({
      key,
      header: headerLabel(key),
      align: isNumeric(key, rows) ? ("right" as const) : undefined,
      render: (r: Row) => cellValue(key, r[key] ?? null),
    })),
    [data?.columns, rows],
  );

  const chart = useMemo(() => {
    if (!data) return null;
    const spec = CHART[data.report];
    if (!spec || !data.columns.includes("day") || !data.columns.includes(spec.key)) return null;
    const byDay = new Map<string, number>();
    for (const r of data.rows) {
      const day = r.day === null || r.day === undefined ? "" : String(r.day);
      if (!day) continue;
      byDay.set(day, (byDay.get(day) ?? 0) + Number(r[spec.key] ?? 0));
    }
    const days = [...byDay].map(([day, value]) => ({ day, value })).sort((a, b) => a.day.localeCompare(b.day));
    return days.length >= 2 ? { title: spec.title, days } : null;
  }, [data]);

  const totals = Object.entries(data?.totals ?? {});
  const tiles = totals.slice(0, MAX_TILES);
  const spare = totals.slice(MAX_TILES);

  return (
    <Main>
      <PageHeader
        eyebrow="Out of the ledger"
        accent="Reports"
        title=""
        actions={
          <Button onClick={() => void runDownload()} disabled={!chosen || !code || csvBusy}>
            {csvBusy ? "Downloading…" : "Download CSV"}
          </Button>
        }
      />

      {!mayRead && <Notice tone="gold">Reading a report needs stock:read. Ask an administrator for the scope.</Notice>}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {listed.map((r) => (
            <Chip key={r.report} active={r.report === chosen} onClick={() => setChosen(r.report)}>
              {sentence(r.report)}
            </Chip>
          ))}
        </div>
        {report && <Muted className="text-sm leading-5">{report.describe}</Muted>}
      </div>

      {report && (
        <div className="flex gap-3 items-end flex-wrap">
          <Field label="Warehouse" className="w-[170px]">
            <Select aria-label="Warehouse filter" value={code} onChange={(e) => setCode(e.target.value)}>
              {warehouses.length === 0 && <option value="">No warehouses yet</option>}
              {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code}</option>)}
            </Select>
          </Field>
          {asksOwner && (
            <Field label="Owner" className="w-[140px]">
              <Input aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="DEFAULT" />
            </Field>
          )}
          {has("from") && (
            <Field label="From" className="w-[160px]">
              <Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
          )}
          {has("to") && (
            <Field label="To" className="w-[160px]">
              <Input aria-label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          )}
          {has("sku") && (
            <Field label="SKU" className="w-[150px]">
              <Input aria-label="SKU" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Any" />
            </Field>
          )}
          {has("zone") && (
            <Field label="Zone" className="w-[150px]">
              <Input aria-label="Zone" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Any" />
            </Field>
          )}
          {has("movement_type") && (
            <Field label="Movement" className="w-[170px]">
              <Select aria-label="Movement" value={movementType} onChange={(e) => setMovementType(e.target.value)}>
                <option value="">Any movement</option>
                {MOVEMENT.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
          )}
          {has("reason") && (
            <Field label="Reason" className="w-[160px]">
              <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Any" />
            </Field>
          )}
          {has("operator") && (
            <Field label="Operator" className="w-[150px]">
              <Input aria-label="Operator" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Anyone" />
            </Field>
          )}
          {has("group_by") && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs leading-4 text-muted">Group by</span>
              <div className="h-10 flex items-center" role="group" aria-label="Group by">
                <SegmentedChoice<GroupBy>
                  value={groupBy}
                  onChange={setGroupBy}
                  options={[{ value: "location", label: "Location" }, { value: "product", label: "Product" }]}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {listing.error && <Notice tone="gold">{listing.error}</Notice>}
      {result.error && <Notice tone="gold">{result.error}</Notice>}
      {csvError && <Notice tone="gold">{csvError}</Notice>}
      {(listing.loading || result.loading) && !data && <Muted className="text-sm leading-5">Loading…</Muted>}

      {tiles.length > 0 && (
        <div className="grid grid-cols-4 gap-4">
          {tiles.map(([key, value]) => <StatTile key={key} label={sentence(key)} value={totalValue(value)} />)}
        </div>
      )}
      {spare.length > 0 && (
        <Muted className="text-xs leading-4">
          {spare.map(([key, value]) => `${sentence(key)} ${totalValue(value)}`).join(" · ")}
        </Muted>
      )}

      {chart && <DayChart title={chart.title} days={chart.days} />}

      {data && (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => columns.map((c) => String(r[c.key] ?? "")).join("/")}
          empty={result.loading ? "Loading…" : "Nothing to report for that range."}
        />
      )}
      <Muted className="text-xs leading-4">
        Every figure is read from the ledger or the balances it rebuilds, so a report can never drift from what happened.
        The same call answers as CSV: <span className="mono">GET /v1/reports/{chosen ?? "…"}?format=csv</span>
      </Muted>
    </Main>
  );
}
