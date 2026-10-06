import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { initials, zoneNote } from "../lib/format";
import { prefersReducedMotion, useGamePrefs } from "../lib/gamePrefs";
import { Logo } from "./Logo";
import { WarehouseMap } from "./map/WarehouseMap";
import { noteDrawerClosed } from "./focusReturn";
import { panelTitle } from "./panels";
import { ToastHost } from "./toast";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin", supervisor: "Supervisor", inventory_controller: "Inventory controller",
  receiver: "Receiver", picker: "Picker", integration: "Integration",
};

/** Only warn near the end. A bar that always nags is one people stop reading. */
const IDLE_WARN_SECONDS = 120;

/** The warehouse clock shows hours and minutes, so a half-minute tick is
 * plenty to keep it honest. */
const CLOCK_TICK_MS = 30_000;

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function IconButton({ label, pressed, onClick, children }: {
  label: string; pressed?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={
        "w-11 h-11 shrink-0 rounded-xl grid place-items-center cursor-pointer border transition-colors " +
        (pressed ? "border-brand bg-brand-tint text-brand-dark" : "border-line bg-card text-ink-2 hover:bg-ground")
      }
    >
      {children}
    </button>
  );
}

/** One box for a SKU or a delivery reference. A delivery that exists opens;
 * anything else is looked up as stock, which says plainly if it is unknown. */
function FindBox() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setBusy(true);
    let isDelivery = false;
    try {
      await api.get(`/v1/deliveries/${encodeURIComponent(term)}`);
      isDelivery = true;
    } catch {
      // Not a delivery we can see (or the WMS is unreachable): the stock
      // page says which, in its own words.
      isDelivery = false;
    } finally {
      setBusy(false);
    }
    navigate(isDelivery ? `/deliveries/${encodeURIComponent(term)}` : `/stock?sku=${encodeURIComponent(term)}`);
    setQ("");
  }

  return (
    <form role="search" onSubmit={submit} className="flex-[1_1_260px] max-w-[460px] min-w-0">
      <label className="flex items-center gap-2 h-11 px-3.5 border border-line rounded-xl bg-field text-muted text-sm">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="sr-only">Find a product or order</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a SKU or order number"
          disabled={busy}
          className="flex-1 min-w-0 border-0 bg-transparent text-ink outline-none"
        />
      </label>
    </form>
  );
}

function TopBar() {
  const { user, warehouses, warehouse, setWarehouse, signOut, idleLeftSeconds, touch } = useAuth();
  const [prefs, setPrefs] = useGamePrefs();
  const warnIdle = idleLeftSeconds > 0 && idleLeftSeconds <= IDLE_WARN_SECONDS;
  // Only worth saying when the warehouse keeps a different clock from the
  // person reading the screen. Same clock, no note.
  const [clock, setClock] = useState(() => zoneNote(warehouse?.timezone));
  useEffect(() => {
    setClock(zoneNote(warehouse?.timezone));
    const timer = setInterval(() => setClock(zoneNote(warehouse?.timezone)), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [warehouse?.timezone]);

  return (
    <header className="relative z-20 shrink-0 flex flex-wrap items-center gap-x-5 gap-y-3 px-6 py-3 bg-card border-b border-line">
      <Link to="/" className="flex items-center gap-2.5 no-underline text-ink hover:text-ink" aria-label="Simple WMS, back to the map">
        <Logo size={32} />
        <span className="text-[19px] font-extrabold tracking-[-0.2px]">Simple WMS</span>
      </Link>
      <FindBox />
      <div className="flex flex-wrap items-center gap-2 ml-auto">
        <label className="flex items-center gap-2 text-xs leading-4 font-bold text-muted">
          <span>Warehouse</span>
          <select
            aria-label="Warehouse"
            className="input !h-11 !w-auto"
            value={warehouse?.code ?? ""}
            onChange={(e) => setWarehouse(e.target.value)}
          >
            {warehouses.length === 0 && <option value="">No warehouses yet</option>}
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}
          </select>
        </label>
        {clock && (
          <span
            title={`Warehouse time · ${warehouse?.timezone}`}
            className="flex items-center gap-1.5 h-9 px-3 rounded-full bg-ok-tint text-ok text-[13px] font-bold whitespace-nowrap"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            {clock.time} {clock.label}
          </span>
        )}
        <IconButton label="Day and night" pressed={prefs.dayNight} onClick={() => setPrefs({ dayNight: !prefs.dayNight })}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
        </IconButton>
        <IconButton label="Game sounds" pressed={prefs.sound} onClick={() => setPrefs({ sound: !prefs.sound })}>
          {prefs.sound ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="m16 9 5 6M21 9l-5 6" /></svg>
          )}
        </IconButton>
        {warnIdle && (
          <span className="inline-flex items-center gap-2 rounded-full bg-warning px-3 py-1.5 text-xs leading-4 font-bold text-warning-ink whitespace-nowrap">
            <span>Signing out in {countdown(idleLeftSeconds)}</span>
            <button type="button" onClick={touch} className="text-warning-ink underline cursor-pointer bg-transparent border-0 p-0 text-xs font-extrabold min-h-6">
              Stay signed in
            </button>
          </span>
        )}
        <div className="flex items-center gap-2 text-sm leading-5">
          <div className="w-11 h-11 rounded-full bg-brand text-white flex items-center justify-center text-sm font-extrabold" title={user?.display_name}>
            {initials(user?.display_name ?? "?")}
          </div>
          <span className="text-ink-2 font-semibold">{ROLE_LABEL[user?.role ?? ""] ?? user?.role}</span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="min-h-11 px-3 rounded-xl text-ink-2 text-[13px] font-bold hover:text-ink hover:bg-ground cursor-pointer bg-transparent border-0"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

/** One level up: a delivery or the batch builder goes back to deliveries;
 * any other panel goes back to the map. */
export function parentPath(pathname: string): string {
  if (pathname.startsWith("/deliveries/")) return "/deliveries";
  return "/";
}

const OPEN_DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** Is this Escape somebody else's? Typing, a form being filled in, or a
 * dialog inside the page all keep it, so nothing half-done is thrown away. */
export function escapeBelongsElsewhere(target: EventTarget | null): boolean {
  if (document.querySelector(OPEN_DIALOG)) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("[contenteditable=''], [contenteditable='true']")) return true;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return true;
  return target.closest("form") !== null;
}

/** Escape goes up one level, unless the page has a better use for it. */
function useEscapeUp() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (escapeBelongsElsewhere(e.target)) return;
      navigate(parentPath(pathname));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, pathname]);
}

/** Every panel slides over the map, which stays put behind it. */
function Drawer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const title = panelTitle(pathname);
  useEscapeUp();
  // Keyboard users start inside the drawer; the map gets focus back on close.
  const close = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    close.current?.focus();
    return () => noteDrawerClosed();
  }, []);
  return (
    <div className="absolute inset-0 z-10">
      <div aria-hidden="true" className="absolute inset-0 hidden min-[960px]:block" onClick={() => navigate("/")}>
        <div className="absolute inset-0 bg-[rgba(24,35,61,0.38)] backdrop-blur-[2px]" />
      </div>
      <section
        aria-label={title}
        className="wm-drawer absolute top-0 right-0 bottom-0 w-full min-[960px]:w-[min(1120px,78vw)] bg-card min-[960px]:rounded-l-[24px] shadow-[-20px_0_50px_rgba(24,35,61,0.25)] flex flex-col overflow-hidden"
      >
        <div className="shrink-0 flex items-center gap-3 px-6 pt-4 pb-2">
          <Link
            ref={close}
            to="/"
            aria-label="Back to the map"
            title="Back to the map (Esc)"
            className="w-11 h-11 rounded-xl bg-ground text-ink grid place-items-center no-underline hover:bg-brand-tint hover:text-ink"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </Link>
          <span className="text-[13px] font-bold text-muted">
            <Link to="/" className="text-muted hover:text-ink no-underline">Map</Link>
            <span aria-hidden="true"> / </span>
            <span className="text-ink">{title}</span>
          </span>
        </div>
        <div className="@container grow min-h-0 overflow-y-auto">
          <div className="flex flex-col @5xl:flex-row @5xl:h-full">
            {children}
          </div>
        </div>
      </section>
    </div>
  );
}

export function Shell() {
  const { warehouse } = useAuth();
  const { pathname } = useLocation();
  const [prefs] = useGamePrefs();
  const home = pathname === "/";
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar />
      <div className="relative grow min-h-0 overflow-hidden">
        {home ? <Outlet /> : (
          <>
            <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center overflow-hidden">
              <WarehouseMap
                decorative
                timezone={warehouse?.timezone}
                dayNight={prefs.dayNight}
                motion={prefs.motion && !prefersReducedMotion()}
              />
            </div>
            <Drawer><Outlet /></Drawer>
          </>
        )}
        <ToastHost />
      </div>
    </div>
  );
}

/** Main column of a screen. Detail panel goes beside it, or below it when
 * the drawer is narrow. */
export function Main({ children }: { children: ReactNode }) {
  return <main className="grow px-6 pt-2 pb-8 flex flex-col gap-6 min-w-0 @5xl:overflow-y-auto [&>*]:shrink-0">{children}</main>;
}
