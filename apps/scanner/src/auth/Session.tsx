import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { RetryQueue } from "../lib/queue";

export interface OperatorSession {
  token: string;
  expires_in: number;
  operator: { code: string; name: string; roles: string[]; supervisor: boolean };
  warehouses: string[];
  device: string;
  idle_logout_minutes: number;
}

interface State {
  session: OperatorSession | null;
  device: string;
  setDevice: (code: string) => void;
  warehouse: string;
  setWarehouse: (code: string) => void;
  online: boolean;
  queue: RetryQueue;
  queued: number;
  idleLeftSeconds: number;
  touch: () => void;
  signIn: (body: { operator_id?: string; pin?: string; badge?: string }) => Promise<OperatorSession>;
  signOut: () => void;
  lastError: string | null;
}

const Ctx = createContext<State | null>(null);
const DEVICE_KEY = "wms.scanner.device";
const WAREHOUSE_KEY = "wms.scanner.warehouse";
const SESSION_KEY = "wms.scanner.session";

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { value === null ? window.localStorage.removeItem(key) : window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

export const queue = new RetryQueue({
  send: ({ path, body }) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json",
      ...(api.session?.token ? { Authorization: `Bearer ${api.session.token}` } : {}) },
    body,
  }),
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<OperatorSession | null>(() => {
    const raw = read(SESSION_KEY);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as OperatorSession;
      api.setSession({ token: s.token, refresh_token: "", expires_in: s.expires_in });
      return s;
    } catch { return null; }
  });
  const [device, setDeviceState] = useState(() => read(DEVICE_KEY) ?? "");
  const [warehouse, setWarehouseState] = useState(() => read(WAREHOUSE_KEY) ?? "");
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [queued, setQueued] = useState(queue.pending().length);
  const [idleLeftSeconds, setIdleLeft] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const lastTouch = useRef(Date.now());

  useEffect(() => {
    const up = () => { setOnline(true); void queue.drain(); };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const unsub = queue.subscribe(() => setQueued(queue.pending().length));
    const tick = setInterval(() => { if (navigator.onLine && queue.pending().length) void queue.drain(); }, 15000);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); unsub(); clearInterval(tick); };
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
    api.setSession(null);
    write(SESSION_KEY, null);
  }, []);

  // idle logout: the warehouse says how long
  useEffect(() => {
    if (!session) return;
    const limit = session.idle_logout_minutes * 60;
    const timer = setInterval(() => {
      const idle = Math.floor((Date.now() - lastTouch.current) / 1000);
      setIdleLeft(Math.max(0, limit - idle));
      if (idle >= limit) signOut();
    }, 1000);
    const bump = () => { lastTouch.current = Date.now(); };
    for (const ev of ["keydown", "pointerdown", "touchstart"]) window.addEventListener(ev, bump);
    return () => { clearInterval(timer); for (const ev of ["keydown", "pointerdown", "touchstart"]) window.removeEventListener(ev, bump); };
  }, [session, signOut]);

  useEffect(() => { api.onSignedOut = () => signOut(); }, [signOut]);

  const setDevice = useCallback((code: string) => { setDeviceState(code); write(DEVICE_KEY, code); }, []);
  const setWarehouse = useCallback((code: string) => { setWarehouseState(code); write(WAREHOUSE_KEY, code); }, []);

  const signIn = useCallback(async (body: { operator_id?: string; pin?: string; badge?: string }) => {
    setLastError(null);
    try {
      const s = await api.post<OperatorSession>("/v1/auth/scanner-login", { device_id: device, warehouse, ...body });
      api.setSession({ token: s.token, refresh_token: "", expires_in: s.expires_in });
      write(SESSION_KEY, JSON.stringify(s));
      lastTouch.current = Date.now();
      setSession(s);
      return s;
    } catch (e) {
      setLastError(e instanceof ApiError ? e.message : "Could not reach the WMS");
      throw e;
    }
  }, [device, warehouse]);

  const touch = useCallback(() => { lastTouch.current = Date.now(); }, []);

  const value = useMemo<State>(() => ({
    session, device, setDevice, warehouse, setWarehouse, online, queue, queued, idleLeftSeconds, touch, signIn, signOut, lastError,
  }), [session, device, setDevice, warehouse, setWarehouse, online, queued, idleLeftSeconds, touch, signIn, signOut, lastError]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
