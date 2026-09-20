import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type {
  Accepted, LedgerRow, Owner, Page, Product, StockAtLocation, StockBySku, Task, TaskReply, Warehouse,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Eyebrow, Field, Input, KeyValue, Muted, Notice, PageHeader,
  SearchInput, Section, Select, StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

const MOVEMENT: Record<string, string> = {
  receipt: "Receive", putaway: "Put away", move: "Move", pick: "Pick", ship: "Ship",
  adjustment: "Adjust", count: "Count", replenish: "Replenish", transfer_out: "Transfer out",
  transfer_in: "Transfer in", production_issue: "Issue to production", production_receipt: "Production receipt",
};

/** An adjustment is a counted quantity a supervisor accepts, with a reason. */
const ADJUST_REASONS: { value: string; label: string }[] = [
  { value: "count_variance", label: "Count variance" },
  { value: "damaged", label: "Damaged" },
  { value: "found", label: "Found" },
  { value: "data_entry_error", label: "Data entry error" },
];
const MOVE_REASONS: { value: string; label: string }[] = [
  { value: "tidy", label: "Tidy" },
  { value: "consolidate", label: "Consolidate" },
  { value: "damaged", label: "Damaged" },
  { value: "quality_hold", label: "Quality hold" },
];

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

/** The report as CSV, behind the bearer token, so fetch it by hand. */
async function downloadStockCsv(sku: string, warehouse: string | undefined) {
  const qs = Object.entries({ warehouse, sku, format: "csv" })
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const res = await fetch(`/v1/reports/stock-on-hand?${qs}`, {
    headers: { Accept: "text/csv", Authorization: `Bearer ${api.session?.token ?? ""}` },
  });
  if (!res.ok) throw new Error(`Could not download the stock on hand report (HTTP ${res.status})`);
  saveText(`stock-on-hand-${sku}.csv`, await res.text());
}

/** The shelf a form is working on: the rows are the only stock there is. */
function rowAt(rows: StockAtLocation[], index: string): StockAtLocation | undefined {
  return rows[Number(index)] ?? rows[0];
}

function shelfLabel(r: StockAtLocation): string {
  return r.batch ? `${r.location} · ${r.batch}` : r.location;
}

/* The printer is asked for once and remembered, not stored per screen. */
const PRINTER_KEY = "wms.printer";
function readPrinter(): string {
  try { return window.localStorage.getItem(PRINTER_KEY) ?? ""; } catch { return ""; }
}
function rememberPrinter(name: string) {
  try { window.localStorage.setItem(PRINTER_KEY, name); } catch { /* private mode */ }
}

export function Stock() {
  const { warehouse, warehouses, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const sku = params.get("sku") ?? "";
  const [draft, setDraft] = useState(sku);
  const [allWarehouses, setAllWarehouses] = useState(false);
  const [batch, setBatch] = useState<string | null>(null);
  useEffect(() => setDraft(sku), [sku]);

  const scope = allWarehouses ? undefined : warehouse?.code;

  /* Owners: one warehouse runs happily on DEFAULT, so only ask where there are more. */
  const asksOwner = multiOwner(warehouse);
  const [owner, setOwner] = useState("DEFAULT");
  const owners = useApi<Page<Owner>>(
    asksOwner ? () => api.get<Page<Owner>>("/v1/owners", { active: true }) : null,
    [asksOwner],
  );
  const ownerCodes = (owners.data?.items ?? []).map((o) => o.code);

  const stock = useApi<StockBySku>(
    sku ? () => api.get<StockBySku>("/v1/stock", { sku, warehouse: scope, batch, owner }) : null,
    [sku, scope, batch, owner],
  );
  const product = useApi<Product>(
    sku ? () => api.get<Product>(`/v1/products/${encodeURIComponent(sku)}`, { owner }) : null,
    [sku, owner],
  );
  const ledger = useApi<Page<LedgerRow>>(
    sku ? () => api.get<Page<LedgerRow>>("/v1/stock/ledger", { sku, warehouse: scope, batch, owner, limit: 12 }) : null,
    [sku, scope, batch, owner],
  );

  const canPrint = can("printing:write");
  const [printer, setPrinter] = useState(readPrinter);
  const [printOpen, setPrintOpen] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printed, setPrinted] = useState<{ tone: "ok" | "gold"; text: string } | null>(null);
  useEffect(() => { setPrintOpen(false); setPrinted(null); }, [sku]);

  /** The looked-up SKU, with the batch chip when one is on. */
  async function sendLabel() {
    const name = printer.trim();
    if (!name || !sku || !warehouse?.code) return;
    rememberPrinter(name);
    setPrintBusy(true);
    setPrinted(null);
    try {
      await api.message("/v1/print-jobs", {
        warehouse: warehouse.code, template: "product-label", printer: name, copies: 1,
        reference: { type: "product", ref: sku, ...(batch ? { batch } : {}) },
      });
      setPrintOpen(false);
      setPrinted({ tone: "ok", text: `Sent the label for ${sku} to ${name}.` });
    } catch (e) {
      setPrinted({ tone: "gold", text: e instanceof ApiError ? e.message : "Could not reach the WMS" });
    } finally {
      setPrintBusy(false);
    }
  }

  const batches = useMemo(() => {
    const set = new Set<string>();
    stock.data?.locations.forEach((l) => { if (l.batch) set.add(l.batch); });
    return [...set].sort();
  }, [stock.data]);

  const rows = stock.data?.locations ?? [];
  const oldest = rows.find((r) => r.received_at)?.received_at ?? null;
  const warehouseCount = new Set(rows.map((r) => r.warehouse)).size;
  const reserved = rows.reduce((n, r) => n + Number(r.reserved), 0);
  const belowMin = useMemo(() => {
    const min = product.data?.pickface_min ? Number(product.data.pickface_min) : null;
    if (min === null) return null;
    return rows.find((r) => r.zone === "PICKFACE" && Number(r.on_hand) < min) ?? null;
  }, [rows, product.data]);

  /* --- export, adjust and move ------------------------------------------ */

  const uom = stock.data?.uom ?? product.data?.uom ?? "EA";
  const canAdjust = can("tasks:approve");
  const canMove = can("tasks:write");

  const [csvError, setCsvError] = useState<string | null>(null);
  const [done, setDone] = useState<{ tone: "ok" | "gold"; text: string } | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [adjustShelf, setAdjustShelf] = useState("0");
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState<string | null>(null);
  const [adjustNote, setAdjustNote] = useState("");
  const [moveShelf, setMoveShelf] = useState("0");
  const [moveTo, setMoveTo] = useState("");
  const [moveQty, setMoveQty] = useState("");
  const [moveReason, setMoveReason] = useState("tidy");
  const adjust = useAction();
  const move = useAction();

  /* A new lookup is a new question: close the forms and clear what was said. */
  useEffect(() => {
    setCsvError(null); setDone(null);
    setAdjustOpen(false); setMoveOpen(false);
    setAdjustShelf("0"); setAdjustQty(""); setAdjustReason(null); setAdjustNote("");
    setMoveShelf("0"); setMoveTo(""); setMoveQty(""); setMoveReason("tidy");
  }, [sku]);

  function openAdjust() {
    setDone(null); adjust.clear();
    setMoveOpen(false);
    setAdjustOpen((v) => !v);
  }
  function openMove() {
    setDone(null); move.clear();
    setAdjustOpen(false);
    setMoveOpen((v) => !v);
  }

  async function exportCsv() {
    setCsvError(null);
    try {
      await downloadStockCsv(sku, scope);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : "Could not download the report");
    }
  }

  /**
   * An adjustment is a counted quantity a supervisor approves: count the shelf,
   * confirm what is really there, and approve the variance with a reason.
   */
  async function submitAdjust() {
    const shelf = rowAt(rows, adjustShelf);
    const qty = adjustQty.trim();
    if (!shelf || !qty || !adjustReason) return;
    setDone(null);
    const out = await adjust.run(async () => {
      const count = await api.message<Accepted>("/v1/counts", {
        warehouse: shelf.warehouse, owner, locations: [shelf.location], sku,
      });
      const task = await api.get<Task>(`/v1/tasks/${encodeURIComponent(count.wms_id)}`);
      const line = task.lines.find((l) => l.sku === sku);
      if (!line) throw new ApiError(404, { detail: `Nothing of ${sku} at ${shelf.location} to count.` });
      const confirmed = await api.message<TaskReply>(
        `/v1/tasks/${encodeURIComponent(count.wms_id)}/lines/${line.line_no}/confirm`, { qty, uom },
      );
      if (confirmed.line?.status !== "variance") return { matched: true };
      await api.message<TaskReply>(
        `/v1/tasks/${encodeURIComponent(count.wms_id)}/lines/${line.line_no}/approve`,
        { reason: adjustReason, note: adjustNote.trim() || null },
      );
      return { matched: false };
    });
    if (!out) return;
    setAdjustOpen(false);
    setAdjustQty(""); setAdjustNote("");
    await Promise.all([stock.reload(), ledger.reload()]);
    setDone({
      tone: "ok",
      text: out.matched
        ? `Counted ${fmtQty(qty)} at ${shelf.location}. It already matched.`
        : `Adjusted to ${fmtQty(qty, uom)} at ${shelf.location}.`,
    });
  }

  /** A move within one warehouse: done on the spot, two ledger lines. */
  async function submitMove() {
    const shelf = rowAt(rows, moveShelf);
    const qty = moveQty.trim();
    const to = moveTo.trim();
    if (!shelf || !qty || !to) return;
    setDone(null);
    const out = await move.run(() => api.message<Accepted>("/v1/moves", {
      warehouse: shelf.warehouse, owner, sku, batch: shelf.batch, qty, uom,
      from_location: shelf.location, to_location: to, reason: moveReason,
    }));
    if (!out) return;
    setMoveOpen(false);
    setMoveQty(""); setMoveTo("");
    await Promise.all([stock.reload(), ledger.reload()]);
    setDone({ tone: "ok", text: `Moved ${fmtQty(qty, uom)} to ${to}.` });
  }

  const adjustGeneralError = adjust.error && Object.keys(adjust.fieldErrors).length === 0 ? adjust.error : null;
  const moveGeneralError = move.error && Object.keys(move.fieldErrors).length === 0 ? move.error : null;

  const columns: Column<StockBySku["locations"][number]>[] = [
    { key: "warehouse", header: "Warehouse", width: "130px", render: (r) => r.warehouse },
    { key: "location", header: "Location", width: "150px", render: (r) => <b>{r.location}</b> },
    { key: "zone", header: "Zone", width: "120px", render: (r) => r.zone },
    { key: "batch", header: "Batch", width: "110px", render: (r) => r.batch ?? <Muted>—</Muted> },
    { key: "on_hand", header: "On hand", width: "100px", render: (r) => fmtQty(r.on_hand) },
    { key: "reserved", header: "Reserved", width: "100px", render: (r) => fmtQty(r.reserved) },
    { key: "available", header: "Available", width: "100px", render: (r) => fmtQty(r.available) },
    {
      key: "received", header: "Received",
      render: (r, ) => <Muted>{fmtDate(r.received_at)}{r === rows[0] && rows.length > 1 && r.received_at ? " · FIFO first" : ""}</Muted>,
    },
  ];

  return (
    <>
      <Main>
        <PageHeader
          eyebrow="Where is it?"
          accent="Stock"
          title="lookup"
          actions={<>
            <Button onClick={() => navigate("/containers")}>Containers</Button>
            <Button
              variant="gold"
              onClick={() => void exportCsv()}
              disabled={!sku}
              title={!sku ? "Look up a SKU first" : undefined}
            >
              Export CSV
            </Button>
            {canAdjust && (
              <Button
                onClick={openAdjust}
                disabled={rows.length === 0}
                title={rows.length === 0 ? "Look up a SKU first" : undefined}
              >
                Adjust stock
              </Button>
            )}
          </>}
        />
        <form
          className="flex gap-2 items-end"
          onSubmit={(e) => { e.preventDefault(); setParams(draft.trim() ? { sku: draft.trim() } : {}); setBatch(null); }}
        >
          <SearchInput
            className="w-[360px]"
            placeholder="Scan or type a SKU"
            aria-label="SKU"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <Button type="submit" variant="primary">Look up</Button>
          <Button type="button" onClick={() => setAllWarehouses((v) => !v)} disabled={warehouses.length < 2}>
            {allWarehouses ? "All warehouses" : warehouse?.code ?? "This warehouse"}
          </Button>
          {batches.length > 0 && (
            <div className="flex items-center gap-1 h-10">
              <Chip active={batch === null} onClick={() => setBatch(null)}>Batch: any</Chip>
              {batches.map((b) => <Chip key={b} active={batch === b} onClick={() => setBatch(b)}>{b}</Chip>)}
            </div>
          )}
          <div className="flex items-center gap-1 h-10">
            {asksOwner && ownerCodes.length > 0 ? (
              <>
                <Muted className="text-xs leading-4">Owner</Muted>
                {ownerCodes.map((code) => (
                  <Chip key={code} active={owner === code} onClick={() => setOwner(code)}>{code}</Chip>
                ))}
              </>
            ) : (
              <Chip>Owner: DEFAULT</Chip>
            )}
          </div>
        </form>

        {stock.error && <Notice tone="gold">{stock.error === `no product ${sku} for owner ${owner}` ? `No product ${sku}` : stock.error}</Notice>}
        {csvError && <Notice tone="gold">{csvError}</Notice>}

        {stock.data && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <StatTile
                label="On hand"
                value={fmtQty(stock.data.total_on_hand)}
                hint={`${stock.data.uom} across ${plural(warehouseCount, "warehouse")}`}
              />
              <StatTile label="Reserved" value={fmtQty(String(reserved))} hint={reserved ? "by open tasks" : "nothing reserved"} />
              <StatTile label="Available" value={fmtQty(stock.data.total_available)} hint={oldest ? `FIFO: oldest ${fmtDate(oldest)}` : "no stock"} />
              {belowMin ? (
                <StatTile tone="gold" label="Below min at" value={belowMin.location} hint={`min ${fmtQty(product.data?.pickface_min)}`} />
              ) : (
                <StatTile label="Pick face" value={product.data?.pickface_min ? "OK" : "—"} hint={product.data?.pickface_min ? `min ${fmtQty(product.data.pickface_min)} / max ${fmtQty(product.data.pickface_max)}` : "no min / max set"} />
              )}
            </div>
            <Table columns={columns} rows={rows} rowKey={(r) => `${r.warehouse}/${r.location}/${r.batch ?? ""}`} empty="No stock on any shelf." />
          </>
        )}
        {!sku && !stock.loading && (
          <Notice>Type a SKU and press Enter. The same call feeds the scanner and the API: <span className="mono">GET /v1/stock?sku=…</span></Notice>
        )}
      </Main>

      <DetailPanel
        footer={sku ? <>
          {canPrint && (
            <Button onClick={() => { setPrintOpen((v) => !v); setPrinted(null); }}>Print product label</Button>
          )}
          {canMove && (
            <Button variant="primary" onClick={openMove} disabled={rows.length === 0}>Move stock</Button>
          )}
        </> : undefined}
      >
        {printed && <Notice tone={printed.tone}>{printed.text}</Notice>}
        {done && <Notice tone={done.tone}>{done.text}</Notice>}
        {canAdjust && adjustOpen && rows.length > 0 && (
          <form
            className="flex flex-col gap-3 rounded-md border border-line p-3"
            onSubmit={(e) => { e.preventDefault(); void submitAdjust(); }}
          >
            <Eyebrow tone="muted">Adjust stock</Eyebrow>
            <Field label="Location">
              <Select value={adjustShelf} onChange={(e) => setAdjustShelf(e.target.value)} autoFocus>
                {rows.map((r, i) => <option key={`${r.location}/${r.batch ?? ""}`} value={String(i)}>{shelfLabel(r)}</option>)}
              </Select>
            </Field>
            <Field label="Counted quantity" hint={`in ${uom}`} error={adjust.fieldErrors.qty}>
              <Input inputMode="decimal" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Reason" error={adjust.fieldErrors.reason}>
              <div className="flex gap-1 flex-wrap">
                {ADJUST_REASONS.map((r) => (
                  <Chip key={r.value} active={adjustReason === r.value} onClick={() => setAdjustReason(r.value)}>{r.label}</Chip>
                ))}
              </div>
            </Field>
            <Field label="Note" error={adjust.fieldErrors.note}>
              <Input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Optional" />
            </Field>
            <Muted className="text-xs leading-4">
              Counting writes nothing when it matches. A difference is approved here and lands as one adjustment in the ledger.
            </Muted>
            {adjustGeneralError && <Notice tone="gold">{adjustGeneralError}</Notice>}
            <div className="flex gap-2 [&>*]:grow">
              <Button small type="button" onClick={() => setAdjustOpen(false)}>Cancel</Button>
              <Button small type="submit" variant="primary" disabled={adjust.busy || !adjustQty.trim() || !adjustReason}>
                {adjust.busy ? "Adjusting…" : "Adjust"}
              </Button>
            </div>
          </form>
        )}
        {canMove && moveOpen && rows.length > 0 && (
          <form
            className="flex flex-col gap-3 rounded-md border border-line p-3"
            onSubmit={(e) => { e.preventDefault(); void submitMove(); }}
          >
            <Eyebrow tone="muted">Move stock</Eyebrow>
            <Field label="From" error={move.fieldErrors.from_location}>
              <Select value={moveShelf} onChange={(e) => setMoveShelf(e.target.value)} autoFocus>
                {rows.map((r, i) => <option key={`${r.location}/${r.batch ?? ""}`} value={String(i)}>{shelfLabel(r)}</option>)}
              </Select>
            </Field>
            <Field label="To" error={move.fieldErrors.to_location}>
              <Input value={moveTo} onChange={(e) => setMoveTo(e.target.value)} placeholder="PF-01-02-A" />
            </Field>
            <Field label="Quantity" hint={`in ${uom}`} error={move.fieldErrors.qty}>
              <Input inputMode="decimal" value={moveQty} onChange={(e) => setMoveQty(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Reason" error={move.fieldErrors.reason}>
              <div className="flex gap-1 flex-wrap">
                {MOVE_REASONS.map((r) => (
                  <Chip key={r.value} active={moveReason === r.value} onClick={() => setMoveReason(r.value)}>{r.label}</Chip>
                ))}
              </div>
            </Field>
            {moveGeneralError && <Notice tone="gold">{moveGeneralError}</Notice>}
            <div className="flex gap-2 [&>*]:grow">
              <Button small type="button" onClick={() => setMoveOpen(false)}>Cancel</Button>
              <Button small type="submit" variant="primary" disabled={move.busy || !moveQty.trim() || !moveTo.trim()}>
                {move.busy ? "Moving…" : "Move"}
              </Button>
            </div>
          </form>
        )}
        {canPrint && printOpen && sku && (
          <form
            className="flex flex-col gap-3 rounded-md border border-line p-3"
            onSubmit={(e) => { e.preventDefault(); void sendLabel(); }}
          >
            <Field label="Printer">
              <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Office" autoFocus />
            </Field>
            <Muted className="text-xs leading-4">{batch ? `Batch ${batch}` : "Every batch"}</Muted>
            <div className="flex gap-2 [&>*]:grow">
              <Button small type="button" onClick={() => setPrintOpen(false)}>Cancel</Button>
              <Button small type="submit" variant="primary" disabled={printBusy || !printer.trim()}>
                {printBusy ? "Printing…" : "Print"}
              </Button>
            </div>
          </form>
        )}
        {product.data ? (
          <>
            <DetailHeader
              eyebrow="Product"
              title={product.data.sku}
              subtitle={`${product.data.name} · ${product.data.uom}${product.data.batch_tracked ? " · batch tracked" : ""}`}
            />
            <KeyValue items={[
              { label: "Unit", value: `${product.data.uom}${product.data.decimals_allowed ? " · decimals allowed" : ""}` },
              { label: "Batch tracking", value: product.data.batch_tracked ? "On" : "Off" },
              { label: "Preferred zone", value: product.data.preferred_zone ?? "—" },
              { label: "Min / max at PF", value: `${fmtQty(product.data.pickface_min)} / ${fmtQty(product.data.pickface_max)}` },
            ]} />
            <Section title="Ledger (newest first)">
              <div className="flex flex-col rounded-lg border border-line">
                {(ledger.data?.items ?? []).length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No movements yet.</div>}
                {(ledger.data?.items ?? []).map((l) => (
                  <div key={l.wms_id} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                    <span className="truncate">
                      {MOVEMENT[l.movement_type] ?? l.movement_type}
                      {l.external_ref ? ` → ${l.external_ref}` : ""} {l.location}
                      {l.reason ? <Muted> · {l.reason.replace(/_/g, " ")}</Muted> : null}
                    </span>
                    <span className="shrink-0 text-ink">{fmtQty(l.qty_change)} · {l.actor} · {fmtWhen(l.at)}</span>
                  </div>
                ))}
              </div>
              <Muted className="text-xs leading-4">Nothing is ever overwritten. Every line above is a transaction with who, where and when.</Muted>
            </Section>
          </>
        ) : (
          <DetailHeader eyebrow="Product" title="—" subtitle="Look up a SKU to see its details and ledger." />
        )}
      </DetailPanel>
    </>
  );
}
