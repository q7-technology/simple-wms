import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { initials } from "../lib/format";
import { Logo } from "./Logo";

const NAV: { to: string; label: string; step?: number }[] = [
  { to: "/tasks", label: "Tasks" },
  { to: "/deliveries", label: "Deliveries" },
  { to: "/receiving", label: "Receiving" },
  { to: "/production", label: "Production" },
  { to: "/transfers", label: "Transfers" },
  { to: "/stock", label: "Stock" },
  { to: "/locations", label: "Locations" },
  { to: "/products", label: "Products" },
  { to: "/replenishment", label: "Replenishment" },
  { to: "/import", label: "Import" },
  { to: "/integrations", label: "Integrations" },
  { to: "/printing", label: "Printing" },
  { to: "/users", label: "Users" },
  { to: "/reports", label: "Reports" },
  { to: "/settings", label: "Settings" },
];

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin", supervisor: "Supervisor", inventory_controller: "Inventory controller",
  receiver: "Receiver", picker: "Picker", integration: "Integration",
};

export function Shell() {
  const { user, warehouses, warehouse, setWarehouse, signOut } = useAuth();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-16 shrink-0 flex items-center gap-6 px-6 border-b border-line bg-card">
        <div className="flex items-center gap-2.5">
          <Logo size={32} />
          <span className="text-xl font-bold leading-7">Simple WMS</span>
        </div>
        <nav aria-label="Main" className="flex gap-1 ml-4">
          {NAV.map((n) =>
            n.step ? (
              <span key={n.to} title={`Build step ${n.step}`} className="text-sm font-medium leading-5 px-3 py-2 rounded-md text-muted/50 cursor-not-allowed">
                {n.label}
              </span>
            ) : (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  "text-sm font-medium leading-5 px-3 py-2 rounded-md no-underline " +
                  (isActive ? "text-ink bg-brand-tint border border-line-strong" : "text-muted border border-transparent hover:text-ink")
                }
              >
                {n.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="grow" />
        <label className="flex items-center gap-2 text-xs leading-4 text-muted">
          <span>Warehouse</span>
          <select
            aria-label="Warehouse"
            className="input !h-9 !w-auto"
            value={warehouse?.code ?? ""}
            onChange={(e) => setWarehouse(e.target.value)}
          >
            {warehouses.length === 0 && <option value="">No warehouses yet</option>}
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2 text-sm leading-5">
          <div className="w-8 h-8 rounded-full border border-line-strong flex items-center justify-center text-xs font-semibold" title={user?.display_name}>
            {initials(user?.display_name ?? "?")}
          </div>
          <span className="text-muted">{ROLE_LABEL[user?.role ?? ""] ?? user?.role}</span>
          <button type="button" onClick={() => void signOut()} className="text-muted text-xs hover:text-ink cursor-pointer bg-transparent border-0 ml-2">
            Sign out
          </button>
        </div>
      </header>
      <div className="grow flex min-h-0">
        <Outlet />
      </div>
    </div>
  );
}

/** Main column of a screen. Detail panel goes beside it. */
export function Main({ children }: { children: React.ReactNode }) {
  return <main className="grow p-6 flex flex-col gap-6 min-w-0 overflow-y-auto">{children}</main>;
}
