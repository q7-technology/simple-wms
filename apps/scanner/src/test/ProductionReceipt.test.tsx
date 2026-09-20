import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { ProductionReceipt } from "../pages/ProductionReceipt";
import type { ProductionOrder } from "../api/types";

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
    token: "t", expires_in: 43200, operator: { code: "op-017", name: "Sam Lee", roles: ["picker"], supervisor: false },
    warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
  }));
  localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
  localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
}

const order: ProductionOrder = {
  wms_id: "p1", external_ref: "PRD-1000456", owner: "DEFAULT", warehouse: "BAL-WH01",
  required_by: "2026-09-22T06:00:00Z", priority: "normal", status: "in_production", note: null,
  created_at: "2026-09-20T00:00:00Z", issued_at: "2026-09-20T01:00:00Z", completed_at: null, cancelled_at: null,
  output: { sku: "FG-900", name: "Brake pad set, boxed", batch: "B2609A", qty: "500", qty_received: "240", uom: "EA" },
  components: [], receipts: [], issue_task: null,
};

const SHELF_SCAN = {
  raw: "BK-04-01-C", format: "plain", type: "location", fields: {},
  resolved: { location: "BK-04-01-C", zone: "BULK" }, matches_expected: true, message: null,
};
const SUGGESTION = { suggestions: [{ location: "BK-04-01-C", zone: "BULK", reason: "same_sku_has_space" }], flag: null };

function renderProduction(path = "/production/PRD-1000456") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/production" element={<ProductionReceipt />} />
          <Route path="/production/:ref" element={<ProductionReceipt />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("ProductionReceipt", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("receives a pallet onto a scanned shelf and says how much is made so far", async () => {
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/production-orders/PRD-1000456" && method === "GET") return { body: order };
      if (url === "/v1/locations/suggest") return { body: SUGGESTION };
      if (url === "/v1/scans/parse" && body.raw === "BK-04-01-C") return { body: SHELF_SCAN };
      if (url === "/v1/production-orders/PRD-1000456/receipts") {
        return { status: 202, body: { message_id: body.message_id, wms_id: "r1", status: "accepted", received_total: "500", expected: "500", complete: false, event_sent: true } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderProduction();

    expect(await screen.findByText("PRD-1000456")).toBeInTheDocument();
    expect(screen.getByText("Production receipt")).toBeInTheDocument();
    expect(screen.getByText("Sam · BAL")).toBeInTheDocument();
    expect(screen.getByText("FG-900")).toBeInTheDocument();
    expect(screen.getByText("Batch B2609A · from the order")).toBeInTheDocument();
    expect(screen.getByText("240 of 500 EA")).toBeInTheDocument();
    // the batch is never typed here: there is no batch field when the order carries one
    expect(screen.queryByPlaceholderText("Batch")).not.toBeInTheDocument();
    // what is left on the order fills the stepper
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(260));

    const confirm = screen.getByRole("button", { name: "Confirm pallet" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Scan"), "BK-04-01-C{Enter}");
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByText("Scanned · Same product already here · BULK")).toBeInTheDocument();

    await user.click(confirm);
    expect(await screen.findByText("500 of 500 EA made")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/production-orders/PRD-1000456/receipts");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      warehouse: "BAL-WH01", sku: "FG-900", batch: "B2609A", qty: "260", uom: "EA",
      to_location: "BK-04-01-C", container_id: null, operator: "op-017", device_id: "SCN-BAL-07",
    });
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("asks for a supervisor badge when the pallet goes over the tolerance, then sends it", async () => {
    let refused = true;
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/production-orders/PRD-1000456" && method === "GET") return { body: order };
      if (url === "/v1/locations/suggest") return { body: SUGGESTION };
      if (url === "/v1/scans/parse" && body.raw === "BK-04-01-C") return { body: SHELF_SCAN };
      if (url === "/v1/production-orders/PRD-1000456/receipts") {
        if (refused) {
          refused = false;
          return { status: 409, body: { code: "needs_supervisor", detail: "Over the tolerance on this order: a supervisor must approve it" } };
        }
        return { status: 202, body: { message_id: body.message_id, wms_id: "r1", status: "accepted", received_total: "500", expected: "500", complete: true, event_sent: false } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderProduction();

    await screen.findByText("PRD-1000456");
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(260));
    await user.type(screen.getByLabelText("Scan"), "BK-04-01-C{Enter}");
    const confirm = screen.getByRole("button", { name: "Confirm pallet" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(await screen.findByText("Supervisor: scan your badge")).toBeInTheDocument();
    expect(screen.getByText("Over the tolerance on this order")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Supervisor badge"), "SUP-0042{Enter}");
    expect(await screen.findByText("500 EA received")).toBeInTheDocument();
    expect(screen.getByText("The ERP counted this one · the WMS wrote the ledger line only")).toBeInTheDocument();

    const calls = (fetchMock.mock.calls as unknown as Call[]).filter(([url]) => url === "/v1/production-orders/PRD-1000456/receipts");
    expect(calls).toHaveLength(2);
    const sent = JSON.parse(calls[1][1].body as string) as Record<string, unknown>;
    expect(sent.supervisor_badge).toBe("SUP-0042");
    expect(sent.qty).toBe("260");
    expect(sent.to_location).toBe("BK-04-01-C");
  });
});
