import { useSyncExternalStore } from "react";

/** How the map feels to whoever is sitting at this screen. Per viewer and
 * per browser, never shared and never sent to the API: one person's quiet
 * screen is nobody else's business. */
export interface GamePrefs {
  sound: boolean;
  /** 0 to 100 */
  volume: number;
  dayNight: boolean;
  motion: boolean;
}

export const GAME_PREFS_KEY = "wms.game";
export const DEFAULT_PREFS: GamePrefs = { sound: true, volume: 60, dayNight: true, motion: true };

function read(): GamePrefs {
  try {
    const raw = window.localStorage.getItem(GAME_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<GamePrefs>;
    const volume = Number(parsed.volume);
    return {
      sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULT_PREFS.sound,
      volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : DEFAULT_PREFS.volume,
      dayNight: typeof parsed.dayNight === "boolean" ? parsed.dayNight : DEFAULT_PREFS.dayNight,
      motion: typeof parsed.motion === "boolean" ? parsed.motion : DEFAULT_PREFS.motion,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: GamePrefs | null = null;
const listeners = new Set<() => void>();

export function getGamePrefs(): GamePrefs {
  if (!current) current = read();
  return current;
}

export function setGamePrefs(change: Partial<GamePrefs>): void {
  current = { ...getGamePrefs(), ...change };
  try { window.localStorage.setItem(GAME_PREFS_KEY, JSON.stringify(current)); } catch { /* private mode */ }
  for (const l of listeners) l();
}

/** Forget the cached copy so the next read comes from storage (tests). */
export function reloadGamePrefs(): void {
  current = null;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useGamePrefs(): [GamePrefs, (change: Partial<GamePrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, getGamePrefs, getGamePrefs);
  return [prefs, setGamePrefs];
}

/** The reader asked their computer for less movement. That wins over us. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/* --- today's goal: a manager's own number, per warehouse ------------------ */

const goalKey = (warehouse: string) => `wms.goal.${warehouse}`;

export function readGoalOverride(warehouse: string | null | undefined): number | null {
  if (!warehouse) return null;
  try {
    const raw = window.localStorage.getItem(goalKey(warehouse));
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeGoalOverride(warehouse: string, goal: number | null): void {
  try {
    if (goal === null) window.localStorage.removeItem(goalKey(warehouse));
    else window.localStorage.setItem(goalKey(warehouse), String(goal));
  } catch { /* private mode */ }
}
