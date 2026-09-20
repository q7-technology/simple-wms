import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Production } from "../pages/Production";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: {}, active: true };

const now = new Date();

const component = (
  n: number, sku: string, name: string, requested: string, issued: string, deliverTo = "LINE-03-IN",
) => ({
  line: n, sku, name, batch: null, qty_requested: requested, qty_issued: issued,
  short: String(Number(requested) - Number(issued)), uom: "EA", deliver_to: deliverTo,
});

const base = {
  owner: "DEFAULT", warehouse: "BAL-WH01", priority: "normal", note: null,
  created_at: now.toISOString(), issued_at: null, completed_at: null, cancelled_at: null,
  receipts: [], issue_task: null,
};

const ORDERS = [
  {
    ...base, wms_id: "p1", external_ref: "PRD-1000456", required_by: "2026-09-22T06:00:00Z",
    status: "in_production", issued_at: now.toISOString(),
    output: { sku: "FG-900", name: "Brake pad set", batch: "B2609A", qty: "500", qty_received: "240", uom: "EA" },
    components: [
      component(1, "RM-120", "Backing plate", "1000", "1000"),
      component(2, "RM-131", "Friction pad", "800", "800"),
    ],
  },
  {
    ...base, wms_id: "p2", external_ref: "PRD-1000457", required_by: "2026-09-22T09:00:00Z",
    status: "issuing",
    output: { sku: "FG-910", name: "Rotor 280 mm", batch: null, qty: "200", qty_received: "0", uom: "EA" },
    components: [
      component(1, "RM-140", "Shim", "1000", "980"),
      component(2, "RM-150", "Clip", "500", "500"),
    ],
  },
  {
    ...base, wms_id: "p3", external_ref: "PRD-1000449", required_by: "2026-09-20T06:00:00Z",
    status: "complete", completed_at: now.toISOString(),
    output: { sku: "FG-910", name: "Rotor 280 mm", batch: "B2601", qty: "200", qty_received: "200", uom: "EA" },
    components: [component(1, "RM-150", "Clip", "400", "400")],
  },
];

const DETAIL = {
  ...ORDERS[0],
  receipts: [
    {
      wms_id: "r1", sku: "FG-900", batch: "B2609A", qty: "120", uom: "EA", location: "BK-04-01-C",
      container_id: null, operator: "op-017", device: "SCN-BAL-07", supervisor: null,
      event_sent: true, created_at: now.toISOString(),
    },
    {
      wms_id: "r2", sku: "FG-900", batch: "B2609A", qty: "120", uom: "EA", location: "BK-04-02-A",
      container_id: null, operator: "op-021", device: "SCN-BAL-07", supervisor: "sup-002",
      event_sent: false, created_at: now.toISOString(),
    },
  ],
  issue_task: {
    wms_id: "7701", type: "production_issue", title: "Issue PRD-1000456", status: "done",
    warehouse: "BAL-WH01", owner: "DEFAULT", priority: "normal", source_type: "production_order",
    source_ref: "PRD-1000456", assigned_to: "Priya", device: "SCN-BAL-07", needs_supervisor: false,
    note: null, created_by: "erp", created_at: now.toISOString(), started_at: now.toISOString(),
    completed_at: now.toISOString(), cancelled_at: null, progress: { done: 2, total: 2 },
    lines: [{
      line_no: 1, source_line: 1, sku: "RM-120", name: "Backing plate", batch: null,
      expected_qty: "1000", actual_qty: "1000", variance: "0", uom: "EA",
      from_location: "BK-01-02-A", to_location: "LINE-03-IN", container_id: null,
      status: "done", reason: null, completed_at: now.toISOString(),
    }],
  },
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/production"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/production" element={<Production />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Production", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") {
        return json(200, {
          wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin",
          warehouses: ["*"], scopes: ["*"], kind: "user",
        });
      }
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/production-orders" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "p9", status: "created", allocation: [] });
      }
      if (path === "/v1/production-orders") return json(200, { items: ORDERS, total: ORDERS.length });
      if (path === "/v1/production-orders/PRD-1000456") return json(200, DETAIL);
      if (path === "/v1/production-orders/PRD-1000460") {
        return json(200, {
          ...ORDERS[1], external_ref: "PRD-1000460", status: "issuing",
          output: { sku: "FG-920", name: "Hub kit", batch: "B2610", qty: "300", qty_received: "0", uom: "EA" },
          components: [component(1, "RM-160", "Hub", "300", "0", "LINE-04-IN")],
        });
      }
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the tiles and a row per order", async () => {
    renderPage();
    expect(await screen.findByText("PRD-1000456")).toBeInTheDocument();
    expect(screen.getByText("2 components at the line")).toBeInTheDocument();
    expect(screen.getByText("200 EA back")).toBeInTheDocument();
    expect(screen.getByText(/^PRD-1000457 · RM-140$/)).toBeInTheDocument();
    expect(screen.getByText("1", { selector: "span.text-gold" })).toBeInTheDocument();

    expect(screen.getByText("In production", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Issuing", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Complete", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Short", { selector: "span.rounded-full" })).toBeInTheDocument();

    expect(screen.getByText("240 / 500 EA")).toBeInTheDocument();
    expect(screen.getByText("2/2 lines issued")).toBeInTheDocument();
    expect(screen.getByText("1/2 lines issued")).toBeInTheDocument();

    const call = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/production-orders?"));
    expect(call).toContain("warehouse=BAL-WH01");
  });

  it("opens an order and shows the pallets that came back", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("PRD-1000456"));

    expect(await screen.findByText("FG-900 · batch B2609A")).toBeInTheDocument();
    expect(screen.getByText("240 of 500 EA made")).toBeInTheDocument();
    expect(screen.getByText("1,000 / 1,000 EA → LINE-03-IN")).toBeInTheDocument();
    expect(screen.getByText("120 EA → BK-04-01-C")).toBeInTheDocument();
    expect(screen.getByText("120 EA → BK-04-02-A")).toBeInTheDocument();
    expect(screen.getByText(/^op-017 · /)).toBeInTheDocument();
    expect(screen.getByText("· supervisor sup-002")).toBeInTheDocument();
    expect(screen.getByText("· the ERP counted this one")).toBeInTheDocument();
    expect(screen.getByText("Finished goods have already come back")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
    expect(screen.getByText("Priya · SCN-BAL-07 · Done · 2 of 2 lines")).toBeInTheDocument();
    expect(screen.getAllByText("RM-120 · Backing plate")).toHaveLength(2);
  });

  it("creates a production order with a message_id", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create order" }));

    await user.type(screen.getByLabelText("Reference"), "PRD-1000460");
    fireEvent.change(screen.getByLabelText("Required by"), { target: { value: "2026-09-22T06:00" } });
    await user.click(screen.getByRole("button", { name: "High" }));
    await user.type(screen.getByLabelText("Output SKU"), "FG-920");
    await user.type(screen.getByLabelText("Output batch"), "B2610");
    await user.type(screen.getByLabelText("Output qty"), "300");
    await user.type(screen.getByLabelText("Component SKU 1"), "RM-160");
    await user.type(screen.getByLabelText("Component qty 1"), "300");
    await user.type(screen.getByLabelText("Deliver to 1"), "LINE-04-IN");
    await user.click(screen.getByRole("button", { name: "Create and allocate" }));

    const post = fetchMock.mock.calls.find(
      (c) => (c[0] as string) === "/v1/production-orders" && (c[1] as RequestInit).method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({
      external_ref: "PRD-1000460", warehouse: "BAL-WH01", required_by: "2026-09-22T06:00",
      priority: "high",
      output: { sku: "FG-920", batch: "B2610", qty: "300", uom: "EA" },
      components: [{ line: 1, sku: "RM-160", batch: null, qty: "300", uom: "EA", deliver_to: "LINE-04-IN" }],
    });
  });
});
