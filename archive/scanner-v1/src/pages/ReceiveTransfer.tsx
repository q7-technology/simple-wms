/** Receive transfer: leg two of a warehouse-to-warehouse move. The stock is
 * already on hand here, sitting in the in-transit bucket; this takes it out
 * of the bucket and onto a real shelf. Anything short stays in the bucket
 * until someone closes the transfer on the desktop. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Page, ScanResult, Task, TaskLine } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty } from "../lib/format";
import { BigLocation, Button, Card, Footer, Header, Main, Notice, Pill, ProductCard, ProgressRow, QtyStepper, ScanHint, Screen } from "../ui";
import {
  DoneCard, OfflineBanner, ScanInput, WrongScan, allowsDecimals, describeError, firstName,
  patchLine, siteOf, useScanStep, useTask, type Expecting,
} from "./task-shared";

/** What is still to receive on this line. */
function outstanding(line: TaskLine): string {
  const left = Number(line.expected_qty ?? 0) - Number(line.actual_qty ?? 0);
  return String(Math.max(0, Math.round(left * 1000) / 1000));
}

function wasShort(line: TaskLine): boolean {
  return line.status !== "open" && Number(line.actual_qty ?? 0) < Number(line.expected_qty ?? 0);
}

export function ReceiveTransfer() {
  const { taskId } = useParams();
  return taskId ? <TransferTask taskId={taskId} /> : <TransferList />;
}

/* --- choose a transfer ----------------------------------------------------- */

function TransferList() {
  const { session, warehouse } = useSession();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<Task>>("/v1/tasks", { warehouse, type: "transfer_receive", status: "waiting,in_progress" })
      .then((p) => setTasks(p.items))
      .catch(() => setError("Could not load the transfers · scan a transfer reference or reconnect"));
  }, [warehouse]);

  const onScan = useCallback((r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const id = (resolved.task_id ?? (r.type === "task" ? resolved.wms_id : undefined)) as string | undefined;
    if (id) { navigate(`/transfer-in/${id}`); return; }
    const ref = String(resolved.external_ref ?? resolved.source_ref ?? r.raw).toUpperCase();
    const hit = tasks.find((t) => (t.source_ref ?? "").toUpperCase() === ref);
    if (hit) navigate(`/transfer-in/${hit.wms_id}`);
    else setError(`No transfer waiting for ${ref}`);
  }, [navigate, tasks]);

  const { wrong, clear } = useScanStep("task", "transfer reference", onScan);

  return (
    <Screen>
      <Header eyebrow="Receive transfer" title="Choose a transfer" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        {wrong ? <WrongScan read={wrong} expected="transfer reference" onAgain={clear} /> : (
          <>
            <ScanHint sub="The paperwork's barcode or the transfer number">Scan the transfer reference</ScanHint>
            <ScanInput placeholder="Transfer reference" />
            {error && <Notice tone="gold">{error}</Notice>}
            <div className="flex flex-col gap-2">
              {tasks.map((t) => (
                <Link key={t.wms_id} to={`/transfer-in/${t.wms_id}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold truncate">{t.source_ref ?? t.title}{t.note ? ` · ${t.note}` : ""}</span>
                    <span className="text-xs leading-4 text-muted">{t.progress.done} of {t.progress.total} lines</span>
                  </span>
                  <Pill tone={t.status === "in_progress" ? "info" : "muted"}>{t.status === "in_progress" ? "In progress" : "Waiting"}</Pill>
                </Link>
              ))}
              {tasks.length === 0 && !error && <span className="text-sm text-muted">Nothing in transit to receive.</span>}
            </div>
          </>
        )}
      </Main>
    </Screen>
  );
}

/* --- work a transfer ------------------------------------------------------- */

function TransferTask({ taskId }: { taskId: string }) {
  const { session, device, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const { task, line, lineIndex, total, error: loadError, applyItem } = useTask(taskId);
  const operator = session?.operator.code ?? "";

  const [qty, setQty] = useState("");
  const [dest, setDest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  // a fresh line starts with the whole shipped quantity and no shelf
  const lineNo = line?.line_no;
  useEffect(() => {
    setDest(null); setError(null);
    setQty(line ? outstanding(line) : "");
  }, [lineNo]); // eslint-disable-line react-hooks/exhaustive-deps

  // start the clock the first time a waiting task is opened
  useEffect(() => {
    if (!task || task.status !== "waiting" || started.current) return;
    started.current = true;
    void queue.submit({ path: `/v1/tasks/${task.wms_id}/start`, body: { operator, device }, label: `Start ${task.source_ref ?? task.title}` })
      .then((item) => applyItem(item, (t) => ({ ...t, status: "in_progress", assigned_to: operator })));
  }, [task, queue, operator, device, applyItem]);

  const step: Expecting = line ? "location" : null;
  const { wrong, clear } = useScanStep(step, "shelf", (r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    setDest(String(resolved.location ?? r.raw).toUpperCase());
    setError(null);
  });

  const confirm = async () => {
    if (!task || !line || !dest || qty === "") return;
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/confirm`,
        body: { qty, uom: line.uom, location: dest, operator, device },
        label: `Line ${line.line_no} · ${line.sku} · ${fmtQty(qty, line.uom)}`,
      });
      if (item.status === "failed") { setError(describeError(item)); return; }
      applyItem(item, (t) => patchLine(t, line.line_no, { actual_qty: qty, status: "done", to_location: dest }));
    } finally {
      setBusy(false);
    }
  };

  const closeTask = async () => {
    if (!task || !window.confirm("Close this transfer? What never turned up stays in transit until it is written off on the desktop.")) return;
    const item = await queue.submit({
      path: `/v1/tasks/${task.wms_id}/close`,
      body: { reason: "short off the truck" },
      label: `Close ${task.source_ref ?? task.title}`,
    });
    if (item.status === "failed") { setError(describeError(item)); return; }
    applyItem(item, (t) => ({ ...t, status: "done" }));
    navigate("/");
  };

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!task) {
    return (
      <Screen>
        <Header eyebrow="Receive transfer" title="Loading…" right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const ref = task.source_ref ?? task.title;
  const finished = !line;
  const shipped = line?.expected_qty ?? "0";
  const short = line ? Math.max(0, Math.round((Number(shipped) - (Number(qty) || 0)) * 1000) / 1000) : 0;
  const anyShort = task.lines.some(wasShort);

  return (
    <Screen>
      <Header eyebrow="Receive transfer" title={ref} right={right} />
      <Main>
        <OfflineBanner />
        <ProgressRow label={finished ? `${total} of ${total} lines` : `Line ${lineIndex} of ${total}`} done={task.progress.done} total={task.progress.total || total} />
        {finished && (
          <DoneCard title={anyShort ? "Transfer received short" : "Transfer received"}>
            <span className="text-sm text-muted">
              {anyShort
                ? "Some lines were short. The difference stays in transit until it is closed on the desktop."
                : `${ref} is put away. The ledger has every line.`}
            </span>
            <Button variant="primary" onClick={() => navigate("/")}>Back to menu</Button>
            {anyShort && <Button variant="quiet" onClick={() => void closeTask()}>Close the task</Button>}
            {error && <Notice tone="gold">{error}</Notice>}
          </DoneCard>
        )}
        {line && wrong && <WrongScan read={wrong} expected="shelf" onAgain={clear} />}
        {line && !wrong && (
          <>
            <Card strong>
              <span className="text-xl leading-7 font-bold">Shipped {fmtQty(shipped, line.uom)}</span>
              <span className="text-sm leading-5 text-muted">
                {[task.note, line.batch ? `batch ${line.batch}` : null, "received date kept for FIFO"].filter(Boolean).join(" · ")}
              </span>
            </Card>
            <ProductCard sku={line.sku} name={line.name} pill={line.batch ? <Pill>Batch {line.batch}</Pill> : undefined} />
            <QtyStepper label="Quantity received" value={qty} onChange={setQty} decimals={allowsDecimals(line.uom)} />
            {short > 0 && (
              <Notice tone="gold">
                Short by {fmtQty(String(short), line.uom)} · the difference stays in transit until someone closes it on the desktop.
              </Notice>
            )}
            <BigLocation
              eyebrow="Put it at" code={dest ?? "—"}
              hint={dest ? "Scanned · the ledger records where it really went" : "Scan a shelf that allows this product"}
              hint2="Out of the in-transit bucket and onto the shelf"
            />
            <ScanHint>{dest ? "Scan another shelf to change it" : "Scan the shelf to confirm"}</ScanHint>
            {error && <Notice tone="gold">{error}</Notice>}
            <ScanInput placeholder="Scan the shelf" />
          </>
        )}
      </Main>
      {line && !wrong && (
        <Footer>
          <Button variant="quiet" disabled={busy} onClick={() => navigate("/transfer-in")}>Cancel</Button>
          <Button variant="primary" disabled={busy || !dest || qty === ""} onClick={() => void confirm()}>Confirm</Button>
        </Footer>
      )}
    </Screen>
  );
}
