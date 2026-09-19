import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Field, Input } from "../ui";
import { Logo } from "../ui/Logo";

export function SignIn() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/stock" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username.trim(), password);
      navigate((location.state as { from?: string } | null)?.from ?? "/stock", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Wrong username or password" : "Could not reach the WMS. Try again.");
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
        <Field label="Username">
          <Input name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password" error={error ?? undefined}>
          <Input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="h-11" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <div className="flex items-center gap-3">
          <div className="grow h-px bg-line-soft" /><span className="text-xs text-muted">or</span><div className="grow h-px bg-line-soft" />
        </div>
        <Button type="button" className="h-11" disabled title="Single sign-on is configured per site; not set up here yet">
          Sign in with single sign-on
        </Button>
        <div className="flex items-center gap-2 text-xs leading-4 text-muted">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8892b0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <span>Admins are asked for a second factor after this step</span>
        </div>
      </form>
    </div>
  );
}
