/** Production receipt: finished goods off the line, one pallet per call.
 * The batch comes from the order and is read-only, because the ERP and the
 * WMS have to agree on what was made. Every pallet goes through the queue. */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Page, ProductionOrder, ScanResult } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty } from "../lib/format";
import type { QueueItem } from "../lib/queue";
import { useScanWedge } from "../lib/useScanWedge";
import { BigLocation, Button, Card, Field, Footer, Header, Input, Main, Notice, Pill, ProductCard, ProgressRow, QtyStepper, ScanHint, Screen } from "../ui";
import {
  DoneCard, OfflineBanner, ScanInput, SupervisorCapture, WrongScan, allowsDecimals, describeError,
  firstName, needsSupervisor, siteOf, useScanStep, type Expecting,
} from "./task-shared";

interface Suggestion { location: string; zone: string; reason: string }
interface SuggestReply { suggestions: Suggestion[]; flag: string | null }
interface ReceiptReply { received_total: string; expected: string; complete: boolean; event_sent: boolean }

function suggestionHint(s: Suggestion): { text: string; gold: boolean } {
  switch (s.reason) {
    case "same_sku_has_space": return { text: `Same product already here · ${s.zone}`, gold: false };
    case "empty_in_preferred_zone": return { text: `Empty shelf in ${s.zone} · preferred zone`, gold: false };
    case "empty_shelf": return { text: `Empty shelf in ${s.zone}`, gold: false };
    case "overflow": return { text: "Overflow · needs a home later", gold: true };
    default: return { text: `${s.reason.replace(/_/g, " ")} in ${s.zone}`, gold: false };
  }
}

/** A 422 on the batch is the one the brief calls out: say it in plain words. */
function palletProblem(item: QueueItem, pallet: string, ordered: string | null): string {
  const text = describeError(item);
  if (/batch/i.test(text) && ordered && pallet && pallet.toUpperCase() !== ordered.toUpperCase()) {
    return `This pallet says batch ${pallet} but the order makes batch ${ordered}.`;
  }
  return text;
}

function remaining(order: ProductionOrder): string {
  const left = Number(order.output.qty) - Number(order.output.qty_received ?? 0);
  return String(Math.max(0, Math.round(left * 1000) / 1000));
}

export function ProductionReceipt() {
  const { ref } = useParams();
  return ref ? <ReceiptForOrder orderRef={ref} /> : <OrderList />;
}

/* --- choose a production order --------------------------------------------- */

function OrderList() {
  const { session, warehouse, touch } = useSession();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<ProductionOrder>>("/v1/production-orders", { warehouse, status: "issuing,in_production" })
      .then((p) => setOrders(p.items))
      .catch(() => setError("Could not load the orders · scan the order QR or reconnect"));
  }, [warehouse]);

  const onScan = useCallback(async (raw: string) => {
    touch();
    setError(null);
    try {
      const r = await api.post<ScanResult>("/v1/scans/parse", { raw, warehouse });
      const fields = r.fields ?? {};
      if (r.type === "production_order" && fields.po) {
        const batch = fields.batch ? `?batch=${encodeURIComponent(fields.batch)}` : "";
        navigate(`/production/${fields.po}${batch}`);
        return;
      }
      const code = raw.trim().toUpperCase();
      const hit = orders.find((o) => o.external_ref.toUpperCase() === code);
      if (hit) { navigate(`/production/${hit.external_ref}`); return; }
      setError(r.message ?? `No open production order for ${code} · choose one from the list`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reach the WMS · choose an order from the list");
    }
  }, [navigate, orders, touch, warehouse]);

  useScanWedge((raw) => { void onScan(raw); });

  return (
    <Screen>
      <Header eyebrow="Production receipt" title="Choose an order" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        <ScanHint sub="The QR on the order carries the product, the batch and the quantity">Scan the production order</ScanHint>
        <ScanInput placeholder="Production order" />
        {error && <Notice tone="gold">{error}</Notice>}
        <div className="flex flex-col gap-2">
          {orders.map((o) => (
            <Link key={o.wms_id} to={`/production/${o.external_ref}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="font-semibold truncate">{o.external_ref} · {o.output.sku}</span>
                <span className="text-xs leading-4 text-muted truncate">{fmtQty(o.output.qty_received)} of {fmtQty(o.output.qty, o.output.uom)} made</span>
              </span>
              <Pill tone={o.status === "in_production" ? "info" : "muted"}>{o.status === "in_production" ? "In production" : "Issuing"}</Pill>
            </Link>
          ))}
          {orders.length === 0 && !error && <span className="text-sm text-muted">No orders on the line right now.</span>}
        </div>
      </Main>
    </Screen>
  );
}

/* --- receive the pallets --------------------------------------------------- */

function ReceiptForOrder({ orderRef }: { orderRef: string }) {
  const { session, device, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scannedBatch = params.get("batch") ?? "";
  const operator = session?.operator.code ?? "";

  const [order, setOrder] = useState<ProductionOrder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [batch, setBatch] = useState(scannedBatch);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [damaged, setDamaged] = useState(false);
  const [damageNote, setDamageNote] = useState("");
  const [needBadge, setNeedBadge] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<ReceiptReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the order is kept in state, so a dropped connection does not lose the flow
  useEffect(() => {
    let live = true;
    api.get<ProductionOrder>(`/v1/production-orders/${orderRef}`)
      .then((o) => {
        if (!live) return;
        setOrder(o);
        setQty(remaining(o));
        setBatch(o.output.batch ?? scannedBatch);
        setLoadError(null);
      })
      .catch((e) => { if (live) setLoadError(e instanceof ApiError ? e.message : "Could not reach the WMS · working from memory"); });
    return () => { live = false; };
  }, [orderRef, scannedBatch]);

  // where should the pallet go?
  const orderId = order?.wms_id;
  useEffect(() => {
    if (!order) return;
    let live = true;
    api.post<SuggestReply>("/v1/locations/suggest", {
      warehouse, sku: order.output.sku, batch: order.output.batch ?? batch ?? null,
      qty: remaining(order), uom: order.output.uom, purpose: "putaway",
    })
      .then((s) => { if (live) setSuggestion(s.suggestions[0] ?? (s.flag ? { location: "—", zone: "", reason: s.flag } : null)); })
      .catch(() => { /* offline or refused: the operator scans a shelf */ });
    return () => { live = false; };
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const step: Expecting = !order || result?.complete ? null : needBadge ? "badge" : "location";
  const { wrong, clear } = useScanStep(step, "shelf", (r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    if (step === "badge") { void confirm(String(resolved.badge ?? r.raw)); return; }
    setDest(String(resolved.location ?? r.raw).toUpperCase());
    setError(null);
  });

  const confirm = useCallback(async (supervisorBadge?: string, damageText?: string) => {
    if (!order || !dest || !qty) return;
    const shelf = dest;
    const body: Record<string, unknown> = needBadge && supervisorBadge
      ? { ...needBadge, supervisor_badge: supervisorBadge }
      : {
        warehouse, sku: order.output.sku, batch: batch || null, qty, uom: order.output.uom,
        to_location: shelf, container_id: null, operator, device_id: device,
        ...(damageText !== undefined ? { note: damageText || "Damaged on the pallet" } : {}),
      };
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/production-orders/${order.external_ref}/receipts`,
        body,
        label: `Pallet · ${order.output.sku} · ${fmtQty(qty, order.output.uom)}`,
      });
      if (item.status === "failed") {
        if (needsSupervisor(item)) { setNeedBadge(body); setError(null); return; }
        setNeedBadge(null);
        setError(palletProblem(item, batch, order.output.batch));
        return;
      }
      setNeedBadge(null);
      const reply = (item.reply ?? null) as ReceiptReply | null;
      if (reply && reply.received_total !== undefined) {
        setResult(reply);
        setOrder((o) => (o ? { ...o, output: { ...o.output, qty_received: reply.received_total }, status: reply.complete ? "complete" : o.status } : o));
        setQty(String(Math.max(0, Math.round((Number(reply.expected) - Number(reply.received_total)) * 1000) / 1000)));
      } else {
        // queued through a Wi-Fi drop: count it locally and carry on
        setOrder((o) => (o ? { ...o, output: { ...o.output, qty_received: String(Number(o.output.qty_received ?? 0) + Number(qty)) } } : o));
        setQty("");
      }
      setDest(null); setDamaged(false); setDamageNote("");
    } finally {
      setBusy(false);
    }
  }, [order, dest, qty, needBadge, warehouse, batch, operator, device, queue]);

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!order) {
    return (
      <Screen>
        <Header eyebrow="Production receipt" title="Loading…" right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const out = order.output;
  const uom = out.uom;
  const hint = suggestion ? suggestionHint(suggestion) : null;
  const shelf = dest ?? suggestion?.location ?? "—";
  const batchMissing = !out.batch && !batch.trim();
  const done = result?.complete === true;

  return (
    <Screen>
      <Header eyebrow="Production receipt" title={order.external_ref} right={right} />
      <Main>
        <OfflineBanner />
        {result && !done && <Notice tone="ok">{fmtQty(result.received_total)} of {fmtQty(result.expected, uom)} made</Notice>}
        {result && !result.event_sent && <Notice>The ERP counted this one · the WMS wrote the ledger line only</Notice>}
        {done && (
          <DoneCard title={`${fmtQty(result.expected, uom)} received`}>
            <span className="text-sm text-muted">{order.external_ref} is complete. Every pallet is on the ledger.</span>
            <Button variant="primary" onClick={() => navigate("/")}>Back to menu</Button>
          </DoneCard>
        )}
        {!done && wrong && <WrongScan read={wrong} expected="shelf" onAgain={clear} />}
        {!done && !wrong && (
          <>
            <ProductCard sku={out.sku} name={out.name} pill={out.batch ? <Pill>Batch {out.batch}</Pill> : undefined} />
            {out.batch
              ? <span className="text-sm leading-5 text-muted">Batch {out.batch} · from the order</span>
              : (
                <Field label="Batch" hint={batchMissing ? "This product needs a batch · take it from the order QR or the pallet label" : "From the order QR"}>
                  <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="Batch" autoCapitalize="characters" className="mono" />
                </Field>
              )}
            <ProgressRow
              label={`${fmtQty(out.qty_received)} of ${fmtQty(out.qty, uom)}`}
              done={Number(out.qty_received ?? 0)} total={Number(out.qty) || 1}
            />
            <QtyStepper label="Quantity on this pallet" value={qty} onChange={setQty} decimals={allowsDecimals(uom)} />
            <BigLocation
              eyebrow="Put it at" code={shelf} tone={hint?.gold ? "gold" : undefined}
              hint={dest ? (suggestion && dest === suggestion.location ? `Scanned · ${hint?.text ?? "suggested shelf"}` : "Scanned · your choice, the ledger records it") : hint?.text ?? "Waiting for a suggestion · or scan any shelf"}
              hint2="Or scan another shelf that allows this product"
            />
            {!needBadge && <ScanHint>{dest ? "Scan another shelf to change it" : "Scan the shelf to confirm"}</ScanHint>}
            {damaged && !needBadge && (
              <Card className="border-gold-line">
                <span className="text-sm font-medium text-gold">Damaged on the pallet</span>
                <Field label="What happened (optional)">
                  <Input value={damageNote} onChange={(e) => setDamageNote(e.target.value)} placeholder="Crushed carton, wet, …" />
                </Field>
                <Button variant="gold" disabled={!dest || busy || batchMissing || !qty} onClick={() => void confirm(undefined, damageNote)}>Confirm as damaged</Button>
              </Card>
            )}
            {needBadge && <SupervisorCapture sub="Over the tolerance on this order" onBadge={(b) => void confirm(b)}>Supervisor: scan your badge</SupervisorCapture>}
            {error && <Notice tone="gold">{error}</Notice>}
            <ScanInput placeholder="Scan the shelf" />
          </>
        )}
      </Main>
      {!done && !wrong && (
        <Footer>
          <Button variant="gold" disabled={busy} onClick={() => setDamaged((d) => !d)}>Damaged</Button>
          <Button variant="primary" disabled={!dest || busy || batchMissing || !qty || Boolean(needBadge)} onClick={() => void confirm()}>Confirm pallet</Button>
        </Footer>
      )}
    </Screen>
  );
}
