import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Page, ScanResult, Task } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty } from "../lib/format";
import { BigLocation, Button, Card, Field, Footer, Header, Input, Main, Notice, Pill, ProductCard, ProgressRow, QtyStepper, ScanHint, Screen } from "../ui";
import {
  DoneCard, OfflineBanner, ScanInput, SupervisorCapture, WrongScan, allowsDecimals, describeError, firstName,
  needsSupervisor, patchLine, siteOf, useScanStep, useTask, type Expecting,
} from "./task-shared";

interface Suggestion { location: string; zone: string; reason: string }
interface SuggestReply { suggestions: Suggestion[]; flag: string | null }

function suggestionHint(s: Suggestion): { text: string; gold: boolean } {
  switch (s.reason) {
    case "same_sku_has_space": return { text: `Same product already here · ${s.zone}`, gold: false };
    case "empty_in_preferred_zone": return { text: `Empty shelf in ${s.zone} · preferred zone`, gold: false };
    case "empty_shelf": return { text: `Empty shelf in ${s.zone}`, gold: false };
    case "overflow": return { text: "Overflow · needs a home later", gold: true };
    default: return { text: `${s.reason.replace(/_/g, " ")} in ${s.zone}`, gold: false };
  }
}

export function Receive() {
  const { taskId } = useParams();
  return taskId ? <ReceiveTask taskId={taskId} /> : <ReceiveList />;
}

/* --- pick a receipt -------------------------------------------------------- */

function ReceiveList() {
  const { session, warehouse } = useSession();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<Task>>("/v1/tasks", { warehouse, type: "receive", status: "waiting,in_progress" })
      .then((p) => setTasks(p.items))
      .catch(() => setError("Could not load the receipts · scan a receipt reference or reconnect"));
  }, [warehouse]);

  const onScan = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const id = (resolved.task_id ?? (r.type === "task" ? resolved.wms_id : undefined)) as string | undefined;
    if (id) { navigate(`/receive/${id}`); return; }
    const ref = String(resolved.external_ref ?? resolved.source_ref ?? r.raw).toUpperCase();
    const hit = tasks.find((t) => (t.source_ref ?? "").toUpperCase() === ref);
    if (hit) navigate(`/receive/${hit.wms_id}`);
    else setError(`No open receipt for ${ref}`);
  }, [navigate, tasks]);

  const { wrong, clear } = useScanStep("receipt", "receipt reference", onScan);

  return (
    <Screen>
      <Header eyebrow="Receive · expected" title="Choose a receipt" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        {wrong ? <WrongScan read={wrong} expected="receipt reference" onAgain={clear} /> : (
          <>
            <ScanHint sub="The paperwork's barcode or the PO number">Scan the receipt reference</ScanHint>
            <ScanInput placeholder="Receipt reference" />
            {error && <Notice tone="gold">{error}</Notice>}
            <div className="flex flex-col gap-2">
              {tasks.map((t) => (
                <Link key={t.wms_id} to={`/receive/${t.wms_id}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold truncate">Receive {t.source_ref ?? t.title}{t.note ? ` · ${t.note}` : ""}</span>
                    <span className="text-xs leading-4 text-muted">{t.progress.done} of {t.progress.total} lines</span>
                  </span>
                  <Pill tone={t.status === "in_progress" ? "info" : "muted"}>{t.status === "in_progress" ? "In progress" : "Waiting"}</Pill>
                </Link>
              ))}
              {tasks.length === 0 && !error && <span className="text-sm text-muted">Nothing waiting to be received.</span>}
            </div>
          </>
        )}
      </Main>
    </Screen>
  );
}

/* --- work a receipt -------------------------------------------------------- */

interface Scanned { qty: string | null; batch: string | null; batchTracked: boolean; fromLabel: boolean }

function ReceiveTask({ taskId }: { taskId: string }) {
  const { session, device, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const { task, line, lineIndex, total, error: loadError, applyItem } = useTask(taskId);
  const operator = session?.operator.code ?? "";

  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [qty, setQty] = useState("");
  const [batch, setBatch] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [damaged, setDamaged] = useState(false);
  const [damageNote, setDamageNote] = useState("");
  const [needBadge, setNeedBadge] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  // a fresh line starts at the product step
  const lineNo = line?.line_no;
  useEffect(() => {
    setScanned(null); setQty(""); setBatch(""); setSuggestion(null); setDest(null);
    setDamaged(false); setDamageNote(""); setNeedBadge(null); setError(null);
  }, [lineNo]);

  // start the clock the first time a waiting task is opened
  useEffect(() => {
    if (!task || task.status !== "waiting" || started.current) return;
    started.current = true;
    void queue.submit({ path: `/v1/tasks/${task.wms_id}/start`, body: { operator, device }, label: `Start ${task.source_ref ?? task.title}` })
      .then((item) => applyItem(item, (t) => ({ ...t, status: "in_progress", assigned_to: operator })));
  }, [task, queue, operator, device, applyItem]);

  const onProduct = useCallback((r: ScanResult) => {
    if (!line) return;
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const sku = String(resolved.sku ?? "").toUpperCase();
    if (sku !== line.sku.toUpperCase()) {
      setWrong({ raw: r.raw, type: "product", format: r.format, code: sku || r.raw, message: r.message });
      return;
    }
    const fields = r.fields ?? {};
    const labelQty = resolved.qty ?? fields.qty;
    const labelBatch = (resolved.batch ?? fields.batch) as string | undefined;
    const remaining = line.expected_qty
      ? String(Math.max(0, Number(line.expected_qty) - Number(line.actual_qty ?? 0)))
      : "";
    setScanned({
      qty: labelQty !== undefined && labelQty !== null ? String(labelQty) : null,
      batch: labelBatch ?? null,
      batchTracked: Boolean(resolved.batch_tracked),
      fromLabel: r.format !== "plain",
    });
    setQty(labelQty !== undefined && labelQty !== null ? String(labelQty) : remaining);
    setBatch(labelBatch ?? line.batch ?? "");
  }, [line]);

  const onLocation = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    setDest(String(resolved.location ?? r.raw).toUpperCase());
    setError(null);
  }, []);

  const step: Expecting = !line ? null : needBadge ? "badge" : scanned ? "location" : "product";
  const expected = step === "location" ? "shelf" : line ? `product barcode for ${line.sku}` : "product";
  const { wrong, setWrong, clear } = useScanStep(step, expected, (r) => {
    if (step === "badge") void confirm(String(((r.resolved ?? {}) as Record<string, unknown>).badge ?? r.raw));
    else if (step === "location") onLocation(r);
    else onProduct(r);
  });

  // ask where it should go once the product and quantity are known
  useEffect(() => {
    if (!scanned || !line) return;
    let live = true;
    const body = {
      warehouse, sku: line.sku, batch: scanned.batch ?? line.batch, qty: scanned.qty ?? line.expected_qty ?? "0", uom: line.uom, purpose: "putaway",
    };
    api.post<SuggestReply>("/v1/locations/suggest", body)
      .then((s) => { if (live) setSuggestion(s.suggestions[0] ?? (s.flag ? { location: "—", zone: "", reason: s.flag } : null)); })
      .catch(() => { /* offline or refused: the operator scans a shelf */ });
    return () => { live = false; };
  }, [scanned, line, warehouse]);

  const confirm = useCallback(async (supervisorBadge?: string, reason?: string) => {
    if (!task || !line || !dest) return;
    const body: Record<string, unknown> = needBadge && supervisorBadge
      ? { ...needBadge, supervisor_badge: supervisorBadge }
      : { qty, uom: line.uom, batch: batch || null, location: dest, operator, device, ...(reason ? { reason, note: damageNote || null } : {}) };
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/confirm`, body,
        label: `Line ${line.line_no} · ${line.sku} · ${fmtQty(qty, line.uom)}${reason ? ` · ${reason}` : ""}`,
      });
      if (item.status === "failed") {
        if (needsSupervisor(item)) setNeedBadge(body);
        else setError(describeError(item));
        return;
      }
      setNeedBadge(null);
      applyItem(item, (t) => patchLine(t, line.line_no, { actual_qty: qty, status: "done", to_location: dest, reason: reason ?? null, batch: batch || line.batch }));
    } finally {
      setBusy(false);
    }
  }, [task, line, dest, needBadge, qty, batch, operator, device, damageNote, queue, applyItem]);

  const closeShort = async () => {
    if (!task || !window.confirm("Close this receipt short? Open lines become short and the supplier is told.")) return;
    const item = await queue.submit({ path: `/v1/tasks/${task.wms_id}/close`, body: { reason: "supplier_short", operator, device }, label: `Close short ${task.source_ref ?? task.title}` });
    if (item.status === "failed") { setError(describeError(item)); return; }
    applyItem(item, (t) => ({ ...t, status: "done", lines: t.lines.map((l) => (l.status === "open" ? { ...l, status: "short" } : l)) }));
  };

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!task) {
    return (
      <Screen>
        <Header eyebrow="Receive · expected" title="Loading…" right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const title = `${task.source_ref ?? task.title}${task.note ? ` · ${task.note}` : ""}`;
  const finished = !line;
  const batchMissing = Boolean(scanned?.batchTracked) && !batch.trim();
  const hint = suggestion ? suggestionHint(suggestion) : null;
  const shelf = dest ?? suggestion?.location ?? "—";

  return (
    <Screen>
      <Header eyebrow="Receive · expected" title={title} right={right} />
      <Main>
        <OfflineBanner />
        <ProgressRow label={finished ? `${total} of ${total} lines` : `Line ${lineIndex} of ${total}`} done={task.progress.done} total={task.progress.total || total} />
        {finished && (
          <DoneCard title={task.status === "done" && task.lines.some((l) => l.status === "short") ? "Receipt closed short" : "All lines received"}>
            <span className="text-sm text-muted">{task.source_ref ?? task.title} is put away. The ledger has every line.</span>
            <Button variant="primary" onClick={() => navigate("/")}>Back to menu</Button>
          </DoneCard>
        )}
        {line && wrong && <WrongScan read={wrong} expected={expected} title={wrong.type === "product" && step === "product" ? "That is a different product" : undefined} onAgain={clear} />}
        {line && !wrong && (
          <>
            <ProductCard
              sku={line.sku} name={line.name}
              pill={<Pill>Expected {fmtQty(line.expected_qty, line.uom)}</Pill>}
              big={scanned ? (qty || scanned.qty || "—") : undefined}
              bigHint={scanned ? (scanned.qty !== null && scanned.fromLabel
                ? `${line.uom} scanned from GS1 label${scanned.batch ? ` · batch ${scanned.batch}` : ""}`
                : `${line.uom} expected · enter what arrived${scanned.batch ? ` · batch ${scanned.batch}` : ""}`) : undefined}
            />
            {!scanned && <ScanHint sub="GS1 fills batch and quantity">Scan the product</ScanHint>}
            {scanned && (
              <>
                {scanned.batchTracked && !scanned.batch && (
                  <Field label="Batch" hint={batchMissing ? "This product is batch tracked · type the batch from the label" : undefined}>
                    <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="Batch" autoCapitalize="characters" className="mono" />
                  </Field>
                )}
                <QtyStepper label="Quantity received" value={qty} onChange={setQty} decimals={allowsDecimals(line.uom)} />
                <BigLocation
                  eyebrow="Put it at" code={shelf} tone={hint?.gold ? "gold" : undefined}
                  hint={dest ? (suggestion && dest === suggestion.location ? `Scanned · ${hint?.text ?? "suggested shelf"}` : "Scanned · your choice, the ledger records it") : hint?.text ?? "Waiting for a suggestion · or scan any shelf"}
                  hint2="Or scan another shelf that allows this product"
                />
                {!needBadge && <ScanHint>{dest ? "Scan another shelf to change it" : "Scan the shelf to confirm"}</ScanHint>}
                {damaged && !needBadge && (
                  <Card className="border-gold-line">
                    <span className="text-sm font-medium text-gold">Damaged on arrival</span>
                    <Field label="What happened (optional)">
                      <Input value={damageNote} onChange={(e) => setDamageNote(e.target.value)} placeholder="Crushed carton, wet, …" />
                    </Field>
                    <Button variant="gold" disabled={!dest || busy || batchMissing} onClick={() => void confirm(undefined, "damaged")}>Confirm as damaged</Button>
                  </Card>
                )}
                {needBadge && <SupervisorCapture sub="Over the tolerance on this line" onBadge={(b) => void confirm(b)}>Supervisor: scan your badge</SupervisorCapture>}
              </>
            )}
            {error && <Notice tone="gold">{error}</Notice>}
            <ScanInput placeholder={scanned ? "Scan the shelf" : "Scan the product"} />
          </>
        )}
      </Main>
      {line && !wrong && (
        <>
          <Footer>
            <Button variant="gold" disabled={!scanned || busy} onClick={() => setDamaged((d) => !d)}>Damaged</Button>
            <Button variant="primary" disabled={!dest || busy || batchMissing || !qty || Boolean(needBadge)} onClick={() => void confirm()}>Confirm receipt</Button>
          </Footer>
          <div className="px-4 pb-3 text-center">
            <button type="button" onClick={() => void closeShort()} className="bg-transparent border-0 text-xs text-muted underline cursor-pointer h-11 px-3">Close short</button>
          </div>
        </>
      )}
    </Screen>
  );
}
