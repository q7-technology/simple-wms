import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../auth/Session";
import { useScanWedge } from "../lib/useScanWedge";
import { Button, Field, Footer, Header, Input, Main, Notice, Screen, SupervisorPanel } from "../ui";
import { errorText, Keypad, PIN_MAX, PinDots } from "./SignIn";

const LINK_PRIMARY = "h-14 flex items-center justify-center rounded-md bg-brand border border-brand text-ground text-base font-semibold no-underline";
const LINK_QUIET = "h-14 flex items-center justify-center rounded-md bg-transparent border border-line-strong text-ink text-base font-medium no-underline";

export function Locked() {
  const { device, warehouse } = useSession();
  const [params] = useSearchParams();
  const operator = params.get("operator") ?? "";
  const configured = Boolean(device && warehouse);

  const [badge, setBadge] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useScanWedge((code) => { setBadge(code); setError(null); });

  const unlock = async () => {
    if (!badge.trim()) { setError("Supervisor: scan your badge first."); return; }
    if (pin.length < 4) { setError("The new PIN needs at least 4 digits."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/auth/scanner-unlock", {
        device_id: device, warehouse, operator_id: operator, supervisor_badge: badge.trim(), new_pin: pin,
      });
      setDone(true);
    } catch (e) {
      setError(errorText(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header back={null} eyebrow="Simple WMS" title={configured ? `${device} · ${warehouse} · known device` : "set up this scanner"} />
      <Main>
        <section className="rounded-xl border border-gold-line bg-card px-5 py-6 flex flex-col items-center gap-3 text-center">
          <div className="w-16 h-16 rounded-full bg-gold-tint flex items-center justify-center">
            <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f7941d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className="m-0 text-2xl leading-tight font-bold text-gold">Account locked</h1>
          <p className="m-0 text-sm leading-5 text-ink"><span className="mono">{operator || "This operator"}</span> entered the wrong PIN 5 times.</p>
          <p className="m-0 text-xs leading-4 text-muted">A supervisor can unlock it here or on the desktop. Every try is in the audit log.</p>
        </section>

        {done ? (
          <Notice tone="ok">
            Unlocked. Sign in with the new PIN. <Link to="/sign-in" className="text-brand font-medium">Back to sign in</Link>
          </Notice>
        ) : (
          <>
            <SupervisorPanel sub={`Then ${operator || "the operator"} sets a new PIN`}>Supervisor: scan your badge to unlock</SupervisorPanel>
            <Field label="Supervisor badge">
              <Input
                data-scan="true" value={badge} onChange={(e) => setBadge(e.target.value)}
                autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="done" disabled={busy} className="mono"
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs leading-4 text-muted">New PIN for <span className="mono">{operator || "the operator"}</span></span>
              <PinDots length={pin.length} />
            </div>
            <Keypad
              disabled={busy}
              onDigit={(d) => { setError(null); setPin((p) => (p.length < PIN_MAX ? p + d : p)); }}
              onDelete={() => setPin((p) => p.slice(0, -1))}
            />
            {error && <Notice tone="gold">{error}</Notice>}
          </>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <span className="text-xs leading-4 text-muted">Or sign in as someone else</span>
          <Link to="/sign-in" className={LINK_QUIET}>Sign in</Link>
        </div>
      </Main>
      <Footer>
        {done
          ? <Link to="/sign-in" className={LINK_PRIMARY}>Back to sign in</Link>
          : <Button variant="primary" onClick={() => void unlock()} disabled={busy || !configured}>Unlock</Button>}
      </Footer>
    </Screen>
  );
}
