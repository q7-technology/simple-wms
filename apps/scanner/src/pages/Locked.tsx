import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../auth/Session";
import { useScanWedge } from "../lib/useScanWedge";
import { Button, Field, Footer, Input, LockIcon, Notice, Screen, SupervisorPanel, linkButton } from "../ui";
import { BrandRow, errorText, Keypad, PIN_MAX, PinDots } from "./SignIn";

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
      <BrandRow line={configured ? `${device} · ${warehouse} · known device` : "set up this scanner"} />
      <main className="grow min-h-0 px-6 pt-3 pb-3 flex flex-col gap-3.5 overflow-y-auto">
        <section className="flex flex-col items-center gap-3 text-center shrink-0">
          <span className="w-[88px] h-[88px] rounded-[28px] bg-bad-tint text-bad-ink grid place-items-center"><LockIcon size={44} /></span>
          <h1 className="m-0 text-[28px] leading-9 font-extrabold tracking-tight">Account locked</h1>
          <p className="m-0 text-[15px] leading-[22px] text-muted"><b className="mono text-ink">{operator || "This operator"}</b> entered the wrong PIN 5 times.</p>
          <p className="m-0 text-xs leading-4 text-faint">A supervisor can unlock it here or on the desktop. Every try is in the audit log.</p>
        </section>

        {done ? (
          <Notice tone="ok">
            Unlocked. Sign in with the new PIN. <Link to="/sign-in" className="text-ok font-extrabold">Back to sign in</Link>
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
            <div className="flex flex-col gap-2 shrink-0">
              <span className="text-sm leading-5 font-extrabold">New PIN for <span className="mono">{operator || "the operator"}</span></span>
              <PinDots length={pin.length} />
            </div>
            <Keypad
              disabled={busy}
              onDigit={(d) => { setError(null); setPin((p) => (p.length < PIN_MAX ? p + d : p)); }}
              onDelete={() => setPin((p) => p.slice(0, -1))}
              onClear={() => setPin("")}
            />
            {error && <Notice tone="gold">{error}</Notice>}
          </>
        )}

        <div className="flex flex-col gap-2 pt-1 shrink-0">
          <Link to="/sign-in" className={linkButton("outline")}>Sign in as someone else</Link>
        </div>
      </main>
      <Footer>
        {done
          ? <Link to="/sign-in" className={linkButton("primary")}>Back to sign in</Link>
          : <Button variant="primary" onClick={() => void unlock()} disabled={busy || !configured}>Unlock</Button>}
      </Footer>
    </Screen>
  );
}
