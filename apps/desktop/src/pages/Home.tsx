import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Delivery, LedgerRow, Page, Receipt, ReportResult } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtDate, fmtQty, fmtWhen, plural } from "../lib/format";
import { prefersReducedMotion, readGoalOverride, useGamePrefs, writeGoalOverride } from "../lib/gamePrefs";
import {
  GOAL_MIN, GOAL_STEP, GOAL_WINDOW_DAYS, addDays, goalStreak, shippedOn, shippedRows, suggestGoal, usualPerDay,
  warehouseDay,
} from "../lib/goal";
import { playBeep, playDing } from "../lib/sound";
import { useApi } from "../lib/useApi";
import { Pill } from "../ui";
import { WarehouseMap } from "../ui/map/WarehouseMap";
import { rememberOpener, takeReturnFocus } from "../ui/focusReturn";

/** Receipts the truck has not finished with. */
export const ARRIVING_STATUSES = "expected,arrived,receiving";
/** Deliveries still in the building. */
export const LEAVING_STATUSES = "new,allocated,picking,picked,packing,packed";

/** The map keeps itself fresh, so trucks can drive in while you watch. */
const REFRESH_MS = 60_000;
const FEED_SIZE = 5;
const NO_STOCK_ACCESS = "You don't have access to stock numbers";
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.25;

const MOVEMENT: Record<string, string> = {
  receipt: "Received", putaway: "Put away", move: "Moved", pick: "Picked", ship: "Shipped",
  adjustment: "Adjusted", count: "Counted", replenish: "Topped up", transfer_out: "Sent on transfer",
  transfer_in: "Arrived on transfer", production_issue: "Issued to production", production_receipt: "Made in production",
};
/** Which zone colour a movement belongs to. The words say it too. */
function movementZone(type: string): "arriving" | "stored" | "leaving" {
  if (["receipt", "putaway", "transfer_in", "production_receipt"].includes(type)) return "arriving";
  if (["pick", "ship", "transfer_out", "production_issue"].includes(type)) return "leaving";
  return "stored";
}
const ZONE_DOT = { arriving: "bg-brand", stored: "bg-[#1F8A84]", leaving: "bg-[#E07A1F]" };

const STATUS_WORD: Record<string, string> = {
  new: "New", allocated: "Stock held", picking: "Picking", picked: "Picked",
  packing: "Packing", packed: "Packed", shipped: "Shipped", cancelled: "Cancelled",
};

function FloatCard({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={`float-card p-4 flex flex-col gap-2.5 ${className}`}>
      {children}
    </section>
  );
}

function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="m-0 eyebrow text-muted">{children}</h2>
      {action}
    </div>
  );
}

function Counter({ label, value, tone, to, page, error, blocked }: {
  label: string; value: number | null; tone: string; to: string; page: string; error: string | null;
  /** Why this number is not shown at all, when the reader may not see it. */
  blocked?: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      data-return-focus={`counter-${to}`}
      title={blocked ?? (error ? `Could not load: ${error}` : `Open ${page}`)}
      className="float-card text-left px-3 py-2.5 min-h-11 cursor-pointer border-0 hover:shadow-[var(--shadow-lift)] transition-shadow"
    >
      <span className={`block text-[11px] font-extrabold tracking-[1.2px] uppercase ${tone}`}>{label}</span>
      <span className="block text-2xl font-extrabold text-ink" data-testid={`count-${label.toLowerCase()}`}>
        {value === null ? "—" : value}
      </span>
      <span className="sr-only">{blocked ? `. ${blocked}` : ""}. Open {page}</span>
    </button>
  );
}

const ICON = {
  products: <path d="M12 3 20 7.5v9L12 21 4 16.5v-9ZM4 7.5l8 4.5 8-4.5" />,
  orders: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  reports: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  all: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
};

function DockLink({ to, icon, children, primary }: { to: string; icon: ReactNode; children: ReactNode; primary?: boolean }) {
  return (
    <Link
      to={to}
      data-return-focus={`dock-${to}`}
      className={
        "h-12 px-4 rounded-xl flex items-center gap-2 text-sm no-underline text-white hover:text-white " +
        (primary ? "bg-brand font-extrabold hover:bg-brand-dark" : "font-bold hover:bg-white/10")
      }
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg>
      {children}
    </Link>
  );
}

function ZoomButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="w-11 h-11 rounded-[10px] bg-transparent border-0 text-ink grid place-items-center cursor-pointer hover:bg-ground disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">{children}</svg>
    </button>
  );
}

export function Home() {
  const { warehouse, can } = useAuth();
  const code = warehouse?.code ?? null;
  // Stock on hand, shipments and the ledger need stock:read. Without it the
  // cards say so kindly instead of asking and showing a refusal.
  const mayRead = can("stock:read");
  const stockCode = mayRead ? code : null;
  const tz = warehouse?.timezone ?? null;
  const [prefs] = useGamePrefs();
  const motion = prefs.motion && !prefersReducedMotion();

  // A gentle heartbeat, so the counts (and the trucks) keep up on their own.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const today = warehouseDay(tz);
  const arriving = useApi<Page<Receipt>>(
    code ? () => api.get<Page<Receipt>>("/v1/receipts", { warehouse: code, status: ARRIVING_STATUSES, limit: 1 }) : null,
    [code, tick],
  );
  const leaving = useApi<Page<Delivery>>(
    code ? () => api.get<Page<Delivery>>("/v1/deliveries", { warehouse: code, status: LEAVING_STATUSES, limit: 1 }) : null,
    [code, tick],
  );
  const stored = useApi<ReportResult>(
    stockCode ? () => api.get<ReportResult>("/v1/reports/stock-on-hand", { warehouse: code, group_by: "product" }) : null,
    [stockCode, tick],
  );
  const shipped = useApi<ReportResult>(
    stockCode
      ? () => api.get<ReportResult>("/v1/reports/shipped", { warehouse: code, from: addDays(today, -GOAL_WINDOW_DAYS), to: today })
      : null,
    [stockCode, today, tick],
  );
  const feed = useApi<Page<LedgerRow>>(
    stockCode ? () => api.get<Page<LedgerRow>>("/v1/stock/ledger", { warehouse: stockCode, limit: FEED_SIZE }) : null,
    [stockCode, tick],
  );

  const arrivingCount = arriving.data?.total ?? null;
  const leavingCount = leaving.data?.total ?? null;
  const storedCount = stored.data ? stored.data.rows.length : null;
  const rows = shipped.data ? shippedRows(shipped.data.rows) : null;
  const shippedToday = rows ? shippedOn(rows, today) : null;
  const next = leaving.data?.items[0] ?? null;

  /* --- goal ------------------------------------------------------------- */
  const [override, setOverride] = useState<number | null>(() => readGoalOverride(code));
  useEffect(() => setOverride(readGoalOverride(code)), [code]);
  const [editing, setEditing] = useState(false);
  const suggestion = rows ? suggestGoal(rows, today) : GOAL_MIN;
  const usual = rows ? usualPerDay(rows, today) : null;
  const goal = override ?? suggestion;
  const changeGoal = (value: number | null) => {
    if (!code) return;
    const clean = value === null ? null : Math.max(GOAL_MIN, value);
    writeGoalOverride(code, clean);
    setOverride(clean);
  };
  const done = shippedToday ?? 0;
  const pct = Math.min(100, Math.round((done / goal) * 100));
  const streak = rows ? goalStreak(rows, today, goal) : 0;

  /* --- trucks and sounds: only for changes after the first load --------- */
  const [arrivals, setArrivals] = useState(0);
  const [departures, setDepartures] = useState(0);
  const seen = useRef<{ code: string | null; arriving: number | null; shipped: number | null }>({ code, arriving: null, shipped: null });
  useEffect(() => {
    if (seen.current.code !== code) seen.current = { code, arriving: null, shipped: null };
  }, [code]);
  useEffect(() => {
    if (arrivingCount === null) return;
    const before = seen.current.arriving;
    seen.current.arriving = arrivingCount;
    if (before !== null && arrivingCount > before) {
      setArrivals((n) => n + 1);
      if (prefs.sound) playBeep(prefs.volume);
    }
  }, [arrivingCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (shippedToday === null) return;
    const before = seen.current.shipped;
    seen.current.shipped = shippedToday;
    if (before !== null && shippedToday > before) {
      setDepartures((n) => n + 1);
      if (prefs.sound) playDing(prefs.volume);
    }
  }, [shippedToday]); // eslint-disable-line react-hooks/exhaustive-deps

  const [zoom, setZoom] = useState(1);

  // Back from a drawer: focus the control that opened it, else the heading.
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const key = takeReturnFocus();
    if (key === undefined) return;
    const opener = key
      ? [...(root.current?.querySelectorAll<HTMLElement>("[data-return-focus]") ?? [])].find((el) => el.dataset.returnFocus === key)
      : null;
    (opener ?? heading.current)?.focus();
  }, []);

  const wide = "min-[960px]:absolute";
  return (
    <div
      ref={root}
      onClickCapture={(e) => {
        const from = (e.target as HTMLElement).closest<HTMLElement>("[data-return-focus]");
        rememberOpener(from?.dataset.returnFocus ?? null);
      }}
      className="relative h-full overflow-y-auto min-[960px]:overflow-hidden flex flex-col gap-3 p-3 min-[960px]:block min-[960px]:p-0"
    >
      <h1 ref={heading} tabIndex={-1} className="sr-only">Warehouse map</h1>
      <div className={`${wide} min-[960px]:inset-0 shrink-0 flex items-center justify-center overflow-hidden`}>
        <WarehouseMap
          zoom={zoom} timezone={tz} dayNight={prefs.dayNight} motion={motion}
          arrivals={arrivals} departures={departures}
        />
      </div>

      {!code && (
        <div className={`${wide} min-[960px]:top-5 min-[960px]:left-1/2 min-[960px]:-translate-x-1/2 float-card px-4 py-3 text-sm text-ink-2`}>
          No warehouse yet. Create one through the API and the map fills in.
        </div>
      )}

      <div className={`${wide} min-[960px]:top-3 min-[960px]:bottom-[84px] min-[960px]:left-4 min-[960px]:w-[336px] min-[960px]:overflow-y-auto min-[960px]:p-2 flex flex-col gap-3`}>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Zones">
          <Counter label="Arriving" value={arrivingCount} tone="text-brand" to="/receiving" page="Receiving" error={arriving.error} />
          <Counter label="Stored" value={storedCount} tone="text-[#167A73]" to="/stock" page="Stock" error={stored.error} blocked={mayRead ? undefined : NO_STOCK_ACCESS} />
          <Counter label="Leaving" value={leavingCount} tone="text-gold" to="/deliveries" page="Deliveries" error={leaving.error} />
        </div>

        <FloatCard label="Today's goal">
          <CardTitle action={
            <button
              type="button"
              aria-expanded={editing}
              onClick={() => setEditing((v) => !v)}
              disabled={!code}
              className="min-h-11 px-2 -mr-2 bg-transparent border-0 text-[13px] font-bold text-[#2557C9] hover:text-[#1A3F99] cursor-pointer disabled:opacity-40"
            >
              {editing ? "Done" : "Edit"}
            </button>
          }>Today's goal</CardTitle>
          <div className="text-lg font-extrabold">Ship {plural(goal, "order")}</div>
          <div
            role="progressbar" aria-label="Shipped towards today's goal"
            aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(done, goal)}
            className="h-3 rounded-full bg-line-soft overflow-hidden"
          >
            <div className={`h-full rounded-full ${done >= goal ? "bg-ok-fill" : "bg-brand"}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-[13px] text-ink-2">
            <span><b className="text-ink">{shippedToday ?? "—"}</b> shipped</span>
            <span>{done >= goal ? "Goal reached" : `${goal - done} to go`}</span>
          </div>
          {editing && (
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex items-center gap-2">
                <button type="button" aria-label="Lower today's goal" onClick={() => changeGoal(goal - GOAL_STEP)} disabled={goal <= GOAL_MIN}
                  className="w-11 h-11 rounded-xl border border-line-strong bg-card grid place-items-center cursor-pointer disabled:opacity-40">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
                </button>
                <span className="grow h-11 rounded-xl border border-line-strong grid place-items-center font-extrabold" aria-live="polite">
                  {plural(goal, "order")}
                </span>
                <button type="button" aria-label="Raise today's goal" onClick={() => changeGoal(goal + GOAL_STEP)}
                  className="w-11 h-11 rounded-xl border border-line-strong bg-card grid place-items-center cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              </div>
              <button type="button" onClick={() => changeGoal(null)} disabled={override === null}
                className="min-h-11 rounded-xl border border-line-strong bg-card text-sm font-bold cursor-pointer disabled:opacity-50 disabled:cursor-default">
                Use suggestion ({suggestion})
              </button>
            </div>
          )}
          <div className="text-xs text-muted">
            {!mayRead ? `${NO_STOCK_ACCESS}, so shipments can't be counted here.`
              : shipped.error ? `Could not read what shipped: ${shipped.error}`
              : override !== null ? `Your own goal for this warehouse. The app would suggest ${suggestion}.`
              : usual !== null ? `Suggested from your last 4 weeks. You usually ship about ${Math.round(usual)} a day.`
              : "Nothing shipped in the last 4 weeks yet, so the goal starts small."}
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-gold-tint text-gold-ink text-xs font-extrabold">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9Z" /></svg>
              {streak > 0 ? `${streak}-day goal streak` : "No streak yet"}
            </span>
          </div>
        </FloatCard>

        <FloatCard label="What just happened" className="min-[960px]:mt-auto">
          <CardTitle>What just happened</CardTitle>
          {!mayRead ? (
            <p className="m-0 text-[13px] text-ink-2">{NO_STOCK_ACCESS}, so the latest movements are hidden.</p>
          ) : feed.error ? (
            <p className="m-0 text-[13px] text-ink-2">Could not load the latest movements: {feed.error}</p>
          ) : !feed.data ? (
            <p className="m-0 text-[13px] text-muted">{code ? "Loading…" : "Nothing to show yet."}</p>
          ) : feed.data.items.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-2">Nothing has moved in this warehouse yet.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
              {feed.data.items.map((r) => {
                const q = r.qty_change.startsWith("-") ? r.qty_change.slice(1) : r.qty_change;
                return (
                  <li key={r.wms_id} className="flex gap-2.5 items-start text-[13px]">
                    <span aria-hidden="true" className={`w-2.5 h-2.5 mt-1 rounded-full shrink-0 ${ZONE_DOT[movementZone(r.movement_type)]}`} />
                    <span className="grow min-w-0">
                      {MOVEMENT[r.movement_type] ?? r.movement_type} {fmtQty(q, r.uom)} of {r.sku}
                      <span className="text-muted"> · {r.location}</span>
                    </span>
                    <span className="text-muted whitespace-nowrap">{fmtWhen(r.at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </FloatCard>
      </div>

      <FloatCard label="Next up" className={`${wide} min-[960px]:top-5 min-[960px]:right-6 min-[960px]:w-[320px] !p-[18px] !gap-3.5`}>
        <CardTitle>Next up</CardTitle>
        {leaving.error ? (
          <p className="m-0 text-sm text-ink-2">Could not load the deliveries: {leaving.error}</p>
        ) : !leaving.data ? (
          <p className="m-0 text-sm text-muted">{code ? "Loading…" : "Pick a warehouse to see what is next."}</p>
        ) : !next ? (
          <p className="m-0 text-sm text-ink-2">Nothing waiting to go. Every order is out the door.</p>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-xl bg-leaving text-leaving-ink grid place-items-center shrink-0">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 20 7.5v9L12 21 4 16.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></svg>
              </div>
              <div className="min-w-0 grow">
                <div className="text-xs font-bold text-muted">Delivery {next.external_ref}</div>
                <div className="text-lg font-extrabold truncate">{next.ship_to?.name ?? "—"}</div>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Pill tone="leaving">{STATUS_WORD[next.status] ?? next.status}</Pill>
              {next.priority === "high" && <Pill tone="problem">High priority</Pill>}
            </div>
            <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2.5 text-[13px]">
              <div><dt className="text-muted">Due</dt><dd className="m-0 mt-0.5 font-bold">{next.required_by ? fmtDate(next.required_by) : "No date"}</dd></div>
              <div><dt className="text-muted">Lines</dt><dd className="m-0 mt-0.5 font-bold">{next.lines?.length ?? "—"}</dd></div>
            </dl>
            <Link
              to={`/deliveries/${encodeURIComponent(next.external_ref)}`}
              data-return-focus="next-up"
              className="h-[46px] rounded-xl bg-brand text-white hover:bg-brand-dark hover:text-white font-extrabold text-[15px] no-underline flex items-center justify-center gap-2"
            >
              Open
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            {leavingCount !== null && leavingCount > 1 && (
              <div className="text-xs text-muted">{plural(leavingCount - 1, "more delivery", "more deliveries")} after this one.</div>
            )}
          </>
        )}
      </FloatCard>

      <div className={`${wide} hidden min-[960px]:flex top-1/2 right-6 translate-y-10 flex-col gap-1.5 p-1.5 float-card !rounded-[14px]`} role="group" aria-label="Zoom">
        <ZoomButton label="Zoom in" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX}><path d="M12 5v14M5 12h14" /></ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN}><path d="M5 12h14" /></ZoomButton>
        <ZoomButton label="Back to whole warehouse" onClick={() => setZoom(1)}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></ZoomButton>
      </div>

      <nav
        aria-label="Shortcuts"
        className={`${wide} min-[960px]:bottom-6 min-[960px]:left-1/2 min-[960px]:-translate-x-[30%] flex flex-wrap gap-1.5 p-1.5 rounded-2xl bg-ink shadow-[0_10px_30px_rgba(24,35,61,0.25)]`}
      >
        <DockLink to="/products" icon={ICON.products}>Products</DockLink>
        <DockLink to="/deliveries" icon={ICON.orders}>Orders</DockLink>
        <DockLink to="/reports" icon={ICON.reports}>Reports</DockLink>
        <DockLink to="/settings" icon={ICON.settings}>Settings</DockLink>
        <DockLink to="/menu" icon={ICON.all} primary>All panels</DockLink>
      </nav>
    </div>
  );
}
