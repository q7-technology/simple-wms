/** Today's goal and the streak, worked out from the `shipped` report.
 * Nothing here keeps its own numbers: it is all read back from what shipped. */

export interface ShippedRow { day: string; deliveries: number }

/** How far back the suggestion looks. */
export const GOAL_WINDOW_DAYS = 28;
export const GOAL_MIN = 5;
export const GOAL_STEP = 5;

/** The warehouse's own date, "YYYY-MM-DD", on its clock rather than ours. */
export function warehouseDay(tz: string | null | undefined, at: Date = new Date()): string {
  try {
    if (tz) {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(at);
    }
  } catch { /* unknown zone: fall through to the reader's clock */ }
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The warehouse's hour of the day, with minutes as a fraction. */
export function warehouseHour(tz: string | null | undefined, at: Date = new Date()): number {
  try {
    if (tz) {
      const parts = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(at);
      const h = Number(parts.find((p) => p.type === "hour")?.value);
      const m = Number(parts.find((p) => p.type === "minute")?.value);
      if (Number.isFinite(h) && Number.isFinite(m)) return h + m / 60;
    }
  } catch { /* fall through */ }
  return at.getHours() + at.getMinutes() / 60;
}

/** A plain date moved by whole days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Report rows to {day, deliveries}, whatever shape the numbers came in. */
export function shippedRows(rows: Record<string, string | number | null>[]): ShippedRow[] {
  return rows
    .filter((r) => typeof r.day === "string")
    .map((r) => ({ day: String(r.day).slice(0, 10), deliveries: Number(r.deliveries ?? 0) || 0 }));
}

export function shippedOn(rows: ShippedRow[], day: string): number {
  return rows.filter((r) => r.day === day).reduce((sum, r) => sum + r.deliveries, 0);
}

/** Average deliveries per day that shipped anything, over the last 28 days
 * before today. Null when nothing shipped at all in that window. */
export function usualPerDay(rows: ShippedRow[], today: string): number | null {
  const from = addDays(today, -GOAL_WINDOW_DAYS);
  const perDay = new Map<string, number>();
  for (const r of rows) {
    if (r.day < from || r.day >= today) continue;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.deliveries);
  }
  const days = [...perDay.values()].filter((n) => n > 0);
  if (days.length === 0) return null;
  return days.reduce((a, b) => a + b, 0) / days.length;
}

/** A little above usual, to keep it fun: ×1.1, up to the next 5, at least 5. */
export function suggestGoal(rows: ShippedRow[], today: string): number {
  const usual = usualPerDay(rows, today);
  if (usual === null) return GOAL_MIN;
  // Floating point says 50 × 1.1 is a hair over 55. The epsilon keeps that
  // at 55 instead of rounding it up to 60.
  const raw = usual * 1.1 - 1e-9;
  return Math.max(GOAL_MIN, Math.ceil(raw / GOAL_STEP) * GOAL_STEP);
}

/** Shipping days in a row the goal was reached. Days nothing shipped are
 * closed days (weekends, holidays) and neither break nor add to it. Today
 * counts once it is reached; until then it does not break the run. */
export function goalStreak(rows: ShippedRow[], today: string, goal: number): number {
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.deliveries);
  let streak = (perDay.get(today) ?? 0) >= goal ? 1 : 0;
  const earlier = [...perDay.entries()]
    .filter(([day, n]) => day < today && n > 0)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [, n] of earlier) {
    if (n >= goal) streak += 1;
    else break;
  }
  return streak;
}
