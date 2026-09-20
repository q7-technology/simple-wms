import { render, screen, waitFor, within } from "@testing-library/react";
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

function renderStock() {
  return render(
    <MemoryRouter initialEntries={["/stock"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/stock" element={<Stock />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

/** Every print job posted, oldest first. */
function printJobs(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls
    .filter((c) => c[0] === "/v1/print-jobs")
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}

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
      if (path === "/v1/print-jobs") return json(202, { message_id: "m", wms_id: "p1", job_id: "j1", status: "pending" });
      if (path === "/v1/stock/ledger") return json(200, { items: [
        { wms_id: "9", at: new Date().toISOString(), movement_type: "receipt", reason: null, warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", sku: "ABC123", batch: null, owner: "DEFAULT", qty_change: "120", uom: "EA", received_at: "2026-09-03", actor: "jo", device: null, task_id: null, external_ref: "PO-88812", container_id: null, note: null },
      ], total: 1 });
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("looks up a sku, shows tiles, rows in FIFO order and the ledger", async () => {
    renderStock();
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

  it("prints a product label for the looked-up sku, with the batch when a chip is on", async () => {
    window.localStorage.removeItem("wms.printer");
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.split("?")[0] === "/v1/stock") {
        return json(200, {
          sku: "ABC123", uom: "EA", total_on_hand: "168", total_available: "158",
          locations: [
            { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: "B2611", owner: "DEFAULT", on_hand: "48", reserved: "10", available: "38", received_at: "2026-08-30" },
          ],
        });
      }
      return base(url, init);
    });

    renderStock();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");

    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.click(within(panel).getByRole("button", { name: "Print product label" }));
    await user.type(within(panel).getByLabelText("Printer"), "Office");
    await user.click(within(panel).getByRole("button", { name: "Print" }));

    expect(await screen.findByText("Sent the label for ABC123 to Office.")).toBeInTheDocument();
    const first = printJobs(fetchMock)[0];
    expect(first.message_id).toEqual(expect.any(String));
    expect(first).toMatchObject({
      warehouse: "BAL-WH01", template: "product-label", printer: "Office", copies: 1,
      reference: { type: "product", ref: "ABC123" },
    });
    expect(first.reference).not.toHaveProperty("batch");

    // with the batch chip on, that batch goes on the label
    await user.click(screen.getByRole("button", { name: "B2611" }));
    await user.click(within(panel).getByRole("button", { name: "Print product label" }));
    await user.click(within(panel).getByRole("button", { name: "Print" }));

    await waitFor(() => expect(printJobs(fetchMock)).toHaveLength(2));
    expect(printJobs(fetchMock)[1].reference).toEqual({ type: "product", ref: "ABC123", batch: "B2611" });
    expect(window.localStorage.getItem("wms.printer")).toBe("Office");
  });
});
