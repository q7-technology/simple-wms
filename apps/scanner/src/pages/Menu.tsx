import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Page, ScanResult, Task, TaskStatus } from "../api/types";
import { useSession } from "../auth/Session";
import { useScanWedge } from "../lib/useScanWedge";
import { Header, Input, Main, Notice, Pill, ScanHint, Screen, Tile } from "../ui";
import { errorText } from "./SignIn";

const LATER = "That task type comes with a later step.";
const STATUS_TEXT: Record<TaskStatus, string> = {
  waiting: "waiting", in_progress: "in progress", needs_supervisor: "needs a supervisor", done: "done", cancelled: "cancelled",
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Where a task opens on the scanner. Only receive and count exist in this build step. */
function taskPath(type: string, id: string): string | null {
  if (type === "receive") return `/receive/${id}`;
  if (type === "count") return `/count/${id}`;
  return null;
}

function TaskPill({ task }: { task: Task }) {
  if (task.status === "needs_supervisor" || task.needs_supervisor) return <Pill tone="warn">Needs a supervisor</Pill>;
  if (task.status === "in_progress") return <Pill tone="info">In progress</Pill>;
  return <Pill>Waiting</Pill>;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  );
}
const ICON = {
  pick: <Icon><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></Icon>,
  production: <Icon><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M17 18h1" /><path d="M12 18h1" /><path d="M7 18h1" /></Icon>,
  receive: <Icon><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></Icon>,
  move: <Icon><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></Icon>,
  count: <Icon><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></Icon>,
  lookup: <Icon><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>,
};

/** A tile for a task type that arrives in a later build step: same shape as Tile, muted, goes nowhere. */
function LaterTile({ label, step, icon }: { label: ReactNode; step: string; icon: ReactNode }) {
  return (
    <div className="card h-24 flex flex-col items-center justify-center gap-1 text-muted text-sm font-medium opacity-60" title={step} aria-disabled="true">
      <span className="text-muted">{icon}</span>
      {label}
      <span className="text-[10px] leading-3 uppercase tracking-wider">{step}</span>
    </div>
  );
}

export function Menu() {
  const { session, device, warehouse, online, queued, idleLeftSeconds, signOut } = useSession();
  const navigate = useNavigate();
  const code = session?.operator.code ?? "";
  const wh = warehouse || session?.warehouses[0] || "";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksState, setTasksState] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    (async () => {
      try {
        const [mine, open] = await Promise.all([
          api.get<Page<Task>>("/v1/tasks", { warehouse: wh, status: "waiting,in_progress", assigned_to: code }),
          api.get<Page<Task>>("/v1/tasks", { warehouse: wh, status: "waiting" }),
        ]);
        const unassigned = open.items.filter((t) => !t.assigned_to && (t.type === "receive" || t.type === "count"));
        const seen = new Set<string>();
        const merged: Task[] = [];
        for (const t of [...mine.items, ...unassigned]) {
          if (seen.has(t.wms_id)) continue;
          seen.add(t.wms_id);
          merged.push(t);
        }
        if (alive) { setTasks(merged.slice(0, 6)); setTasksState("ready"); }
      } catch {
        if (alive) setTasksState("failed");
      }
    })();
    return () => { alive = false; };
  }, [wh, code]);

  const onScan = async (raw: string) => {
    setNotice(null);
    try {
      const r = await api.post<ScanResult>("/v1/scans/parse", { raw, warehouse: wh });
      const res = (r.resolved ?? {}) as Record<string, unknown>;
      const str = (k: string) => (typeof res[k] === "string" ? (res[k] as string) : "");
      switch (r.type) {
        case "location":
          navigate(`/lookup?location=${encodeURIComponent(str("location") || raw)}`);
          return;
        case "product":
          navigate(`/lookup?sku=${encodeURIComponent(str("sku") || raw)}`);
          return;
        case "receipt": {
          const id = str("task_id");
          if (id) navigate(`/receive/${id}`);
          else setNotice(`${str("receipt") || raw} has no receive task yet. The desktop can expect it first.`);
          return;
        }
        case "task": {
          const path = taskPath(str("type"), str("task_id"));
          if (path) navigate(path);
          else setNotice(LATER);
          return;
        }
        default:
          setNotice(r.message ?? `Nothing matches "${raw}". Try a location, product, delivery or production order.`);
      }
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  useScanWedge((code) => { void onScan(code); });

  const openTask = (t: Task) => {
    const path = taskPath(t.type, t.wms_id);
    if (path) navigate(path);
    else setNotice(LATER);
  };

  if (!session) return null;

  const pending = queued > 0 || !online;
  const idleMinutes = idleLeftSeconds > 0 ? Math.ceil(idleLeftSeconds / 60) : session.idle_logout_minutes;

  return (
    <Screen>
      <Header
        back={null}
        eyebrow={`Hi ${firstName(session.operator.name)}`}
        title={`${wh} · ${device || session.device} · ${online ? "online" : "offline"}`}
        right={
          <button type="button" onClick={() => { signOut(); navigate("/sign-in", { replace: true }); }} className="h-11 px-2 -mr-2 bg-transparent border-0 text-brand text-xs font-medium cursor-pointer">
            Sign out
          </button>
        }
      />
      <Main>
        <div className="flex flex-col gap-2">
          <ScanHint sub="A location, product, delivery or production order">Scan anything to start</ScanHint>
          <Input data-scan="true" aria-label="Scan or type a code" placeholder="or type a code and press Enter" autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go" className="mono" />
        </div>

        {notice && <Notice tone="gold">{notice}</Notice>}

        <div className="flex flex-col gap-2">
          <span className="eyebrow text-muted">My tasks</span>
          {tasksState === "loading" && <span className="text-sm leading-5 text-muted">Loading your tasks…</span>}
          {tasksState === "failed" && <Notice tone="gold">Could not load your tasks. Scan a delivery or start one below.</Notice>}
          {tasksState === "ready" && tasks.length === 0 && (
            <span className="text-sm leading-5 text-muted">Nothing waiting for you. Scan a delivery or start a task below.</span>
          )}
          {tasks.length > 0 && (
            <div className="card flex flex-col divide-y divide-line">
              {tasks.map((t) => {
                const total = t.progress.total;
                const line = total ? Math.min(t.progress.done + 1, total) : 0;
                return (
                  <button
                    key={t.wms_id} type="button" onClick={() => openTask(t)}
                    className="min-h-14 px-4 py-3 flex items-center justify-between gap-3 bg-transparent border-0 text-left text-ink cursor-pointer active:bg-brand-tint"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-base leading-6 font-semibold truncate">{t.title}</span>
                      <span className="text-xs leading-4 text-muted">Line {line} of {total} · {STATUS_TEXT[t.status]}</span>
                    </div>
                    <TaskPill task={t} />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="eyebrow text-muted">Start a task</span>
          <div className="grid grid-cols-2 gap-3">
            <LaterTile label="Pick" step="Step 3" icon={ICON.pick} />
            <LaterTile label="Production receipt" step="Step 5" icon={ICON.production} />
            <Tile to="/receive" label="Receive" icon={ICON.receive} />
            <Tile to="/move" label="Move" icon={ICON.move} />
            <Tile to="/count" label="Count" icon={ICON.count} />
            <Tile to="/lookup" label="Look up" icon={ICON.lookup} />
          </div>
        </div>
      </Main>
      <footer className="p-4 border-t border-line shrink-0 flex justify-between gap-3 text-xs leading-4 text-muted">
        <span className={pending ? "text-gold" : undefined}>{queued} queued · {pending ? "sending when back" : "all synced"}</span>
        <span>Idle logout in {idleMinutes} min</span>
      </footer>
    </Screen>
  );
}
