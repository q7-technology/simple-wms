import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* --- buttons ------------------------------------------------------------- */

type Variant = "primary" | "quiet" | "gold" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand border-brand text-ground font-semibold hover:brightness-110",
  quiet: "bg-transparent border-line-strong text-ink font-medium hover:bg-brand-tint",
  gold: "bg-transparent border-gold text-gold font-medium hover:bg-[rgba(247,148,29,0.1)]",
  ghost: "bg-transparent border-transparent text-muted font-medium hover:text-ink",
};

export function Button({
  variant = "quiet", className, small, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border px-4 text-sm cursor-pointer whitespace-nowrap",
        small ? "h-8 px-3" : "h-10",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        VARIANTS[variant], className,
      )}
      {...props}
    />
  );
}

/* --- text ---------------------------------------------------------------- */

export function Eyebrow({ children, tone = "brand", className }: { children: ReactNode; tone?: "brand" | "muted"; className?: string }) {
  return <span className={cx("eyebrow", tone === "brand" ? "text-brand" : "text-muted", className)}>{children}</span>;
}

export function PageHeader({ eyebrow, title, accent, actions }: { eyebrow: ReactNode; title: ReactNode; accent?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end gap-4">
      <div className="flex flex-col gap-1">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="m-0 text-[30px] leading-9 font-bold">
          {accent ? <><span className="text-brand">{accent}</span> {title}</> : title}
        </h1>
      </div>
      <div className="grow" />
      {actions}
    </div>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("text-muted", className)}>{children}</span>;
}

/* --- cards and tiles ----------------------------------------------------- */

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: "gold" }) {
  return (
    <div className={cx("card", tone === "gold" && "border-gold-line", className)}>{children}</div>
  );
}

export function StatTile({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "gold" }) {
  return (
    <Card tone={tone} className="p-5 flex flex-col gap-1.5">
      <span className="text-xs leading-4 text-muted">{label}</span>
      <span className={cx("text-4xl leading-10 font-bold truncate", tone === "gold" ? "text-gold" : "text-ink")}>{value}</span>
      {hint !== undefined && <span className="text-xs leading-4 text-muted">{hint}</span>}
    </Card>
  );
}

/* --- pills and chips ----------------------------------------------------- */

type PillTone = "ok" | "warn" | "muted" | "info";
const PILLS: Record<PillTone, string> = {
  ok: "border-ok-line text-ok",
  warn: "border-gold-line text-gold",
  muted: "border-line text-muted",
  info: "border-line-strong bg-brand-tint text-ink",
};

export function Pill({ tone = "info", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className={cx("inline-block rounded-full border px-2 py-0.5 text-xs leading-4 font-semibold whitespace-nowrap", PILLS[tone])}>
      {children}
    </span>
  );
}

export function Chip({ active, children, onClick }: { active?: boolean; children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-block rounded-full border px-2 py-0.5 text-xs leading-4 font-semibold whitespace-nowrap cursor-pointer",
        active ? "border-line-strong bg-brand-tint text-ink" : "border-line text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/* --- forms --------------------------------------------------------------- */

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5 min-w-0", className)}>
      <span className="text-xs leading-4 text-muted">{label}</span>
      {children}
      {error ? <span className="text-xs leading-4 text-gold">{error}</span>
        : hint ? <span className="text-xs leading-4 text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("input", className)} {...props} />;
}

export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cx("relative flex items-center", className)}>
      <span className="absolute left-3 flex" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8892b0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
      </span>
      <input type="search" className="input pl-9" {...props} />
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("flex items-center justify-between gap-4 py-2.5 row-line last:border-b-0", disabled && "opacity-60")}>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm leading-5 text-ink">{label}</span>
        {hint && <span className="text-xs leading-4 text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cx(
          "relative shrink-0 w-10 h-6 rounded-full border transition-colors cursor-pointer disabled:cursor-not-allowed",
          checked ? "bg-brand border-brand" : "bg-transparent border-line-strong",
        )}
      >
        <span className={cx(
          "absolute top-0.5 w-4 h-4 rounded-full transition-all",
          checked ? "left-[18px] bg-ground" : "left-0.5 bg-muted",
        )} />
      </button>
    </label>
  );
}

/* --- tables -------------------------------------------------------------- */

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: string;
  align?: "right";
  render: (row: T) => ReactNode;
}

export function Table<T>({ columns, rows, rowKey, onRowClick, selectedKey, empty }: {
  columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string;
  onRowClick?: (row: T) => void; selectedKey?: string | null; empty?: ReactNode;
}) {
  const template = columns.map((c) => c.width ?? "minmax(0, 1fr)").join(" ");
  return (
    <div className="card overflow-hidden flex flex-col">
      <div className="grid px-6 py-3 eyebrow text-muted border-b border-line" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => <span key={c.key} className={cx("truncate", c.align === "right" && "text-right")}>{c.header}</span>)}
      </div>
      {rows.length === 0 && <div className="px-6 py-8 text-sm text-muted">{empty ?? "Nothing here yet."}</div>}
      {rows.map((row) => {
        const k = rowKey(row);
        const selected = selectedKey === k;
        return (
          <div
            key={k}
            role={onRowClick ? "button" : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(row); } : undefined}
            className={cx(
              "grid px-6 py-3.5 text-sm leading-5 items-center row-line last:border-b-0",
              onRowClick && "cursor-pointer hover:bg-brand-tint",
              selected && "bg-brand-tint",
            )}
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((c) => <span key={c.key} className={cx("min-w-0 truncate", c.align === "right" && "text-right")}>{c.render(row)}</span>)}
          </div>
        );
      })}
    </div>
  );
}

/* --- detail panel -------------------------------------------------------- */

export function DetailPanel({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <aside aria-label="Detail" className="w-[400px] shrink-0 border-l border-line bg-card p-6 flex flex-col gap-5 overflow-y-auto">
      {children}
      {footer && <><div className="grow" /><div className="flex gap-2 [&>*]:grow">{footer}</div></>}
    </aside>
  );
}

export function DetailHeader({ eyebrow, title, subtitle }: { eyebrow: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow>{eyebrow}</Eyebrow>
      <div className="text-2xl leading-none font-semibold tracking-tight">{title}</div>
      {subtitle && <span className="text-sm leading-5 text-muted">{subtitle}</span>}
    </div>
  );
}

export function KeyValue({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((it, i) => (
        <div key={i} className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xs leading-4 text-muted">{it.label}</span>
          <span className="text-sm leading-5 text-ink truncate">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Section({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Eyebrow tone="muted">{title}</Eyebrow>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "gold" | "ok"; children: ReactNode }) {
  const cls = tone === "gold" ? "border-gold-line text-gold" : tone === "ok" ? "border-ok-line text-ok" : "border-line text-muted";
  return <div className={cx("rounded-md border px-3 py-2 text-sm", cls)}>{children}</div>;
}

export function SegmentedChoice<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => (
        <Chip key={o.value} active={o.value === value} onClick={disabled ? undefined : () => onChange(o.value)}>{o.label}</Chip>
      ))}
    </div>
  );
}
