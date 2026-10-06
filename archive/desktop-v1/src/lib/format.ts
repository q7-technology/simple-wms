/** Quantities arrive as decimal strings. Show them grouped, decimals untouched. */
export function fmtQty(qty: string | number | null | undefined, uom?: string): string {
  if (qty === null || qty === undefined || qty === "") return "—";
  const s = String(qty);
  const negative = s.startsWith("-");
  const [whole, frac] = (negative ? s.slice(1) : s).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = (negative ? "−" : "") + grouped + (frac ? "." + frac : "");
  return uom ? `${out} ${uom}` : out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "30 Aug", or "30 Aug 2025" if not this year. Dates are plain YYYY-MM-DD. */
export function fmtDate(date: string | null | undefined, now: Date = new Date()): string {
  if (!date) return "—";
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  const text = `${d} ${MONTHS[m - 1]}`;
  return y === now.getFullYear() ? text : `${text} ${y}`;
}

/* --- whose clock ----------------------------------------------------------
 * Stock moves on the warehouse's clock. A 06:00 receipt in Perth happened at
 * six in the morning to everyone who was there, so that is what the screen
 * says, whether it is read in Perth, Ballarat or from home in another state.
 * The zone is set once when the warehouse is chosen; unset, times fall back
 * to the reader's own clock, which is right for a single-site warehouse. */

let displayZone: string | null = null;
const CLOCKS = new Map<string, Intl.DateTimeFormat | null>();

/** A formatter for one zone, or null if the browser has never heard of it. */
function clock(tz: string): Intl.DateTimeFormat | null {
  if (!CLOCKS.has(tz)) {
    let made: Intl.DateTimeFormat | null = null;
    try {
      made = new Intl.DateTimeFormat("en-AU", {
        timeZone: tz, weekday: "short", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      });
    } catch {
      made = null;
    }
    CLOCKS.set(tz, made);
  }
  return CLOCKS.get(tz) ?? null;
}

/** Show every time from here on in this zone. Null means the reader's own. */
export function setDisplayZone(tz: string | null | undefined): void {
  displayZone = tz && clock(tz) ? tz : null;
}

export function displayZoneName(): string | null {
  return displayZone;
}

type Wall = { y: number; m: number; d: number; time: string; weekday: string };

/** The wall clock at a moment: what a clock on that warehouse's wall read. */
function wall(t: Date, tz: string | null = displayZone): Wall {
  const f = tz ? clock(tz) : null;
  if (!f) {
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(),
             time: t.toTimeString().slice(0, 5), weekday: DAYS[t.getDay()] };
  }
  const part: Record<string, string> = {};
  for (const p of f.formatToParts(t)) part[p.type] = p.value;
  return { y: Number(part.year), m: Number(part.month), d: Number(part.day),
           time: `${part.hour}:${part.minute}`, weekday: part.weekday };
}

function dayText(w: Wall, thisYear: number): string {
  const text = `${w.d} ${MONTHS[w.m - 1]}`;
  return w.y === thisYear ? text : `${text} ${w.y}`;
}

/** A timestamp as people say it: "09:14" today, "Fri" this week, else "30 Aug". */
export function fmtWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const t = new Date(iso);
  const then = wall(t);
  const today = wall(now);
  if (then.y === today.y && then.m === today.m && then.d === today.d) return then.time;
  const days = (now.getTime() - t.getTime()) / 86_400_000;
  if (days > 0 && days < 6) return then.weekday;
  return dayText(then, today.y);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = wall(new Date(iso));
  return `${dayText(then, new Date().getFullYear())} ${then.time}`;
}

/** What to say beside the warehouse picker, or null when there is nothing to
 * say: a reader on the same clock as the warehouse does not need telling. */
export function zoneNote(
  tz: string | null | undefined,
  at: Date = new Date(),
  here: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { label: string; time: string } | null {
  if (!tz || !clock(tz) || tz === here) return null;
  const there = wall(at, tz);
  const mine = wall(at, here);
  if (there.time === mine.time && there.d === mine.d) return null;
  let label = tz;
  try {
    label = new Intl.DateTimeFormat("en-AU", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    label = tz;
  }
  return { label, time: there.time };
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
