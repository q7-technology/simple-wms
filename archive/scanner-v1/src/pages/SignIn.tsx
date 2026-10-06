import { useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useSession } from "../auth/Session";
import { useScanWedge } from "../lib/useScanWedge";
import { Button, Card, Field, Footer, Header, Input, Main, Notice, ScanHint, Screen } from "../ui";

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

const KEY = "h-16 rounded-lg bg-card border border-line text-ink text-2xl font-semibold cursor-pointer active:bg-brand-tint disabled:opacity-50 disabled:cursor-not-allowed";

/** Numeric keypad: 1 to 9, 0 and delete. Keys are 64 px, above the 56 px floor. */
export function Keypad({ onDigit, onDelete, disabled }: { onDigit: (digit: string) => void; onDelete: () => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="PIN keypad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button key={d} type="button" className={KEY} disabled={disabled} onClick={() => onDigit(d)}>{d}</button>
      ))}
      <div />
      <button type="button" className={KEY} disabled={disabled} onClick={() => onDigit("0")}>0</button>
      <button type="button" aria-label="Delete" className={KEY} disabled={disabled} onClick={onDelete}>⌫</button>
    </div>
  );
}

/** Masked PIN: a filled dot per digit, at least four slots. */
export function PinDots({ length, slots = 4 }: { length: number; slots?: number }) {
  const n = Math.max(slots, length);
  return (
    <div className="flex justify-center gap-4 py-2" role="img" aria-label={`${length} digits entered`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i < length ? "w-4 h-4 rounded-full bg-brand" : "w-4 h-4 rounded-full border border-line-strong"} />
      ))}
    </div>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8892b0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
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
      <Header
        back={null}
        eyebrow="Simple WMS"
        title={configured ? `${device} · ${warehouse} · known device` : "set up this scanner"}
        right={configured && (
          <button type="button" onClick={() => setSetup((s) => !s)} className="h-11 px-2 -mr-2 bg-transparent border-0 text-brand text-xs font-medium cursor-pointer">
            {setup ? "close" : "change"}
          </button>
        )}
      />
      <Main>
        {setup && (
          <Card strong>
            <span className="eyebrow text-muted">This scanner</span>
            <Field label="Device ID">
              <Input value={deviceDraft} onChange={(e) => setDeviceDraft(e.target.value)} placeholder="SCN-BAL-07" autoComplete="off" autoCapitalize="characters" spellCheck={false} className="mono" />
            </Field>
            <Field label="Warehouse code">
              <Input value={warehouseDraft} onChange={(e) => setWarehouseDraft(e.target.value)} placeholder="BAL-WH01" autoComplete="off" autoCapitalize="characters" spellCheck={false} className="mono" />
            </Field>
            <Button variant="primary" onClick={save} disabled={!deviceDraft.trim() || !warehouseDraft.trim()}>Save</Button>
          </Card>
        )}

        <ScanHint sub="or type your operator ID and PIN">Scan your badge</ScanHint>

        <Field label="Operator ID">
          <Input
            data-scan="true" value={operatorId} onChange={(e) => onOperatorChange(e.target.value)}
            autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="done" disabled={busy} className="mono"
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs leading-4 text-muted">PIN</span>
          <PinDots length={pin.length} />
        </div>
        <Keypad
          disabled={busy}
          onDigit={(d) => { setError(null); setPin((p) => (p.length < PIN_MAX ? p + d : p)); }}
          onDelete={() => setPin((p) => p.slice(0, -1))}
        />

        {error && <Notice tone="gold">{error}</Notice>}

        <div className="grow" />
        <div className="flex items-center gap-2">
          <LockIcon />
          <span className="text-xs leading-4 text-muted">5 wrong tries locks this account. A supervisor can unlock it.</span>
        </div>
      </Main>
      <Footer>
        <Button variant="primary" onClick={submit} disabled={busy || !configured}>Sign in</Button>
      </Footer>
    </Screen>
  );
}
