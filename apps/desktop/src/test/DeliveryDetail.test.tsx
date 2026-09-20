import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { DeliveryDetail } from "../pages/DeliveryDetail";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: {}, active: true };
const now = new Date();

const line = (
  n: number, sku: string, name: string, ordered: string, picked: string,
  opts: { batch?: string | null; shipped?: string; short_reason?: string | null } = {},
) => ({
  delivery_line: n, sku, name, batch: opts.batch ?? null, qty_ordered: ordered, qty_allocated: ordered,
  qty_picked: picked, qty_shipped: opts.shipped ?? "0", uom: "EA", short_reason: opts.short_reason ?? null,
});

const PICKED = {
  wms_id: "d1", external_ref: "0080012345", owner: "DEFAULT", warehouse: "BAL-WH01", pick_mode: "single",
  priority: "high", required_by: "2026-09-22",
  ship_to: { name: "Acme Auto Parts", address: "12 Example St", suburb: "Geelong", state: "VIC", postcode: "3220", country: "AU" },
  carrier_hint: "Toll", carrier: null, tracking_no: null, allow_short: true, status: "picked", short: true,
  staging_location: "STAGE-01", note: null, created_at: now.toISOString(), allocated_at: now.toISOString(),
  picked_at: now.toISOString(), packed_at: null, shipped_at: null, cancelled_at: null,
  lines: [
    line(10, "ABC123", "Brake pad set", "10", "10"),
    line(20, "DEF456", "Rotor 280 mm", "4", "4", { batch: "B2611" }),
    line(30, "GHI789", "Wiper blade 22 in", "6", "2", { short_reason: "not_found" }),
  ],
  packages: [{
    package_no: 1, type: "carton", container_id: null, sscc: "393123456789012345", weight_kg: "8.4",
    length_cm: "40", width_cm: "30", height_cm: "25", packed_by: "op-017", created_at: now.toISOString(),
    lines: [{ delivery_line: 10, sku: "ABC123", batch: null, qty: "6", uom: "EA" }],
  }],
  task: {
    wms_id: "5511", type: "pick", title: "Pick 0080012345", status: "in_progress", warehouse: "BAL-WH01",
    owner: "DEFAULT", priority: "high", source_type: "delivery", source_ref: "0080012345", assigned_to: "op-017",
    device: "SCN-BAL-07", needs_supervisor: false, note: null, created_by: "erp", created_at: now.toISOString(),
    started_at: now.toISOString(), completed_at: null, cancelled_at: null, progress: { done: 2, total: 3 },
    lines: [
      {
        line_no: 1, source_line: 10, sku: "ABC123", name: "Brake pad set", batch: null, expected_qty: "10",
        actual_qty: "10", variance: null, uom: "EA", from_location: "PF-01-02-A", to_location: "STAGE-01",
        container_id: null, status: "done", reason: null, completed_at: now.toISOString(),
      },
      {
        line_no: 3, source_line: 30, sku: "GHI789", name: "Wiper blade 22 in", batch: null, expected_qty: "6",
        actual_qty: "2", variance: null, uom: "EA", from_location: "PF-01-05-C", to_location: "STAGE-01",
        container_id: null, status: "short", reason: "not_found", completed_at: now.toISOString(),
      },
    ],
  },
  pack_task: null,
  events: [
    { event_type: "delivery.allocated", subscriber: "ERP", status: "delivered", at: now.toISOString() },
    { event_type: "delivery.picked", subscriber: "ERP", status: "pending", at: now.toISOString() },
  ],
};

const PACKED = {
  ...PICKED, wms_id: "d2", external_ref: "0080012338", status: "packed", short: false, priority: "normal",
  packed_at: now.toISOString(),
  lines: [line(10, "JKL012", "Oil filter", "6", "6")],
  packages: [{
    package_no: 1, type: "carton", container_id: null, sscc: null, weight_kg: "3.2",
    length_cm: null, width_cm: null, height_cm: null, packed_by: "op-017", created_at: now.toISOString(),
    lines: [{ delivery_line: 10, sku: "JKL012", batch: null, qty: "6", uom: "EA" }],
  }],
  task: null, events: [],
};

function renderPage(ref: string) {
  return render(
    <MemoryRouter initialEntries={[`/deliveries/${ref}`]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/deliveries/:ref" element={<DeliveryDetail />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("DeliveryDetail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/deliveries/0080012345/pack" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "d1", status: "accepted" });
      }
      if (path === "/v1/deliveries/0080012338/ship" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "d2", status: "accepted" });
      }
      if (path === "/v1/deliveries/0080012345") return json(200, PICKED);
      if (path === "/v1/deliveries/0080012338") return json(200, PACKED);
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the lines, the packages, the pick task and the events", async () => {
    renderPage("0080012345");
    expect(await screen.findByRole("heading", { name: "0080012345 Acme Auto Parts" })).toBeInTheDocument();
    expect(screen.getByText("12 Example St")).toBeInTheDocument();
    expect(screen.getByText("Geelong VIC 3220")).toBeInTheDocument();
    expect(screen.getByText("Staging STAGE-01")).toBeInTheDocument();

    // lines
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Rotor 280 mm")).toBeInTheDocument();
    expect(screen.getByText("B2611")).toBeInTheDocument();
    expect(screen.getByText("Short · not found", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getAllByText("Picked", { selector: "span.rounded-full" }).length).toBeGreaterThan(1);

    // packages
    expect(screen.queryByText("Nothing packed yet.")).not.toBeInTheDocument();
    expect(screen.getByText("393123456789012345")).toBeInTheDocument();
    expect(screen.getByText("40 × 30 × 25 cm")).toBeInTheDocument();
    expect(screen.getByText("ABC123 × 6 EA")).toBeInTheDocument();

    // pick task and events
    expect(screen.getByText(/op-017 · SCN-BAL-07 · In progress · 2 of 3 lines/)).toBeInTheDocument();
    expect(screen.getByText("delivery.allocated")).toBeInTheDocument();
    expect(screen.getByText("Delivered", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Queued", { selector: "span.rounded-full" })).toBeInTheDocument();
  });

  it("packs what is left in a carton", async () => {
    renderPage("0080012345");
    const user = userEvent.setup();
    await user.click(await screen.findByText("Pack"));

    expect(screen.getByLabelText("Package number")).toHaveValue("2");
    expect(screen.getByLabelText("Pack qty line 10")).toHaveValue("4");
    await user.type(screen.getByLabelText("Weight kg"), "2.5");
    await user.type(screen.getByLabelText("Length cm"), "40");
    await user.type(screen.getByLabelText("Width cm"), "30");
    await user.type(screen.getByLabelText("Height cm"), "25");
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByText("Pack carton"));

    const post = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/deliveries/0080012345/pack");
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({
      warehouse: "BAL-WH01", packed_by: "leighton", complete: true,
      packages: [{
        package_no: 2, type: "carton", weight_kg: "2.5", length_cm: "40", width_cm: "30", height_cm: "25",
        lines: [
          { delivery_line: 10, sku: "ABC123", qty: "4", uom: "EA" },
          { delivery_line: 20, sku: "DEF456", qty: "4", uom: "EA" },
          { delivery_line: 30, sku: "GHI789", qty: "2", uom: "EA" },
        ],
      }],
    });
  });

  it("ships with a carrier and a tracking number", async () => {
    renderPage("0080012338");
    const user = userEvent.setup();
    await user.click(await screen.findByText("Ship"));

    expect(screen.getByLabelText("Carrier")).toHaveValue("Toll");
    await user.type(screen.getByLabelText("Tracking number"), "TOLL-99123");
    await user.click(screen.getByText("Ship delivery"));

    const post = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/deliveries/0080012338/ship");
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({
      warehouse: "BAL-WH01", carrier: "Toll", tracking_no: "TOLL-99123", shipped_by: "leighton",
    });
  });
});
