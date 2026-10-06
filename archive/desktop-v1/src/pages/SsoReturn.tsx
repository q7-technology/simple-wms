import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Notice } from "../ui";
import { Logo } from "../ui/Logo";

/** Where the identity provider sends the browser back to. It carries a code,
 * which is worth nothing without the verifier the API kept. */
export function SsoReturn() {
  const [params] = useSearchParams();
  const { signInWithSso } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  const code = params.get("code");
  const state = params.get("state");
  const refused = params.get("error");

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    if (refused) {
      setError(params.get("error_description") ?? `The provider said no: ${refused}`);
      return;
    }
    if (!code || !state) {
      setError("That link is missing its code. Start again from the sign-in screen.");
      return;
    }
    void (async () => {
      try {
        await signInWithSso(code, state);
        navigate("/stock", { replace: true });
      } catch (err) {
        setError(err instanceof ApiError
          ? err.message
          : "Could not reach the WMS. Try again.");
      }
    })();
  }, [code, state, refused, params, signInWithSso, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-[420px] p-8 rounded-xl border border-line bg-card flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Logo size={48} />
          <div className="flex flex-col gap-0.5">
            <span className="text-2xl leading-none font-semibold tracking-tight">Simple WMS</span>
            <span className="text-xs leading-4 text-muted">
              {error ? "Single sign-on" : "Signing you in…"}
            </span>
          </div>
        </div>
        {error ? (
          <>
            <Notice tone="gold">{error}</Notice>
            <Link to="/sign-in"><Button variant="primary" className="w-full h-11">Back to sign in</Button></Link>
          </>
        ) : (
          <p className="text-sm text-muted m-0">Checking with the provider.</p>
        )}
      </div>
    </div>
  );
}
