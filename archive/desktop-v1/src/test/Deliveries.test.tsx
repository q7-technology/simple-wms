import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Deliveries } from "../pages/Deliveries";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: {}, active: true };

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = localDate(now);

const line = (n: number, sku: string, name: string, ordered: string, picked: string, shortReason: string | null = null) =>
  ({
    delivery_line: n, sku, name, batch: null, qty_ordered: ordered, qty_allocated: ordered,
    qty_picked: picked, qty_shipped: "0", uom: "EA", short_reason: shortReason,
  });

const base = {
  owner: "DEFAULT", warehouse: "BAL-WH01", pick_mode: "single", carrier_hint: null, carrier: null,
  tracking_no: null, allow_short: true, short: false, staging_location: "STAGE-01", note: null,
  created_at: now.toISOString(), allocated_at: now.toISOString(), picked_at: null, packed_at: null,
  shipped_at: null, cancelled_at: null, packages: [], task: null, pack_task: null, events: [],
};

const pickTask = {
  wms_id: "5511", type: "pick", title: "Pick 0080012345", status: "in_progress", warehouse: "BAL-WH01",
  owner: "DEFAULT", priority: "high", source_type: "delivery", source_ref: "0080012345", assigned_to: "Sam",
  device: "SCN-BAL-07", needs_supervisor: false, note: null, created_by: "erp", created_at: now.toISOString(),
  started_at: now.toISOString(), completed_at: null, cancelled_at: null, progress: { done: 1, total: 2 }, lines: [],
};

const DELIVERIES = [
  {
    ...base, wms_id: "d1", external_ref: "0080012345", priority: "normal", required_by: TODAY,
    ship_to: { name: "Acme Auto Parts", address: "12 Example St", suburb: "Geelong", state: "VIC", postcode: "3220", country: "AU" },
    status: "picking", task: pickTask,
    lines: [line(10, "ABC123", "Brake pad set", "10", "10"), line(20, "DEF456", "Rotor 280 mm", "4", "0")],
  },
  {
    ...base, wms_id: "d2", external_ref: "0080012346", priority: "high", required_by: TODAY,
    ship_to: { name: "Westside Motors", address: "9 Sturt St", suburb: "Ballarat", state: "VIC", postcode: "3350", country: "AU" },
    status: "allocated",
    lines: [line(10, "GHI789", "Wiper blade 22 in", "12", "0")],
  },
  {
    ...base, wms_id: "d3", external_ref: "0080012338", priority: "normal", required_by: TODAY,
    ship_to: { name: "Repco", address: "1 Howitt St", suburb: "Wendouree", state: "VIC", postcode: "3355", country: "AU" },
    status: "packed", short: true, picked_at: now.toISOString(), packed_at: now.toISOString(),
    lines: [line(10, "JKL012", "Oil filter", "6", "4", "short_on_shelf")],
  },
  {
    ...base, wms_id: "d4", external_ref: "0080012340", priority: "normal", required_by: TODAY,
    ship_to: { name: "Hume Trucks", address: "40 Borella Rd", suburb: "Albury", state: "NSW", postcode: "2640", country: "AU" },
    status: "shipped", short: true, carrier: "Toll", tracking_no: "TOLL-99123",
    picked_at: now.toISOString(), packed_at: now.toISOString(), shipped_at: now.toISOString(),
    lines: [line(10, "MNO345", "Air filter", "9", "8", "not_found")],
  },
  {
    ...base, wms_id: "d5", external_ref: "0080012299", priority: "low", required_by: TODAY,
    ship_to: { name: "Bendix", address: "3 Gillies St", suburb: "Ballarat", state: "VIC", postcode: "3350", country: "AU" },
    status: "cancelled", cancelled_at: now.toISOString(),
    lines: [line(10, "PQR678", "Clutch kit", "2", "0")],
  },
];

const NEW_DELIVERY = {
  ...base, wms_id: "d9", external_ref: "0080012399", priority: "high", required_by: "2026-09-22",
  ship_to: { name: "Filters AU", address: "7 Latrobe St", suburb: "Melbourne", state: "VIC", postcode: "3000", country: "AU" },
  status: "allocated",
  lines: [line(10, "JKL012", "Oil filter", "100", "0"), line(20, "MNO345", "Air filter", "40.5", "0")],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/deliveries"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/deliveries" element={<Deliveries />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Deliveries", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/deliveries" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, {
          message_id: body.message_id, wms_id: "d9", status: "accepted",
          allocation: [
            { delivery_line: 10, sku: "JKL012", qty_ordered: "100", qty_allocated: "100", uom: "EA", short: "0" },
            { delivery_line: 20, sku: "MNO345", qty_ordered: "40.5", qty_allocated: "34.5", uom: "EA", short: "6" },
          ],
        });
      }
      if (path === "/v1/deliveries") return json(200, { items: DELIVERIES, total: DELIVERIES.length });
      if (path === "/v1/deliveries/0080012399") return json(200, NEW_DELIVERY);
      if (path === "/v1/deliveries/0080012345") return json(200, DELIVERIES[0]);
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the tiles, a row per delivery and the right pills", async () => {
    renderPage();
    expect(await screen.findByText("1 high priority")).toBeInTheDocument();
    expect(screen.getByText("1 operator on the floor")).toBeInTheDocument();
    expect(screen.getByText("1 short")).toBeInTheDocument();
    expect(screen.getByText("last with Toll")).toBeInTheDocument();

    expect(screen.getByText("0080012345")).toBeInTheDocument();
    expect(screen.getByText("Acme Auto Parts")).toBeInTheDocument();
    expect(screen.getByText("· Geelong")).toBeInTheDocument();
    expect(screen.getByText("14 EA")).toBeInTheDocument();

    const pill = { selector: "span.rounded-full" };
    expect(screen.getByText("Picking", pill)).toBeInTheDocument();
    expect(screen.getByText("Waiting", pill)).toBeInTheDocument();
    expect(screen.getByText("Packed", pill)).toBeInTheDocument();
    expect(screen.getByText("Shipped", pill)).toBeInTheDocument();
    expect(screen.getByText("Cancelled", pill)).toBeInTheDocument();
    expect(screen.getByText("High", pill)).toBeInTheDocument();
    expect(screen.getAllByText("Short", pill)).toHaveLength(2);

    const call = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/deliveries?"));
    expect(call).toContain("warehouse=BAL-WH01");
  });

  it("narrows the table to short orders", async () => {
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("0080012345")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Short" }));
    expect(screen.getByText("0080012338")).toBeInTheDocument();
    expect(screen.getByText("0080012340")).toBeInTheDocument();
    expect(screen.queryByText("0080012345")).not.toBeInTheDocument();
    expect(screen.queryByText("0080012299")).not.toBeInTheDocument();
  });

  it("creates a delivery with a message_id and shows what could not be allocated", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Create delivery"));

    await user.type(screen.getByLabelText("Reference"), "0080012399");
    await user.type(screen.getByLabelText("Ship to name"), "Filters AU");
    await user.type(screen.getByLabelText("Address"), "7 Latrobe St");
    await user.type(screen.getByLabelText("Suburb"), "Melbourne");
    await user.type(screen.getByLabelText("State"), "VIC");
    await user.type(screen.getByLabelText("Postcode"), "3000");
    fireEvent.change(screen.getByLabelText("Required by"), { target: { value: "2026-09-22" } });
    await user.click(screen.getByRole("button", { name: "High" }));
    await user.type(screen.getByLabelText("SKU 1"), "JKL012");
    await user.type(screen.getByLabelText("Qty 1"), "100");
    await user.click(screen.getByText("Add line"));
    await user.type(screen.getByLabelText("SKU 2"), "MNO345");
    await user.type(screen.getByLabelText("Qty 2"), "40.5");
    await user.click(screen.getByText("Create and allocate"));

    const post = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/deliveries" && (c[1] as RequestInit).method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({
      external_ref: "0080012399", warehouse: "BAL-WH01", owner: "DEFAULT",
      pick_mode: "single", priority: "high", required_by: "2026-09-22", allow_short: true,
      ship_to: { name: "Filters AU", address: "7 Latrobe St", suburb: "Melbourne", state: "VIC", postcode: "3000" },
      lines: [
        { delivery_line: 10, sku: "JKL012", batch: null, qty: "100", uom: "EA" },
        { delivery_line: 20, sku: "MNO345", batch: null, qty: "40.5", uom: "EA" },
      ],
    });

    expect(await screen.findByText("1 of 2 lines allocated · MNO345 short 6 EA")).toBeInTheDocument();
    expect(await screen.findByText("Filters AU · 2 lines · high priority")).toBeInTheDocument();
  });
});
