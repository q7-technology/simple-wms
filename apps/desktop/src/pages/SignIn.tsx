import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Field, Input, Muted } from "../ui";
import { Logo } from "../ui/Logo";

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

  useEffect(() => {
    void api.get<{ enabled: boolean; name: string | null }>("/v1/auth/sso")
      .then(setSso)
      .catch(() => setSso({ enabled: false, name: null }));
  }, []);

  async function startSso() {
    setError(null);
    setBusy(true);
    try {
      const { authorize_url } = await api.get<{ authorize_url: string }>("/v1/auth/sso/start");
      window.location.assign(authorize_url);
    } catch (err) {
      setError(refusal(err));
      setBusy(false);
    }
  }

  if (user) return <Navigate to="/stock" replace />;

  function land() {
    navigate((location.state as { from?: string } | null)?.from ?? "/stock", { replace: true });
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

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-[420px] p-8 rounded-xl border border-line bg-card flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Logo size={48} />
          <div className="flex flex-col gap-0.5">
            <span className="text-2xl leading-none font-semibold tracking-tight">Simple WMS</span>
            <span className="text-xs leading-4 text-muted">Desktop · control</span>
          </div>
        </div>
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
            <Button type="submit" variant="primary" className="h-11" disabled={busy || code.length < 6}>
              {busy ? "Checking…" : "Confirm"}
            </Button>
            <button
              type="button"
              className="text-xs text-muted hover:text-ink bg-transparent border-0 cursor-pointer"
              onClick={() => { setChallenge(null); setCode(""); setError(null); }}
            >
              Sign in as someone else
            </button>
          </>
        ) : (
          <>
            <Field label="Username">
              <Input name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password" error={error ?? undefined}>
              <Input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="h-11" disabled={busy || !username || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </>
        )}
        <div className="flex items-center gap-3">
          <div className="grow h-px bg-line-soft" /><span className="text-xs text-muted">or</span><div className="grow h-px bg-line-soft" />
        </div>
        {sso?.enabled ? (
          <Button type="button" className="h-11" disabled={busy} onClick={() => void startSso()}>
            Sign in with {sso.name ?? "single sign-on"}
          </Button>
        ) : (
          <Muted className="text-xs leading-4 text-center">
            Single sign-on is not set up on this install.
          </Muted>
        )}
        <div className="flex items-center gap-2 text-xs leading-4 text-muted">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8892b0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <span>Admins are asked for a second factor after this step</span>
        </div>
      </form>
    </div>
  );
}
