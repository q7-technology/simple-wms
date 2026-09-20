import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
  signOut: () => Promise<void>;
  reloadWarehouses: () => Promise<void>;
  can: (scope: string) => boolean;
}

/** Either we are in, or the phone still has to say so. */
export type SignInResult = { needsCode: false } | { needsCode: true; challenge: string };

type LoginReply =
  | (Session & { status?: "signed_in"; user: SessionUser })
  | { status: "totp_required"; challenge: string; expires_in: number };

const Ctx = createContext<AuthState | null>(null);
const WAREHOUSE_KEY = "wms.warehouse";

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

  const can = useCallback((scope: string) => {
    if (!user) return false;
    const area = scope.split(":")[0];
    return user.scopes.includes("*") || user.scopes.includes(scope) || user.scopes.includes(`${area}:*`);
  }, [user]);

  const value = useMemo<AuthState>(() => ({
    ready, user, warehouses, warehouse, setWarehouse, signIn, signInWithCode, signOut,
    reloadWarehouses: loadWarehouses, can,
  }), [ready, user, warehouses, warehouse, setWarehouse, signIn, signInWithCode, signOut,
       loadWarehouses, can]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
