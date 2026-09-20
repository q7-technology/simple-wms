import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Session } from "../api/client";
import type { Me, SessionUser, Warehouse } from "../api/types";

interface AuthState {
  ready: boolean;
  user: Me | null;
  warehouses: Warehouse[];
  warehouse: Warehouse | null;
  setWarehouse: (code: string) => void;
  signIn: (username: string, password: string) => Promise<SignInResult>;
  signInWithCode: (challenge: string, code: string) => Promise<void>;
  signInWithSso: (code: string, state: string) => Promise<void>;
  signOut: () => Promise<void>;
  reloadWarehouses: () => Promise<void>;
  can: (scope: string) => boolean;
  /** Seconds left before an idle screen signs itself out. 0 when nobody is in. */
  idleLeftSeconds: number;
  /** Someone is still there: start the idle clock again. */
  touch: () => void;
}

/** Either we are in, or the phone still has to say so. */
export type SignInResult = { needsCode: false } | { needsCode: true; challenge: string };

type LoginReply =
  | (Session & { status?: "signed_in"; user: SessionUser })
  | { status: "totp_required"; challenge: string; expires_in: number };

const Ctx = createContext<AuthState | null>(null);
const WAREHOUSE_KEY = "wms.warehouse";
/** The warehouse says how long; until it has, assume a floor, not an office. */
const IDLE_DEFAULT_MINUTES = 15;
const IDLE_EVENTS = ["keydown", "pointerdown", "touchstart"] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<Me | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseCode, setWarehouseCode] = useState<string | null>(() => {
    try { return window.localStorage.getItem(WAREHOUSE_KEY); } catch { return null; }
  });

  const loadWarehouses = useCallback(async () => {
    const page = await api.get<{ items: Warehouse[] }>("/v1/warehouses");
    setWarehouses(page.items);
  }, []);

  const loadMe = useCallback(async () => {
    const me = await api.get<Me>("/v1/auth/me");
    setUser(me);
    await loadWarehouses();
  }, [loadWarehouses]);

  useEffect(() => {
    api.onSignedOut = () => setUser(null);
    (async () => {
      try {
        if (await api.resume()) await loadMe();
      } catch {
        api.setSession(null);
      } finally {
        setReady(true);
      }
    })();
  }, [loadMe]);

  /** The password is only half of it when someone has a second factor. */
  const signIn = useCallback(async (username: string, password: string): Promise<SignInResult> => {
    const body = await api.post<LoginReply>("/v1/auth/login", { username, password });
    if (body.status === "totp_required") {
      return { needsCode: true, challenge: body.challenge };
    }
    api.setSession(body);
    await loadMe();
    return { needsCode: false };
  }, [loadMe]);

  const signInWithSso = useCallback(async (code: string, state: string) => {
    const body = await api.post<Session & { user: SessionUser }>("/v1/auth/sso/callback",
                                                                { code, state });
    api.setSession(body);
    await loadMe();
  }, [loadMe]);

  const signInWithCode = useCallback(async (challenge: string, code: string) => {
    const body = await api.post<Session & { user: SessionUser }>("/v1/auth/login/totp",
                                                                 { challenge, code });
    api.setSession(body);
    await loadMe();
  }, [loadMe]);

  const signOut = useCallback(async () => {
    const refresh = api.session?.refresh_token;
    try {
      if (refresh) await api.post("/v1/auth/logout", { refresh_token: refresh });
    } finally {
      api.setSession(null);
      setUser(null);
      setWarehouses([]);
    }
  }, []);

  const setWarehouse = useCallback((code: string) => {
    setWarehouseCode(code);
    try { window.localStorage.setItem(WAREHOUSE_KEY, code); } catch { /* ignore */ }
  }, []);

  const warehouse = useMemo(() => {
    if (warehouses.length === 0) return null;
    return warehouses.find((w) => w.code === warehouseCode) ?? warehouses[0];
  }, [warehouses, warehouseCode]);

  // Idle logout: a signed-in screen on the warehouse floor should not stay
  // signed in all night. The scanner already does this; so does the desktop.
  const [idleLeftSeconds, setIdleLeft] = useState(0);
  const lastTouch = useRef(Date.now());
  const limit = useRef(IDLE_DEFAULT_MINUTES * 60);
  const idleLimit = (warehouse?.settings?.idle_logout_minutes ?? IDLE_DEFAULT_MINUTES) * 60;

  const touch = useCallback(() => {
    lastTouch.current = Date.now();
    setIdleLeft(limit.current);
  }, []);

  useEffect(() => {
    if (!user) { setIdleLeft(0); return; }
    limit.current = idleLimit;
    lastTouch.current = Date.now();
    setIdleLeft(idleLimit);
    const timer = setInterval(() => {
      const idle = Math.floor((Date.now() - lastTouch.current) / 1000);
      setIdleLeft(Math.max(0, limit.current - idle));
      if (idle >= limit.current) void signOut();
    }, 1000);
    const bump = () => { lastTouch.current = Date.now(); };
    for (const ev of IDLE_EVENTS) window.addEventListener(ev, bump);
    return () => {
      clearInterval(timer);
      for (const ev of IDLE_EVENTS) window.removeEventListener(ev, bump);
    };
  }, [user, idleLimit, signOut]);

  const can = useCallback((scope: string) => {
    if (!user) return false;
    const area = scope.split(":")[0];
    return user.scopes.includes("*") || user.scopes.includes(scope) || user.scopes.includes(`${area}:*`);
  }, [user]);

  const value = useMemo<AuthState>(() => ({
    ready, user, warehouses, warehouse, setWarehouse, signIn, signInWithCode, signInWithSso,
    signOut, reloadWarehouses: loadWarehouses, can, idleLeftSeconds, touch,
  }), [ready, user, warehouses, warehouse, setWarehouse, signIn, signInWithCode, signInWithSso,
       signOut, loadWarehouses, can, idleLeftSeconds, touch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
