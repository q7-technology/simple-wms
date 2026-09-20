import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Product, ScanResult, StockAtLocation, StockAtShelf, StockBySku } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtDate, fmtQty } from "../lib/format";
import { useScanWedge } from "../lib/useScanWedge";
import { BigLocation, Button, Card, Footer, Header, Input, Main, Notice, Pill, ProductCard, ScanHint, Screen } from "../ui";
import { errorText } from "./SignIn";

type Scope = "here" | "all";

function cx(...parts: (string | false | null | undefined)[]) { return parts.filter(Boolean).join(" "); }

/** Add decimal strings without going through a float. */
export function sumQty(values: string[]): string {
  let scale = 0;
  for (const v of values) { const f = v.split(".")[1]; if (f && f.length > scale) scale = f.length; }
  let total = 0n;
  for (const v of values) {
    const neg = v.startsWith("-");
    const [whole, frac = ""] = (neg ? v.slice(1) : v).split(".");
    const n = BigInt((whole || "0") + frac.padEnd(scale, "0"));
    total += neg ? -n : n;
  }
  const neg = total < 0n;
  const s = (neg ? -total : total).toString().padStart(scale + 1, "0");
  return (neg ? "-" : "") + (scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s);
}

/** This warehouse first, then other sites; oldest receipt first within each, never received last. */
function orderShelves(rows: StockAtLocation[], wh: string): StockAtLocation[] {
  const key = (r: StockAtLocation) => r.received_at ?? "9999";
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const site = Number(a.r.warehouse !== wh) - Number(b.r.warehouse !== wh);
      if (site) return site;
      const when = key(a.r) < key(b.r) ? -1 : key(a.r) > key(b.r) ? 1 : 0;
      return when || a.i - b.i;
    })
    .map(({ r }) => r);
}

function Stat({ label, value, brand }: { label: string; value: string; brand?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs leading-4 text-muted">{label}</span>
      <span className={cx("text-2xl leading-none font-semibold", brand && "text-brand")}>{value}</span>
    </div>
  );
}

const ROW = "min-h-14 px-4 py-3 flex items-center justify-between gap-3 bg-transparent border-0 text-left text-ink text-sm leading-5 cursor-pointer active:bg-brand-tint";

export function Lookup() {
  const { session, warehouse } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const wh = warehouse || session?.warehouses[0] || "";
  const sku = params.get("sku") ?? "";
  const location = params.get("location") ?? "";
  const shelfWh = params.get("warehouse") || wh;
  const site = wh.split("-")[0];
  const first = session ? session.operator.name.trim().split(/\s+/)[0] : "";

  const [scope, setScope] = useState<Scope>("all");
  const [stock, setStock] = useState<StockBySku | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [shelf, setShelf] = useState<StockAtShelf | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Product: where is it?
  useEffect(() => {
    if (!sku) { setStock(null); setProduct(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    setShelf(null);
    (async () => {
      try {
        const [s, p] = await Promise.all([
          api.get<StockBySku>("/v1/stock", { sku, warehouse: scope === "here" ? wh : undefined }),
          api.get<Product>(`/v1/products/${encodeURIComponent(sku)}`).catch(() => null),
        ]);
        if (alive) { setStock(s); setProduct(p); }
      } catch (e) {
        if (alive) { setStock(null); setError(e instanceof ApiError && e.status === 404 ? `No product called ${sku}.` : errorText(e)); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [sku, scope, wh]);

  // Shelf: what is here?
  useEffect(() => {
    if (!location || sku) { setShelf(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const s = await api.get<StockAtShelf>(`/v1/locations/${encodeURIComponent(location)}/stock`, { warehouse: shelfWh });
        if (alive) setShelf(s);
      } catch (e) {
        if (alive) { setShelf(null); setError(e instanceof ApiError && e.status === 404 ? `No shelf called ${location} at ${shelfWh}.` : errorText(e)); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [location, sku, shelfWh]);

  const onScan = async (raw: string) => {
    setNotice(null);
    try {
      const r = await api.post<ScanResult>("/v1/scans/parse", { raw, warehouse: wh });
      const res = (r.resolved ?? {}) as Record<string, unknown>;
      const str = (k: string) => (typeof res[k] === "string" ? (res[k] as string) : "");
      if (r.type === "location") setParams({ location: str("location") || raw, warehouse: str("warehouse") || wh });
      else if (r.type === "product") setParams({ sku: str("sku") || raw });
      else setNotice(r.message ?? `That is not a product or a shelf. Nothing matches "${raw}".`);
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  useScanWedge((code) => { void onScan(code); });

  const showProduct = Boolean(sku && stock);
  const showShelf = Boolean(location && !sku && shelf);
  const shelves = stock ? orderShelves(stock.locations, wh) : [];
  const reserved = stock ? sumQty(stock.locations.map((l) => l.reserved)) : "0";

  const moveTo = sku ? `/move?sku=${encodeURIComponent(sku)}` : location ? `/move?from=${encodeURIComponent(location)}` : null;

  return (
    <Screen>
      <Header eyebrow="Look up" title="Where is it?" right={session ? `${first} · ${site}` : undefined} />
      <Main>
        <div className="flex flex-col gap-2">
          <ScanHint sub="Product shows every shelf. Shelf shows what is on it.">Scan a product or a shelf</ScanHint>
          <Input data-scan="true" aria-label="Scan or type a product or shelf" placeholder="or type a code and press Enter" autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go" className="mono" />
        </div>

        {notice && <Notice tone="gold">{notice}</Notice>}
        {error && <Notice tone="gold">{error}</Notice>}
        {loading && <span className="text-sm leading-5 text-muted">Looking…</span>}
        {!sku && !location && !loading && <span className="text-sm leading-5 text-muted">Nothing looked up yet.</span>}

        {showProduct && stock && (
          <>
            <ProductCard
              sku={<span className="mono">{stock.sku}</span>}
              name={product ? `${product.name} · ${product.uom}` : stock.uom}
              pill={product?.batch_tracked ? <Pill>Batch tracked</Pill> : undefined}
            />
            <Card>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="On hand" value={fmtQty(stock.total_on_hand)} />
                <Stat label="Reserved" value={fmtQty(reserved)} />
                <Stat label="Available" value={fmtQty(stock.total_available)} brand />
              </div>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Which warehouses">
                {(["here", "all"] as const).map((s) => (
                  <button
                    key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}
                    className={cx("h-14 px-2 rounded-md border text-xs leading-4 font-medium cursor-pointer", scope === s ? "border-brand bg-brand-tint text-ink" : "border-line bg-transparent text-muted")}
                  >
                    {s === "here" ? `This warehouse · ${wh}` : "All warehouses"}
                  </button>
                ))}
              </div>
            </Card>
            <div className="flex flex-col gap-2">
              <span className="eyebrow text-muted">Shelves, oldest first</span>
              <div className="rounded-lg border border-line flex flex-col divide-y divide-line">
                {shelves.length === 0 && <span className="px-4 py-3 text-sm leading-5 text-muted">Not on any shelf.</span>}
                {shelves.map((r, i) => {
                  const other = r.warehouse !== wh;
                  const held = Number(r.reserved) > 0;
                  return (
                    <button
                      key={`${r.warehouse}/${r.location}/${r.batch ?? ""}/${i}`} type="button" data-testid="shelf-row" className={ROW}
                      onClick={() => setParams({ location: r.location, warehouse: r.warehouse })}
                    >
                      <span className="mono truncate">{other ? `${r.warehouse} · ${r.location}` : r.location}{r.batch ? ` · ${r.batch}` : ""}</span>
                      <span className="text-muted whitespace-nowrap">
                        <span className="text-ink font-semibold">{fmtQty(r.on_hand)}</span>
                        {other ? " · other site" : held ? ` · ${fmtQty(r.reserved)} held` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {showShelf && shelf && (
          <>
            <BigLocation eyebrow="Shelf" code={<span className="mono">{shelf.location}</span>} hint={`${shelf.zone} · ${shelf.warehouse}`} />
            <div className="flex flex-col gap-2">
              <span className="eyebrow text-muted">On this shelf</span>
              <div className="rounded-lg border border-line flex flex-col divide-y divide-line">
                {shelf.stock.length === 0 && <span className="px-4 py-3 text-sm leading-5 text-muted">Nothing on this shelf.</span>}
                {shelf.stock.map((l, i) => (
                  <button key={`${l.sku}/${l.batch ?? ""}/${i}`} type="button" data-testid="stock-row" className={ROW} onClick={() => setParams({ sku: l.sku })}>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="mono font-semibold truncate">{l.sku}</span>
                      <span className="text-xs leading-4 text-muted truncate">
                        {l.name}{l.batch ? ` · ${l.batch}` : ""}{l.received_at ? ` · received ${fmtDate(l.received_at)}` : ""}
                      </span>
                    </div>
                    <span className="whitespace-nowrap"><span className="font-semibold">{fmtQty(l.on_hand)}</span> <span className="text-muted">{l.uom}</span></span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </Main>
      <Footer>
        <Button disabled title="Step 4">Print label</Button>
        <Button variant="primary" disabled={!moveTo || loading} onClick={() => moveTo && navigate(moveTo)}>Move from here</Button>
      </Footer>
    </Screen>
  );
}
