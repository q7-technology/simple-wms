import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Stock } from "../pages/Stock";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: {}, active: true };

describe("Stock lookup", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/stock") return json(200, {
        sku: "ABC123", uom: "EA", total_on_hand: "168", total_available: "158",
        locations: [
          { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: null, owner: "DEFAULT", on_hand: "48", reserved: "10", available: "38", received_at: "2026-08-30" },
          { warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", batch: null, owner: "DEFAULT", on_hand: "120", reserved: "0", available: "120", received_at: "2026-09-03" },
        ],
      });
      if (path === "/v1/products/ABC123") return json(200, { wms_id: "1", owner: "DEFAULT", sku: "ABC123", name: "Brake pad set", uom: "EA", decimals_allowed: false, batch_tracked: true, preferred_zone: "PICKFACE", pickface_min: "60", pickface_max: "96", barcodes: [], active: true });
      if (path === "/v1/stock/ledger") return json(200, { items: [
        { wms_id: "9", at: new Date().toISOString(), movement_type: "receipt", reason: null, warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", sku: "ABC123", batch: null, owner: "DEFAULT", qty_change: "120", uom: "EA", received_at: "2026-09-03", actor: "jo", device: null, task_id: null, external_ref: "PO-88812", container_id: null, note: null },
      ], total: 1 });
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("looks up a sku, shows tiles, rows in FIFO order and the ledger", async () => {
    render(
      <MemoryRouter initialEntries={["/stock"]}>
        <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/stock" element={<Stock />} /></Route></Routes></AuthProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");

    expect(await screen.findByText("Brake pad set · EA · batch tracked")).toBeInTheDocument();
    expect(screen.getByText("168")).toBeInTheDocument();
    expect(screen.getByText("158")).toBeInTheDocument();
    expect(screen.getByText("30 Aug · FIFO first")).toBeInTheDocument();
    // below min at the pick face: 48 < 60, in gold
    expect(screen.getByText("Below min at")).toBeInTheDocument();
    expect(screen.getByText("PF-01-02-A", { selector: "span.text-gold" })).toBeInTheDocument();
    expect(screen.getByText(/Receive → PO-88812/)).toBeInTheDocument();

    const stockCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/stock?"));
    expect(stockCall).toContain("sku=ABC123");
    expect(stockCall).toContain("warehouse=BAL-WH01");
  });
});
