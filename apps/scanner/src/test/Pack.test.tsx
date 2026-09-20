import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Pack } from "../pages/Pack";
import type { Delivery } from "../api/types";

type Reply = { status?: number; body: unknown } | undefined;
type Call = [string, RequestInit];

function mockFetch(handler: (url: string, method: string, body: Record<string, unknown>) => Reply) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const out = handler(url, init.method ?? "GET", body) ?? { status: 404, body: { detail: `no route ${init.method ?? "GET"} ${url}` } };
    const status = out.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(out.body) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function signIn() {
  localStorage.setItem("wms.scanner.session", JSON.stringify({
    token: "t", expires_in: 43200, operator: { code: "op-017", name: "Sam Lee", roles: ["packer"], supervisor: false },
    warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
  }));
  localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
  localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
}

const delivery: Delivery = {
  wms_id: "41", external_ref: "0080012345", owner: "DEFAULT", warehouse: "BAL-WH01", pick_mode: "single",
  priority: "normal", required_by: "2026-09-22", ship_to: { name: "Acme Auto Parts" }, carrier_hint: null,
  carrier: null, tracking_no: null, allow_short: true, status: "picked", short: false, staging_location: "PACK-01",
  note: null, created_at: "2026-09-20T00:00:00Z", allocated_at: "2026-09-20T00:01:00Z", picked_at: "2026-09-20T01:00:00Z",
  packed_at: null, shipped_at: null, cancelled_at: null,
  lines: [
    { delivery_line: 10, sku: "GHI789", name: "Wiper blade 22 in", batch: null, qty_ordered: "6", qty_allocated: "6", qty_picked: "6", qty_shipped: "0", uom: "EA", short_reason: null },
    { delivery_line: 20, sku: "JKL012", name: "Cabin filter", batch: null, qty_ordered: "4", qty_allocated: "4", qty_picked: "4", qty_shipped: "0", uom: "EA", short_reason: null },
  ],
  packages: [{
    package_no: 1, type: "carton", container_id: null, sscc: null, weight_kg: "8.4", length_cm: "40", width_cm: "30",
    height_cm: "25", packed_by: "op-017", created_at: "2026-09-20T01:30:00Z",
    lines: [{ delivery_line: 10, sku: "GHI789", batch: null, qty: "1", uom: "EA" }],
  }],
  task: null, pack_task: null, events: [],
};

function renderPack(path = "/pack/0080012345") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/pack" element={<Pack />} />
          <Route path="/pack/:ref" element={<Pack />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Pack", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a carton from the picked lines and finishes the packing", async () => {
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/deliveries/0080012345" && method === "GET") return { body: delivery };
      if (url === "/v1/deliveries/0080012345/pack") {
        return { status: 202, body: { message_id: body.message_id, wms_id: "41", status: "accepted", delivery: { ...delivery, status: "packed" } } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPack();

    expect(await screen.findByText("Packed 1 of 10")).toBeInTheDocument();
    expect(screen.getByText("0080012345")).toBeInTheDocument();
    expect(screen.getByText("Pack · 2 cartons")).toBeInTheDocument();
    expect(screen.getByText("Carton 1 · 8.4 kg")).toBeInTheDocument();
    expect(screen.getByText("Carton 2 · open")).toBeInTheDocument();
    expect(screen.getByText("Scan an item into the carton")).toBeInTheDocument();

    // tap a line to put one in the carton, then set the quantity
    await user.click(screen.getByRole("button", { name: /GHI789/ }));
    expect(await screen.findByText("Into carton 2")).toBeInTheDocument();
    const qty = screen.getByRole("spinbutton");
    await user.clear(qty);
    await user.type(qty, "5");

    await user.click(screen.getByRole("button", { name: /JKL012/ }));
    const qty2 = screen.getByRole("spinbutton");
    await user.clear(qty2);
    await user.type(qty2, "4");

    expect(await screen.findByText("Packed 10 of 10")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Weight (kg)"), "3.1");

    await user.click(screen.getByRole("button", { name: "Finish packing" }));
    expect(await screen.findByText("1 carton packed")).toBeInTheDocument();
    expect(screen.getByText("Shipping happens on the desktop.")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/deliveries/0080012345/pack");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent.warehouse).toBe("BAL-WH01");
    expect(sent.packed_by).toBe("op-017");
    expect(sent.complete).toBe(true);
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.packages).toEqual([{
      package_no: 2, type: "carton", weight_kg: "3.1", length_cm: null, width_cm: null, height_cm: null,
      lines: [
        { delivery_line: 10, sku: "GHI789", qty: "5", uom: "EA" },
        { delivery_line: 20, sku: "JKL012", qty: "4", uom: "EA" },
      ],
    }]);
  });

  it("shows the WMS field error in gold when a carton holds more than was picked", async () => {
    mockFetch((url, method) => {
      if (url === "/v1/deliveries/0080012345" && method === "GET") return { body: delivery };
      if (url === "/v1/deliveries/0080012345/pack") {
        return { status: 422, body: { errors: [{ field: "packages.0.lines.0.qty", message: "more than was picked for delivery line 10" }] } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPack();

    await screen.findByText("Packed 1 of 10");
    await user.click(screen.getByRole("button", { name: /GHI789/ }));
    await user.click(screen.getByRole("button", { name: "Finish packing" }));

    expect(await screen.findByText("packages.0.lines.0.qty: more than was picked for delivery line 10")).toBeInTheDocument();
  });

  it("lists the orders waiting to be packed when none is chosen", async () => {
    mockFetch((url, method) => {
      if (url.startsWith("/v1/tasks?") && method === "GET") {
        return { body: { items: [{
          wms_id: "77", type: "pack", title: "Pack 0080012345", status: "waiting", warehouse: "BAL-WH01", owner: "DEFAULT",
          priority: "normal", source_type: "delivery", source_ref: "0080012345", assigned_to: null, device: null,
          needs_supervisor: false, note: "Acme Auto Parts", created_by: null, created_at: "2026-09-20T00:00:00Z",
          started_at: null, completed_at: null, cancelled_at: null, progress: { done: 0, total: 2 }, lines: [],
        }], total: 1 } };
      }
      return undefined;
    });
    renderPack("/pack");
    expect(await screen.findByText("Pack 0080012345")).toBeInTheDocument();
    expect(screen.getByText("Acme Auto Parts")).toBeInTheDocument();
  });
});
