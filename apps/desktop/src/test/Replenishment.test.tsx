import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Replenishment } from "../pages/Replenishment";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ME = { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "supervisor", warehouses: ["*"], scopes: ["*"], kind: "user" };
const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: {}, active: true };

const base = {
  warehouse: "BAL-WH01", owner: "DEFAULT", needs_supervisor: false, note: null, created_by: null,
  created_at: "2026-09-20T01:00:00Z", started_at: null, completed_at: null, cancelled_at: null,
};
const lineBase = {
  source_line: 1, batch: null, actual_qty: null, variance: null, container_id: null, status: "open", reason: null, completed_at: null,
};
const TASKS = [
  {
    ...base, wms_id: "1", type: "replenish", title: "Replenish PF-01-02-A", status: "in_progress", priority: "normal",
    source_type: "min_max", source_ref: "REP-1001", assigned_to: "Jo", device: "SCN-BAL-02", started_at: "2026-09-20T01:10:00Z",
    progress: { done: 0, total: 1 },
    lines: [{ ...lineBase, line_no: 1, sku: "ABC123", name: "Brake pad set", expected_qty: "48", uom: "EA", from_location: "BK-04-01-C", to_location: "PF-01-02-A" }],
  },
  {
    ...base, wms_id: "2", type: "replenish", title: "Replenish PF-01-06-A", status: "waiting", priority: "normal",
    source_type: "api", source_ref: "REP-1003", assigned_to: null, device: null,
    progress: { done: 0, total: 1 },
    lines: [{ ...lineBase, line_no: 1, sku: "JKL012", name: "Oil filter", expected_qty: "60", uom: "EA", from_location: null, to_location: "PF-01-06-A" }],
  },
  {
    ...base, wms_id: "3", type: "replenish", title: "Replenish PF-01-03-B", status: "waiting", priority: "high",
    source_type: "manual", source_ref: "REP-1004", assigned_to: null, device: null,
    progress: { done: 0, total: 1 },
    lines: [{ ...lineBase, line_no: 1, sku: "DEF456", name: "Rotor 280 mm", expected_qty: "12", uom: "EA", from_location: "BK-05-01-A", to_location: "PF-01-03-B" }],
  },
  {
    ...base, wms_id: "4", type: "count", title: "Count PF-01-02-A", status: "needs_supervisor", priority: "normal", needs_supervisor: true,
    source_type: "count", source_ref: "CNT-0412", assigned_to: "Priya", device: null, started_at: "2026-09-20T01:20:00Z",
    progress: { done: 0, total: 1 },
    lines: [{
      ...lineBase, line_no: 1, sku: "ABC123", name: "Brake pad set", expected_qty: "48", actual_qty: "46", variance: "-2", uom: "EA",
      from_location: "PF-01-02-A", to_location: null, status: "variance", completed_at: new Date().toISOString(),
    }],
  },
];
const PRODUCTS = [
  { wms_id: "1", owner: "DEFAULT", sku: "ABC123", name: "Brake pad set", uom: "EA", decimals_allowed: false, batch_tracked: false, preferred_zone: "PICKFACE", pickface_min: "48", pickface_max: "96", barcodes: [], active: true },
  { wms_id: "2", owner: "DEFAULT", sku: "JKL012", name: "Oil filter", uom: "EA", decimals_allowed: false, batch_tracked: false, preferred_zone: null, pickface_min: null, pickface_max: null, barcodes: [], active: true },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/replenishment"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/replenishment" element={<Replenishment />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Replenishment and counts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900 });
      if (path === "/v1/auth/me") return json(200, ME);
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/tasks") return json(200, { items: TASKS, total: TASKS.length });
      if (path === "/v1/products") return json(200, { items: PRODUCTS, total: PRODUCTS.length });
      if (path === "/v1/stock") return json(200, {
        sku: "ABC123", uom: "EA", total_on_hand: "166", total_available: "166",
        locations: [
          { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: null, owner: "DEFAULT", on_hand: "46", reserved: "0", available: "46", received_at: "2026-08-30" },
          { warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", batch: null, owner: "DEFAULT", on_hand: "120", reserved: "0", available: "120", received_at: "2026-09-03" },
        ],
      });
      if (path === "/v1/tasks/4/lines/1/approve" && init?.method === "POST") {
        return json(202, { message_id: "m", wms_id: "4", status: "accepted", task: { ...TASKS[3], status: "done" }, line: null });
      }
      return json(404, { detail: `no route ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); api.setSession(null); });

  it("lists open tasks with the right pills and the tiles", async () => {
    renderPage();
    expect(await screen.findByText("REP-1001")).toBeInTheDocument();
    expect(screen.getByText("Ballarat · pick face")).toBeInTheDocument();

    // pills
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting")).toHaveLength(2);
    expect(screen.getByText("Variance −2")).toBeInTheDocument();

    // columns
    expect(screen.getByText("ABC123 · Brake pad set")).toBeInTheDocument();
    expect(screen.getByText("FIFO")).toBeInTheDocument();
    expect(screen.getByText("48 EA")).toBeInTheDocument();
    expect(screen.getByText("46 of 48")).toBeInTheDocument();
    expect(screen.getByText("PF-01-02-A · count")).toBeInTheDocument();
    expect(screen.getByText("Min/max")).toBeInTheDocument();
    expect(screen.getByText("API · ERP")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Cycle count")).toBeInTheDocument();
    expect(screen.getByText("Jo · SCN-BAL-02")).toBeInTheDocument();
    expect(screen.getByText("Priya · approve?")).toBeInTheDocument();
    expect(screen.getByText("Priority: high")).toHaveClass("text-gold");

    // tiles
    const variances = screen.getByText("Variances to approve").parentElement as HTMLElement;
    expect(within(variances).getByText("1")).toHaveClass("text-gold");
    expect(within(variances).getByText("−2 EA")).toBeInTheDocument();
    const replens = screen.getByText("Replen tasks open").parentElement as HTMLElement;
    expect(within(replens).getByText("3")).toBeInTheDocument();
    expect(within(replens).getByText("1 in progress")).toBeInTheDocument();
    const below = screen.getByText("Below minimum").parentElement as HTMLElement;
    expect(await within(below).findByText("1")).toBeInTheDocument();

    const tasksCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/tasks?"));
    expect(tasksCall).toContain("warehouse=BAL-WH01");
    expect(tasksCall).toContain("type=replenish%2Ccount");
    expect(tasksCall).toContain("status=waiting%2Cin_progress%2Cneeds_supervisor");
    const stockCalls = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith("/v1/stock?"));
    expect(stockCalls).toHaveLength(1);
    expect(stockCalls[0]).toContain("sku=ABC123");
  });

  it("filters to counts and approves a variance with a reason", async () => {
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("CNT-0412")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Needs a supervisor" }));
    expect(screen.queryByText("REP-1001")).not.toBeInTheDocument();

    await user.click(screen.getByText("CNT-0412"));
    const panel = screen.getByLabelText("Detail");
    expect(within(panel).getByText("Cycle count · variance")).toBeInTheDocument();
    expect(within(panel).getByText(/PF-01-02-A · counted by Priya · \d\d:\d\d/)).toBeInTheDocument();
    expect(within(panel).getByText("−2 EA")).toBeInTheDocument();
    expect(within(panel).getByText("Not yet")).toBeInTheDocument();
    expect(within(panel).getByText("ABC123 min / max")).toBeInTheDocument();
    expect(within(panel).getByText("48 / 96")).toBeInTheDocument();
    expect(within(panel).getByText("Below 48 at end of pick")).toBeInTheDocument();

    const approve = within(panel).getByRole("button", { name: "Approve adjustment" });
    expect(approve).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Damaged" }));
    expect(approve).toBeEnabled();
    await user.click(approve);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/tasks/4/lines/1/approve");
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.reason).toBe("damaged");
      expect(body.note).toBeNull();
      expect(typeof body.message_id).toBe("string");
      expect(body.message_id.length).toBeGreaterThan(10);
    });
    // the list is reloaded after approving
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith("/v1/tasks?")).length).toBeGreaterThanOrEqual(2);
    });
  });
});
