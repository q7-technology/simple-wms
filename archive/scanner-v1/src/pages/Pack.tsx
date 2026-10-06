import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Delivery, DeliveryLine, Page, ScanResult, Task } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty, plural } from "../lib/format";
import { Button, Card, Field, Footer, Header, Input, Main, Notice, Pill, ProductCard, ProgressRow, QtyStepper, ScanHint, Screen } from "../ui";
import { DoneCard, OfflineBanner, ScanInput, WrongScan, allowsDecimals, describeError, firstName, siteOf, useScanStep } from "./task-shared";

/* --- decimal strings ------------------------------------------------------
 * Quantities are decimals with a unit of measure and never floats, so the
 * sums here are done on the digits. */

const NUMERIC = /^-?\d*(\.\d*)?$/;

function scaleOf(...xs: string[]): number {
  return xs.reduce((m, x) => Math.max(m, (x.split(".")[1] ?? "").length), 0);
}
function toUnits(x: string, scale: number): bigint {
  const s = (x ?? "").trim() || "0";
  if (!NUMERIC.test(s)) return 0n;
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  return (neg ? -1n : 1n) * BigInt((whole || "0") + (frac + "0".repeat(scale)).slice(0, scale));
}
function fromUnits(n: bigint, scale: number): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale ? digits.slice(digits.length - scale).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
function decAdd(a: string, b: string): string { const s = scaleOf(a, b); return fromUnits(toUnits(a, s) + toUnits(b, s), s); }
function decSub(a: string, b: string): string { const s = scaleOf(a, b); return fromUnits(toUnits(a, s) - toUnits(b, s), s); }
function decCmp(a: string, b: string): number { const s = scaleOf(a, b); const x = toUnits(a, s); const y = toUnits(b, s); return x < y ? -1 : x > y ? 1 : 0; }

/* --- cartons built at the bench ------------------------------------------ */

interface BuiltLine { delivery_line: number; sku: string; qty: string; uom: string }
interface Carton { weight_kg: string; length_cm: string; width_cm: string; height_cm: string; lines: BuiltLine[] }

const EMPTY: Carton = { weight_kg: "", length_cm: "", width_cm: "", height_cm: "", lines: [] };

function cartonQty(c: { lines: { qty: string }[] }): string {
  return c.lines.reduce((sum, l) => decAdd(sum, l.qty), "0");
}

export function Pack() {
  const { ref } = useParams();
  return ref ? <PackDelivery deliveryRef={ref} /> : <PackList />;
}

/* --- pick an order to pack ------------------------------------------------- */

function PackList() {
  const { session, warehouse } = useSession();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<Task>>("/v1/tasks", { warehouse, type: "pack", status: "waiting,in_progress" })
      .then((p) => setTasks(p.items))
      .catch(() => setError("Could not load the packing · scan a delivery reference or reconnect"));
  }, [warehouse]);

  const onScan = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const ref = String(resolved.external_ref ?? resolved.source_ref ?? resolved.delivery ?? r.raw).toUpperCase();
    const hit = tasks.find((t) => (t.source_ref ?? "").toUpperCase() === ref);
    navigate(`/pack/${hit?.source_ref ?? ref}`);
  }, [navigate, tasks]);

  const { wrong, clear } = useScanStep("task", "delivery reference", onScan);

  return (
    <Screen>
      <Header eyebrow="Pack · delivery" title="Choose an order" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        {wrong ? <WrongScan read={wrong} expected="delivery reference" onAgain={clear} /> : (
          <>
            <ScanHint sub="The pick slip's barcode or the order number">Scan the delivery reference</ScanHint>
            <ScanInput placeholder="Delivery reference" />
            {error && <Notice tone="gold">{error}</Notice>}
            <div className="flex flex-col gap-2">
              {tasks.map((t) => (
                <Link key={t.wms_id} to={`/pack/${t.source_ref ?? t.wms_id}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold truncate">Pack {t.source_ref ?? t.title}</span>
                    {t.note && <span className="text-xs leading-4 text-muted truncate">{t.note}</span>}
                  </span>
                  <Pill tone={t.status === "in_progress" ? "info" : "muted"}>{t.status === "in_progress" ? "In progress" : "Waiting"}</Pill>
                </Link>
              ))}
              {tasks.length === 0 && !error && <span className="text-sm text-muted">Nothing waiting to be packed.</span>}
            </div>
          </>
        )}
      </Main>
    </Screen>
  );
}

/* --- pack one delivery ------------------------------------------------------ */

function PackDelivery({ deliveryRef }: { deliveryRef: string }) {
  const { session, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const operator = session?.operator.code ?? "";

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [closed, setClosed] = useState<Carton[]>([]);
  const [current, setCurrent] = useState<Carton>(EMPTY);
  const [sel, setSel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ cartons: number; packed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<Delivery>(`/v1/deliveries/${encodeURIComponent(deliveryRef)}`)
      .then((d) => { if (live) { setDelivery(d); setLoadError(null); } })
      .catch((e) => { if (live) setLoadError(e instanceof ApiError ? e.message : "Could not reach the WMS · reconnect to pack this order"); });
    return () => { live = false; };
  }, [deliveryRef]);

  /** What is already in a carton for a delivery line: what the WMS has, plus
   * what is on the bench. */
  const packedOf = useCallback((deliveryLine: number): string => {
    const fromWms = (delivery?.packages ?? []).flatMap((p) => p.lines).filter((l) => l.delivery_line === deliveryLine);
    const fromBench = [...closed, current].flatMap((c) => c.lines).filter((l) => l.delivery_line === deliveryLine);
    return [...fromWms, ...fromBench].reduce((sum, l) => decAdd(sum, l.qty), "0");
  }, [delivery, closed, current]);

  const remainingOf = useCallback((l: DeliveryLine): string => decSub(l.qty_picked, packedOf(l.delivery_line)), [packedOf]);

  const addToCarton = useCallback((l: DeliveryLine, qty: string) => {
    setSel(l.delivery_line);
    setCurrent((c) => {
      const has = c.lines.find((b) => b.delivery_line === l.delivery_line);
      if (has) return { ...c, lines: c.lines.map((b) => (b.delivery_line === l.delivery_line ? { ...b, qty: decAdd(b.qty, qty) } : b)) };
      return { ...c, lines: [...c.lines, { delivery_line: l.delivery_line, sku: l.sku, qty, uom: l.uom }] };
    });
    setError(null);
  }, []);

  /** A tap puts one in the carton, or whatever is left when that is less. */
  const addOne = useCallback((l: DeliveryLine) => {
    const left = remainingOf(l);
    if (decCmp(left, "0") <= 0) { setSel(l.delivery_line); return; }
    addToCarton(l, decCmp(left, "1") < 0 ? left : "1");
  }, [remainingOf, addToCarton]);

  const onProduct = useCallback((r: ScanResult) => {
    if (!delivery) return;
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const sku = String(resolved.sku ?? r.raw).toUpperCase();
    const hit = delivery.lines.find((l) => l.sku.toUpperCase() === sku && decCmp(remainingOf(l), "0") > 0)
      ?? delivery.lines.find((l) => l.sku.toUpperCase() === sku);
    if (!hit) { setWrong({ raw: r.raw, type: "product", format: r.format, code: sku, message: "Nothing on this order needs that product" }); return; }
    addOne(hit);
  }, [delivery, remainingOf, addOne]);

  const { wrong, setWrong, clear } = useScanStep(delivery && !done ? "product" : null, "product on this order", onProduct);

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!delivery) {
    return (
      <Screen>
        <Header eyebrow="Pack · delivery" title={deliveryRef} right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const baseNo = delivery.packages.reduce((m, p) => Math.max(m, p.package_no), 0) + 1;
  const currentNo = baseNo + closed.length;
  const openCarton = current.lines.length > 0;
  const cartonCount = delivery.packages.length + closed.length + 1; // the one on the bench counts
  const picked = delivery.lines.reduce((sum, l) => decAdd(sum, l.qty_picked), "0");
  const packed = delivery.lines.reduce((sum, l) => decAdd(sum, packedOf(l.delivery_line)), "0");
  const toPack = delivery.lines.filter((l) => decCmp(remainingOf(l), "0") > 0);
  const selected = delivery.lines.find((l) => l.delivery_line === sel) ?? null;
  const selQty = current.lines.find((b) => b.delivery_line === sel)?.qty ?? "0";
  const short = delivery.lines.reduce((sum, l) => decAdd(sum, decSub(l.qty_ordered, l.qty_picked)), "0");

  const setSelQty = (v: string) => {
    if (!selected) return;
    setCurrent((c) => ({
      ...c,
      lines: c.lines.some((b) => b.delivery_line === selected.delivery_line)
        ? c.lines.map((b) => (b.delivery_line === selected.delivery_line ? { ...b, qty: v } : b))
        : [...c.lines, { delivery_line: selected.delivery_line, sku: selected.sku, qty: v, uom: selected.uom }],
    }));
  };

  const closeCarton = () => {
    if (!openCarton) return;
    setClosed((cs) => [...cs, current]);
    setCurrent(EMPTY);
    setSel(null);
    setError(null);
  };

  const finish = async () => {
    const cartons = [...closed, ...(openCarton ? [current] : [])];
    if (cartons.length === 0) { setError("Put something in a carton first."); return; }
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/deliveries/${delivery.external_ref}/pack`,
        body: {
          warehouse, packed_by: operator, complete: true,
          packages: cartons.map((c, i) => ({
            package_no: baseNo + i,
            type: "carton",
            weight_kg: c.weight_kg.trim() || null,
            length_cm: c.length_cm.trim() || null,
            width_cm: c.width_cm.trim() || null,
            height_cm: c.height_cm.trim() || null,
            lines: c.lines.filter((l) => decCmp(l.qty, "0") > 0).map((l) => ({ delivery_line: l.delivery_line, sku: l.sku, qty: l.qty, uom: l.uom })),
          })),
        },
        label: `Pack ${delivery.external_ref} · ${plural(cartons.length, "carton")}`,
      });
      if (item.status === "failed") { setError(describeError(item)); return; }
      const reply = item.reply as { delivery?: { status?: string } } | null;
      setDone({ cartons: cartons.length, packed: (reply?.delivery?.status ?? "packed") === "packed" });
    } finally {
      setBusy(false);
    }
  };

  const shipTo = delivery.ship_to?.name ?? "";

  return (
    <Screen>
      <Header eyebrow={`Pack · ${plural(cartonCount, "carton")}`} title={delivery.external_ref} right={right} />
      <Main>
        <OfflineBanner />
        <ProgressRow
          label={`Packed ${fmtQty(packed)} of ${fmtQty(picked)}`}
          done={Number(packed) || 0} total={Number(picked) || 0}
        />
        {done ? (
          <DoneCard title={`${plural(done.cartons, "carton")} packed`}>
            <span className="text-sm text-muted">{delivery.external_ref}{shipTo ? ` · ${shipTo}` : ""} is on the bench with its labels.</span>
            {done.packed && <span className="text-sm text-muted">Shipping happens on the desktop.</span>}
            <Button variant="primary" onClick={() => navigate("/")}>Back to menu</Button>
          </DoneCard>
        ) : wrong ? (
          <WrongScan read={wrong} expected="product on this order" onAgain={clear} />
        ) : (
          <>
            <Card>
              <div className="flex justify-between items-center gap-3">
                <span className="eyebrow text-muted">Picked progress</span>
                {decCmp(short, "0") > 0 && <Pill tone="warn">Short {fmtQty(short)}</Pill>}
              </div>
              <div className="flex flex-col gap-2">
                {delivery.lines.map((l) => (
                  <div key={l.delivery_line} className="flex justify-between items-center gap-3 text-sm leading-5">
                    <span className="truncate"><span className="mono">{l.sku}</span> · {l.name}</span>
                    <span className="shrink-0 text-muted">{fmtQty(packedOf(l.delivery_line))} / {fmtQty(l.qty_picked, l.uom)}</span>
                  </div>
                ))}
              </div>
            </Card>

            <div className="flex flex-col gap-2">
              <span className="eyebrow text-muted">Packages</span>
              <div className="flex flex-col rounded-lg border border-line">
                {delivery.packages.map((p) => (
                  <div key={`wms-${p.package_no}`} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 border-b border-line-soft last:border-b-0">
                    <span className="truncate">Carton {p.package_no}{p.weight_kg ? ` · ${p.weight_kg} kg` : ""}</span>
                    <span className="shrink-0 text-muted">{fmtQty(cartonQty(p))} items</span>
                  </div>
                ))}
                {closed.map((c, i) => (
                  <div key={`bench-${baseNo + i}`} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 border-b border-line-soft last:border-b-0">
                    <span className="truncate">Carton {baseNo + i}{c.weight_kg ? ` · ${c.weight_kg} kg` : ""}</span>
                    <span className="shrink-0 text-muted">{fmtQty(cartonQty(c))} items</span>
                  </div>
                ))}
                <div className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 border-b border-line-soft last:border-b-0">
                  <span className="truncate">Carton {currentNo} · open</span>
                  <span className="shrink-0 text-brand">{fmtQty(cartonQty(current))} items</span>
                </div>
              </div>
              {delivery.packages.length + closed.length === 0 && <span className="text-xs leading-4 text-muted">Nothing closed yet. Closing a carton prints its label.</span>}
            </div>

            <ScanHint sub="Or tap a line below">Scan an item into the carton</ScanHint>
            <ScanInput placeholder="Scan the product" />

            <div className="flex flex-col gap-2">
              <span className="eyebrow text-muted">Still to pack</span>
              {toPack.map((l) => (
                <button
                  key={l.delivery_line} type="button" onClick={() => addOne(l)}
                  className="card min-h-14 px-4 py-3 flex items-center justify-between gap-3 bg-transparent text-left text-ink cursor-pointer active:bg-brand-tint"
                >
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold truncate"><span className="mono">{l.sku}</span> · {l.name}</span>
                    {l.batch && <span className="text-xs leading-4 text-muted">Batch {l.batch}</span>}
                  </span>
                  <span className="text-xs leading-4 text-muted shrink-0">{fmtQty(remainingOf(l), l.uom)} left</span>
                </button>
              ))}
              {toPack.length === 0 && <span className="text-sm text-muted">Every picked line is in a carton.</span>}
            </div>

            {selected && (
              <>
                <ProductCard
                  sku={selected.sku} name={selected.name}
                  pill={<Pill>Into carton {currentNo}</Pill>}
                  big={fmtQty(selQty)} bigHint={`${selected.uom} · scan each or enter`}
                />
                <QtyStepper label="Quantity in carton" value={selQty} onChange={setSelQty} decimals={allowsDecimals(selected.uom)} />
              </>
            )}

            <Field label={`Carton ${currentNo} weight (kg)`}>
              <Input value={current.weight_kg} onChange={(e) => setCurrent((c) => ({ ...c, weight_kg: e.target.value }))} inputMode="decimal" placeholder="kg" aria-label="Weight (kg)" />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs leading-4 text-muted">Length / Width / Height (cm)</span>
              <div className="flex gap-2">
                <Input value={current.length_cm} onChange={(e) => setCurrent((c) => ({ ...c, length_cm: e.target.value }))} inputMode="decimal" placeholder="L" aria-label="Length (cm)" className="min-w-0" />
                <Input value={current.width_cm} onChange={(e) => setCurrent((c) => ({ ...c, width_cm: e.target.value }))} inputMode="decimal" placeholder="W" aria-label="Width (cm)" className="min-w-0" />
                <Input value={current.height_cm} onChange={(e) => setCurrent((c) => ({ ...c, height_cm: e.target.value }))} inputMode="decimal" placeholder="H" aria-label="Height (cm)" className="min-w-0" />
              </div>
            </div>

            {error && <Notice tone="gold">{error}</Notice>}
            {loadError && <Notice tone="gold">{loadError}</Notice>}
          </>
        )}
      </Main>
      {!done && !wrong && (
        <Footer>
          <Button variant="quiet" disabled={busy || !openCarton} onClick={closeCarton}>Close carton</Button>
          <Button variant="primary" disabled={busy || (closed.length === 0 && !openCarton)} onClick={() => void finish()}>Finish packing</Button>
        </Footer>
      )}
    </Screen>
  );
}
