import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { Locations } from "../pages/Locations";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ME = { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" };
const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: {}, active: true };
const ZONES = [
  { wms_id: "1", warehouse: "BAL-WH01", code: "BULK", name: "Bulk", kind: "bulk", active: true },
  { wms_id: "2", warehouse: "BAL-WH01", code: "PICKFACE", name: "Pick face", kind: "pickface", active: true },
];
const LOCATIONS = [
  { wms_id: "10", warehouse: "BAL-WH01", code: "PF-01-02-A", zone: "PICKFACE", type: "shelf", access: "step", mixing: "single_sku", capacity: "96", capacity_uom: "EA", pick_sequence: 102, barcode: "LOC-PF-01-02-A", active: true },
  { wms_id: "11", warehouse: "BAL-WH01", code: "BK-04-01-C", zone: "BULK", type: "rack", access: "forklift", mixing: "mixed", capacity: "3", capacity_uom: "PALLET", pick_sequence: 410, barcode: null, active: true },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/locations"]}>
      <AuthProvider>
        <Routes>
          <Route path="/locations" element={<Locations />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Locations", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/refresh") return jsonResponse(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (url === "/v1/auth/me") return jsonResponse(200, ME);
      if (url === "/v1/warehouses") return jsonResponse(200, { items: [WAREHOUSE], total: 1 });
      if (url.startsWith("/v1/zones?")) return jsonResponse(200, { items: ZONES, total: ZONES.length });
      if (url.startsWith("/v1/locations?")) {
        const zone = new URL(url, "http://x").searchParams.get("zone");
        const items = zone ? LOCATIONS.filter((l) => l.zone === zone) : LOCATIONS;
        return jsonResponse(200, { items, total: items.length });
      }
      if (url === "/v1/locations/10/stock") {
        return jsonResponse(200, { wms_id: "10", warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", stock: [
          { sku: "ABC123", name: "Brake pad set", batch: null, owner: "DEFAULT", on_hand: "48", reserved: "0", available: "48", uom: "EA", received_at: "2026-08-30" },
        ] });
      }
      if (url === "/v1/locations" && init?.method === "POST") return jsonResponse(202, { message_id: "m", wms_id: "12", status: "created" });
      return jsonResponse(404, { detail: `no route ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); api.setSession(null); });

  it("lists locations with their zones and rules", async () => {
    renderPage();
    expect(await screen.findByText("PF-01-02-A")).toBeInTheDocument();
    expect(screen.getByText("BK-04-01-C")).toBeInTheDocument();
    expect(screen.getByText("Ballarat · BAL-WH01")).toBeInTheDocument();
    expect(screen.getByText("No · one SKU")).toBeInTheDocument();
    expect(screen.getByText("Pallet rack")).toBeInTheDocument();
    expect(screen.getByText("3 PALLET")).toBeInTheDocument();
    expect(screen.getByText("Forklift")).toBeInTheDocument();
    // zone chips
    expect(screen.getByRole("button", { name: "All zones" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PICKFACE" })).toBeInTheDocument();
  });

  it("filters by zone chip", async () => {
    renderPage();
    await screen.findByText("PF-01-02-A");
    await userEvent.setup().click(screen.getByRole("button", { name: "BULK" }));
    await waitFor(() => expect(screen.queryByText("PF-01-02-A")).not.toBeInTheDocument());
    expect(screen.getByText("BK-04-01-C")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/locations?warehouse=BAL-WH01&zone=BULK")).toBe(true);
  });

  it("opens a row in the panel and loads what it holds", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("PF-01-02-A"));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    expect(within(panel).getByText("PF-01-02-A")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Zone")).toHaveValue("PICKFACE");
    expect(within(panel).getByLabelText("Pick sequence")).toHaveValue("102");
    expect(within(panel).getByLabelText("Type")).toHaveValue("shelf");
    expect(within(panel).getByRole("switch", { name: /One product only/ })).toBeChecked();
    expect(within(panel).getByRole("switch", { name: /Counts in FIFO/ })).toBeDisabled();
    expect(within(panel).getByLabelText(/^Barcode/)).toHaveValue("LOC-PF-01-02-A");
    expect(await screen.findByText("ABC123 ×48")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Print label" })).toBeDisabled();
  });

  it("adds a location with the message envelope", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("PF-01-02-A");
    await user.click(screen.getByRole("button", { name: "Add location" }));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.type(within(panel).getByLabelText(/^Code/), "pf-01-03-a");
    await user.selectOptions(within(panel).getByLabelText("Zone"), "PICKFACE");
    await user.type(within(panel).getByLabelText("Pick sequence"), "103");
    await user.click(within(panel).getByRole("button", { name: "Step" }));
    await user.click(within(panel).getByRole("switch", { name: /One product only/ }));
    await user.type(within(panel).getByLabelText("Capacity"), "96");
    await user.type(within(panel).getByLabelText("Capacity unit"), "ea");
    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/locations" && c[1]?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find((c) => c[0] === "/v1/locations" && c[1]?.method === "POST")!;
    const body = JSON.parse(post[1].body as string);
    expect(body.message_id).toEqual(expect.any(String));
    expect(body.message_id.length).toBeGreaterThan(10);
    expect(body).toMatchObject({
      warehouse: "BAL-WH01", code: "PF-01-03-A", zone: "PICKFACE", type: "shelf", access: "step",
      mixing: "single_sku", pick_sequence: 103, capacity: "96", capacity_uom: "EA", barcode: null, active: true,
    });
    expect(await screen.findByText("Added PF-01-03-A.")).toBeInTheDocument();
  });

  it("shows a field error from the API under the field", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/refresh") return jsonResponse(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (url === "/v1/auth/me") return jsonResponse(200, ME);
      if (url === "/v1/warehouses") return jsonResponse(200, { items: [WAREHOUSE], total: 1 });
      if (url.startsWith("/v1/zones?")) return jsonResponse(200, { items: ZONES, total: 2 });
      if (url.startsWith("/v1/locations?")) return jsonResponse(200, { items: LOCATIONS, total: 2 });
      if (url === "/v1/locations/11/stock") return jsonResponse(200, { wms_id: "11", warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", stock: [] });
      if (url === "/v1/locations" && init?.method === "POST") return jsonResponse(422, { errors: [{ field: "capacity", message: "must be zero or more" }] });
      return jsonResponse(404, {});
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("BK-04-01-C"));
    expect(await screen.findByText("Empty")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("must be zero or more")).toBeInTheDocument();
  });
});
