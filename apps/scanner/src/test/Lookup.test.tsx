import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Lookup, sumQty } from "../pages/Lookup";

const SESSION = {
  token: "tok", expires_in: 43200,
  operator: { code: "op-017", name: "Sam Lee", roles: ["operator"], supervisor: false },
  warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
};

const STOCK = {
  sku: "ABC123", uom: "EA", total_on_hand: "144", total_available: "134",
  locations: [
    { warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", batch: "B2601", owner: "DEFAULT", on_hand: "72", reserved: "0", available: "72", received_at: "2026-08-20" },
    { warehouse: "MEL-WH01", location: "PF-02-01-B", zone: "PICKFACE", batch: null, owner: "DEFAULT", on_hand: "24", reserved: "0", available: "24", received_at: "2026-08-01" },
    { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: "B2601", owner: "DEFAULT", on_hand: "48", reserved: "10", available: "38", received_at: "2026-08-10" },
  ],
};
const PRODUCT = {
  wms_id: "77", owner: "DEFAULT", sku: "ABC123", name: "Brake pad set", uom: "EA", decimals_allowed: false, batch_tracked: true,
  preferred_zone: null, pickface_min: null, pickface_max: null, barcodes: [], active: true,
};
const SHELF = {
  wms_id: "501", warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE",
  stock: [{ sku: "ABC123", name: "Brake pad set", batch: "B2601", owner: "DEFAULT", on_hand: "48", reserved: "10", available: "38", uom: "EA", received_at: "2026-08-10" }],
};

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith("/v1/stock?")) return reply(200, STOCK);
  if (url.startsWith("/v1/products/")) return reply(200, PRODUCT);
  if (url.startsWith("/v1/locations/PF-01-02-A/stock")) return reply(200, SHELF);
  return reply(404, { detail: "not found" });
});

function renderLookup(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/lookup" element={<Lookup />} />
          <Route path="/move" element={<div>Move page</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Lookup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
    window.localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
    window.localStorage.setItem("wms.scanner.session", JSON.stringify(SESSION));
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads a product from ?sku= and shows totals and shelves oldest first", async () => {
    renderLookup("/lookup?sku=ABC123");
    expect(screen.getByText("Where is it?")).toBeInTheDocument();
    expect(screen.getByText("Sam · BAL")).toBeInTheDocument();

    expect(await screen.findByText("Brake pad set · EA")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Batch tracked")).toBeInTheDocument();
    expect(screen.getByText("On hand").nextSibling).toHaveTextContent("144");
    expect(screen.getByText("Reserved").nextSibling).toHaveTextContent("10");
    expect(screen.getByText("Available").nextSibling).toHaveTextContent("134");

    const rows = screen.getAllByTestId("shelf-row").map((r) => r.textContent);
    expect(rows).toEqual(["PF-01-02-A · B260148 · 10 held", "BK-04-01-C · B260172", "MEL-WH01 · PF-02-01-B24 · other site"]);

    expect(fetchMock.mock.calls.map(([u]) => u)).toContain("/v1/stock?sku=ABC123");
  });

  it("narrows to this warehouse when the chip is tapped", async () => {
    const user = userEvent.setup();
    renderLookup("/lookup?sku=ABC123");
    await screen.findByText("Brake pad set · EA");
    await user.click(screen.getByRole("button", { name: "This warehouse · BAL-WH01" }));
    await screen.findByText("Brake pad set · EA");
    expect(fetchMock.mock.calls.map(([u]) => u)).toContain("/v1/stock?sku=ABC123&warehouse=BAL-WH01");
  });

  it("loads a shelf from ?location= and moves from it", async () => {
    const user = userEvent.setup();
    renderLookup("/lookup?location=PF-01-02-A");
    expect(await screen.findByText("PICKFACE · BAL-WH01")).toBeInTheDocument();
    expect(screen.getByText("PF-01-02-A")).toBeInTheDocument();
    expect(screen.getByTestId("stock-row")).toHaveTextContent("Brake pad set · B2601 · received 10 Aug");
    expect(fetchMock.mock.calls.map(([u]) => u)).toContain("/v1/locations/PF-01-02-A/stock?warehouse=BAL-WH01");
    expect(screen.getByRole("button", { name: "Print label" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move from here" }));
    expect(await screen.findByText("Move page")).toBeInTheDocument();
  });

  it("adds decimal quantities without floating point drift", () => {
    expect(sumQty(["0.1", "0.2"])).toBe("0.3");
    expect(sumQty(["48", "10.5", "-2.25"])).toBe("56.25");
    expect(sumQty([])).toBe("0");
  });
});
