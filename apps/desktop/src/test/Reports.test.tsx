import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Reports } from "../pages/Reports";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function csv(text: string) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/csv" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: {}, active: true };

const LISTING = {
  items: [
    { report: "stock-on-hand", describe: "What is on the shelves right now, from the balances the ledger rebuilds.", filters: ["warehouse", "owner", "zone", "sku", "group_by"] },
    { report: "movements", describe: "Every movement by day and type: what came in, what went out.", filters: ["warehouse", "owner", "from", "to", "sku", "movement_type"] },
    { report: "pick-rate", describe: "Lines and units picked per operator, and how fast.", filters: ["warehouse", "owner", "from", "to", "operator"] },
    { report: "variances", describe: "Every adjustment with its reason, oldest at the bottom.", filters: ["warehouse", "owner", "from", "to", "sku", "reason"] },
    { report: "shipped", describe: "Deliveries that left, by day.", filters: ["warehouse", "owner", "from", "to"] },
  ],
  total: 5,
};

const ON_HAND = {
  report: "stock-on-hand", warehouse: "BAL-WH01", owner: "DEFAULT", from: null, to: null,
  describe: "What is on the shelves right now, from the balances the ledger rebuilds.",
  columns: ["sku", "name", "warehouse", "zone", "location", "batch", "owner", "on_hand", "reserved", "available", "uom", "received_at"],
  rows: [
    {
      sku: "ABC123", name: "Brake pad set", warehouse: "BAL-WH01", zone: "PICKFACE", location: "PF-01-02-A",
      batch: null, owner: "DEFAULT", on_hand: "48", reserved: "10", available: "38", uom: "EA", received_at: "2026-08-30",
    },
  ],
  totals: { lines: 1, on_hand: "48", available: "38" },
};

/** Two days of movements: enough for the chart. */
const MOVEMENTS = {
  report: "movements", warehouse: "BAL-WH01", owner: "DEFAULT", from: "2026-08-22", to: "2026-09-20",
  describe: "Every movement by day and type: what came in, what went out.",
  columns: ["day", "movement_type", "lines", "qty_in", "qty_out", "net"],
  rows: [
    { day: "2026-09-20", movement_type: "pick", lines: 12, qty_in: "0", qty_out: "48", net: "-48" },
    { day: "2026-09-19", movement_type: "receipt", lines: 3, qty_in: "1200", qty_out: "0", net: "1200" },
  ],
  totals: { lines: 15, qty_in: "1200", qty_out: "48" },
};

const ONE_DAY = { ...MOVEMENTS, rows: [MOVEMENTS.rows[0]], totals: { lines: 12, qty_in: "0", qty_out: "48" } };

function renderReports() {
  return render(
    <MemoryRouter initialEntries={["/reports"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/reports" element={<Reports />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

/** The table's header row: column names live here, filter labels do not. */
function headerRow(): HTMLElement {
  const el = document.querySelector("div.grid.eyebrow");
  if (!el) throw new Error("no report table yet");
  return el as HTMLElement;
}

/** The row of stat tiles built from the report's totals. */
function tileRow(): HTMLElement {
  const el = document.querySelector("div.grid.grid-cols-4");
  if (!el) throw new Error("no totals yet");
  return el as HTMLElement;
}

/** Every report call made, newest last. */
function reportCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/v1/reports/"));
}

describe("Reports", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let movements: Record<string, unknown> = MOVEMENTS;

  beforeEach(() => {
    movements = MOVEMENTS;
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string) => {
      const [path, query = ""] = String(url).split("?");
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/reports") return json(200, LISTING);
      if (path === "/v1/reports/stock-on-hand") return json(200, ON_HAND);
      if (path === "/v1/reports/movements") {
        if (query.includes("format=csv")) return csv("day,movement_type,lines\n2026-09-20,pick,12\n");
        return json(200, movements);
      }
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the reports, runs stock on hand first and shows its totals", async () => {
    renderReports();
    for (const label of ["Stock on hand", "Movements", "Pick rate", "Variances", "Shipped"]) {
      expect(await screen.findByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByText("What is on the shelves right now, from the balances the ledger rebuilds.")).toBeInTheDocument();

    // the generic table, with nicer headers and the sku in bold
    expect(await screen.findByText("ABC123", { selector: "b" })).toBeInTheDocument();
    const head = headerRow();
    expect(within(head).getByText("SKU")).toBeInTheDocument();
    expect(within(head).getByText("On hand")).toBeInTheDocument();
    expect(within(head).getByText("Received")).toBeInTheDocument();
    expect(screen.getByText("PF-01-02-A", { selector: "span.mono" })).toBeInTheDocument();
    expect(screen.getByText("30 Aug")).toBeInTheDocument();

    // one tile per key in totals
    const tiles = tileRow();
    expect(within(tiles).getByText("Lines")).toBeInTheDocument();
    expect(within(tiles).getByText("On hand")).toBeInTheDocument();
    expect(within(tiles).getByText("48")).toBeInTheDocument();
    expect(within(tiles).getByText("Available")).toBeInTheDocument();

    // stock on hand declares group_by, not from/to
    expect(screen.getByLabelText("Group by")).toBeInTheDocument();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();

    const call = reportCalls(fetchMock).find((u) => u.startsWith("/v1/reports/stock-on-hand"));
    expect(call).toContain("warehouse=BAL-WH01");
    expect(call).toContain("owner=DEFAULT");
    expect(call).toContain("group_by=location");

    // changing a filter runs the report again
    await userEvent.setup().click(screen.getByRole("button", { name: "Product" }));
    await waitFor(() => expect(reportCalls(fetchMock).some((u) => u.includes("group_by=product"))).toBe(true));
  });

  it("runs movements with the warehouse and date range, and draws a day chart", async () => {
    renderReports();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Movements" }));

    expect(await screen.findByText("Every movement by day and type: what came in, what went out.")).toBeInTheDocument();
    const call = await waitFor(() => {
      const found = reportCalls(fetchMock).find((u) => u.startsWith("/v1/reports/movements"));
      expect(found).toBeDefined();
      return found!;
    });
    expect(call).toContain("warehouse=BAL-WH01");
    expect(call).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(call).toMatch(/to=\d{4}-\d{2}-\d{2}/);

    // the movement filters appear, the stock ones do not
    expect(await screen.findByLabelText("Movement")).toBeInTheDocument();
    expect(screen.queryByLabelText("Group by")).not.toBeInTheDocument();

    // headers and rows from the mocked columns
    await screen.findByText("receipt");
    const head = headerRow();
    expect(within(head).getByText("Qty in")).toBeInTheDocument();
    expect(within(head).getByText("Day")).toBeInTheDocument();
    expect(within(head).getByText("Movement")).toBeInTheDocument();
    expect(screen.getAllByText("1,200").length).toBeGreaterThan(0);

    // two days of data: one bar per day, oldest first
    expect(screen.getByText("Quantity in per day")).toBeInTheDocument();
    expect(screen.getByTitle("19 Sep · 1,200")).toBeInTheDocument();
    expect(screen.getByTitle("20 Sep · 0")).toBeInTheDocument();
  });

  it("draws no chart for a single day of movements", async () => {
    movements = ONE_DAY;
    renderReports();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Movements" }));

    await screen.findByText("pick");
    expect(within(headerRow()).getByText("Qty out")).toBeInTheDocument();
    expect(screen.queryByText("Quantity in per day")).not.toBeInTheDocument();
  });

  it("downloads the chosen report as CSV with the bearer token", async () => {
    renderReports();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Movements" }));
    await screen.findByText("receipt");

    await user.click(screen.getByRole("button", { name: "Download CSV" }));

    const download = await waitFor(() => {
      const found = fetchMock.mock.calls.find((c) => String(c[0]).includes("format=csv"));
      expect(found).toBeDefined();
      return found!;
    });
    expect(String(download[0])).toContain("/v1/reports/movements?");
    expect(String(download[0])).toContain("warehouse=BAL-WH01");
    const headers = (download[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${api.session?.token}`);
    expect(headers.Authorization).toMatch(/^Bearer \S+$/);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
