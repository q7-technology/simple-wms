import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Users } from "../pages/Users";

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
const NOW = new Date().toISOString();

const USERS = [
  { wms_id: "1", username: "leighton", display_name: "Leighton L.", email: "l@example.com", role: "admin", warehouses: ["*"], active: true, two_factor: true, created_at: NOW, last_login_at: NOW },
  { wms_id: "2", username: "tony", display_name: "Tony S.", email: null, role: "supervisor", warehouses: ["BAL-WH01"], active: true, two_factor: false, created_at: NOW, last_login_at: null },
];
const OPERATORS = [
  { wms_id: "10", code: "op-017", name: "Sam K.", badge: "0042", roles: ["picker", "packer"], warehouses: ["BAL-WH01"], active: true, locked: false, failed_attempts: 0, created_at: NOW },
  { wms_id: "11", code: "op-022", name: "Old account", badge: null, roles: ["picker"], warehouses: ["MEL-WH01"], active: false, locked: false, failed_attempts: 0, created_at: NOW },
];
const DEVICES = [
  { wms_id: "20", code: "SCN-BAL-07", name: "Honeywell CT45", warehouse: "BAL-WH01", active: true, last_seen_at: NOW, created_at: NOW },
  { wms_id: "21", code: "SCN-MEL-01", name: "Zebra TC52", warehouse: "MEL-WH01", active: false, last_seen_at: null, created_at: NOW },
];
const AUDIT = [
  { wms_id: "30", at: NOW, actor_type: "operator", actor: "op-017", action: "pick.short", target_type: "delivery", target: "0080012345", device: "SCN-BAL-07", ip: null, detail: { reason: "not found" } },
  { wms_id: "31", at: NOW, actor_type: "operator", actor: "op-022", action: "operator.locked", target_type: null, target: null, device: "SCN-BAL-08", ip: null, detail: {} },
  { wms_id: "32", at: NOW, actor_type: "user", actor: "leighton", action: "api_client.rotated", target_type: "api_client", target: "Carrier A", device: null, ip: null, detail: {} },
];

function renderUsers() {
  return render(
    <MemoryRouter initialEntries={["/users"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/users" element={<Users />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

describe("Users, roles and devices", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/users") return json(200, { items: USERS, total: USERS.length });
      if (path === "/v1/operators" && init?.method === "POST") return json(201, { wms_id: "12" });
      if (path === "/v1/operators") return json(200, { items: OPERATORS, total: OPERATORS.length });
      if (path === "/v1/devices") return json(200, { items: DEVICES, total: DEVICES.length });
      if (path === "/v1/audit-log") return json(200, { items: AUDIT, total: AUDIT.length });
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists people, scanners and the audit log", async () => {
    renderUsers();
    expect(await screen.findByText("Sam K.")).toBeInTheDocument();
    // desktop users and operators share one table
    expect(screen.getByText("Leighton L.")).toBeInTheDocument();
    expect(screen.getByText("· 2FA on")).toBeInTheDocument();
    expect(screen.getByText("Badge + PIN")).toBeInTheDocument();
    expect(screen.getByText("Picker, Packer")).toBeInTheDocument();
    // one deactivated operator and one deactivated scanner
    expect(screen.getAllByText("Deactivated", { selector: "span.rounded-full" })).toHaveLength(2);
    // scanners
    expect(screen.getByText("SCN-BAL-07", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText("Honeywell CT45")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    // audit rows: action words, desktop for a user with no device, results
    expect(screen.getByText("Pick short 0080012345 · reason: not found")).toBeInTheDocument();
    expect(screen.getByText("Desktop")).toBeInTheDocument();
    expect(screen.getAllByText("Allowed")).toHaveLength(2);
    expect(screen.getByText("Locked out")).toBeInTheDocument();
    const auditCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/audit-log"));
    expect(auditCall).toContain("limit=20");
  });

  it("shows an operator in the detail panel", async () => {
    renderUsers();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Sam K."));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    expect(within(panel).getByText("Operator")).toBeInTheDocument();
    expect(within(panel).getByText("op-017 · badge 0042 · BAL-WH01")).toBeInTheDocument();
    expect(within(panel).getByText("Badge or ID + PIN")).toBeInTheDocument();
    expect(within(panel).getByText("SCN-BAL-07")).toBeInTheDocument();
    expect(within(panel).getByText("15 min")).toBeInTheDocument();
    expect(within(panel).getByText("5 wrong PINs")).toBeInTheDocument();
    expect(within(panel).getByText("No badge needed")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Reset PIN" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("adds an operator with the expected body", async () => {
    renderUsers();
    const user = userEvent.setup();
    await screen.findByText("Sam K.");
    await user.click(screen.getByRole("button", { name: "Add operator" }));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.type(within(panel).getByLabelText("Code"), "op-030");
    await user.type(within(panel).getByLabelText("Name"), "Priya N.");
    await user.type(within(panel).getByLabelText("PIN"), "4321");
    await user.click(within(panel).getByRole("button", { name: "Picker" }));
    await user.click(within(panel).getByRole("button", { name: "Counter" }));
    expect(within(panel).getByLabelText("Warehouses")).toHaveValue("BAL-WH01");
    await user.click(within(panel).getByRole("button", { name: "Create operator" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/operators" && (c[1] as RequestInit)?.method === "POST");
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        code: "op-030", name: "Priya N.", pin: "4321", badge: null, roles: ["picker", "counter"], warehouses: ["BAL-WH01"],
      });
    });
  });
});
