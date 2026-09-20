import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { fmtDate } from "../lib/format";
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

/** A plain YYYY-MM-DD this many days from today, so expiry tests do not age. */
function isoInDays(days: number): string {
  const t = new Date(Date.now() + days * 86_400_000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

const SOON = isoInDays(10);
const LATER = isoInDays(400);
const BATCHES = [
  {
    wms_id: "3", sku: "ABC123", name: "Brake pad set", code: "B2601", expiry_date: SOON,
    manufactured_on: "2026-03-31", supplier_lot: "ACME-99", status: "released", reason: null,
    note: "First lot", on_hand: "48", created_at: "2026-09-21T01:00:00Z", updated_at: "2026-09-21T01:00:00Z",
  },
  {
    wms_id: "4", sku: "ABC123", name: "Brake pad set", code: "B2602", expiry_date: LATER,
    manufactured_on: "2026-06-30", supplier_lot: null, status: "quarantined", reason: "Damaged in transit",
    note: null, on_hand: "120", created_at: "2026-09-21T01:00:00Z", updated_at: "2026-09-21T02:00:00Z",
  },
  {
    wms_id: "5", sku: "ABC123", name: "Brake pad set", code: "B2603", expiry_date: null,
    manufactured_on: null, supplier_lot: "ACME-12", status: "released", reason: null, note: null,
    on_hand: "12", created_at: "2026-09-21T01:00:00Z", updated_at: "2026-09-21T01:00:00Z",
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/products"]}>
      <AuthProvider>
        <Routes>
          <Route path="/products" element={<Products />} />
          <Route path="/import" element={<h1>Import and export</h1>} />
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
  if (url.startsWith("/v1/batches?sku=ABC123")) return jsonResponse(200, { items: BATCHES, total: BATCHES.length });
  if (url.startsWith("/v1/batches?")) return jsonResponse(200, { items: [], total: 0 });
  if (url.startsWith("/v1/batches/") && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return jsonResponse(202, { message_id: body.message_id, wms_id: "3", status: "accepted", batch: BATCHES[0] });
  }
  if (url === "/v1/products" && init?.method === "POST") return jsonResponse(202, { message_id: "m", wms_id: "1", status: "updated" });
  if (url === "/v1/print-jobs" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return jsonResponse(202, { message_id: body.message_id, wms_id: "p1", job_id: "j1", status: "pending" });
  }
  return null;
}

/** Every stock lookup made, oldest first. */
function stockCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/v1/stock?"));
}

/** Every print job posted, oldest first. */
function printJobs(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls
    .filter((c) => c[0] === "/v1/print-jobs")
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}

/** Every batch list read, oldest first. */
function batchReads(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/v1/batches?"));
}

/** Every hold or release posted, as [url, body], oldest first. */
function batchPosts(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls
    .filter((c) => String(c[0]).startsWith("/v1/batches/") && (c[1] as RequestInit)?.method === "POST")
    .map((c) => [String(c[0]), JSON.parse(String((c[1] as RequestInit).body))] as [string, Record<string, unknown>]);
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

  it("sends Import CSV to the import screen", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("ABC123");
    const button = screen.getByRole("button", { name: "Import CSV" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
    await user.click(button);
    expect(await screen.findByRole("heading", { name: "Import and export" })).toBeInTheDocument();
  });

  it("checks the pick face only when Below min is clicked, then filters on it", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith("/v1/stock?sku=ABC123&warehouse=")) {
        return jsonResponse(200, { sku: "ABC123", uom: "EA", total_on_hand: "40", total_available: "40", locations: [
          { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: null, owner: "DEFAULT", on_hand: "40", reserved: "0", available: "40", received_at: "2026-08-30" },
        ] });
      }
      return baseFetch(url, init) ?? jsonResponse(404, { detail: `no route ${url}` });
    });
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("ABC123");
    // nothing is looked up until the chip is asked for
    expect(stockCalls(fetchMock)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /Below min/ }));
    await waitFor(() => expect(screen.queryByText("LUB-05")).not.toBeInTheDocument());
    expect(screen.getByText("ABC123")).toBeInTheDocument();

    // only the products with a minimum are looked up, in this warehouse
    const calls = stockCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("sku=ABC123");
    expect(calls[0]).toContain("warehouse=BAL-WH01");

    // the answer is kept: coming back to the chip asks nothing again
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("LUB-05")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Below min/ }));
    await waitFor(() => expect(screen.queryByText("LUB-05")).not.toBeInTheDocument());
    expect(stockCalls(fetchMock)).toHaveLength(1);
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

  it("lists the batches of the selected product with their expiry and on hand", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });

    expect(await within(panel).findByText("B2601")).toBeInTheDocument();
    expect(within(panel).getByText("B2602")).toBeInTheDocument();
    expect(within(panel).getByText("B2603")).toBeInTheDocument();
    expect(within(panel).getByText(`Expires ${fmtDate(SOON)}`)).toBeInTheDocument();
    expect(within(panel).getByText("No expiry")).toBeInTheDocument();
    expect(within(panel).getByText(`Made ${fmtDate("2026-03-31")} · lot ACME-99`)).toBeInTheDocument();
    expect(within(panel).getByText("48 EA on hand")).toBeInTheDocument();
    expect(within(panel).getByText("120 EA on hand")).toBeInTheDocument();
    expect(within(panel).getByText("12 EA on hand")).toBeInTheDocument();
    expect(within(panel).getAllByText("Released")).toHaveLength(2);
    expect(batchReads(fetchMock)).toEqual(["/v1/batches?sku=ABC123&owner=DEFAULT"]);
  });

  it("reads an expiry inside 30 days in gold, and a later one plainly", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });

    expect(await within(panel).findByText(`Expires ${fmtDate(SOON)}`)).toHaveClass("text-gold");
    expect(within(panel).getByText(`Expires ${fmtDate(LATER)}`)).not.toHaveClass("text-gold");
  });

  it("shows a quarantined batch in gold with its reason", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });

    expect(await within(panel).findByText("Quarantined")).toHaveClass("text-gold");
    expect(within(panel).getByText("Held: Damaged in transit")).toHaveClass("text-gold");
  });

  it("holds a batch with a reason, posting the message envelope, then reloads the list", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await within(panel).findByText("B2601");

    await user.click(within(panel).getByRole("button", { name: "Hold B2601" }));
    await user.type(within(panel).getByLabelText(/^Reason/), "Quality hold");
    await user.type(within(panel).getByLabelText("Note"), "Waiting on the lab");
    await user.click(within(panel).getByRole("button", { name: "Save B2601" }));

    await waitFor(() => expect(batchPosts(fetchMock)).toHaveLength(1));
    const [url, body] = batchPosts(fetchMock)[0];
    expect(url).toBe("/v1/batches/ABC123/B2601/quarantine");
    expect(body.message_id).toEqual(expect.any(String));
    expect(String(body.message_id).length).toBeGreaterThan(10);
    expect(body).toMatchObject({
      warehouse: "BAL-WH01", owner: "DEFAULT", reason: "Quality hold", note: "Waiting on the lab",
    });

    // the list is read again, and the form closes
    await waitFor(() => expect(batchReads(fetchMock)).toHaveLength(2));
    expect(await screen.findByText(/^Held B2601\./)).toBeInTheDocument();
    expect(within(panel).queryByLabelText(/^Reason/)).not.toBeInTheDocument();
  });

  it("releases a quarantined batch with only a note", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await within(panel).findByText("B2602");

    await user.click(within(panel).getByRole("button", { name: "Release B2602" }));
    expect(within(panel).queryByLabelText(/^Reason/)).not.toBeInTheDocument();
    await user.type(within(panel).getByLabelText("Note"), "Lab cleared it");
    await user.click(within(panel).getByRole("button", { name: "Save B2602" }));

    await waitFor(() => expect(batchPosts(fetchMock)).toHaveLength(1));
    const [url, body] = batchPosts(fetchMock)[0];
    expect(url).toBe("/v1/batches/ABC123/B2602/release");
    expect(body).toMatchObject({ warehouse: "BAL-WH01", owner: "DEFAULT", note: "Lab cleared it" });
    expect(body).not.toHaveProperty("reason");
    expect(await screen.findByText(/^Released B2602\./)).toBeInTheDocument();
  });

  it("shows an API refusal to hold through a gold notice", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith("/v1/batches/") && init?.method === "POST") {
        return jsonResponse(409, { detail: "B2601 is already on hold" });
      }
      return baseFetch(url, init) ?? jsonResponse(404, { detail: `no route ${url}` });
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await within(panel).findByText("B2601");

    await user.click(within(panel).getByRole("button", { name: "Hold B2601" }));
    await user.type(within(panel).getByLabelText(/^Reason/), "Quality hold");
    await user.click(within(panel).getByRole("button", { name: "Save B2601" }));

    expect(await within(panel).findByText("B2601 is already on hold")).toBeInTheDocument();
    expect(batchReads(fetchMock)).toHaveLength(1);
  });

  it("leaves Hold and Release out for someone without stock:write", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/me") return jsonResponse(200, { ...ME, scopes: ["stock:read", "master:write"] });
      return baseFetch(url, init) ?? jsonResponse(404, { detail: `no route ${url}` });
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("ABC123"));
    const panel = screen.getByRole("complementary", { name: "Detail" });

    expect(await within(panel).findByText("B2601")).toBeInTheDocument();
    expect(within(panel).getByText("Quarantined")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Hold B2601" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Release B2602" })).not.toBeInTheDocument();
  });

  it("says plainly when a product has no batches", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("LUB-05"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    expect(await within(panel).findByText(
      "No batches recorded for this product. A batch is recorded the first time it is received.",
    )).toBeInTheDocument();
  });
});
