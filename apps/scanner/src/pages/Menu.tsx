import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Page, ScanResult, Task, TaskStatus } from "../api/types";
import { useSession } from "../auth/Session";
import { useScanWedge } from "../lib/useScanWedge";
import { fmtClock, initials } from "../lib/format";
import { Button, CheckIcon, DeviceChip, Icon, Input, Notice, Pill, ScanIcon, Screen, Tile, WifiOffIcon, cx } from "../ui";
import { errorText } from "./SignIn";

const LATER = "That task type comes with a later step.";
const STATUS_TEXT: Record<TaskStatus, string> = {
  waiting: "waiting", in_progress: "in progress", needs_supervisor: "needs a supervisor", done: "done", cancelled: "cancelled",
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Where a task opens on the scanner. Packing is worked by delivery reference. */
function taskPath(type: string, id: string, ref?: string): string | null {
  if (type === "receive") return `/receive/${id}`;
  if (type === "count") return `/count/${id}`;
  if (type === "pick") return `/pick/${id}`;
  if (type === "pack") return ref ? `/pack/${ref}` : null;
  if (type === "transfer_receive") return `/transfer-in/${id}`;
  if (type === "production_issue") return `/pick/${id}`; // a production issue is picked like any other pick
  return null;
}

function TaskPill({ task }: { task: Task }) {
  if (task.status === "needs_supervisor" || task.needs_supervisor) return <Pill tone="warn">Needs a supervisor</Pill>;
  if (task.status === "in_progress") return <Pill tone="info">In progress</Pill>;
  return <Pill>Waiting</Pill>;
}

const TILE_ICON = (d: string) => <Icon><path d={d} /></Icon>;
const ICON = {
  pick: TILE_ICON("M5 4h14v4H5ZM6 8v12h12V8M10 12h4"),
  pack: TILE_ICON("M12 3 20 7.5v9L12 21 4 16.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9"),
  sort: TILE_ICON("M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM13 13h7v7h-7Z"),
  receive: TILE_ICON("M12 4v11M7 10l5 5 5-5M5 20h14"),
  production: TILE_ICON("M3 20V10l6 4V10l6 4V6h6v14ZM3 20h18"),
  transfer: TILE_ICON("M2 9V6a2 2 0 0 1 2-2h11v11H2M15 8h3.5l3.5 4.5V17h-2M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 18h7"),
  move: TILE_ICON("M5 12h14M13 6l6 6-6 6"),
  count: TILE_ICON("M9 5h10M9 12h10M9 19h10M4 5h1M4 12h1M4 19h1"),
  lookup: TILE_ICON("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4"),
};

/** The coloured bar on a task row: where in the warehouse the work is. */
function taskBar(type: string): string {
  if (type === "receive" || type === "transfer_receive") return "bg-brand";
  if (type === "count" || type === "move") return "bg-[#1B8A7E]";
  return "bg-[#E07A1F]";
}

/** When the idle logout lands if nobody touches the scanner from now on. */
export function signOutAt(now: number, idleLeftSeconds: number, idleMinutes: number): Date {
  const left = idleLeftSeconds > 0 ? idleLeftSeconds : idleMinutes * 60;
  return new Date(now + left * 1000);
}

export function Menu() {
  const { session, device, warehouse, online, queued, idleLeftSeconds, signOut } = useSession();
  const [asking, setAsking] = useState(false);
  const askId = useId();
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
          const path = taskPath(str("type"), str("task_id"), str("source_ref") || str("external_ref") || undefined);
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
    const path = taskPath(t.type, t.wms_id, t.source_ref ?? undefined);
    if (path) navigate(path);
    else setNotice(LATER);
  };

  if (!session) return null;

  const pending = queued > 0 || !online;
  const first = firstName(session.operator.name);
  const outAt = fmtClock(signOutAt(Date.now(), idleLeftSeconds, session.idle_logout_minutes));
  const switchWorker = () => { setAsking(false); signOut(); navigate("/sign-in", { replace: true }); };

  return (
    <Screen>
      <header className="px-5 pt-5 pb-1 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span aria-hidden="true" className="w-11 h-11 shrink-0 rounded-full bg-brand text-white grid place-items-center font-extrabold">{initials(session.operator.name)}</span>
          <div className="flex flex-col min-w-0">
            <span className="text-lg leading-6 font-extrabold truncate">Hi, {first}</span>
            <span className="flex items-center gap-1.5 text-xs leading-4 text-muted font-semibold">
              <span aria-hidden="true" className={cx("w-2 h-2 rounded-full shrink-0", online ? "bg-ok-fill" : "bg-gold")} />
              <span>{wh} · {online ? "online" : "offline"}</span>
            </span>
          </div>
        </div>
        <DeviceChip>{device || session.device}</DeviceChip>
      </header>

      <main className="grow min-h-0 px-5 pt-2 flex flex-col gap-3">
        <section className="shrink-0 p-3 rounded-[18px] border-2 border-dashed border-brand bg-card flex flex-col gap-2.5">
          <div className="flex items-center gap-3.5">
            <span className="w-12 h-12 shrink-0 rounded-[14px] bg-brand text-white grid place-items-center"><ScanIcon /></span>
            <div className="flex flex-col min-w-0">
              <span className="text-lg leading-6 font-extrabold">Scan anything to start</span>
              <span className="text-xs leading-4 text-muted">A location, product, delivery or production order</span>
            </div>
          </div>
          <Input data-scan="true" aria-label="Scan or type a code" placeholder="or type a code and press Enter" autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go" className="mono" />
        </section>

        {notice && <Notice tone="gold">{notice}</Notice>}

        <section aria-label="My tasks" className="grow min-h-0 flex flex-col gap-2">
          <span className="eyebrow text-faint shrink-0">My tasks</span>
          <div className="grow min-h-0 overflow-y-auto flex flex-col gap-2">
            {tasksState === "loading" && <span className="text-sm leading-5 text-muted">Loading your tasks…</span>}
            {tasksState === "failed" && <Notice tone="gold">Could not load your tasks. Scan a delivery or start one below.</Notice>}
            {tasksState === "ready" && tasks.length === 0 && (
              <span className="text-sm leading-5 text-muted">Nothing waiting for you. Scan a delivery or start a task below.</span>
            )}
            {tasks.map((t) => {
              const total = t.progress.total;
              const line = total ? Math.min(t.progress.done + 1, total) : 0;
              return (
                <button
                  key={t.wms_id} type="button" onClick={() => openTask(t)}
                  className="min-h-14 shrink-0 px-3 py-2 rounded-2xl bg-card border border-line flex items-center gap-3 text-left text-ink cursor-pointer active:bg-brand-tint"
                >
                  <span aria-hidden="true" className={cx("w-2.5 h-9 shrink-0 rounded-md", taskBar(t.type))} />
                  <span className="flex flex-col grow min-w-0">
                    <span className="text-[15px] leading-5 font-extrabold truncate">{t.title}</span>
                    <span className="text-xs leading-4 text-muted">Line {line} of {total} · {STATUS_TEXT[t.status]}</span>
                  </span>
                  <TaskPill task={t} />
                </button>
              );
            })}
          </div>
        </section>

        <section aria-label="Start a task" className="shrink-0 flex flex-col gap-2">
          <span className="eyebrow text-faint">Start a task</span>
          <div className="grid grid-cols-3 gap-2">
            <Tile to="/pick" label="Pick" icon={ICON.pick} tone="leaving" />
            <Tile to="/pack" label="Pack" icon={ICON.pack} tone="leaving" />
            <Tile to="/sort" label="Batch sort" icon={ICON.sort} tone="leaving" />
            <Tile to="/receive" label="Receive" icon={ICON.receive} tone="arriving" />
            <Tile to="/production" label="Production receipt" icon={ICON.production} tone="arriving" />
            <Tile to="/transfer-in" label="Receive transfer" icon={ICON.transfer} tone="arriving" />
            <Tile to="/move" label="Move" icon={ICON.move} tone="stored" />
            <Tile to="/count" label="Count" icon={ICON.count} tone="stored" />
            <Tile to="/lookup" label="Look up" icon={ICON.lookup} />
          </div>
        </section>
      </main>

      <footer className="px-5 pt-3 pb-4 flex flex-col gap-2.5 shrink-0">
        <div className="flex justify-between items-center gap-3 text-xs leading-4 font-semibold text-muted">
          <span className={cx("flex items-center gap-1.5", pending ? "text-warn-ink" : "text-ok")}>
            {pending ? <WifiOffIcon size={14} /> : <CheckIcon size={14} />}
            {queued} waiting · {pending ? "sending when back" : "all sent"}
          </span>
          <span className="flex items-center gap-1.5">
            <Icon size={14} stroke={2.2}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
            Auto sign-out {outAt} if idle
          </span>
        </div>
        {/* stays in the layout while the question floats over it, so nothing jumps */}
        <Button variant="outline" onClick={() => setAsking(true)} className={cx("flex items-center justify-center gap-2.5", asking && "invisible")}>
          <Icon size={22} stroke={2.2}><path d="M7 7h11l-3-3M17 17H6l3 3" /></Icon>Switch worker
        </Button>
      </footer>

      {asking && (
        <div
          role="alertdialog" aria-modal="false" aria-labelledby={`${askId}-t`} aria-describedby={`${askId}-d`}
          className="absolute left-4 right-4 bottom-4 z-20 p-3.5 rounded-[18px] bg-card border-2 border-ink shadow-float flex flex-col gap-2.5"
        >
          <span id={`${askId}-t`} className="text-base leading-6 font-extrabold">Hand the scanner over?</span>
          <span id={`${askId}-d`} className="text-sm leading-5 text-muted">{first} gets signed out now, so the next person scans under their own name.</span>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="quiet" autoFocus onClick={() => setAsking(false)}>Not now</Button>
            <Button variant="ink" onClick={switchWorker}>Yes, switch</Button>
          </div>
        </div>
      )}
    </Screen>
  );
}
