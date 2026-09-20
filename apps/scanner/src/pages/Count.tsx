import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Accepted, Page, ScanResult, Task, TaskLine } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtQty, plural } from "../lib/format";
import { BigLocation, Button, Footer, Header, Main, Notice, Pill, ProductCard, ProgressRow, QtyStepper, ScanHint, Screen } from "../ui";
import {
  DoneCard, OfflineBanner, ScanInput, SupervisorCapture, WrongScan, allowsDecimals, describeError, firstName,
  needsSupervisor, patchLine, sameCode, siteOf, useScanStep, useTask, type Expecting,
} from "./task-shared";

function shelvesOf(task: Task): string[] {
  return Array.from(new Set(task.lines.map((l) => l.from_location ?? "").filter(Boolean)));
}

export function Count() {
  const { taskId } = useParams();
  return taskId ? <CountTask taskId={taskId} /> : <CountList />;
}

/* --- pick a count, or count one shelf now ------------------------------------- */

function CountList() {
  const { session, warehouse, queue, device, online } = useSession();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const operator = session?.operator.code ?? "";

  useEffect(() => {
    api.get<Page<Task>>("/v1/tasks", { warehouse, type: "count", status: "waiting,in_progress,needs_supervisor" })
      .then((p) => setTasks(p.items))
      .catch(() => setError("Could not load the counts · scan a shelf or reconnect"));
  }, [warehouse]);

  const onShelf = useCallback(async (r: ScanResult) => {
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const code = String(resolved.location ?? r.raw).toUpperCase();
    if (!online) { setError("Starting a count needs the connection back, because stock numbers may have changed."); return; }
    const item = await queue.submit({ path: "/v1/counts", body: { warehouse, owner: "DEFAULT", locations: [code], operator, device }, label: `Count ${code}` });
    if (item.status === "sent") navigate(`/count/${(item.reply as Accepted).wms_id}`);
    else if (item.status === "failed") setError(describeError(item));
    else setError("The count is queued · open it from the list once the connection is back.");
  }, [online, queue, warehouse, operator, device, navigate]);

  const { wrong, clear } = useScanStep("location", "shelf to count", (r) => void onShelf(r));

  return (
    <Screen>
      <Header eyebrow="Cycle count" title="Choose a count" right={`${firstName(session?.operator.name)} · ${siteOf(warehouse)}`} />
      <Main>
        <OfflineBanner />
        {wrong ? <WrongScan read={wrong} expected="shelf to count" onAgain={clear} /> : (
          <>
            <ScanHint sub="Raises a blind count of that shelf and opens it">Scan a shelf to count it now</ScanHint>
            <ScanInput placeholder="Shelf code" />
            {error && <Notice tone="gold">{error}</Notice>}
            <div className="flex flex-col gap-2">
              {tasks.map((t) => (
                <Link key={t.wms_id} to={`/count/${t.wms_id}`} className="card p-4 flex items-center justify-between gap-3 no-underline text-ink min-h-14 active:bg-brand-tint">
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold truncate">Count {t.source_ref ?? t.title} · {plural(shelvesOf(t).length, "shelf", "shelves")}</span>
                    <span className="text-xs leading-4 text-muted">{t.progress.done} of {t.progress.total} lines</span>
                  </span>
                  <Pill tone={t.status === "needs_supervisor" ? "warn" : t.status === "in_progress" ? "info" : "muted"}>
                    {t.status === "needs_supervisor" ? "Needs supervisor" : t.status === "in_progress" ? "In progress" : "Waiting"}
                  </Pill>
                </Link>
              ))}
              {tasks.length === 0 && !error && <span className="text-sm text-muted">No counts waiting.</span>}
            </div>
          </>
        )}
      </Main>
    </Screen>
  );
}

/* --- work a count ----------------------------------------------------------------- */

function CountTask({ taskId }: { taskId: string }) {
  const { session, device, warehouse, queue } = useSession();
  const navigate = useNavigate();
  const { task, line, lineIndex, total, error: loadError, applyItem } = useTask(taskId);
  const operator = session?.operator.code ?? "";

  const [shelf, setShelf] = useState<string | null>(null); // the shelf the operator is standing at
  const [qty, setQty] = useState("");
  const [variance, setVariance] = useState<TaskLine | null>(null);
  const [needBadge, setNeedBadge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const lineNo = line?.line_no;
  useEffect(() => {
    setQty(""); setError(null); setNeedBadge(false);
    setVariance(line && line.status === "variance" ? line : null);
    // a variance parked earlier means the shelf was already scanned
    if (line?.status === "variance") setShelf(line.from_location);
  }, [lineNo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!task || task.status !== "waiting" || started.current) return;
    started.current = true;
    void queue.submit({ path: `/v1/tasks/${task.wms_id}/start`, body: { operator, device }, label: `Start count ${task.source_ref ?? task.title}` })
      .then((item) => applyItem(item, (t) => ({ ...t, status: "in_progress", assigned_to: operator })));
  }, [task, queue, operator, device, applyItem]);

  const atShelf = Boolean(line && shelf && sameCode(shelf, line.from_location));

  const onShelf = useCallback((r: ScanResult) => {
    if (!line) return;
    const resolved = (r.resolved ?? {}) as Record<string, unknown>;
    const code = String(resolved.location ?? r.raw).toUpperCase();
    if (!sameCode(code, line.from_location)) {
      setWrong({ raw: r.raw, type: "location", format: r.format, code, message: r.message });
      return;
    }
    setShelf(line.from_location);
    setQty("");
  }, [line]);

  const step: Expecting = !line ? null : needBadge ? "badge" : atShelf ? null : "location";
  const expected = line ? `shelf ${line.from_location ?? ""}`.trim() : "shelf";
  const { wrong, setWrong, clear } = useScanStep(step, expected, (r) => {
    if (step === "badge") void approve(String(((r.resolved ?? {}) as Record<string, unknown>).badge ?? r.raw));
    else onShelf(r);
  });

  const submit = async () => {
    if (!task || !line || qty === "") return;
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/confirm`,
        body: { qty, uom: line.uom, operator, device },
        label: `Count ${line.from_location ?? ""} · ${line.sku} · ${fmtQty(qty, line.uom)}`,
      });
      if (item.status === "failed") {
        if (needsSupervisor(item)) setNeedBadge(true);
        else setError(describeError(item));
        return;
      }
      const reply = applyItem(item, (t) => patchLine(t, line.line_no, { actual_qty: qty, status: "done" }));
      if (reply?.line && reply.line.status === "variance") setVariance(reply.line);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (badge: string) => {
    if (!task || !line) return;
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({
        path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/approve`,
        body: { reason: "count_variance", note: null, supervisor_badge: badge, operator, device },
        label: `Approve count ${line.from_location ?? ""} · ${line.sku}`,
      });
      if (item.status === "failed") { setError(describeError(item)); return; }
      setNeedBadge(false);
      applyItem(item, (t) => patchLine(t, line.line_no, { status: "done" }));
    } finally {
      setBusy(false);
    }
  };

  const recount = async () => {
    if (!task || !line) return;
    if (!variance) { setQty(""); return; }
    setBusy(true); setError(null);
    try {
      const item = await queue.submit({ path: `/v1/tasks/${task.wms_id}/lines/${line.line_no}/recount`, body: { operator, device }, label: `Recount ${line.from_location ?? ""} · ${line.sku}` });
      if (item.status === "failed") { setError(describeError(item)); return; }
      applyItem(item, (t) => patchLine(t, line.line_no, { status: "open", actual_qty: null, variance: null }));
      setVariance(null); setQty("");
    } finally {
      setBusy(false);
    }
  };

  const right = `${firstName(session?.operator.name)} · ${siteOf(warehouse)}`;
  if (!task) {
    return (
      <Screen>
        <Header eyebrow="Cycle count" title="Loading…" right={right} />
        <Main><OfflineBanner />{loadError && <Notice tone="gold">{loadError}</Notice>}</Main>
      </Screen>
    );
  }

  const shelves = shelvesOf(task);
  const title = shelves.length === 1 ? shelves[0] : `${task.title} · ${plural(shelves.length, "shelf", "shelves")}`;
  const finished = !line;

  return (
    <Screen>
      <Header eyebrow={`Cycle count · ${task.source_ref ?? task.wms_id}`} title={title} right={right} />
      <Main>
        <OfflineBanner />
        <ProgressRow label={finished ? `${total} of ${total} locations` : `Location ${lineIndex} of ${total}`} done={task.progress.done} total={task.progress.total || total} />
        {finished && (
          <DoneCard title="All shelves counted">
            <span className="text-sm text-muted">{task.source_ref ?? task.title} is complete. Variances wait for a supervisor on the desktop.</span>
            <Button variant="primary" onClick={() => navigate("/")}>Back to menu</Button>
          </DoneCard>
        )}
        {line && wrong && <WrongScan read={wrong} expected={expected} title={wrong.type === "location" ? "That is a different shelf" : undefined} onAgain={clear} />}
        {line && !wrong && (
          <>
            <BigLocation eyebrow="Count" code={line.from_location ?? "—"} hint="Blind count · expected quantity is hidden" hint2={atShelf ? "Scanned · count everything of this product on the shelf" : undefined} />
            {!atShelf && <ScanHint>Scan the shelf to start</ScanHint>}
            {atShelf && (
              <>
                <ProductCard
                  sku={line.sku} name={line.name}
                  pill={line.batch ? <Pill>Batch {line.batch}</Pill> : undefined}
                  big={variance ? fmtQty(variance.actual_qty) : qty || "0"} bigHint={`${line.uom} counted`}
                />
                {!variance && <QtyStepper label="Quantity on shelf" value={qty} onChange={setQty} decimals={allowsDecimals(line.uom)} />}
                {variance && (
                  <>
                    <Notice tone="gold">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">Differs from expected · variance {fmtQty(variance.variance, line.uom)}</span>
                        <span className="text-xs leading-4 text-muted">Recount, or submit and a supervisor decides</span>
                      </div>
                    </Notice>
                    <SupervisorCapture sub="Approving writes one adjustment to the ledger" onBadge={(b) => void approve(b)}>Supervisor: scan your badge to approve</SupervisorCapture>
                  </>
                )}
                {needBadge && !variance && <SupervisorCapture sub="This count needs a supervisor" onBadge={(b) => void approve(b)}>Supervisor: scan your badge to approve</SupervisorCapture>}
              </>
            )}
            {error && <Notice tone="gold">{error}</Notice>}
            {!atShelf && <ScanInput placeholder="Scan the shelf" />}
          </>
        )}
      </Main>
      {line && !wrong && (
        <Footer>
          <Button variant="quiet" disabled={!atShelf || busy} onClick={() => void recount()}>Recount</Button>
          <Button variant="primary" disabled={!atShelf || busy || qty === "" || Boolean(variance) || needBadge} onClick={() => void submit()}>Submit count</Button>
        </Footer>
      )}
    </Screen>
  );
}
