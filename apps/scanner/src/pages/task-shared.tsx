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
import { Button, Card, Input, Notice, ScanHint, SupervisorPanel } from "../ui";

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
      <Card className="border-gold-line gap-2.5">
        <div className="flex items-center gap-3">
          <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f7941d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
          <span className="text-xl leading-7 font-bold text-gold">{heading}</span>
        </div>
        <span className="text-sm leading-5">You scanned {read.code ?? read.raw}. This step wants the {expected}.</span>
        <div className="flex flex-col gap-1 p-3 rounded-lg border border-line">
          <span className="text-xs leading-4 text-muted">What the scanner read</span>
          <span className="mono text-sm leading-5 break-all">{read.raw}</span>
          <span className="text-xs leading-4 text-muted">format: {read.format} · type: {typeName}</span>
        </div>
      </Card>
      <ScanHint sub="GS1, QR or the plain SKU all work here">Scan the {expected} to continue</ScanHint>
      <span className="text-xs leading-4 text-muted">Unknown codes are kept with their raw text so a new pattern can be added on the desktop.</span>
      <Button variant="quiet" onClick={onAgain}>Scan again</Button>
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
    <div className="flex flex-col gap-2">
      <Notice tone="gold">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-gold shrink-0" />
          <div className="flex flex-col gap-0.5 grow min-w-0">
            <span className="font-medium">{online ? `Back online · sending ${queued} queued` : "Wi-Fi dropped · working from memory"}</span>
            <span className="text-xs leading-4 text-muted">{plural(queued, "confirmation")} queued · will send when back</span>
          </div>
        </div>
      </Notice>
      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="eyebrow text-muted">Queued to send</span>
          <div className="flex flex-col rounded-lg border border-line">
            {recent.map((item) => (
              <div key={item.id} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 border-b border-line-soft last:border-b-0">
                <span className="truncate">{item.label}</span>
                <span className={item.status === "sent" ? "text-muted shrink-0" : "text-gold shrink-0"}>{item.status} {fmtWhen(item.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {queued > 0 && <Button variant="quiet" onClick={() => void queue.drain()}>Retry now</Button>}
      <span className="text-xs leading-4 text-muted">You can finish this task. Starting a new one needs the connection back, because stock numbers may have changed.</span>
    </div>
  );
}

/* --- SupervisorCapture ----------------------------------------------------------- */

/** The dashed gold panel plus a badge field. The field is marked
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
    <div className="flex flex-col gap-2">
      <SupervisorPanel sub={sub}>{children}</SupervisorPanel>
      <Input data-scan="badge" aria-label="Supervisor badge" placeholder="Supervisor badge" autoComplete="off" autoFocus className="mono" onKeyDown={onKey} />
    </div>
  );
}

/* --- task list rows -------------------------------------------------------------- */

export function DoneCard({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <Card strong>
      <span className="text-xl leading-7 font-bold">{title}</span>
      {children}
    </Card>
  );
}
