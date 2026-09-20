import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Shell } from "../ui/Shell";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SETTINGS = {
  erp_counts_gr: true, batch_from_production_order: true, receipt_tolerance_pct: 2, supplier_tolerance_pct: 5,
  allow_ship_short: false, supervisor_for_short_pick: true, auto_pick_mode: "auto", batch_pick_max_orders: 6,
  idle_logout_minutes: 15, pin_lockout_tries: 5, known_devices_only: true, queue_offline_confirmations: true,
  fifo_by_received_date: true, blind_counts: true, decimals_allowed: true, multi_owner: false,
  gs1_company_prefix: null, sscc_extension_digit: 3, platen_url: null, retry_failed_print_jobs: true,
  default_copies: 1, ledger_retention_years: 7, duplicate_window_hours: 24, allow_hard_deletes: false,
};

/** 15 minutes, as the warehouse says. */
const LIMIT = 15 * 60;

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/stock"]}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<div>Sign in</div>} />
          <Route element={<RequireAuth />}>
            <Route element={<Shell />}>
              <Route path="/stock" element={<div>Stock page</div>} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Move the clock on and let the one-second tick settle. */
async function idleFor(seconds: number) {
  await act(async () => { vi.advanceTimersByTime(seconds * 1000); });
}

describe("Shell idle logout", () => {
  let posted: string[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    posted = [];
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") posted.push(url);
      if (url === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900 });
      if (url === "/v1/auth/logout") return json(200, {});
      if (url === "/v1/auth/me") {
        return json(200, {
          wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin",
          warehouses: ["*"], scopes: ["*"], kind: "user",
        });
      }
      if (url === "/v1/warehouses") {
        return json(200, {
          items: [{ wms_id: "w1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: SETTINGS, active: true }],
          total: 1,
        });
      }
      return json(404, { detail: `no mock for ${method} ${url}` });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    api.setSession(null);
  });

  it("says nothing while there is plenty of time left", async () => {
    renderShell();
    expect(await screen.findByText("Stock page")).toBeInTheDocument();
    expect(screen.queryByText(/^Signing out in/)).not.toBeInTheDocument();

    // Thirteen minutes of nothing is still not worth a word.
    await idleFor(LIMIT - 180);
    expect(screen.queryByText(/^Signing out in/)).not.toBeInTheDocument();
  });

  it("warns with a countdown under two minutes", async () => {
    renderShell();
    await screen.findByText("Stock page");

    await idleFor(LIMIT - 120);
    expect(screen.getByText("Signing out in 2:00")).toBeInTheDocument();

    await idleFor(15);
    expect(screen.getByText("Signing out in 1:45")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeInTheDocument();
  });

  it("clears the warning when someone says they are still there", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderShell();
    await screen.findByText("Stock page");

    await idleFor(LIMIT - 105);
    expect(screen.getByText("Signing out in 1:45")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stay signed in" }));
    expect(screen.queryByText(/^Signing out in/)).not.toBeInTheDocument();

    // And the clock really did start again.
    await idleFor(60);
    expect(screen.queryByText(/^Signing out in/)).not.toBeInTheDocument();
    expect(screen.getByText("Stock page")).toBeInTheDocument();
  });

  it("signs out when the time runs out", async () => {
    renderShell();
    await screen.findByText("Stock page");

    await idleFor(LIMIT);
    expect(posted).toContain("/v1/auth/logout");
    expect(await screen.findByText("Sign in")).toBeInTheDocument();
  });

  it("keeps the session alive while someone is typing", async () => {
    renderShell();
    await screen.findByText("Stock page");

    for (let i = 0; i < 20; i++) {
      await idleFor(60);
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    }
    expect(posted).not.toContain("/v1/auth/logout");
    expect(screen.getByText("Stock page")).toBeInTheDocument();
  });
});
