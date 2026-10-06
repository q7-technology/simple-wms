import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { ding } from "../ui/toast";

/** Load something from the API and keep it fresh on demand. */
export function useApi<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (!load) { setData(null); return; }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await load();
      if (mine === seq.current) setData(result);
    } catch (e) {
      if (mine === seq.current) {
        setError(e instanceof ApiError ? e.message : "Could not reach the WMS");
        setData(null);
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { void run(); }, [run]);
  return { data, error, loading, reload: run, setData };
}

/** A pending action with its error, for buttons that call the API. A
 * successful action says "Ding!" unless it only looked (a preview, a try). */
export function useAction(opts: { ding?: boolean } = {}) {
  const dings = opts.ding !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = useCallback(async <T,>(fn: () => Promise<T>, runOpts: { ding?: boolean } = {}): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const out = await fn();
      if (dings && runOpts.ding !== false) ding();
      return out;
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fieldErrors);
      } else {
        setError("Could not reach the WMS");
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [dings]);
  return { busy, error, fieldErrors, run, clear: () => { setError(null); setFieldErrors({}); } };
}
