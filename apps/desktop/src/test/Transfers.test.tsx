import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Transfers } from "../pages/Transfers";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSES = [
  { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: {}, active: true },
  { wms_id: "2", code: "MEL-WH01", site: "MEL", name: "Melbourne 1", settings: {}, active: true },
];

const now = new Date();

const line = (
  n: number, sku: string, name: string,
  qty: { requested: string; picked?: string; shipped?: string; received?: string; variance?: string },
  batch: string | null = null,
) => ({
  line: n, sku, name, batch,
  qty_requested: qty.requested, qty_allocated: qty.requested, qty_picked: qty.picked ?? "0",
  qty_shipped: qty.shipped ?? "0", qty_received: qty.received ?? "0", variance: qty.variance ?? "0",
  uom: "EA",
});

const base = {
  owner: "DEFAULT", priority: "normal", carrier_hint: null, carrier: null, tracking_no: null,
  staging_location: null, in_transit_location: null, note: null, variance_reason: null,
  created_at: now.toISOString(), allocated_at: now.toISOString(), shipped_at: null,
  received_at: null, closed_at: null, cancelled_at: null, pick_task: null, receive_task: null,
};

const task = (over: Record<string, unknown>) => ({
  wms_id: "9001", type: "transfer_pick", title: "Pick STO-4500009", status: "done",
  warehouse: "BAL-WH01", owner: "DEFAULT", priority: "normal", source_type: "transfer",
  source_ref: "STO-4500009", assigned_to: "Sam", device: null, needs_supervisor: false, note: null,
  created_by: "erp", created_at: now.toISOString(), started_at: now.toISOString(),
  completed_at: null, cancelled_at: null, progress: { done: 3, total: 3 }, lines: [],
  ...over,
});

const TRANSFERS = [
  {
    ...base, wms_id: "t1", external_ref: "STO-4500012", from_warehouse: "BAL-WH01",
    to_warehouse: "MEL-WH01", required_by: "2026-09-25", status: "picking",
    lines: [line(1, "ABC123", "Brake pad set", { requested: "120" })],
  },
  {
    ...base, wms_id: "t2", external_ref: "STO-4500011", from_warehouse: "BAL-WH01",
    to_warehouse: "MEL-WH01", required_by: "2026-09-22", status: "in_transit", carrier: "Toll",
    tracking_no: "TOLL-99123", in_transit_location: "MEL-TRANSIT", shipped_at: now.toISOString(),
    lines: [line(1, "DEF456", "Rotor 280 mm", { requested: "640", picked: "640", shipped: "640" })],
  },
  {
    ...base, wms_id: "t3", external_ref: "STO-4500010", from_warehouse: "MEL-WH01",
    to_warehouse: "BAL-WH01", required_by: "2026-09-19", status: "received",
    shipped_at: now.toISOString(), received_at: now.toISOString(),
    lines: [line(1, "GHI789", "Wiper 22 in", { requested: "300", picked: "300", shipped: "300", received: "300" })],
  },
  {
    ...base, wms_id: "t4", external_ref: "STO-4500009", from_warehouse: "BAL-WH01",
    to_warehouse: "MEL-WH01", required_by: "2026-09-18", status: "variance",
    shipped_at: now.toISOString(), received_at: now.toISOString(), in_transit_location: "MEL-TRANSIT",
    lines: [
      line(1, "ABC123", "Brake pad set", { requested: "200", picked: "200", shipped: "200", received: "200" }, "B2601"),
      line(2, "DEF456", "Rotor 280 mm", { requested: "150", picked: "150", shipped: "150", received: "150" }),
      line(3, "GHI789", "Wiper 22 in", { requested: "70", picked: "70", shipped: "70", received: "68", variance: "-2" }, "B2588"),
    ],
  },
  {
    ...base, wms_id: "t5", external_ref: "STO-4500008", from_warehouse: "BAL-WH01",
    to_warehouse: "MEL-WH01", required_by: "2026-08-30", status: "closed",
    shipped_at: "2026-08-28T01:00:00Z", received_at: "2026-08-29T01:00:00Z", closed_at: "2026-08-29T02:00:00Z",
    lines: [line(1, "JKL012", "Filter", { requested: "200", picked: "200", shipped: "200", received: "200" })],
  },
];

const VARIANCE_DETAIL = {
  ...TRANSFERS[3],
  pick_task: task({}),
  receive_task: task({
    wms_id: "9002", type: "transfer_receive", title: "Receive STO-4500009", status: "in_progress",
    warehouse: "MEL-WH01", assigned_to: "Priya", progress: { done: 2, total: 3 },
  }),
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/transfers"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/transfers" element={<Transfers />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Transfers", () => {
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
      if (path === "/v1/warehouses") return json(200, { items: WAREHOUSES, total: 2 });
      if (path === "/v1/transfers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "t9", status: "created", allocation: [] });
      }
      if (path === "/v1/transfers") return json(200, { items: TRANSFERS, total: TRANSFERS.length });
      if (path === "/v1/transfers/STO-4500009/close-variance") {
        const body = JSON.parse(String(init!.body));
        return json(202, { message_id: body.message_id, wms_id: "t4", status: "accepted" });
      }
      if (path === "/v1/transfers/STO-4500009") return json(200, VARIANCE_DETAIL);
      if (path === "/v1/transfers/STO-4500012") return json(200, TRANSFERS[0]);
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the tiles, a row per transfer and the right pill", async () => {
    renderPage();
    expect(await screen.findByText("BAL-WH01 → MEL-WH01")).toBeInTheDocument();
    expect(screen.getByText(/^next due /)).toBeInTheDocument();
    expect(screen.getByText(/^last into BAL-WH01 /)).toBeInTheDocument();
    expect(screen.getByText("−2 EA")).toBeInTheDocument();
    expect(screen.getByText("1", { selector: "span.text-gold" })).toBeInTheDocument();

    expect(screen.getByText("Picking", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("In transit", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Received", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Variance", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Closed", { selector: "span.rounded-full" })).toBeInTheDocument();

    expect(screen.getByText("STO-4500012")).toBeInTheDocument();
    expect(screen.getByText("420 EA")).toBeInTheDocument();

    const call = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/transfers?"));
    expect(call).toContain("warehouse=BAL-WH01");

    // inbound only keeps the transfer coming the other way
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Inbound" }));
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes("direction=in"))).toBe(true);
  });

  it("opens a transfer and shows both legs", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("STO-4500009"));

    expect(await screen.findByText("BAL-WH01 → MEL-WH01 · 3 lines")).toBeInTheDocument();
    expect(screen.getByText("MEL-TRANSIT")).toBeInTheDocument();
    expect(screen.getByText("68 / 70 of 70 EA")).toBeInTheDocument();
    expect(screen.getByText("Pick STO-4500009 · done · Sam")).toBeInTheDocument();
    expect(screen.getByText("Receive STO-4500009 · in progress · Priya")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 lines")).toBeInTheDocument();
  });

  it("closes a variance with a reason and a note", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("STO-4500009"));
    await user.click(await screen.findByRole("button", { name: "Close variance" }));

    await user.click(screen.getByRole("button", { name: "Damaged in transit" }));
    await user.type(screen.getByLabelText("Note"), "One carton crushed on arrival");
    await user.click(screen.getByRole("button", { name: "Write it off" }));

    const post = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/transfers/STO-4500009/close-variance");
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({ reason: "damaged_in_transit", note: "One carton crushed on arrival" });
  });

  it("creates a transfer between two different warehouses", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create transfer" }));

    await user.type(screen.getByLabelText("Reference"), "STO-4500013");
    await user.type(screen.getByLabelText("Carrier hint"), "Own truck");
    await user.type(screen.getByLabelText("SKU 1"), "ABC123");
    await user.type(screen.getByLabelText("Qty 1"), "120");
    await user.click(screen.getByRole("button", { name: "Create and allocate" }));

    const post = fetchMock.mock.calls.find(
      (c) => (c[0] as string) === "/v1/transfers" && (c[1] as RequestInit).method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({
      external_ref: "STO-4500013", from_warehouse: "BAL-WH01", to_warehouse: "MEL-WH01",
      priority: "normal", carrier_hint: "Own truck",
      lines: [{ line: 1, sku: "ABC123", batch: null, qty: "120", uom: "EA" }],
    });
  });

  it("refuses a transfer to the same warehouse", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create transfer" }));
    await user.selectOptions(screen.getByLabelText("To warehouse"), "BAL-WH01");
    expect(screen.getByText("A transfer needs two different warehouses")).toBeInTheDocument();
  });
});
