import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { BatchPick } from "../pages/BatchPick";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = {
  wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1",
  settings: { batch_pick_max_orders: 6 }, active: true,
};

const now = new Date();

const deliveryLine = (n: number, sku: string, qty: string) => ({
  delivery_line: n, sku, name: sku, batch: null, qty_ordered: qty, qty_allocated: qty,
  qty_picked: "0", qty_shipped: "0", uom: "EA", short_reason: null,
});

const delivery = (ref: string, name: string, pickMode: string, lines: number) => ({
  wms_id: ref, external_ref: ref, owner: "DEFAULT", warehouse: "BAL-WH01", pick_mode: pickMode,
  priority: "normal", required_by: "2026-09-22", ship_to: { name },
  carrier_hint: null, carrier: null, tracking_no: null, allow_short: true, status: "allocated",
  short: false, staging_location: null, note: null, created_at: now.toISOString(),
  allocated_at: now.toISOString(), picked_at: null, packed_at: null, shipped_at: null,
  cancelled_at: null, packages: [], task: null, pack_task: null, events: [],
  lines: Array.from({ length: lines }, (_, i) => deliveryLine((i + 1) * 10, `SKU-${i + 1}`, "6")),
});

const DELIVERIES = [
  delivery("0080012347", "Repco, Wendouree", "batch", 2),
  delivery("0080012349", "Autobarn, Sebastopol", "auto", 3),
  delivery("0080012351", "Hume Trucks, Albury", "single", 9),
];

const SUGGEST = {
  groups: [{
    zone: "PICKFACE", deliveries: ["0080012347", "0080012349"], orders: 2, lines: 5, stops: 3, saved: 2,
  }],
  max_orders: 6,
};

const BATCHES = [{
  wms_id: "BP-0001", external_ref: "BP-0001", owner: "DEFAULT", warehouse: "BAL-WH01",
  status: "picking", assigned_to: "op-017", note: null, created_by: "leighton",
  created_at: now.toISOString(), started_at: now.toISOString(), completed_at: null,
  cancelled_at: null, orders: 2, lines: 4, stops: [], done_stops: 0, totes: [],
}];

const BATCH_DETAIL = {
  ...BATCHES[0],
  done_stops: 1,
  totes: [
    { tote: "1", delivery: "D1", ship_to: "Repco", status: "picked", lines: 1 },
    { tote: "2", delivery: "D2", ship_to: "Autobarn", status: "picking", lines: 3 },
  ],
  stops: [{
    stop: 1, location: "PF-01-02-A", zone: "PICKFACE", pick_sequence: 120, sku: "ABC123",
    name: "Brake pad set", batch: null, qty: "18", uom: "EA",
    picks: [{ tote: "1", delivery: "D1", qty: "6" }, { tote: "2", delivery: "D2", qty: "12" }],
  }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/deliveries/batches"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/deliveries/batches" element={<BatchPick />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("BatchPick", () => {
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
      if (path === "/v1/deliveries") return json(200, { items: DELIVERIES, total: DELIVERIES.length });
      if (path === "/v1/pick-batches/suggest") return json(200, SUGGEST);
      if (path === "/v1/pick-batches" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "BP-0002", status: "created" });
      }
      if (path === "/v1/pick-batches") return json(200, { items: BATCHES, total: BATCHES.length });
      if (path === "/v1/pick-batches/BP-0001") return json(200, BATCH_DETAIL);
      if (path === "/v1/pick-batches/BP-0002") {
        return json(200, { ...BATCH_DETAIL, external_ref: "BP-0002", status: "new", done_stops: 0 });
      }
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the waiting orders that want batching, with a suggestion", async () => {
    renderPage();
    expect(await screen.findByLabelText("Add 0080012347")).toBeInTheDocument();
    expect(screen.getByLabelText("Add 0080012349")).toBeInTheDocument();
    // a single-pick order is not a candidate
    expect(screen.queryByLabelText("Add 0080012351")).not.toBeInTheDocument();
    expect(screen.getByText("Repco, Wendouree")).toBeInTheDocument();
    expect(screen.getAllByText("PICKFACE")).toHaveLength(2);

    expect(screen.getByText("2 orders in PICKFACE · 5 lines → 3 stops, saves 2")).toBeInTheDocument();
    expect(screen.getByText("Tick the orders that should be walked together.")).toBeInTheDocument();

    const suggested = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/pick-batches/suggest"));
    expect(suggested).toContain("warehouse=BAL-WH01");
  });

  it("ticks two orders and creates the batch", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Add 0080012347"));
    await user.click(screen.getByLabelText("Add 0080012349"));

    expect(screen.getByText("2 orders · 5 lines")).toBeInTheDocument();
    expect(screen.getByText("tote 1 → 0080012347")).toBeInTheDocument();
    expect(screen.getByText("tote 2 → 0080012349")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Assign to"), "op-017");
    await user.click(screen.getByRole("button", { name: "Create batch" }));

    const post = fetchMock.mock.calls.find(
      (c) => (c[0] as string) === "/v1/pick-batches" && (c[1] as RequestInit).method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toEqual({
      message_id: body.message_id,
      warehouse: "BAL-WH01",
      deliveries: ["0080012347", "0080012349"],
      assigned_to: "op-017",
    });

    expect(await screen.findByText(/^BP-0002 created · 2 orders · 4 lines → 1 stop$/)).toBeInTheDocument();
  });

  it("uses a suggestion in one click", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Use this suggestion" }));
    expect(screen.getByLabelText("Add 0080012347")).toBeChecked();
    expect(screen.getByLabelText("Add 0080012349")).toBeChecked();
    expect(screen.getByText("2 orders · 5 lines")).toBeInTheDocument();
  });

  it("opens an open batch and shows its totes and the stops left", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("BP-0001"));

    expect(await screen.findByText("tote 1 → D1 · Repco · picked")).toBeInTheDocument();
    expect(screen.getByText("tote 2 → D2 · Autobarn · picking")).toBeInTheDocument();
    expect(screen.getByText("stop 1 · PF-01-02-A · ABC123 · 18 EA")).toBeInTheDocument();
    expect(screen.getByText("tote 1 6 · tote 2 12")).toBeInTheDocument();
    expect(screen.getByText("Only the grouping goes; every order keeps its task and its stock.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel batch" })).toBeInTheDocument();
  });
});
