import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { LedgerRow, Page, Product, StockBySku } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, fmtWhen, plural } from "../lib/format";
import { useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, SearchInput,
  Section, StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

const MOVEMENT: Record<string, string> = {
  receipt: "Receive", putaway: "Put away", move: "Move", pick: "Pick", ship: "Ship",
  adjustment: "Adjust", count: "Count", replenish: "Replenish", transfer_out: "Transfer out",
  transfer_in: "Transfer in", production_issue: "Issue to production", production_receipt: "Production receipt",
};

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
  const sku = params.get("sku") ?? "";
  const [draft, setDraft] = useState(sku);
  const [allWarehouses, setAllWarehouses] = useState(false);
  const [batch, setBatch] = useState<string | null>(null);
  useEffect(() => setDraft(sku), [sku]);

  const scope = allWarehouses ? undefined : warehouse?.code;

  const stock = useApi<StockBySku>(
    sku ? () => api.get<StockBySku>("/v1/stock", { sku, warehouse: scope, batch }) : null,
    [sku, scope, batch],
  );
  const product = useApi<Product>(sku ? () => api.get<Product>(`/v1/products/${encodeURIComponent(sku)}`) : null, [sku]);
  const ledger = useApi<Page<LedgerRow>>(
    sku ? () => api.get<Page<LedgerRow>>("/v1/stock/ledger", { sku, warehouse: scope, batch, limit: 12 }) : null,
    [sku, scope, batch],
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
            <Button variant="gold" disabled title="Comes with reports (step 6)">Export CSV</Button>
            <Button disabled title="Adjustments come with counts (step 2)">Adjust stock</Button>
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
          <Button type="button" disabled title="One owner for now; switched on in step 6">Owner: DEFAULT</Button>
        </form>

        {stock.error && <Notice tone="gold">{stock.error === "no product " + sku + " for owner DEFAULT" ? `No product ${sku}` : stock.error}</Notice>}

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
          <Button variant="primary" disabled title="Moves come with step 2">Move stock</Button>
        </> : undefined}
      >
        {printed && <Notice tone={printed.tone}>{printed.text}</Notice>}
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
