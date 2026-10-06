import { Link } from "react-router-dom";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

function cx(...parts: (string | false | null | undefined)[]) { return parts.filter(Boolean).join(" "); }

/* --- screen frame -------------------------------------------------------- */

export function Screen({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-screen flex flex-col bg-ground text-ink">{children}</div>;
}

export function Header({ eyebrow, title, right, back = "/" }: { eyebrow: ReactNode; title: ReactNode; right?: ReactNode; back?: string | null }) {
  return (
    <header className="p-4 flex items-center gap-3 border-b border-line shrink-0">
      {back !== null && (
        <Link to={back} aria-label="Back to menu" className="w-11 h-11 flex items-center justify-center rounded-md border border-line no-underline">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ccd6f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
        </Link>
      )}
      <div className="flex flex-col gap-0.5 grow min-w-0">
        <span className="eyebrow text-brand">{eyebrow}</span>
        <span className="text-base leading-6 font-semibold truncate">{title}</span>
      </div>
      {right && <span className="text-xs leading-4 text-muted shrink-0">{right}</span>}
    </header>
  );
}

export function Main({ children }: { children: ReactNode }) {
  return <main className="grow px-4 py-5 flex flex-col gap-4 overflow-y-auto">{children}</main>;
}

export function Footer({ children }: { children: ReactNode }) {
  return <footer className="p-4 flex gap-2 border-t border-line shrink-0 [&>*:last-child]:grow-[2] [&>*]:grow">{children}</footer>;
}

/* --- buttons --------------------------------------------------------------- */

type Variant = "primary" | "quiet" | "gold";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand border-brand text-ground font-semibold",
  quiet: "bg-transparent border-line-strong text-ink font-medium",
  gold: "bg-transparent border-gold text-gold font-medium",
};

export function Button({ variant = "quiet", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button type="button" className={cx("h-14 px-4 rounded-md border text-base cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed active:brightness-125", VARIANTS[variant], className)} {...props} />
  );
}

/* --- cards ------------------------------------------------------------------ */

export function ProgressRow({ label, done, total }: { label: ReactNode; done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="card px-4 py-3 flex items-center gap-3">
      <span className="text-sm leading-5 text-muted whitespace-nowrap">{label}</span>
      <div className="grow h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Card({ children, className, strong }: { children: ReactNode; className?: string; strong?: boolean }) {
  return <section className={cx("card p-5 flex flex-col gap-3", strong && "border-line-strong", className)}>{children}</section>;
}

export function BigLocation({ eyebrow, code, hint, hint2, tone }: { eyebrow: ReactNode; code: ReactNode; hint?: ReactNode; hint2?: ReactNode; tone?: "gold" }) {
  return (
    <Card strong className={tone === "gold" ? "border-gold-line" : undefined}>
      <span className="eyebrow text-muted">{eyebrow}</span>
      <span className={cx("text-[44px] leading-[1.1] font-bold tracking-tight break-all", tone === "gold" && "text-gold")}>{code}</span>
      {hint && <span className="text-xs leading-4 text-muted">{hint}</span>}
      {hint2 && <span className="text-xs leading-4 text-muted">{hint2}</span>}
    </Card>
  );
}

export function ProductCard({ sku, name, pill, big, bigHint }: { sku: ReactNode; name: ReactNode; pill?: ReactNode; big?: ReactNode; bigHint?: ReactNode }) {
  return (
    <Card>
      <div className="flex justify-between items-start gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-xl leading-7 font-bold truncate">{sku}</span>
          <span className="text-sm leading-5 text-muted truncate">{name}</span>
        </div>
        {pill}
      </div>
      {big !== undefined && (
        <div className="flex items-baseline gap-2">
          <span className="text-4xl leading-10 font-bold">{big}</span>
          <span className="text-base leading-6 text-muted">{bigHint}</span>
        </div>
      )}
    </Card>
  );
}

export function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "info" | "ok" }) {
  const cls = { muted: "border-line text-muted", warn: "border-gold-line text-gold", info: "border-line-strong bg-brand-tint text-ink", ok: "border-ok-line text-ok" }[tone];
  return <span className={cx("inline-block px-2 py-0.5 rounded-full text-xs leading-4 font-semibold whitespace-nowrap border", cls)}>{children}</span>;
}

export function ScanHint({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <section className="p-4 rounded-xl border border-dashed border-line-strong flex items-center gap-3">
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#29abe2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M8 7v10" /><path d="M12 7v10" /><path d="M17 7v10" /></svg>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm leading-5 font-medium text-ink">{children}</span>
        {sub && <span className="text-xs leading-4 text-muted">{sub}</span>}
      </div>
    </section>
  );
}

export function SupervisorPanel({ children, sub }: { children?: ReactNode; sub?: ReactNode }) {
  return (
    <section className="p-4 rounded-xl border border-dashed border-gold-line flex items-center gap-3">
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f7941d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm leading-5 font-medium text-gold">{children ?? "Supervisor: scan your badge"}</span>
        {sub && <span className="text-xs leading-4 text-muted">{sub}</span>}
      </div>
    </section>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "gold" | "ok"; children: ReactNode }) {
  const cls = tone === "gold" ? "border-gold-line text-gold bg-gold-tint" : tone === "ok" ? "border-ok-line text-ok" : "border-line text-muted";
  return <div className={cx("rounded-lg border px-3 py-2 text-sm", cls)}>{children}</div>;
}

/* --- inputs ------------------------------------------------------------------ */

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs leading-4 text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs leading-4 text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...props} />;
}

/** The scanner's quantity control: big number, big buttons. Decimals allowed when the product says so. */
export function QtyStepper({ value, onChange, label = "Quantity", step = 1, decimals = false, min = 0 }: {
  value: string; onChange: (v: string) => void; label?: ReactNode; step?: number; decimals?: boolean; min?: number;
}) {
  const num = Number(value) || 0;
  const set = (n: number) => onChange(decimals ? String(Math.max(min, Math.round(n * 1000) / 1000)) : String(Math.max(min, Math.round(n))));
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs leading-4 text-muted">{label}</span>
      <div className="flex gap-2">
        <button type="button" aria-label="Less" onClick={() => set(num - step)} className="w-14 h-14 rounded-md bg-transparent border border-line-strong text-ink text-2xl cursor-pointer">−</button>
        <input
          type="number" inputMode={decimals ? "decimal" : "numeric"} step={decimals ? "any" : 1} value={value}
          onChange={(e) => onChange(e.target.value)}
          className="grow h-14 text-center text-[28px] font-bold rounded-md bg-ground border border-line-strong text-ink min-w-0"
        />
        <button type="button" aria-label="More" onClick={() => set(num + step)} className="w-14 h-14 rounded-md bg-transparent border border-line-strong text-ink text-2xl cursor-pointer">+</button>
      </div>
    </label>
  );
}

export function Tile({ to, label, icon }: { to: string; label: ReactNode; icon: ReactNode }) {
  return (
    <Link to={to} className="card h-24 flex flex-col items-center justify-center gap-2 no-underline text-ink text-sm font-medium active:bg-brand-tint">
      <span className="text-brand">{icon}</span>{label}
    </Link>
  );
}
