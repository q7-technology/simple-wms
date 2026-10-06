/** Batch sort: one walk for several orders. The scanner walks the stops the
 * API gives it (stop 1 is always the next one), then sorts what it picked
 * into a tote per order. Every confirmation goes through the retry queue. */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Page, PickBatch, ScanResult, ShortReason } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty, plural } from "../lib/format";
import { useScanWedge } from "../lib/useScanWedge";
import { BigLocation, Button, Card, Footer, Header, Main, Notice, Pill, ProductCard, ProgressRow, ScanHint, Screen } from "../ui";
import {
  DoneCard, OfflineBanner, ScanInput, SupervisorCapture, WrongScan, allowsDecimals, describeError,
  firstName, needsSupervisor, sameCode, siteOf, useScanStep, type Expecting,
} from "./task-shared";

const REASONS: { reason: ShortReason; label: string }[] = [
  { reason: "not_found", label: "Not found on the shelf" },
  { reason: "short_on_shelf", label: "Fewer here than the system says" },
  { reason: "damaged", label: "Damaged" },
  { reason: "location_unreadable", label: "Cannot read the shelf label" },
  { reason: "customer_cancelled", label: "Customer cancelled the line" },
];

/** Quantities are decimal strings: step them without floating-point dust. */
function bump(value: string, delta: number, decimals: boolean): string {
  const n = (Number(value) || 0) + delta;
  const safe = Math.max(0, n);
  return decimals ? String(Math.round(safe * 1000) / 1000) : String(Math.max(0, Math.round(safe)));
}

function sum(values: string[]): string {
  return String(Math.round(values.reduce((t, v) => t + (Number(v) || 0), 0) * 1000) / 1000);
}

export function BatchSort() {
  const { ref } = useParams();
  return ref ? <BatchStop batchRef={ref} /> : <BatchList />;
}

/* --- choose a batch -------------------------------------------------------- */

function BatchList() {
  const { session, warehouse, touch } = useSession();
  const navigate = useNavigate();
  const [batches, setBatches] = useState<PickBatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<PickBatch>>("/v1/pick-batches", { warehouse, status: "new,picking" })
      .then((p) => setBatches(p.items))
      .catch(() => setError("Could not load the batches · scan a batch reference or reconnect"));
  }, [warehouse]);

  // A batch reference is not a barcode the WMS parses, so it is matched here.
  useScanWedge((raw) => {
    touch();
    const code = raw.trim().toUpperCase();
    const hit = batches.find((b) => b.external_ref.toUpperCase() === code);
    if (hit) navigate(`/sort/${hit.external_ref}`);
    else setError(`No open batch for ${code} · choose one from the list`);
  });

  return (
    <Screen>
      <Header eyebrow="Pick · batch" title="Choose a batch" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        <ScanHint sub="The label on the trolley, or tap a batch below">Scan the batch reference</ScanHint>
        <ScanInput placeholder="Batch reference" />
        {error && <Notice tone="gold">{error}</Notice>}
        <div className="flex flex-col gap-2">
          {batches.map((b) => (
            <Link key={b.wms_id} to={`/sort/${b.external_ref}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="font-semibold truncate">{b.external_ref} · {plural(b.orders, "order")} · {plural(b.stops.length, "stop")}</span>
                {b.note && <span className="text-xs leading-4 text-muted truncate">{b.note}</span>}
              </span>
              <Pill tone={b.status === "picking" ? "info" : "muted"}>{b.status === "picking" ? "Picking" : "New"}</Pill>
            </Link>
          ))}
          {batches.length === 0 && !error && <span className="text-sm text-muted">No batches waiting to be picked.</span>}
        </div>
      </Main>
    </Screen>
  );
}

/* --- walk and sort a batch ------------------------------------------------- */

function BatchStop({ batchRef }: { batchRef: string }) {
  const { session, device, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const operator = session?.operator.code ?? "";

  const [batch, setBatch] = useState<PickBatch | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shelf, setShelf] = useState(false);
  const [gotProduct, setGotProduct] = useState(false);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState(0);
  const [shorting, setShorting] = useState(false);
  const [reason, setReason] = useState<ShortReason | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setBatch(await api.get<PickBatch>(`/v1/pick-batches/${batchRef}`));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Could not reach the WMS · working from memory");
    }
  }, [batchRef]);

  useEffect(() => { void reload(); }, [reload]);

  const stop = batch?.stops[0] ?? null;
  const doneStops = batch?.done_stops ?? 0;
  const stopKey = `${doneStops}·${stop?.location ?? ""}·${stop?.sku ?? ""}`;

  // a fresh stop starts back at the shelf, with each tote asking for its share
  useEffect(() => {
    setShelf(false); setGotProduct(false); setCursor(0);
    setShorting(false); setReason(null); setBadge(null); setError(null);
    setQtys(stop ? Object.fromEntries(stop.picks.map((p) => [p.tote, p.qty])) : {});
  }, [stopKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const step: Expecting = !stop ? null : shorting ? "badge" : !shelf ? "location" : "product";
  const expected = step === "product" && stop
    ? `product barcode for ${stop.sku}`
    : step === "badge" ? "supervisor badge" : `shelf ${stop?.location ?? ""}`.trim();

  const { wrong, setWrong, clear } = useScanStep(step, expected, (r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    if (!stop) return;
    if (step === "badge") { setBadge(String(resolved.badge ?? r.raw)); return; }
    if (step === "location") {
      const code = String(resolved.location ?? r.raw).toUpperCase();
      if (!sameCode(code, stop.location)) {
        setWrong({ raw: r.raw, type: "location", format: r.format, code, message: r.message });
        return;
      }
      setShelf(true); setError(null);
      return;
    }
    const sku = String(resolved.sku ?? "").toUpperCase();
    if (sku !== stop.sku.toUpperCase()) {
      setWrong({ raw: r.raw, type: "product", format: r.format, code: sku || r.raw, message: r.message });
      return;
    }
    setError(null);
    // the first scan confirms the product; each one after it points at the next tote
    if (!gotProduct) setGotProduct(true);
    else setCursor((c) => (stop.picks.length ? (c + 1) % stop.picks.length : 0));
  });

  const decimals = allowsDecimals(stop?.uom);
  const sorted = stop ? sum(stop.picks.map((p) => qtys[p.tote] ?? p.qty)) : "0";
  const differs = Boolean(stop?.picks.some((p) => Number(qtys[p.tote] ?? p.qty) !== Number(p.qty)));
  const missing = stop ? String(Math.max(0, Math.round((Number(stop.qty) - Number(sorted)) * 1000) / 1000)) : "0";

  const confirm = async (short: boolean) => {
    if (!stop || !batch) return;
    const picks = stop.picks.map((p) => ({ tote: p.tote, qty: qtys[p.tote] ?? p.qty }));
    const body: Record<string, unknown> = {
      ...(short || differs ? { picks } : {}),
      ...(short ? { reason, supervisor_badge: badge } : {}),
      operator, device,
    };
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/pick-batches/${batch.external_ref}/stops/1/confirm`,
        body,
        label: `Stop ${doneStops + 1} · ${stop.sku} · ${fmtQty(sorted, stop.uom)}`,
      });
      if (item.status === "failed") {
        setError(describeError(item));
        // a short tote needs a badge: the panel that takes one is the short flow
        if (needsSupervisor(item)) { setShorting(true); setBadge(null); }
        return;
      }
      if (item.status === "sent") await reload();
      else setBatch((b) => (b ? { ...b, done_stops: b.done_stops + 1, stops: b.stops.slice(1) } : b));
    } finally {
      setBusy(false);
    }
  };

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!batch) {
    return (
      <Screen>
        <Header eyebrow="Pick · batch" title="Loading…" right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const totalStops = doneStops + batch.stops.length;
  const current = stop?.picks[Math.min(cursor, Math.max(0, stop.picks.length - 1))] ?? null;

  return (
    <Screen>
      <Header
        eyebrow={`Batch pick · ${plural(batch.orders, "order")}`}
        title={shorting && stop ? `${batch.external_ref} · ${stop.sku}` : batch.external_ref}
        right={right}
      />
      <Main>
        <OfflineBanner />
        <ProgressRow
          label={stop ? `Stop ${doneStops + 1} of ${totalStops}` : `${totalStops} of ${totalStops} stops`}
          done={doneStops} total={totalStops || 1}
        />
        {!stop && (
          <DoneCard title={`${plural(batch.orders, "order")} picked`}>
            <span className="text-sm text-muted">Every tote is full. Each order keeps its own task and its own ledger lines.</span>
            <Button variant="primary" onClick={() => navigate("/")}>Back to menu</Button>
          </DoneCard>
        )}
        {stop && wrong && (
          <WrongScan
            read={wrong} expected={expected}
            title={wrong.type === "location" && step === "product" ? "That is a shelf, not the product" : wrong.type === "product" && step === "product" ? "That is a different product" : wrong.type === "location" ? "That is a different shelf" : undefined}
            onAgain={clear}
          />
        )}
        {stop && !wrong && !shorting && (
          <>
            <BigLocation
              eyebrow="Go to" code={stop.location}
              hint={`${stop.zone} · walk order`}
              hint2={shelf ? "Scanned · take the stock from this shelf" : "Scan the shelf label when you get there"}
            />
            <ProductCard
              sku={stop.sku} name={stop.name}
              pill={stop.batch ? <Pill>Batch {stop.batch}</Pill> : undefined}
              big={fmtQty(stop.qty)} bigHint={`${stop.uom} to pick here`}
            />
            {!shelf && <ScanHint sub="Then the product">Scan the shelf to start</ScanHint>}
            {shelf && !gotProduct && <ScanHint sub="GS1, QR or the plain SKU all work here">Scan the product to confirm</ScanHint>}
            {shelf && gotProduct && (
              <>
                {current && (
                  <BigLocation
                    eyebrow="Put it in" code={`TOTE ${current.tote}`}
                    hint={`Order ${current.delivery}`}
                    hint2={`${fmtQty(qtys[current.tote] ?? current.qty)} of ${fmtQty(current.qty)} in this tote so far`}
                  />
                )}
                <ScanHint sub="Each scan points at the next tote · or tap a tote">Scan the next item from the tote</ScanHint>
                <div className="flex flex-col gap-2">
                  <span className="eyebrow text-muted">Sort into the totes</span>
                  {stop.picks.map((p, i) => {
                    const value = qtys[p.tote] ?? p.qty;
                    const here = i === cursor;
                    return (
                      <div key={p.tote} className={`card p-3 flex items-center justify-between gap-3 ${here ? "border-brand bg-brand-tint" : ""}`}>
                        <button
                          type="button" aria-label={`Put this one in tote ${p.tote}`} onClick={() => setCursor(i)}
                          className="flex flex-col gap-0.5 min-w-0 bg-transparent border-0 p-0 text-left text-ink cursor-pointer"
                        >
                          <span className="text-xl leading-7 font-bold">Tote {p.tote}</span>
                          <span className="mono text-xs leading-4 text-muted truncate">{p.delivery}</span>
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button" aria-label={`Less in tote ${p.tote}`}
                            onClick={() => setQtys((q) => ({ ...q, [p.tote]: bump(q[p.tote] ?? p.qty, -1, decimals) }))}
                            className="w-14 h-14 rounded-md bg-transparent border border-line-strong text-ink text-2xl cursor-pointer"
                          >−</button>
                          <span aria-label={`Tote ${p.tote} quantity`} className="w-10 text-center text-2xl leading-8 font-bold">{fmtQty(value)}</span>
                          <button
                            type="button" aria-label={`More in tote ${p.tote}`}
                            onClick={() => setQtys((q) => ({ ...q, [p.tote]: bump(q[p.tote] ?? p.qty, 1, decimals) }))}
                            className="w-14 h-14 rounded-md bg-transparent border border-line-strong text-ink text-2xl cursor-pointer"
                          >+</button>
                        </div>
                      </div>
                    );
                  })}
                  <span className="text-sm leading-5 text-muted">{fmtQty(sorted)} of {fmtQty(stop.qty)} sorted</span>
                </div>
              </>
            )}
            {error && <Notice tone="gold">{error}</Notice>}
            <ScanInput placeholder={shelf ? "Scan the product" : "Scan the shelf"} />
          </>
        )}
        {stop && !wrong && shorting && (
          <>
            <Card strong>
              <span className="text-xl leading-7 font-bold">Sorted {fmtQty(sorted)} of {fmtQty(stop.qty)}</span>
              <span className="text-sm leading-5 text-muted">{fmtQty(missing, stop.uom)} missing from {stop.location}</span>
            </Card>
            <div className="flex flex-col gap-2">
              <span className="eyebrow text-muted">Why?</span>
              {REASONS.map((r) => (
                <Button
                  key={r.reason} variant={reason === r.reason ? "gold" : "quiet"}
                  className={reason === r.reason ? "text-left bg-gold-tint" : "text-left"}
                  aria-pressed={reason === r.reason}
                  onClick={() => { setReason(r.reason); setError(null); }}
                >
                  {r.label}
                </Button>
              ))}
            </div>
            <span className="text-xs leading-4 text-muted">The tote that gets less is short. The other orders on this stop are untouched.</span>
            <SupervisorCapture sub="A short pick always needs one" onBadge={(b) => { setBadge(b); setError(null); }}>Supervisor: scan your badge</SupervisorCapture>
            {badge && <span className="text-xs leading-4 text-muted">Badge <span className="mono">{badge}</span> ready · confirm to send</span>}
            {error && <Notice tone="gold">{error}</Notice>}
          </>
        )}
      </Main>
      {stop && !wrong && !shorting && (
        <Footer>
          <Button variant="gold" disabled={busy} onClick={() => { setShorting(true); setError(null); }}>Short</Button>
          <Button variant="primary" disabled={busy || !shelf || !gotProduct} onClick={() => void confirm(false)}>Confirm stop</Button>
        </Footer>
      )}
      {stop && !wrong && shorting && (
        <Footer>
          <Button variant="quiet" disabled={busy} onClick={() => { setShorting(false); setError(null); }}>Back</Button>
          <Button variant="primary" disabled={busy || !reason || !badge} onClick={() => void confirm(true)}>Confirm short</Button>
        </Footer>
      )}
    </Screen>
  );
}
