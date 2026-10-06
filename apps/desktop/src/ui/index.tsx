import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* --- buttons ------------------------------------------------------------- */

type Variant = "primary" | "quiet" | "gold" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand border-brand text-white font-bold hover:bg-brand-dark hover:border-brand-dark",
  quiet: "bg-card border-line-strong text-ink font-bold hover:bg-brand-tint",
  gold: "bg-card border-gold-line text-gold font-bold hover:bg-gold-tint",
  ghost: "bg-transparent border-transparent text-ink-2 font-bold hover:text-ink hover:bg-ground",
};

export function Button({
  variant = "quiet", className, small, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl border text-sm cursor-pointer whitespace-nowrap transition-colors",
        small ? "min-h-11 px-3 text-[13px]" : "min-h-11 px-4",
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
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="flex flex-col gap-1 min-w-0 grow">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="m-0 text-[26px] leading-9 font-extrabold tracking-[-0.3px]">
          {accent ? <><span className="text-brand">{accent}</span> {title}</> : title}
        </h1>
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("text-muted", className)}>{children}</span>;
}

/* --- cards and tiles ----------------------------------------------------- */

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: "gold" }) {
  return (
    <div className={cx("card", tone === "gold" && "border-gold-line bg-gold-tint", className)}>{children}</div>
  );
}

export function StatTile({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "gold" }) {
  return (
    <Card tone={tone} className="px-4 py-3.5 flex flex-col gap-1 min-w-0">
      <span className={cx("eyebrow !tracking-[0.06em]", tone === "gold" ? "text-gold" : "text-ink-2")}>{label}</span>
      <span className={cx("text-[30px] leading-9 font-extrabold truncate", tone === "gold" ? "text-gold" : "text-ink")}>{value}</span>
      {hint !== undefined && <span className={cx("text-[13px] leading-[18px]", tone === "gold" ? "text-gold-ink" : "text-muted")}>{hint}</span>}
    </Card>
  );
}

/** A thin progress bar. The numbers beside it say the same thing in words. */
export function Progress({ done, total, tone = "brand", label }: { done: number; total: number; tone?: "brand" | "ok" | "gold"; label?: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const fill = tone === "ok" ? "bg-ok-fill" : tone === "gold" ? "bg-[#E07A1F]" : "bg-brand";
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="block h-1.5 w-full min-w-10 rounded-full bg-line-soft overflow-hidden"
    >
      <span className={cx("block h-full rounded-full", fill)} style={{ width: `${pct}%` }} />
    </span>
  );
}

/* --- pills and chips ----------------------------------------------------- */

/** Status colour always comes with the word inside the pill. */
type PillTone = "ok" | "warn" | "muted" | "info" | "arriving" | "stored" | "leaving" | "problem" | "warning";
const PILLS: Record<PillTone, string> = {
  ok: "bg-ok-tint text-ok",
  warn: "bg-gold-tint text-gold",
  muted: "bg-ground text-ink-2",
  info: "bg-brand-tint text-brand-dark",
  arriving: "bg-arriving text-arriving-ink",
  stored: "bg-stored text-stored-ink",
  leaving: "bg-leaving text-leaving-ink",
  problem: "bg-problem text-problem-ink",
  warning: "bg-warning text-warning-ink",
};

export function Pill({ tone = "info", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className={cx("inline-block rounded-full px-2.5 py-1 text-xs leading-4 font-extrabold whitespace-nowrap", PILLS[tone])}>
      {children}
    </span>
  );
}

/** A filter chip. The count is a visual extra; the chip's name stays its word. */
export function Chip({ active, children, onClick, count }: { active?: boolean; children: ReactNode; onClick?: () => void; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={onClick ? !!active : undefined}
      className={cx(
        "inline-flex items-center gap-2 min-h-11 rounded-full border px-3.5 text-[13px] leading-4 font-bold whitespace-nowrap cursor-pointer transition-colors",
        active ? "border-brand bg-brand text-white" : "border-line bg-card text-ink hover:bg-brand-tint",
      )}
    >
      {count === undefined ? children : <span>{children}</span>}
      {count !== undefined && (
        <span aria-hidden="true" className={cx(
          "min-w-6 rounded-full px-1.5 py-0.5 text-[11px] leading-4 font-extrabold text-center",
          active ? "bg-white/25 text-white" : "bg-brand-tint text-brand-dark",
        )}>{count}</span>
      )}
    </button>
  );
}

/** Zone kinds the API names, as the three map colours. Kinds with no obvious
 * place on the map (in transit, overflow, line side) get no colour. */
export function zoneLook(kind: string | null | undefined): { tone: "stored" | "leaving"; word: string } | null {
  switch (kind) {
    case "bulk": case "pickface": return { tone: "stored", word: "Stored" };
    case "packing": case "staging": return { tone: "leaving", word: "Leaving" };
    default: return null;
  }
}

/** A location code as a small tile, as the map labels them. */
export function LocCode({ children }: { children: ReactNode }) {
  return <span className="inline-block rounded-lg bg-ground px-2 py-1 mono text-[13px] leading-4 font-bold text-ink whitespace-nowrap">{children}</span>;
}

/* --- forms --------------------------------------------------------------- */

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5 min-w-0", className)}>
      <span className="text-[13px] leading-4 font-bold text-ink-2">{label}</span>
      {children}
      {error ? <span className="text-xs leading-4 font-semibold text-gold">{error}</span>
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </span>
      <input type="search" className="input pl-10 bg-field border-line" {...props} />
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled, icon }: { checked: boolean; onChange?: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; icon?: ReactNode }) {
  return (
    <label className={cx("flex items-center justify-between gap-4 py-2.5 min-h-11 row-line last:border-b-0", disabled && "opacity-60")}>
      {icon && <span aria-hidden="true" className="grid place-items-center w-10 h-10 shrink-0 rounded-xl bg-brand-tint text-brand">{icon}</span>}
      <span className="flex flex-col gap-0.5 min-w-0 grow">
        <span className="text-sm leading-5 font-bold text-ink">{label}</span>
        {hint && <span className="text-xs leading-4 text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cx(
          "relative shrink-0 w-14 h-8 rounded-full border-0 p-0 transition-colors cursor-pointer disabled:cursor-not-allowed",
          checked ? "bg-brand" : "bg-line-strong",
        )}
      >
        <span className={cx(
          "absolute top-1 w-6 h-6 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-all",
          checked ? "left-7" : "left-1",
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
  // Wide tables scroll sideways in their own box rather than getting cut off
  // by the drawer: the row never gets narrower than its columns need.
  const minWidth = columns.reduce((sum, c) => sum + minColumnWidth(c.width), 40 + COLUMN_GAP * (columns.length - 1));
  return (
    <div className="card scroll-x-hint overflow-x-auto overflow-y-hidden">
    <div className="flex flex-col" style={{ minWidth }}>
      <div className="grid gap-x-4 px-5 py-3 eyebrow text-muted border-b border-line-soft" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => <span key={c.key} className={cx("truncate", c.align === "right" && "text-right pr-4")}>{c.header}</span>)}
      </div>
      {rows.length === 0 && <div className="px-5 py-8 text-sm text-muted">{empty ?? "Nothing here yet."}</div>}
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
              "grid gap-x-4 px-5 py-3.5 min-h-11 text-sm leading-5 items-center row-line last:border-b-0",
              onRowClick && "cursor-pointer hover:bg-[#F2F6FF]",
              selected && "bg-brand-tint shadow-[inset_3px_0_0_var(--color-brand)]",
            )}
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((c) => <span key={c.key} className={cx("min-w-0 truncate", c.align === "right" && "text-right pr-4")}>{c.render(row)}</span>)}
          </div>
        );
      })}
    </div>
    </div>
  );
}

/** Space between columns (gap-x-4), so a truncated cell never touches the next. */
const COLUMN_GAP = 16;

/** The least a grid column should get: its fixed width, its minmax floor, or
 * a sensible 120px for a flexible column. */
function minColumnWidth(width: string | undefined): number {
  if (!width) return 120;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(width.trim());
  if (px) return Number(px[1]);
  const mm = /^minmax\(\s*(\d+(?:\.\d+)?)px/.exec(width.trim());
  if (mm) return Math.max(Number(mm[1]), 60);
  return 120;
}

/* --- detail panel -------------------------------------------------------- */

export function DetailPanel({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <aside
      aria-label="Detail"
      className="wm-detail shrink-0 mx-6 mb-6 rounded-[18px] border border-line bg-field p-5 flex flex-col gap-5 @5xl:mx-0 @5xl:mr-6 @5xl:mt-2 @5xl:w-[340px] @5xl:self-start @5xl:max-h-[calc(100%-2rem)] @5xl:overflow-y-auto"
    >
      {children}
      {footer && <div className="flex flex-wrap gap-2 [&>*]:grow">{footer}</div>}
    </aside>
  );
}

export function DetailHeader({ eyebrow, title, subtitle }: { eyebrow: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  // A dash title is the "nothing picked yet" hint. On a wide drawer a panel
  // holding only that steps aside, so the list gets the room.
  return (
    <div className="flex flex-col gap-1" data-idle={title === "—" ? "" : undefined}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div className="text-[22px] leading-7 font-extrabold tracking-tight break-words">{title}</div>
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
          <span className="text-sm leading-5 font-bold text-ink truncate">{it.value}</span>
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
  const cls = tone === "gold" ? "border-gold-line bg-gold-tint text-gold"
    : tone === "ok" ? "border-ok-line bg-ok-tint text-ok"
    : "border-line-soft bg-brand-tint text-ink-2";
  return <div className={cx("rounded-xl border px-3.5 py-2.5 text-sm leading-5", cls)}>{children}</div>;
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
