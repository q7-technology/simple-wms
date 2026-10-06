/** Shared by the scanner task screens (Receive, Move, Count): the task
 * hook, the scan step, the wrong-scan card, the offline banner and the
 * supervisor badge capture. Every write goes through the retry queue so a
 * Wi-Fi drop never loses or doubles a confirmation. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { ScanResult, Task, TaskLine, TaskReply } from "../api/types";
import { useSession } from "../auth/Session";
import { fmtWhen, plural } from "../lib/format";
import type { QueueItem } from "../lib/queue";
import { useScanWedge } from "../lib/useScanWedge";
import { AlertIcon, Button, CheckIcon, Input, Pill, ScanHint, SupervisorPanel, WifiOffIcon } from "../ui";

/* --- small helpers ------------------------------------------------------- */

export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** "BAL-WH01" → "BAL": the site is the first segment of the warehouse code. */
export function siteOf(warehouse: string): string {
  return warehouse.split("-")[0] ?? warehouse;
}

/** Location barcodes may carry a LOC- prefix; codes compare without it. */
export function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/^LOC-/, "");
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Decimals are allowed unless the unit is a plain count. */
export function allowsDecimals(uom: string | null | undefined): boolean {
  return !["EA", "CTN"].includes((uom ?? "").toUpperCase());
}

export function isOpen(line: TaskLine): boolean {
  return line.status === "open" || line.status === "variance";
}

/** A new task with one line patched and the progress recomputed. Used for
 * the optimistic copy while a confirmation waits in the queue. */
export function patchLine(task: Task, lineNo: number, patch: Partial<TaskLine>): Task {
  const lines = task.lines.map((l) => (l.line_no === lineNo ? { ...l, ...patch } : l));
  const done = lines.filter((l) => l.status !== "open").length;
  const stillOpen = lines.some(isOpen);
  return { ...task, lines, progress: { done, total: lines.length }, status: stillOpen ? task.status : "done" };
}

export function describeError(item: QueueItem): string {
  return item.error ?? "The WMS said no";
}

export function needsSupervisor(item: QueueItem): boolean {
  const text = (item.error ?? "").toLowerCase();
  return text.includes("supervisor") || text.includes("tolerance");
}

/* --- useTask ----------------------------------------------------------------- */

export function useTask(taskId: string | undefined) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(taskId));

  const reload = useCallback(async () => {
    if (!taskId) { setTask(null); setLoading(false); return; }
    setLoading(true);
    try {
      const t = await api.get<Task>(`/v1/tasks/${taskId}`);
      setTask(t);
      setError(null);
    } catch (e) {
      // keep whatever is in memory; the screen carries on from it
      setError(e instanceof ApiError ? e.message : "Could not reach the WMS · working from memory");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void reload(); }, [reload]);

  const line = useMemo(() => task?.lines.find(isOpen) ?? null, [task]);
  const total = task?.lines.length ?? 0;
  const lineIndex = line && task ? task.lines.indexOf(line) + 1 : total;

  /** Take the task from a sent reply; when the item is still queued, apply
   * the optimistic patch so the operator can carry on. Returns the reply
   * when there was one. */
  const applyItem = useCallback((item: QueueItem, optimistic?: (t: Task) => Task): TaskReply | null => {
    if (item.status === "sent") {
      const reply = item.reply as Partial<TaskReply> | null;
      if (reply && reply.task) { setTask(reply.task); return reply as TaskReply; }
      return null;
    }
    if (item.status === "queued" && optimistic) setTask((t) => (t ? optimistic(t) : t));
    return null;
  }, []);

  return { task, setTask, reload, line, lineIndex, total, loading, error, applyItem };
}

/* --- scanning ---------------------------------------------------------------- */

export type Expecting = "product" | "location" | "receipt" | "task" | "badge" | null;

export interface WrongRead {
  raw: string;
  type: string;
  format: string;
  code?: string;
  message?: string | null;
}

/** The scan a page is waiting for. `expecting` changes with the step; one
 * wedge listener per page. Offline, the raw text is taken as the code
 * because the task in memory has everything else. */
export function useScanStep(expecting: Expecting, expected: string, onOk: (r: ScanResult) => void) {
  const { warehouse, online, touch } = useSession();
  const [wrong, setWrong] = useState<WrongRead | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ expecting, expected, onOk, online, warehouse });
  latest.current = { expecting, expected, onOk, online, warehouse };

  const handle = useCallback(async (raw: string) => {
    const { expecting, onOk, online, warehouse } = latest.current;
    touch();
    if (!expecting) return;
    const asIs = (type: string): ScanResult => ({
      raw, format: "plain", type, fields: {},
      resolved: type === "location" ? { location: raw.replace(/^LOC-/i, "").toUpperCase() } : type === "badge" ? { badge: raw } : { sku: raw },
      matches_expected: true, message: null,
    });
    if (expecting === "badge") { onOk(asIs("badge")); return; }
    if (!online) { setWrong(null); onOk(asIs(expecting)); return; }
    setBusy(true);
    try {
      const r = await api.post<ScanResult>("/v1/scans/parse", { raw, warehouse, expecting });
      const ok = r.matches_expected ?? r.type === expecting;
      if (ok) { setWrong(null); onOk(r); }
      else {
        const resolved = (r.resolved ?? {}) as Record<string, unknown>;
        const code = (resolved.location ?? resolved.sku ?? resolved.code ?? resolved.external_ref) as string | undefined;
        setWrong({ raw, type: r.type, format: r.format, code, message: r.message });
      }
    } catch (e) {
      if (e instanceof ApiError) setWrong({ raw, type: "unknown", format: "plain", message: e.message });
      else { setWrong(null); onOk(asIs(expecting)); } // network gone mid-scan: same as offline
    } finally {
      setBusy(false);
    }
  }, [touch]);

  useScanWedge(handle);
  const clear = useCallback(() => setWrong(null), []);
  return { wrong, setWrong, clear, busy };
}

/** The one text field a keyboard-wedge scanner (or a tester) types into. */
export function ScanInput({ placeholder = "Scan or type a code", label = "Scan" }: { placeholder?: string; label?: string }) {
  return <Input data-scan="true" aria-label={label} placeholder={placeholder} autoComplete="off" autoCapitalize="characters" className="mono" />;
}

/* --- WrongScan --------------------------------------------------------------- */

const TYPE_NAMES: Record<string, string> = {
  product: "product", location: "location", container: "container", production_order: "production order",
  operator: "badge", receipt: "receipt", task: "task", unknown: "code",
};

export function WrongScan({ read, expected, title, onAgain }: { read: WrongRead; expected: string; title?: ReactNode; onAgain: () => void }) {
  const typeName = TYPE_NAMES[read.type] ?? read.type;
  const heading = title ?? (read.type === "unknown" ? "That code is unknown" : `That is a ${typeName}`);
  return (
    <>
      <section role="alert" className="p-4 rounded-[18px] bg-bad-tint text-bad-ink flex flex-col gap-2.5 shrink-0">
        <div className="flex items-center gap-2.5">
          <AlertIcon size={28} />
          <span className="text-[22px] leading-7 font-extrabold">{heading}</span>
        </div>
        <span className="text-[15px] leading-[22px] font-semibold text-ink">You scanned {read.code ?? read.raw}. This step wants the {expected}.</span>
        <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl bg-card text-ink">
          <span className="text-xs leading-4 font-bold text-faint">What the scanner read</span>
          <span className="mono text-base leading-6 font-bold break-all">{read.raw}</span>
          <div className="flex gap-1.5 flex-wrap">
            <Pill tone="info">Format: {read.format}</Pill>
            <Pill tone="info">Type: {typeName}</Pill>
          </div>
        </div>
      </section>
      <ScanHint sub="GS1, QR or the plain SKU all work here">Scan the {expected} to continue</ScanHint>
      <span className="text-xs leading-4 text-faint">Unknown codes are kept with their raw text so a new pattern can be added on the desktop.</span>
      <Button variant="primary" className="shrink-0" onClick={onAgain}>Scan again</Button>
    </>
  );
}

/* --- OfflineBanner ------------------------------------------------------------- */

export function OfflineBanner() {
  const { online, queued, queue } = useSession();
  const [, bump] = useState(0);
  useEffect(() => queue.subscribe(() => bump((n) => n + 1)), [queue]);
  if (online && queued === 0) return null;
  const recent = queue.all().slice(0, 3);
  return (
    <div className="flex flex-col gap-2.5 shrink-0">
      <div role="status" className="flex items-center gap-3 px-3.5 py-3 rounded-2xl bg-warn-tint text-warn-ink">
        <WifiOffIcon />
        <div className="flex flex-col grow min-w-0">
          <span className="text-[15px] leading-5 font-extrabold">{online ? `Back online · sending ${queued} queued` : "Wi-Fi dropped · working from memory"}</span>
          <span className="text-xs leading-4 font-semibold">{plural(queued, "confirmation")} queued · will send when back</span>
        </div>
      </div>
      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="eyebrow text-muted">Queued to send</span>
          <div className="flex flex-col rounded-2xl bg-card border border-line overflow-hidden">
            {recent.map((item) => (
              <div key={item.id} className="flex justify-between items-center gap-3 px-3.5 py-2.5 text-sm leading-5 font-bold border-b border-line last:border-b-0">
                <span className="truncate">{item.label}</span>
                <Pill tone={item.status === "sent" ? "ok" : item.status === "failed" ? "bad" : "warn"}>{item.status} {fmtWhen(item.created_at)}</Pill>
              </div>
            ))}
          </div>
        </div>
      )}
      {queued > 0 && <Button variant="quiet" onClick={() => void queue.drain()}>Retry now</Button>}
      <span className="text-xs leading-4 text-faint">You can finish this task. Starting a new one needs the connection back, because stock numbers may have changed.</span>
    </div>
  );
}

/* --- SupervisorCapture ----------------------------------------------------------- */

/** The supervisor's badge box plus a badge field. The field is marked
 * data-scan="badge" so the page's wedge listener leaves it alone and the
 * badge only ever lands here. */
export function SupervisorCapture({ onBadge, sub, children }: { onBadge: (badge: string) => void; sub?: ReactNode; children?: ReactNode }) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const value = e.currentTarget.value.trim();
    if (!value) return;
    e.preventDefault();
    e.currentTarget.value = "";
    onBadge(value);
  };
  return (
    <div className="flex flex-col gap-2 shrink-0">
      <SupervisorPanel sub={sub}>{children}</SupervisorPanel>
      <Input data-scan="badge" aria-label="Supervisor badge" placeholder="Supervisor badge" autoComplete="off" autoFocus className="mono" onKeyDown={onKey} />
    </div>
  );
}

/* --- task list rows -------------------------------------------------------------- */

export function DoneCard({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <section className="card p-4 flex flex-col gap-2.5 shrink-0">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="w-11 h-11 shrink-0 rounded-full bg-ok-tint text-ok grid place-items-center"><CheckIcon size={24} /></span>
        <span className="text-xl leading-7 font-extrabold">{title}</span>
      </div>
      {children}
    </section>
  );
}

/** A row on a task-choosing list: what it is, a line under it, a status pill. */
export const LIST_ROW = "min-h-14 px-4 py-3 rounded-2xl bg-card border border-line shadow-soft flex items-center justify-between gap-3 no-underline text-ink active:bg-brand-tint shrink-0";
