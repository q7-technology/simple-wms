import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Field, Input, Muted, Notice } from "../ui";
import { Logo } from "../ui/Logo";
import { WarehouseMap } from "../ui/map/WarehouseMap";

/** Microsoft's provider goes by a few names. Anything else is just single sign-on. */
export function isMicrosoft(name: string | null | undefined): boolean {
  return !!name && /microsoft|entra|azure/i.test(name);
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function SignIn() {
  const { user, signIn, signInWithCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // set once the password is accepted and the phone still has to answer
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // whether this install has a provider at all
  const [sso, setSso] = useState<{ enabled: boolean; name: string | null } | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ enabled: boolean; name: string | null }>("/v1/auth/sso")
      .then(setSso)
      .catch(() => setSso({ enabled: false, name: null }));
  }, []);

  async function startSso() {
    setSsoError(null);
    setBusy(true);
    try {
      const { authorize_url } = await api.get<{ authorize_url: string }>("/v1/auth/sso/start");
      window.location.assign(authorize_url);
    } catch (err) {
      setSsoError(refusal(err));
      setBusy(false);
    }
  }

  if (user) return <Navigate to="/" replace />;

  function land() {
    navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });
  }

  /** What to tell someone when the API says no. It already words it well,
   * so mostly this just starts the sentence with a capital. */
  function refusal(err: unknown): string {
    if (!(err instanceof ApiError)) return "Could not reach the WMS. Try again.";
    if (err.status !== 401) return sentence(err.message);
    const left = (err.body as { tries_left?: number } | null)?.tries_left;
    if (err.code === "wrong_password" && typeof left === "number") {
      return `Wrong username or password · ${left} ${left === 1 ? "try" : "tries"} left`;
    }
    if (err.code === "locked") return sentence(err.message);
    if (err.code === "wrong_code") return "That code is not right. Try the next one.";
    if (err.code === "code_used") return "That code has been used. Wait for the next one.";
    if (err.code === "unknown_challenge") return "That took too long. Start again.";
    return sentence(err.message) || "Wrong username or password";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        await signInWithCode(challenge, code.trim());
        land();
        return;
      }
      const result = await signIn(username.trim(), password);
      if (result.needsCode) {
        setChallenge(result.challenge);
        setPassword("");
        return;
      }
      land();
    } catch (err) {
      setError(refusal(err));
      if (err instanceof ApiError && err.code === "unknown_challenge") {
        setChallenge(null);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  const ssoOn = !!sso?.enabled;
  const microsoft = isMicrosoft(sso?.name);

  return (
    <div className="relative min-h-screen overflow-hidden bg-line-soft flex items-center justify-center p-6 box-border">
      <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center opacity-55">
        <WarehouseMap decorative />
      </div>
      <div aria-hidden="true" className="absolute inset-0 bg-[rgba(230,237,251,0.45)]" />

      <main className="relative w-full max-w-[440px] px-8 py-9 rounded-[28px] bg-card shadow-[0_24px_60px_rgba(24,35,61,0.18)] flex flex-col items-center gap-[18px] box-border">
        <Logo size={64} />
        <div className="text-center">
          <h1 className="m-0 text-[30px] font-extrabold tracking-[-0.4px]">Simple WMS</h1>
          <p className="m-0 mt-1.5 text-[15px] text-ink-2">Your warehouse is waiting. Sign in to start the day.</p>
        </div>

        {ssoOn && !challenge && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void startSso()}
              className="w-full h-14 rounded-[14px] bg-ink text-white font-extrabold text-base border-0 cursor-pointer flex items-center justify-center gap-3 hover:bg-[#24324F] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span aria-hidden="true" className="w-[26px] h-[26px] rounded-md bg-white text-ink grid place-items-center">
                {microsoft ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" fill="currentColor" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.2-8.2M16 7l3 3M14 9l2 2" /></svg>
                )}
              </span>
              {microsoft ? "Sign in with Microsoft" : "Sign in with single sign-on"}
            </button>
            <div className="flex items-center gap-2.5 w-full px-3.5 py-3 rounded-[14px] bg-brand-tint text-left box-border">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-brand-dark"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6Z" /><path d="m9 12 2 2 4-4" /></svg>
              <span className="text-[13px] text-[#2B3A5E]">
                {microsoft ? "Uses your work Microsoft account. No new password to remember."
                  : `Uses your work account${sso?.name ? ` (${sso.name})` : ""}. No new password to remember.`}
              </span>
            </div>
            {ssoError && <div className="w-full"><Notice tone="gold">{ssoError}</Notice></div>}
            <div className="flex items-center gap-3 w-full">
              <div className="grow h-px bg-line" /><span className="text-xs font-bold text-muted">or use a username and password</span><div className="grow h-px bg-line" />
            </div>
          </>
        )}

        <form onSubmit={submit} className="w-full flex flex-col gap-4 text-left">
          {challenge ? (
            <>
              <Field
                label="Code from your authenticator"
                hint="Six digits, from the app on your phone."
                error={error ?? undefined}
              >
                <Input
                  name="one-time-code" inputMode="numeric" autoComplete="one-time-code" autoFocus
                  maxLength={8} className="tracking-[0.4em] text-center text-lg"
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Button type="submit" variant="primary" className="h-12" disabled={busy || code.length < 6}>
                {busy ? "Checking…" : "Confirm"}
              </Button>
              <button
                type="button"
                className="min-h-11 text-[13px] font-bold text-ink-2 hover:text-ink bg-transparent border-0 cursor-pointer"
                onClick={() => { setChallenge(null); setCode(""); setError(null); }}
              >
                Sign in as someone else
              </button>
            </>
          ) : (
            <>
              <Field label="Username">
                <Input name="username" autoComplete="username" autoFocus={!ssoOn} value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label="Password" error={error ?? undefined}>
                <Input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button type="submit" variant={ssoOn ? "quiet" : "primary"} className="h-12" disabled={busy || !username || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </>
          )}
        </form>

        {!ssoOn && sso && (
          <Muted className="text-xs leading-4 text-center">
            Single sign-on is not set up on this install.
          </Muted>
        )}
        <div className="flex items-center gap-2 text-xs leading-4 text-muted">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <span>Admins are asked for a second factor after a password</span>
        </div>
        <p className="m-0 text-[13px] text-muted text-center">Can't get in? Ask whoever runs IT at your work to add you to Simple WMS.</p>
      </main>

      <p className="absolute bottom-4 left-0 right-0 m-0 text-center text-xs text-[#3A4A72]">Simple WMS · open source</p>
    </div>
  );
}
