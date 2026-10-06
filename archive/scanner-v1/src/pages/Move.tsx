import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ScanResult, StockAtShelf, StockLine } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty } from "../lib/format";
import { BigLocation, Button, Card, Footer, Header, Main, Notice, Pill, ProductCard, QtyStepper, ScanHint, Screen } from "../ui";
import {
  OfflineBanner, ScanInput, WrongScan, allowsDecimals, describeError, firstName, sameCode, siteOf, useScanStep, type Expecting,
} from "./task-shared";

const REASONS: { code: string; label: string }[] = [
  { code: "tidy", label: "Tidy" },
  { code: "consolidate", label: "Consolidate" },
  { code: "damaged", label: "Damaged" },
  { code: "quality_hold", label: "Quality hold" },
];

function hereSummary(here: StockAtShelf | null | undefined, offline: boolean): string {
  if (here === undefined) return offline ? "Scanned · stock not loaded · scan the product" : "Scanned · looking up what is here";
  if (here === null) return "Scanned · stock not loaded · scan the product";
  if (here.stock.length === 0) return "Scanned · nothing recorded here";
  if (here.stock.length === 1) {
    const s = here.stock[0];
    return `Scanned · ${fmtQty(s.on_hand, s.uom)} ${s.sku} here${s.batch ? ` · batch ${s.batch}` : ""}`;
  }
  return `Scanned · ${here.stock.length} products here · scan the one to move`;
}

export function Move() {
  const { session, device, warehouse, online, queue } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const operator = session?.operator.code ?? "";

  const [from, setFrom] = useState<string | null>(params.get("from"));
  const [here, setHere] = useState<StockAtShelf | null | undefined>(undefined);
  const [product, setProduct] = useState<StockLine | null>(null);
  const [qty, setQty] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [reason, setReason] = useState("tidy");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wantedSku = params.get("sku");

  // what is on the from shelf; one product is preselected
  useEffect(() => {
    if (!from) { setHere(undefined); return; }
    let live = true;
    setHere(undefined);
    api.get<StockAtShelf>(`/v1/locations/${encodeURIComponent(from)}/stock`, { warehouse })
      .then((s) => {
        if (!live) return;
        setHere(s);
        const pick = wantedSku ? s.stock.find((l) => sameCode(l.sku, wantedSku)) : s.stock.length === 1 ? s.stock[0] : null;
        if (pick) { setProduct(pick); setQty(pick.available); }
      })
      .catch(() => { if (live) setHere(null); });
    return () => { live = false; };
  }, [from, warehouse, wantedSku]);

  const reset = () => { setFrom(null); setHere(undefined); setProduct(null); setQty(""); setTo(null); setReason("tidy"); setError(null); };

  const onFrom = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    setOk(null); setError(null); setProduct(null); setQty(""); setTo(null);
    setFrom(String(resolved.location ?? r.raw).toUpperCase());
  }, []);

  const onProduct = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const sku = String(resolved.sku ?? r.raw).toUpperCase();
    const batch = (resolved.batch ?? r.fields?.batch ?? null) as string | null;
    if (here && here.stock.length > 0) {
      const onShelf = here.stock.filter((l) => sameCode(l.sku, sku));
      const hit = onShelf.find((l) => !batch || sameCode(l.batch, batch)) ?? onShelf[0];
      if (!hit) { setWrong({ raw: r.raw, type: "product", format: r.format, code: sku, message: r.message }); return; }
      setProduct(hit); setQty(hit.available);
      return;
    }
    // no stock list in memory (offline): trust the scan, the API checks availability
    setProduct({ sku, name: String(resolved.name ?? sku), batch, owner: "DEFAULT", on_hand: "", reserved: "", available: "", uom: String(resolved.uom ?? "EA"), received_at: null });
    setQty(resolved.qty !== undefined && resolved.qty !== null ? String(resolved.qty) : "");
  }, [here]);

  const onTo = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    setTo(String(resolved.location ?? r.raw).toUpperCase());
    setError(null);
  }, []);

  const step: Expecting = !from ? "location" : !product ? "product" : "location";
  const expected = !from ? "shelf you are moving from" : !product ? `product on ${from}` : "destination shelf";
  const { wrong, setWrong, clear } = useScanStep(step, expected, (r) => {
    if (!from) onFrom(r);
    else if (!product) onProduct(r);
    else onTo(r);
  });

  const ready = Boolean(from && product && to && Number(qty) > 0);

  const confirm = async () => {
    if (!from || !product || !to || !ready) return;
    setBusy(true); setError(null); setOk(null);
    try {
      const item = await queue.submit({
        path: "/v1/moves",
        body: { warehouse, owner: product.owner || "DEFAULT", sku: product.sku, batch: product.batch, qty, uom: product.uom, from_location: from, to_location: to, reason, operator, device },
        label: `Move ${fmtQty(qty, product.uom)} ${product.sku} · ${from} → ${to}`,
      });
      if (item.status === "failed") { setError(describeError(item)); return; }
      setOk(item.status === "sent" ? `Moved ${fmtQty(qty, product.uom)} to ${to}` : `Move of ${fmtQty(qty, product.uom)} to ${to} queued · will send when back`);
      reset();
    } finally {
      setBusy(false);
    }
  };

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  const onHand = product?.on_hand ? `${fmtQty(product.on_hand, product.uom)} here` : "On hand not loaded";

  return (
    <Screen>
      <Header eyebrow="Move · within warehouse" title="Free move" right={right} />
      <Main>
        <OfflineBanner />
        {ok && <Notice tone="ok">Done · {ok}</Notice>}
        {wrong ? <WrongScan read={wrong} expected={expected} title={wrong.type === "product" && step === "product" ? "That product is not on this shelf" : undefined} onAgain={clear} /> : (
          <>
            <BigLocation eyebrow="From" code={from ?? "—"} hint={from ? hereSummary(here, !online) : "Scan the shelf you are moving from"} />
            {from && !product && here && here.stock.length > 1 && (
              <Card>
                <span className="text-xs leading-4 text-muted">On this shelf · tap or scan the one to move</span>
                {here.stock.map((l) => (
                  <Button key={`${l.sku}|${l.batch ?? ""}`} variant="quiet" className="text-left flex items-center justify-between gap-3" onClick={() => { setProduct(l); setQty(l.available); }}>
                    <span className="truncate"><span className="font-semibold">{l.sku}</span> <span className="text-muted">{l.name}</span></span>
                    <span className="text-muted text-sm shrink-0">{fmtQty(l.on_hand, l.uom)}{l.batch ? ` · ${l.batch}` : ""}</span>
                  </Button>
                ))}
              </Card>
            )}
            {from && !product && <ScanHint sub={here && here.stock.length > 0 ? "One of the products on this shelf" : "The product barcode or plain SKU"}>Scan the product</ScanHint>}
            {product && (
              <>
                <ProductCard
                  sku={product.sku} name={product.name}
                  pill={product.batch ? <Pill>Batch {product.batch}</Pill> : undefined}
                  big={qty || "0"} bigHint={`${product.uom} to move${product.on_hand ? ` · ${fmtQty(product.on_hand)} here` : ""}`}
                />
                <div className="flex flex-col gap-1.5">
                  <QtyStepper label="Quantity" value={qty} onChange={setQty} decimals={allowsDecimals(product.uom)} />
                  <span className="text-xs leading-4 text-muted">{onHand}</span>
                </div>
                <BigLocation eyebrow="To" code={to ?? "—"} hint="Scan the destination shelf" hint2="Mixed-product shelves are allowed here" />
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs leading-4 text-muted">Reason</span>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason">
                    {REASONS.map((r) => (
                      <Button key={r.code} role="radio" aria-checked={reason === r.code} variant={reason === r.code ? "primary" : "quiet"} className="h-11 px-3 text-sm grow-0" onClick={() => setReason(r.code)}>{r.label}</Button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {error && <Notice tone="gold">{error}</Notice>}
            <ScanInput placeholder={!from ? "Scan the from shelf" : !product ? "Scan the product" : "Scan the destination shelf"} />
          </>
        )}
      </Main>
      <Footer>
        <Button variant="quiet" onClick={() => navigate("/")}>Cancel</Button>
        <Button variant="primary" disabled={!ready || busy || Boolean(wrong)} onClick={() => void confirm()}>Confirm move</Button>
      </Footer>
    </Screen>
  );
}
