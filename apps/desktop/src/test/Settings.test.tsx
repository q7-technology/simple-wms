import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Settings } from "../pages/Settings";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SETTINGS = {
  erp_counts_gr: true, batch_from_production_order: true, receipt_tolerance_pct: 2, supplier_tolerance_pct: 5,
  allow_ship_short: false, supervisor_for_short_pick: true, auto_pick_mode: "auto", batch_pick_max_orders: 6,
  idle_logout_minutes: 15, pin_lockout_tries: 5, known_devices_only: true, queue_offline_confirmations: true,
  fifo_by_received_date: true, blind_counts: true, decimals_allowed: true, platen_url: "https://platen.internal/jobs",
  retry_failed_print_jobs: true, default_copies: 1, ledger_retention_years: 7, duplicate_window_hours: 24,
  allow_hard_deletes: false,
};
const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: SETTINGS, active: true };

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/settings" element={<Settings />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

describe("Settings", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/warehouses/BAL-WH01") return json(200, WAREHOUSE);
      if (path === "/v1/warehouses/BAL-WH01/settings" && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        return json(200, { ...WAREHOUSE, settings: { ...SETTINGS, ...body } });
      }
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the warehouse switches and values", async () => {
    renderSettings();
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("· BAL-WH01")).toBeInTheDocument();
    expect(await screen.findByText("ERP already counts production stock")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /ERP already counts production stock/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Ship short allowed/ })).not.toBeChecked();
    expect(screen.getByLabelText("Over-receipt tolerance %")).toHaveValue(2);
    expect(screen.getByLabelText("Idle logout (min)")).toHaveValue(15);
    expect(screen.getByLabelText("Platen URL")).toHaveValue("https://platen.internal/jobs");
    expect(screen.getByText("This one cannot be switched on. Kept here so nobody asks.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Allow hard deletes/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("patches only the keys that changed", async () => {
    renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: /Ship short allowed/ }));
    const tolerance = screen.getByLabelText("Over-receipt tolerance %");
    await user.clear(tolerance);
    await user.type(tolerance, "10");
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/warehouses/BAL-WH01/settings");
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).method).toBe("PATCH");
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ allow_ship_short: true, receipt_tolerance_pct: 10 });
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Ship short allowed/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // the warehouse list is refreshed so the header and the rest of the app see the new values
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/v1/warehouses").length).toBeGreaterThan(1);
  });
});
