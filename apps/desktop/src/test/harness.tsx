import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthContext";

/** The whole app, signed in, at one path. For the map home and the drawer. */

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const SETTINGS = {
  erp_counts_gr: true, batch_from_production_order: true, receipt_tolerance_pct: 2, supplier_tolerance_pct: 5,
  allow_ship_short: false, supervisor_for_short_pick: true, auto_pick_mode: "auto", batch_pick_max_orders: 6,
  idle_logout_minutes: 15, pin_lockout_tries: 5, known_devices_only: true, queue_offline_confirmations: true,
  fifo_by_received_date: true, blind_counts: true, decimals_allowed: true, multi_owner: false,
  gs1_company_prefix: null, sscc_extension_digit: 3, platen_url: null, retry_failed_print_jobs: true,
  default_copies: 1, ledger_retention_years: 7, duplicate_window_hours: 24, allow_hard_deletes: false,
};

export const WAREHOUSE = {
  wms_id: "w1", code: "BAL-WH01", site: "BAL", name: "Ballarat", timezone: null, settings: SETTINGS, active: true,
};

type Handler = (url: string, init: RequestInit) => Response | null | Promise<Response | null>;

/** Signed in as an admin with one warehouse; `more` answers anything else. */
export function stubApi(more: Handler = () => null, opts: { scopes?: string[]; role?: string } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    if (url === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900 });
    if (url === "/v1/auth/logout") return json(200, {});
    if (url === "/v1/auth/me") {
      return json(200, {
        wms_id: "1", username: "leighton", display_name: "Leighton L.", role: opts.role ?? "admin",
        warehouses: ["*"], scopes: opts.scopes ?? ["*"], kind: "user",
      });
    }
    if (url === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
    const answer = await more(url, init);
    return answer ?? json(404, { detail: `no mock for ${init.method ?? "GET"} ${url}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/** Shows where the router is, so a test can see a navigation happen. */
function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

export function renderApp(path: string) {
  api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
        <Where />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The path of a URL without its query string. */
export function path(url: string): string {
  return url.split("?")[0];
}

export function query(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

/** A whole delivery record, as GET /v1/deliveries/{ref} returns it. */
export function deliveryRecord(ref = "SO-2047", over: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  return {
    wms_id: "41", external_ref: ref, owner: "DEFAULT", warehouse: "BAL-WH01", pick_mode: "single",
    priority: "normal", required_by: at.slice(0, 10),
    ship_to: { name: "Ridgeline Hardware", address: "1 Example St", suburb: "Ballarat", state: "VIC", postcode: "3350", country: "AU" },
    carrier_hint: null, carrier: null, tracking_no: null, allow_short: false, status: "allocated", short: false,
    staging_location: null, note: null, created_at: at, allocated_at: at, picked_at: null, packed_at: null,
    shipped_at: null, cancelled_at: null,
    lines: [{
      delivery_line: 10, sku: "ABC123", name: "Brake pad set", batch: null, qty_ordered: "4", qty_allocated: "4",
      qty_picked: "0", qty_shipped: "0", uom: "EA", short_reason: null,
    }],
    packages: [], task: null, pack_task: null, events: [],
    ...over,
  };
}
