import { Link } from "react-router-dom";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useSessionOptional } from "../auth/Session";
import { DingToast } from "./ding";

export { ding, DingToast } from "./ding";

export function cx(...parts: (string | false | null | undefined)[]) { return parts.filter(Boolean).join(" "); }

/* --- icons (inline stroke SVG, always aria-hidden) ------------------------- */

export function Icon({ children, size = 24, stroke = 2, className }: { children: ReactNode; size?: number; stroke?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className}>{children}</svg>
  );
}
export const BackIcon = () => <Icon size={22} stroke={2.2}><path d="M15 6l-6 6 6 6" /></Icon>;
export const ScanIcon = ({ size = 26 }: { size?: number }) => <Icon size={size}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M8 9v6M11 9v6M14 9v6M17 9v6" /></Icon>;
export const LockIcon = ({ size = 24 }: { size?: number }) => <Icon size={size}><rect width="16" height="11" x="4" y="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Icon>;
export const BadgeIcon = ({ size = 24 }: { size?: number }) => <Icon size={size}><rect width="16" height="18" x="4" y="3" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M8 17c1-2 2.5-3 4-3s3 1 4 3" /></Icon>;
export const CheckIcon = ({ size = 16 }: { size?: number }) => <Icon size={size} stroke={2.6}><path d="m5 12 5 5 9-10" /></Icon>;
export const AlertIcon = ({ size = 24 }: { size?: number }) => <Icon size={size}><path d="M12 3 2 20h20Z" /><path d="M12 10v4M12 17h.01" /></Icon>;
export const WifiOffIcon = ({ size = 22 }: { size?: number }) => <Icon size={size}><path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01M3 3l18 18" /></Icon>;
export const MinusIcon = () => <Icon size={24} stroke={2.6}><path d="M5 12h14" /></Icon>;
export const PlusIcon = () => <Icon size={24} stroke={2.6}><path d="M12 5v14M5 12h14" /></Icon>;

/* --- screen frame -------------------------------------------------------- */

/** A whole scanner screen: fills the phone, never scrolls itself (Main does),
 * and is the anchor for the Ding toast and any pop-up. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-full min-h-0 flex flex-col bg-ground text-ink overflow-hidden">
      {children}
      <DingToast />
    </div>
  );
}

export function DeviceChip({ children }: { children: ReactNode }) {
  return <span className="shrink-0 px-2.5 py-1.5 rounded-full bg-card border border-line text-xs leading-4 font-extrabold text-muted whitespace-nowrap max-w-[40%] truncate">{children}</span>;
}

/** Back button, the job in big type, the reference and who is working
 * underneath, and the device chip. */
export function Header({ eyebrow, title, right, back = "/" }: { eyebrow: ReactNode; title: ReactNode; right?: ReactNode; back?: string | null }) {
  const ctx = useSessionOptional();
  const device = ctx ? (ctx.device || ctx.session?.device || "") : "";
  return (
    <header className="px-4 pt-4 pb-2 flex items-center gap-2.5 shrink-0">
      {back !== null && (
        <Link to={back} aria-label="Back to menu" className="w-11 h-11 shrink-0 grid place-items-center rounded-[14px] bg-card border border-line text-ink no-underline">
          <BackIcon />
        </Link>
      )}
      <div className="flex flex-col grow min-w-0">
        <span className="text-lg leading-tight font-extrabold truncate">{eyebrow}</span>
        <span className="text-xs leading-4 text-muted font-semibold truncate">
          <span>{title}</span>
          {right && <><span aria-hidden="true"> · </span><span>{right}</span></>}
        </span>
      </div>
      {device && <DeviceChip>{device}</DeviceChip>}
    </header>
  );
}

export function Main({ children }: { children: ReactNode }) {
  return <main className="grow min-h-0 px-4 pt-1 pb-3 flex flex-col gap-3 overflow-y-auto [&>*]:shrink-0">{children}</main>;
}

export function Footer({ children }: { children: ReactNode }) {
  return <footer className="px-4 pt-2 pb-4 flex gap-2.5 shrink-0 [&>*]:basis-0 [&>*]:grow [&>*:last-child]:grow-[1.6]">{children}</footer>;
}

/* --- buttons --------------------------------------------------------------- */

type Variant = "primary" | "quiet" | "gold" | "outline" | "ink" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand border-brand text-white disabled:bg-[#8FA9DE] disabled:border-[#8FA9DE]",
  quiet: "bg-card border-line-strong text-ink disabled:opacity-50",
  gold: "bg-warn-tint border-warn-tint text-warn-ink disabled:opacity-50",
  outline: "bg-card border-ink text-ink disabled:opacity-50",
  ink: "bg-ink border-ink text-white disabled:opacity-50",
  danger: "bg-card border-line-strong text-bad-ink disabled:opacity-50",
};

export function Button({ variant = "quiet", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button type="button" className={cx("min-h-14 h-[58px] px-3 rounded-2xl border-2 text-[17px] leading-tight font-extrabold cursor-pointer disabled:cursor-not-allowed active:brightness-95", VARIANTS[variant], className)} {...props} />
  );
}

/** Link classes that look like a Button. */
export function linkButton(variant: Variant = "quiet") {
  return cx("min-h-14 h-[58px] px-4 rounded-2xl border-2 text-[17px] font-extrabold no-underline flex items-center justify-center text-center", VARIANTS[variant]);
}

/* --- cards ------------------------------------------------------------------ */

export function ProgressRow({ label, done, total }: { label: ReactNode; done: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <span className="text-sm leading-5 font-extrabold whitespace-nowrap">{label}</span>
      <div role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="grow h-3 rounded-full bg-line overflow-hidden">
        <div className="h-full rounded-full bg-ok-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Card({ children, className, strong }: { children: ReactNode; className?: string; strong?: boolean }) {
  return <section className={cx("card p-4 flex flex-col gap-2.5", strong && "border-2 border-brand", className)}>{children}</section>;
}

/** The one big place to look. `tone="go"` is the blue "go here" card. */
export function BigLocation({ eyebrow, code, hint, hint2, tone }: { eyebrow: ReactNode; code: ReactNode; hint?: ReactNode; hint2?: ReactNode; tone?: "go" | "gold" }) {
  const label = typeof eyebrow === "string" ? eyebrow : undefined;
  if (tone === "go") {
    return (
      <section aria-label={label} className="px-4 py-3.5 rounded-[18px] bg-brand text-white flex flex-col gap-1 shadow-soft shrink-0">
        <span className="eyebrow">{eyebrow}</span>
        <span className="text-[34px] leading-[1.1] font-extrabold tracking-tight break-all">{code}</span>
        {hint && <span className="text-[13px] leading-[18px] font-semibold">{hint}</span>}
        {hint2 && <span className="text-[13px] leading-[18px] font-semibold">{hint2}</span>}
      </section>
    );
  }
  return (
    <section aria-label={label} className={cx("card px-4 py-3.5 flex flex-col gap-1 shrink-0", tone === "gold" && "border-2 border-gold-line")}>
      <span className="eyebrow text-faint">{eyebrow}</span>
      <span className={cx("text-[30px] leading-[1.1] font-extrabold tracking-tight break-all", tone === "gold" && "text-gold")}>{code}</span>
      {hint && <span className="text-[13px] leading-[18px] font-semibold text-muted">{hint}</span>}
      {hint2 && <span className="text-xs leading-4 text-faint">{hint2}</span>}
    </section>
  );
}

export function ProductCard({ sku, name, pill, big, bigHint }: { sku: ReactNode; name: ReactNode; pill?: ReactNode; big?: ReactNode; bigHint?: ReactNode }) {
  return (
    <Card>
      <div className="flex justify-between items-start gap-3">
        <div className="flex flex-col min-w-0">
          <span className="text-xl leading-7 font-extrabold truncate">{sku}</span>
          <span className="text-sm leading-5 text-muted truncate">{name}</span>
        </div>
        {pill}
      </div>
      {big !== undefined && (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[34px] leading-none font-extrabold">{big}</span>
          <span className="text-[15px] leading-5 text-muted">{bigHint}</span>
        </div>
      )}
    </Card>
  );
}

export type PillTone = "muted" | "warn" | "info" | "ok" | "bad";
export function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: PillTone }) {
  const cls = {
    muted: "bg-ground border-line text-muted",
    warn: "bg-warn-tint border-warn-tint text-warn-ink",
    info: "bg-brand-tint border-brand-tint text-brand-dark",
    ok: "bg-ok-tint border-ok-tint text-ok",
    bad: "bg-bad-tint border-bad-tint text-bad-ink",
  }[tone];
  return <span className={cx("inline-block shrink-0 px-2.5 py-1 rounded-full text-xs leading-4 font-extrabold whitespace-nowrap border", cls)}>{children}</span>;
}

/** The dashed "scan this" box: what the scanner is waiting for. */
export function ScanHint({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <section className="min-h-16 px-3.5 py-2.5 rounded-2xl border-2 border-dashed border-brand bg-card flex items-center gap-3 shrink-0">
      <span className="w-11 h-11 shrink-0 rounded-[14px] bg-brand text-white grid place-items-center"><ScanIcon size={24} /></span>
      <div className="flex flex-col min-w-0">
        <span className="text-[17px] leading-6 font-extrabold text-ink">{children}</span>
        {sub && <span className="text-xs leading-4 text-muted">{sub}</span>}
      </div>
    </section>
  );
}

/** The supervisor's badge box: dashed, with a badge icon. */
export function SupervisorPanel({ children, sub }: { children?: ReactNode; sub?: ReactNode }) {
  return (
    <section className="min-h-[88px] px-4 py-3 rounded-[22px] border-2 border-dashed border-brand bg-card flex items-center gap-3 shrink-0">
      <span className="w-12 h-12 shrink-0 rounded-[14px] bg-warn-tint text-warn-ink grid place-items-center"><BadgeIcon size={26} /></span>
      <div className="flex flex-col min-w-0">
        <span className="text-[17px] leading-6 font-extrabold text-ink">{children ?? "Supervisor: scan your badge"}</span>
        {sub && <span className="text-[13px] leading-[18px] text-muted">{sub}</span>}
      </div>
    </section>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "gold" | "ok" | "bad"; children: ReactNode }) {
  const cls = {
    gold: "bg-warn-tint border-warn-tint text-warn-ink",
    ok: "bg-ok-tint border-ok-tint text-ok",
    bad: "bg-bad-tint border-bad-tint text-bad-ink",
    muted: "bg-card border-line text-muted",
  }[tone];
  return <div className={cx("rounded-2xl border px-3.5 py-2.5 text-sm leading-5 font-semibold shrink-0", cls)}>{children}</div>;
}

/* --- inputs ------------------------------------------------------------------ */

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm leading-5 font-extrabold text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs leading-4 text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...props} />;
}

const STEP_BTN = "w-14 h-14 shrink-0 grid place-items-center rounded-[14px] bg-card border border-line-strong text-ink cursor-pointer active:bg-brand-tint";

/** The scanner's quantity control: big number, big buttons. Decimals allowed when the product says so. */
export function QtyStepper({ value, onChange, label = "Quantity", step = 1, decimals = false, min = 0 }: {
  value: string; onChange: (v: string) => void; label?: ReactNode; step?: number; decimals?: boolean; min?: number;
}) {
  const num = Number(value) || 0;
  const set = (n: number) => onChange(decimals ? String(Math.max(min, Math.round(n * 1000) / 1000)) : String(Math.max(min, Math.round(n))));
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm leading-5 font-extrabold text-ink">{label}</span>
      <div className="flex gap-2">
        <button type="button" aria-label="Less" onClick={() => set(num - step)} className={STEP_BTN}><MinusIcon /></button>
        <input
          type="number" inputMode={decimals ? "decimal" : "numeric"} step={decimals ? "any" : 1} value={value}
          onChange={(e) => onChange(e.target.value)}
          className="grow h-14 min-w-0 box-border text-center text-[28px] font-extrabold rounded-[14px] bg-card border-2 border-line-strong text-ink focus:outline-none focus:border-brand"
        />
        <button type="button" aria-label="More" onClick={() => set(num + step)} className={STEP_BTN}><PlusIcon /></button>
      </div>
    </label>
  );
}

/** Small − / + pair used outside QtyStepper (the tote rows). */
export function StepButton({ dir, label, onClick }: { dir: "less" | "more"; label: string; onClick: () => void }) {
  return <button type="button" aria-label={label} onClick={onClick} className={STEP_BTN}>{dir === "less" ? <MinusIcon /> : <PlusIcon />}</button>;
}

/** Where the work happens: arriving, stored, leaving, or a tool. */
export type TileTone = "arriving" | "stored" | "leaving" | "tool";
const TILE_TONES: Record<TileTone, string> = {
  arriving: "bg-arriving text-arriving-ink",
  stored: "bg-stored text-stored-ink",
  leaving: "bg-leaving text-leaving-ink",
  tool: "bg-line-soft text-brand-dark",
};

export function Tile({ to, label, icon, tone = "tool" }: { to: string; label: ReactNode; icon: ReactNode; tone?: TileTone }) {
  return (
    <Link to={to} className={cx("min-h-[68px] px-1.5 py-2 rounded-2xl flex flex-col items-center justify-center gap-1.5 no-underline active:brightness-95", TILE_TONES[tone])}>
      {icon}
      <span className="text-[13px] leading-[15px] font-extrabold text-center">{label}</span>
    </Link>
  );
}
