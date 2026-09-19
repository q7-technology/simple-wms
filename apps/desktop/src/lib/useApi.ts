import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

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

/** A pending action with its error, for buttons that call the API. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      return await fn();
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
  }, []);
  return { busy, error, fieldErrors, run, clear: () => { setError(null); setFieldErrors({}); } };
}
