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

/** A timestamp as people say it: "09:14" today, "Fri" this week, else "30 Aug". */
export function fmtWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const t = new Date(iso);
  const sameDay = t.toDateString() === now.toDateString();
  if (sameDay) return t.toTimeString().slice(0, 5);
  const days = (now.getTime() - t.getTime()) / 86_400_000;
  if (days > 0 && days < 6) return DAYS[t.getDay()];
  const local = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return fmtDate(local, now);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  return `${fmtDate(`${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`)} ${t.toTimeString().slice(0, 5)}`;
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
