import { useReducer, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useSession } from "../auth/Session";
import { useScanWedge } from "../lib/useScanWedge";
import { Button, Card, Field, Icon, Input, LockIcon, Notice, ScanHint, Screen } from "../ui";

export const PIN_MAX = 8;

/** "wrong PIN" from the API reads better as "Wrong PIN" on a screen. */
export function sentence(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** What to tell the operator when a call fails. Network trouble is never their fault. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Could not reach the WMS. Check the Wi-Fi and try again.";
  const left = (e.body as { tries_left?: number } | null)?.tries_left;
  if (e.code === "wrong_pin" && typeof left === "number") return `Wrong PIN · ${left} ${left === 1 ? "try" : "tries"} left`;
  return sentence(e.message);
}

const KEY = "h-14 rounded-2xl bg-card border border-line text-ink text-2xl font-extrabold cursor-pointer active:bg-brand-tint disabled:opacity-50 disabled:cursor-not-allowed";
const KEY_SOFT = "h-14 rounded-2xl bg-transparent border-0 text-muted text-[15px] font-extrabold cursor-pointer grid place-items-center active:bg-brand-tint disabled:opacity-50 disabled:cursor-not-allowed";

/** Numeric keypad: 1 to 9, clear, 0 and delete. Keys are 56 px, the scanner floor. */
export function Keypad({ onDigit, onDelete, onClear, disabled }: { onDigit: (digit: string) => void; onDelete: () => void; onClear?: () => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2 shrink-0" role="group" aria-label="PIN keypad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button key={d} type="button" className={KEY} disabled={disabled} onClick={() => onDigit(d)}>{d}</button>
      ))}
      {onClear ? <button type="button" aria-label="Clear PIN" className={KEY_SOFT} disabled={disabled} onClick={onClear}>Clear</button> : <div />}
      <button type="button" className={KEY} disabled={disabled} onClick={() => onDigit("0")}>0</button>
      <button type="button" aria-label="Delete" className={KEY_SOFT} disabled={disabled} onClick={onDelete}>
        <Icon size={26}><path d="M21 5H9l-6 7 6 7h12Z" /><path d="m12 9 6 6M18 9l-6 6" /></Icon>
      </button>
    </div>
  );
}

/** Masked PIN: a filled dot per digit, at least four slots. */
export function PinDots({ length, slots = 4 }: { length: number; slots?: number }) {
  const n = Math.max(slots, length);
  return (
    <div className="flex justify-center gap-[18px] py-0.5" role="img" aria-label={`${length} digits entered`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i < length ? "w-[18px] h-[18px] box-border rounded-full bg-brand border-2 border-brand" : "w-[18px] h-[18px] box-border rounded-full border-2 border-brand"} />
      ))}
    </div>
  );
}

/** The scanner's brand row on the sign-in screens: logo, name, which scanner. */
export function BrandRow({ line, action }: { line: ReactNode; action?: ReactNode }) {
  return (
    <header className="px-6 pt-6 pb-1 flex items-center justify-between gap-3 shrink-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <span aria-hidden="true" className="w-10 h-10 shrink-0 rounded-xl bg-brand text-white grid place-items-center">
          <Icon size={22}><path d="M12 3 20 7.5v9L12 21 4 16.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9" /></Icon>
        </span>
        <div className="flex flex-col min-w-0">
          <span className="text-[17px] leading-6 font-extrabold">Simple WMS</span>
          <span className="text-xs leading-4 text-muted font-semibold truncate">{line}</span>
        </div>
      </div>
      {action}
    </header>
  );
}

/** "or type it in" between the badge box and the keypad. */
export function OrDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 eyebrow text-faint shrink-0">
      <span aria-hidden="true" className="grow border-t border-line-strong" />{children}<span aria-hidden="true" className="grow border-t border-line-strong" />
    </div>
  );
}

export function SignIn() {
  const { device, setDevice, warehouse, setWarehouse, signIn } = useSession();
  const navigate = useNavigate();
  const configured = Boolean(device && warehouse);

  const [setup, setSetup] = useState(!configured);
  const [deviceDraft, setDeviceDraft] = useState(device);
  const [warehouseDraft, setWarehouseDraft] = useState(warehouse);
  const [operatorId, setOperatorId] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The wedge clears a scan field's DOM value on Enter; a re-render puts the controlled value back.
  const [, resync] = useReducer((n: number) => n + 1, 0);
  // Was the operator field filled by a person (slow keys) or a scanner (a burst)?
  const typing = useRef({ last: 0, slow: false });

  const save = () => {
    setDevice(deviceDraft.trim());
    setWarehouse(warehouseDraft.trim());
    setSetup(false);
    setError(null);
  };

  const finish = async (body: { operator_id: string; pin: string } | { badge: string }) => {
    if (!configured) {
      setSetup(true);
      setError("Set up this scanner first: its device ID and warehouse.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(body);
      navigate("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && /locked/i.test(e.message)) {
        const who = "operator_id" in body ? body.operator_id : (/^(\S+) is locked/.exec(e.message)?.[1] ?? "");
        navigate(`/locked?operator=${encodeURIComponent(who)}`);
        return;
      }
      setError(errorText(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  const onOperatorChange = (value: string) => {
    const now = Date.now();
    const t = typing.current;
    if (value.length <= 1) typing.current = { last: now, slow: false };
    else { if (now - t.last > 80) t.slow = true; t.last = now; }
    setOperatorId(value);
  };

  useScanWedge((code) => {
    const typed = operatorId.trim();
    if (typed !== "" && typed === code && typing.current.slow) {
      // A person typed their operator ID and pressed Enter: keep it, PIN comes next.
      resync();
      return;
    }
    // A burst is a badge, whether it landed in the field or anywhere on the page.
    setOperatorId("");
    typing.current = { last: 0, slow: false };
    void finish({ badge: code });
  });

  const submit = () => {
    const id = operatorId.trim();
    if (!id) { setError("Type your operator ID or scan your badge."); return; }
    if (!pin) { setError("Type your PIN on the keypad."); return; }
    void finish({ operator_id: id, pin });
  };

  return (
    <Screen>
      <BrandRow
        line={configured ? `${device} · ${warehouse} · known device` : "set up this scanner"}
        action={configured && (
          <button type="button" onClick={() => setSetup((s) => !s)} className="h-11 px-3 -mr-2 bg-transparent border-0 text-brand-dark text-sm font-extrabold cursor-pointer">
            {setup ? "close" : "change"}
          </button>
        )}
      />
      <main className="grow min-h-0 px-6 pt-2 pb-4 flex flex-col gap-3 overflow-y-auto">
        {setup && (
          <Card strong>
            <span className="eyebrow text-faint">This scanner</span>
            <Field label="Device ID">
              <Input value={deviceDraft} onChange={(e) => setDeviceDraft(e.target.value)} placeholder="SCN-BAL-07" autoComplete="off" autoCapitalize="characters" spellCheck={false} className="mono" />
            </Field>
            <Field label="Warehouse code">
              <Input value={warehouseDraft} onChange={(e) => setWarehouseDraft(e.target.value)} placeholder="BAL-WH01" autoComplete="off" autoCapitalize="characters" spellCheck={false} className="mono" />
            </Field>
            <Button variant="primary" onClick={save} disabled={!deviceDraft.trim() || !warehouseDraft.trim()}>Save</Button>
          </Card>
        )}

        <h1 className="m-0 text-[28px] leading-9 font-extrabold tracking-tight shrink-0">Ready to scan?</h1>

        <ScanHint sub="Quickest way in. Hold your badge to the scanner.">Scan your badge</ScanHint>

        <OrDivider>or type it in</OrDivider>

        <Field label="Operator ID">
          <Input
            data-scan="true" value={operatorId} onChange={(e) => onOperatorChange(e.target.value)}
            autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="done" disabled={busy} className="mono"
          />
        </Field>

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-sm leading-5 font-extrabold">PIN</span>
          <PinDots length={pin.length} />
        </div>
        <Keypad
          disabled={busy}
          onDigit={(d) => { setError(null); setPin((p) => (p.length < PIN_MAX ? p + d : p)); }}
          onDelete={() => setPin((p) => p.slice(0, -1))}
          onClear={() => setPin("")}
        />

        {error && <Notice tone="gold">{error}</Notice>}

        <Button variant="primary" className="shrink-0" onClick={submit} disabled={busy || !configured}>Sign in</Button>

        <div className="mt-auto pt-1 flex items-center justify-center gap-1.5 text-center text-xs leading-4 text-faint shrink-0">
          <LockIcon size={14} />
          <span>5 wrong PINs locks your account. A supervisor can unlock it.</span>
        </div>
      </main>
    </Screen>
  );
}
