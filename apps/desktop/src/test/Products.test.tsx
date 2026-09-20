import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { Products } from "../pages/Products";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ME = { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" };
const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: {}, active: true };
const PRODUCTS = [
  {
    wms_id: "1", owner: "DEFAULT", sku: "ABC123", name: "Brake pad set", uom: "EA", decimals_allowed: false, batch_tracked: true,
    preferred_zone: "PICKFACE", pickface_min: "48", pickface_max: "96", active: true,
    barcodes: [
      { barcode: "09312345000012", kind: "gtin", qty_per: "1" },
      { barcode: "ABC123-CTN12", kind: "carton", qty_per: "12" },
      { barcode: "SUP-77812", kind: "supplier", qty_per: "1" },
    ],
  },
  {
    wms_id: "2", owner: "DEFAULT", sku: "LUB-05", name: "Grease, bulk", uom: "KG", decimals_allowed: true, batch_tracked: false,
    preferred_zone: null, pickface_min: null, pickface_max: null, active: true, barcodes: [],
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/products"]}>
      <AuthProvider>
        <Routes>
          <Route path="/products" element={<Products />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function baseFetch(url: string, init: RequestInit): Response | null {
  if (url === "/v1/auth/refresh") return jsonResponse(200, { token: "t", refresh_token: "r2", expires_in: 900 });
  if (url === "/v1/auth/me") return jsonResponse(200, ME);
  if (url === "/v1/warehouses") return jsonResponse(200, { items: [WAREHOUSE], total: 1 });
  if (url.startsWith("/v1/products?")) {
    const q = (new URL(url, "http://x").searchParams.get("q") ?? "").toLowerCase();
    const items = q ? PRODUCTS.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : PRODUCTS;
    return jsonResponse(200, { items, total: items.length });
  }
  if (url.startsWith("/v1/stock?sku=ABC123")) {
    return jsonResponse(200, { sku: "ABC123", uom: "EA", total_on_hand: "168", total_available: "160", locations: [
      { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: null, owner: "DEFAULT", on_hand: "48", reserved: "8", available: "40", received_at: "2026-08-30" },
      { warehouse: "MEL-WH01", location: "BK-01-01-A", zone: "BULK", batch: null, owner: "DEFAULT", on_hand: "120", reserved: "0", available: "120", received_at: "2026-08-20" },
    ] });
  }
  if (url === "/v1/products" && init?.method === "POST") return jsonResponse(202, { message_id: "m", wms_id: "1", status: "updated" });
  if (url === "/v1/print-jobs" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return jsonResponse(202, { message_id: body.message_id, wms_id: "p1", job_id: "j1", status: "pending" });
  }
  return null;
}

/** Every print job posted, oldest first. */
function printJobs(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls
    .filter((c) => c[0] === "/v1/print-jobs")
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}

describe("Products", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init: RequestInit) => baseFetch(url, init) ?? jsonResponse(404, { detail: `no route ${url}` }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); api.setSession(null); });

  it("lists products with unit, batch, zone, min / max and barcodes", async () => {
    renderPage();
    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Brake pad set")).toBeInTheDocument();
    expect(screen.getByText("48 / 96")).toBeInTheDocument();
    expect(screen.getByText("GTIN + 2")).toBeInTheDocument();
    expect(screen.getByText("LUB-05")).toBeInTheDocument();
    expect(screen.getByText("— / —")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Owner: DEFAULT")).toBeInTheDocument();
  });

  it("filters with the chips and the search box", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("ABC123");
    await user.click(screen.getByRole("button", { name: "Batch tracked" }));
    expect(screen.queryByText("LUB-05")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No barcode" }));
    expect(screen.getByText("LUB-05")).toBeInTheDocument();
    expect(screen.queryByText("ABC123")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByLabelText("Find a product"), "grease");
    await waitFor(() => expect(screen.queryByText("ABC123")).not.toBeInTheDocument());
    expect(screen.getByText("LUB-05")).toBeInTheDocument();
  });

  it("opens a row in the panel with its barcodes and on hand", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    expect(within(panel).getByLabelText("SKU")).toHaveValue("ABC123");
    expect(within(panel).getByLabelText("SKU")).toHaveAttribute("readonly");
    expect(within(panel).getByLabelText("Name")).toHaveValue("Brake pad set");
    expect(within(panel).getByLabelText("Min at pick face")).toHaveValue("48");
    expect(within(panel).getByRole("switch", { name: /Batch \/ lot tracking/ })).toBeChecked();
    expect(within(panel).getByRole("switch", { name: /Decimal quantities/ })).not.toBeChecked();
    expect(within(panel).getByText("09312345000012")).toBeInTheDocument();
    expect(within(panel).getByText("Carton of 12")).toBeInTheDocument();
    expect(within(panel).getByText("Supplier label")).toBeInTheDocument();
    expect(await screen.findByText("168 EA · 2 warehouses")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Print product label" })).toBeEnabled();
  });

  it("saves the product with the whole barcode set and the message envelope", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.clear(within(panel).getByLabelText("Max at pick face"));
    await user.type(within(panel).getByLabelText("Max at pick face"), "120");
    await user.click(within(panel).getByRole("button", { name: "Remove SUP-77812" }));
    await user.click(within(panel).getByRole("button", { name: "Add barcode" }));
    await user.type(within(panel).getByLabelText("Barcode"), "19312345000019");
    await user.selectOptions(within(panel).getByLabelText("Kind"), "carton");
    await user.type(within(panel).getByLabelText(/^Qty per scan/), "24");
    await user.click(within(panel).getByRole("button", { name: "Add" }));
    expect(within(panel).getByText("19312345000019")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/products" && c[1]?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find((c) => c[0] === "/v1/products" && c[1]?.method === "POST")!;
    const body = JSON.parse(post[1].body as string);
    expect(body.message_id).toEqual(expect.any(String));
    expect(body.message_id.length).toBeGreaterThan(10);
    expect(body).toMatchObject({
      owner: "DEFAULT", sku: "ABC123", name: "Brake pad set", uom: "EA", decimals_allowed: false, batch_tracked: true,
      preferred_zone: "PICKFACE", pickface_min: "48", pickface_max: "120", active: true,
    });
    expect(body.barcodes).toEqual([
      { barcode: "09312345000012", kind: "gtin", qty_per: "1" },
      { barcode: "ABC123-CTN12", kind: "carton", qty_per: "12" },
      { barcode: "19312345000019", kind: "carton", qty_per: "24" },
    ]);
    expect(await screen.findByText("Saved ABC123.")).toBeInTheDocument();
  });

  it("prints a product label, with the batch and quantity only when they are filled", async () => {
    window.localStorage.removeItem("wms.printer");
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.click(within(panel).getByRole("button", { name: "Print product label" }));
    await user.type(within(panel).getByLabelText("Printer"), "Office");
    await user.click(within(panel).getByRole("button", { name: "Print" }));

    expect(await screen.findByText("Sent the label for ABC123 to Office.")).toBeInTheDocument();
    let bodies = printJobs(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].message_id).toEqual(expect.any(String));
    expect(bodies[0]).toMatchObject({
      warehouse: "BAL-WH01", template: "product-label", printer: "Office", copies: 1,
      reference: { type: "product", ref: "ABC123" },
    });
    expect(bodies[0].reference).not.toHaveProperty("batch");
    expect(bodies[0].reference).not.toHaveProperty("qty");

    // second time round: the printer is remembered, and a batch and a quantity are sent
    await user.click(within(panel).getByRole("button", { name: "Print product label" }));
    expect(within(panel).getByLabelText("Printer")).toHaveValue("Office");
    await user.type(within(panel).getByLabelText("Batch"), "B2611");
    await user.type(within(panel).getByLabelText("Quantity"), "12");
    await user.click(within(panel).getByRole("button", { name: "Print" }));

    await waitFor(() => expect(printJobs(fetchMock)).toHaveLength(2));
    bodies = printJobs(fetchMock);
    expect(bodies[1].reference).toEqual({ type: "product", ref: "ABC123", batch: "B2611", qty: "12" });
    expect(window.localStorage.getItem("wms.printer")).toBe("Office");
  });

  it("adds a new product and shows API field errors under the field", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/v1/products" && init?.method === "POST") {
        return jsonResponse(422, { errors: [{ field: "barcodes", message: "09312345000012 already belongs to ABC123" }] });
      }
      return baseFetch(url, init) ?? jsonResponse(404, {});
    });
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("ABC123");
    await user.click(screen.getByRole("button", { name: "Add product" }));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.type(within(panel).getByLabelText(/^SKU/), "NEW-1");
    await user.type(within(panel).getByLabelText("Name"), "New thing");
    await user.click(within(panel).getByRole("button", { name: "KG" }));
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("09312345000012 already belongs to ABC123")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find((c) => c[0] === "/v1/products" && c[1]?.method === "POST")!;
    const body = JSON.parse(post[1].body as string);
    expect(body).toMatchObject({ sku: "NEW-1", name: "New thing", uom: "KG", preferred_zone: null, pickface_min: null, barcodes: [] });
    expect(body.message_id).toEqual(expect.any(String));
  });
});
