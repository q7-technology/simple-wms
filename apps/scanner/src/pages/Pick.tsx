import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Page, ScanResult, ShortReason, Task, TaskLine } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty, plural } from "../lib/format";
import type { QueueItem } from "../lib/queue";
import { BigLocation, Button, Card, Footer, Header, Main, Notice, Pill, ProductCard, ProgressRow, QtyStepper, ScanHint, Screen } from "../ui";
import {
  DoneCard, OfflineBanner, ScanInput, SupervisorCapture, WrongScan, allowsDecimals, describeError, firstName,
  needsSupervisor, patchLine, sameCode, siteOf, useScanStep, useTask, type Expecting,
} from "./task-shared";

const REASONS: { reason: ShortReason; label: string }[] = [
  { reason: "not_found", label: "Not found on the shelf" },
  { reason: "short_on_shelf", label: "Fewer here than the system says" },
  { reason: "damaged", label: "Damaged" },
  { reason: "location_unreadable", label: "Cannot read the shelf label" },
  { reason: "customer_cancelled", label: "Customer cancelled the line" },
];

/** The first three raise a high-priority count for the shelf: the shelf and
 * the system disagree. An unreadable label raises none. (docs/api.md) */
const RAISES_COUNT: ShortReason[] = ["not_found", "short_on_shelf", "damaged"];

function whatHappens(reason: ShortReason | null, shelf: string): string {
  if (!reason) return "A short pick always needs a supervisor badge. The rest of the line goes back to stock.";
  if (RAISES_COUNT.includes(reason)) return `This raises a count for ${shelf}, because the shelf and the system disagree. The order may ship short.`;
  if (reason === "location_unreadable") return "This removes the line and raises no count. Fix the label on the desktop.";
  return "The line closes and the reservation goes back to stock. No count is raised.";
}

/** What is still to pick on this line. */
function outstanding(line: TaskLine): string {
  const left = Number(line.expected_qty ?? 0) - Number(line.actual_qty ?? 0);
  return String(Math.max(0, Math.round(left * 1000) / 1000));
}

/** The queue only keeps the message, so the status is read from it. */
function shortError(item: QueueItem): string {
  const text = describeError(item);
  if (/403|forbidden|not a supervisor/i.test(text)) return "That badge is not a supervisor here";
  return text;
}

export function Pick() {
  const { taskId } = useParams();
  return taskId ? <PickTask taskId={taskId} /> : <PickList />;
}

/* --- pick an order --------------------------------------------------------- */

function PickList() {
  const { session, warehouse } = useSession();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<Task>>("/v1/tasks", { warehouse, type: "pick", status: "waiting,in_progress" })
      .then((p) => setTasks(p.items))
      .catch(() => setError("Could not load the picks · scan a delivery reference or reconnect"));
  }, [warehouse]);

  const onScan = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const id = (resolved.task_id ?? (r.type === "task" ? resolved.wms_id : undefined)) as string | undefined;
    if (id) { navigate(`/pick/${id}`); return; }
    const ref = String(resolved.external_ref ?? resolved.source_ref ?? resolved.delivery ?? r.raw).toUpperCase();
    const hit = tasks.find((t) => (t.source_ref ?? "").toUpperCase() === ref);
    if (hit) navigate(`/pick/${hit.wms_id}`);
    else setError(`No open pick for ${ref}`);
  }, [navigate, tasks]);

  const { wrong, clear } = useScanStep("task", "delivery reference", onScan);

  return (
    <Screen>
      <Header eyebrow="Pick · single" title="Choose an order" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        {wrong ? <WrongScan read={wrong} expected="delivery reference" onAgain={clear} /> : (
          <>
            <ScanHint sub="The pick slip's barcode or the order number">Scan the delivery reference</ScanHint>
            <ScanInput placeholder="Delivery reference" />
            {error && <Notice tone="gold">{error}</Notice>}
            <div className="flex flex-col gap-2">
              {tasks.map((t) => (
                <Link key={t.wms_id} to={`/pick/${t.wms_id}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold truncate">Pick {t.source_ref ?? t.title}</span>
                    <span className="text-xs leading-4 text-muted truncate">{[t.note, plural(t.progress.total, "line")].filter(Boolean).join(" · ")}</span>
                  </span>
                  <Pill tone={t.status === "in_progress" ? "info" : "muted"}>{t.status === "in_progress" ? "In progress" : "Waiting"}</Pill>
                </Link>
              ))}
              {tasks.length === 0 && !error && <span className="text-sm text-muted">Nothing waiting to be picked.</span>}
            </div>
          </>
        )}
      </Main>
    </Screen>
  );
}

/* --- work an order --------------------------------------------------------- */

function PickTask({ taskId }: { taskId: string }) {
  const { session, device, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const { task, line, lineIndex, total, error: loadError, applyItem } = useTask(taskId);
  const operator = session?.operator.code ?? "";

  const [shelf, setShelf] = useState<string | null>(null); // the shelf, once scanned
  const [gotProduct, setGotProduct] = useState(false);
  const [qty, setQty] = useState("");
  const [shorting, setShorting] = useState(false);
  const [reason, setReason] = useState<ShortReason | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const [countRaised, setCountRaised] = useState<string | null>(null); // survives the move to the next line
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  // a fresh line starts back at the shelf
  const lineNo = line?.line_no;
  useEffect(() => {
    setShelf(null); setGotProduct(false); setShorting(false); setReason(null); setBadge(null); setError(null);
    setQty(line ? outstanding(line) : "");
  }, [lineNo]); // eslint-disable-line react-hooks/exhaustive-deps

  // start the clock the first time a waiting task is opened
  useEffect(() => {
    if (!task || task.status !== "waiting" || started.current) return;
    started.current = true;
    void queue.submit({ path: `/v1/tasks/${task.wms_id}/start`, body: { operator, device }, label: `Start pick ${task.source_ref ?? task.title}` })
      .then((item) => applyItem(item, (t) => ({ ...t, status: "in_progress", assigned_to: operator })));
  }, [task, queue, operator, device, applyItem]);

  const onShelf = useCallback((r: ScanResult) => {
    if (!line) return;
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const code = String(resolved.location ?? r.raw).toUpperCase();
    if (!sameCode(code, line.from_location)) {
      setWrong({ raw: r.raw, type: "location", format: r.format, code, message: r.message });
      return;
    }
    setShelf(line.from_location);
    setError(null);
  }, [line]);

  const onProduct = useCallback((r: ScanResult) => {
    if (!line) return;
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const sku = String(resolved.sku ?? "").toUpperCase();
    if (sku !== line.sku.toUpperCase()) {
      setWrong({ raw: r.raw, type: "product", format: r.format, code: sku || r.raw, message: r.message });
      return;
    }
    setGotProduct(true);
    setError(null);
  }, [line]);

  const step: Expecting = !line ? null : shorting ? "badge" : shelf ? "product" : "location";
  const expected = step === "product" && line ? `product barcode for ${line.sku}` : step === "badge" ? "supervisor badge" : `shelf ${line?.from_location ?? ""}`.trim();
  const { wrong, setWrong, clear } = useScanStep(step, expected, (r) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    if (step === "badge") setBadge(String(resolved.badge ?? r.raw));
    else if (step === "product") onProduct(r);
    else onShelf(r);
  });

  const confirm = async () => {
    if (!task || !line || qty === "") return;
    setBusy(true); setError(null); setCountRaised(null);
    try {
      const item = await queue.submit({
        path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/confirm`,
        body: { qty, uom: line.uom, operator, device },
        label: `Line ${line.line_no} · ${line.sku} · ${fmtQty(qty, line.uom)}`,
      });
      if (item.status === "failed") { setError(describeError(item)); return; }
      applyItem(item, (t) => patchLine(t, line.line_no, { actual_qty: qty, status: "done" }));
    } finally {
      setBusy(false);
    }
  };

  const confirmShort = async () => {
    if (!task || !line || !reason || !badge) return;
    setBusy(true); setError(null); setCountRaised(null);
    try {
      const item = await queue.submit({
        path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/short`,
        body: { qty, reason, supervisor_badge: badge, operator, device, note: null },
        label: `Short line ${line.line_no} · ${line.sku} · ${fmtQty(qty, line.uom)}`,
      });
      if (item.status === "failed") {
        setBadge(null);
        setError(needsSupervisor(item) ? describeError(item) : shortError(item));
        return;
      }
      if (RAISES_COUNT.includes(reason)) setCountRaised(line.from_location ?? "that shelf");
      setShorting(false);
      applyItem(item, (t) => patchLine(t, line.line_no, { actual_qty: qty, status: "short", reason }));
    } finally {
      setBusy(false);
    }
  };

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!task) {
    return (
      <Screen>
        <Header eyebrow="Pick · single" title="Loading…" right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const ref = task.source_ref ?? task.title;
  const finished = !line;
  const left = line ? outstanding(line) : "0";
  const missing = String(Math.max(0, Number(left) - (Number(qty) || 0)));
  const atShelf = line?.from_location ?? "the shelf";

  return (
    <Screen>
      <Header
        eyebrow={shorting && line ? `Short pick · line ${line.line_no}` : "Pick · single"}
        title={shorting && line ? `${ref} · ${line.sku}` : ref}
        right={right}
      />
      <Main>
        <OfflineBanner />
        <ProgressRow label={finished ? `${total} of ${total} lines` : `Line ${lineIndex} of ${total}`} done={task.progress.done} total={task.progress.total || total} />
        {countRaised && <Notice tone="gold">A count for {countRaised} has been raised</Notice>}
        {finished && (
          <DoneCard title="All lines picked">
            <span className="text-sm text-muted">{ref} is in the packing area. The ledger has every line.</span>
            <Button variant="primary" onClick={() => navigate(`/pack/${task.source_ref ?? ""}`)}>Pack this order</Button>
            <Button variant="quiet" onClick={() => navigate("/")}>Back to menu</Button>
          </DoneCard>
        )}
        {line && wrong && (
          <WrongScan
            read={wrong} expected={expected}
            title={wrong.type === "location" && step === "product" ? "That is a shelf, not the product" : wrong.type === "product" && step === "product" ? "That is a different product" : wrong.type === "location" ? "That is a different shelf" : undefined}
            onAgain={clear}
          />
        )}
        {line && !wrong && !shorting && (
          <>
            <BigLocation
              eyebrow="Go to" code={line.from_location ?? "—"}
              hint={`Walk order · line ${lineIndex} of ${total}`}
              hint2={shelf ? "Scanned · take the stock from this shelf" : "Scan the shelf label when you get there"}
            />
            <ProductCard
              sku={line.sku} name={line.name}
              pill={line.batch ? <Pill>Batch {line.batch}</Pill> : undefined}
              big={left} bigHint={`${line.uom} to pick`}
            />
            {shelf && !gotProduct && <ScanHint sub="GS1, QR or the plain SKU all work here">Scan the product to confirm</ScanHint>}
            {!shelf && <ScanHint sub="Then the product · one GS1 code fills batch and quantity">Scan the shelf to start</ScanHint>}
            <QtyStepper label="Quantity picked" value={qty} onChange={setQty} decimals={allowsDecimals(line.uom)} />
            {error && <Notice tone="gold">{error}</Notice>}
            <ScanInput placeholder={shelf ? "Scan the product" : "Scan the shelf"} />
          </>
        )}
        {line && !wrong && shorting && (
          <>
            <Card strong>
              <span className="text-xl leading-7 font-bold">Picked {fmtQty(qty || "0")} of {fmtQty(left)}</span>
              <span className="text-sm leading-5 text-muted">{fmtQty(missing, line.uom)} missing from {atShelf}</span>
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
            <span className="text-xs leading-4 text-muted">{whatHappens(reason, atShelf)}</span>
            <SupervisorCapture sub="A short pick always needs one" onBadge={(b) => { setBadge(b); setError(null); }}>Supervisor: scan your badge</SupervisorCapture>
            {badge && <span className="text-xs leading-4 text-muted">Badge <span className="mono">{badge}</span> ready · confirm to send</span>}
            {error && <Notice tone="gold">{error}</Notice>}
          </>
        )}
      </Main>
      {line && !wrong && !shorting && (
        <Footer>
          <Button variant="gold" disabled={busy} onClick={() => { setShorting(true); setError(null); }}>Short</Button>
          <Button variant="primary" disabled={busy || !shelf || !gotProduct || qty === ""} onClick={() => void confirm()}>Confirm pick</Button>
        </Footer>
      )}
      {line && !wrong && shorting && (
        <Footer>
          <Button variant="quiet" disabled={busy} onClick={() => { setShorting(false); setError(null); }}>Back</Button>
          <Button variant="primary" disabled={busy || !reason || !badge} onClick={() => void confirmShort()}>Confirm short</Button>
        </Footer>
      )}
    </Screen>
  );
}
