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

const COUNT_TASK = {
  wms_id: "c1", type: "count", title: "Count PF-01-02-A", status: "in_progress", warehouse: "BAL-WH01",
  owner: "DEFAULT", priority: "normal", source_type: null, source_ref: null, assigned_to: null, device: null,
  needs_supervisor: false, note: null, created_by: null, created_at: "2026-09-20T01:00:00Z", started_at: null,
  completed_at: null, cancelled_at: null, progress: { done: 0, total: 1 },
  lines: [{
    line_no: 1, source_line: null, sku: "ABC123", name: "Brake pad set", batch: null, expected_qty: null,
    actual_qty: null, variance: null, uom: "EA", from_location: "PF-01-02-A", to_location: null,
    container_id: null, status: "open", reason: null, completed_at: null,
  }],
};

function csv(text: string) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/csv" } });
}

/** Every body posted to a path, oldest first. */
function posted(mock: ReturnType<typeof vi.fn>, path: string) {
  return mock.mock.calls
    .filter((c) => String(c[0]) === path)
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}

/** Every call made, in order, so a flow can be read back. */
function paths(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map((c) => String(c[0]).split("?")[0]);
}

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
      if (path === "/v1/reports/stock-on-hand") return csv("sku,location,on_hand\nABC123,PF-01-02-A,48\n");
      if (path === "/v1/counts") return json(202, { message_id: "m", wms_id: "c1", status: "accepted" });
      if (path === "/v1/tasks/c1") return json(200, COUNT_TASK);
      if (path === "/v1/tasks/c1/lines/1/confirm") {
        return json(202, { message_id: "m", wms_id: "c1", status: "accepted", task: COUNT_TASK, line: { ...COUNT_TASK.lines[0], status: "variance", actual_qty: "40", variance: "-8" } });
      }
      if (path === "/v1/tasks/c1/lines/1/approve") {
        return json(202, { message_id: "m", wms_id: "c1", status: "accepted", task: COUNT_TASK, line: { ...COUNT_TASK.lines[0], status: "done" } });
      }
      if (path === "/v1/moves") return json(202, { message_id: "m", wms_id: "mv1", status: "accepted" });
      if (path === "/v1/stock/ledger") return json(200, { items: [
        { wms_id: "9", at: new Date().toISOString(), movement_type: "receipt", reason: null, warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", sku: "ABC123", batch: null, owner: "DEFAULT", qty_change: "120", uom: "EA", received_at: "2026-09-03", actor: "jo", device: null, task_id: null, external_ref: "PO-88812", container_id: null, note: null },
      ], total: 1 });
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:stock"), revokeObjectURL: vi.fn() }));
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

  it("downloads the stock on hand report as CSV for the looked-up sku", async () => {
    renderStock();
    const user = userEvent.setup();

    const button = await screen.findByRole("button", { name: "Export CSV" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Look up a SKU first");

    await user.type(screen.getByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
    await user.click(button);

    const call = await waitFor(() => {
      const found = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/v1/reports/stock-on-hand"));
      expect(found).toBeDefined();
      return found!;
    });
    const url = new URL(String(call[0]), "http://x");
    expect(url.searchParams.get("sku")).toBe("ABC123");
    expect(url.searchParams.get("warehouse")).toBe("BAL-WH01");
    expect(url.searchParams.get("format")).toBe("csv");
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${api.session?.token}` });
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("adjusts stock by counting the shelf, confirming it and approving the variance", async () => {
    renderStock();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");

    await user.click(screen.getByRole("button", { name: "Adjust stock" }));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    expect(within(panel).getByLabelText("Location")).toHaveValue("0");
    await user.type(within(panel).getByLabelText(/^Counted quantity/), "40");
    await user.click(within(panel).getByText("Count variance", { selector: "button" }));
    await user.type(within(panel).getByLabelText("Note"), "Two boxes crushed");
    await user.click(within(panel).getByRole("button", { name: "Adjust" }));

    expect(await screen.findByText("Adjusted to 40 EA at PF-01-02-A.")).toBeInTheDocument();

    const [count] = posted(fetchMock, "/v1/counts");
    expect(count.message_id).toEqual(expect.any(String));
    expect(count).toMatchObject({ warehouse: "BAL-WH01", owner: "DEFAULT", locations: ["PF-01-02-A"], sku: "ABC123" });

    const [confirm] = posted(fetchMock, "/v1/tasks/c1/lines/1/confirm");
    expect(confirm).toMatchObject({ qty: "40", uom: "EA" });
    expect(confirm.qty).toEqual(expect.any(String));

    const [approve] = posted(fetchMock, "/v1/tasks/c1/lines/1/approve");
    expect(approve).toMatchObject({ reason: "count_variance", note: "Two boxes crushed" });

    // in order: the count, the task it made, the confirm, then the approval
    const flow = paths(fetchMock).filter((p) => p.startsWith("/v1/counts") || p.startsWith("/v1/tasks/"));
    expect(flow).toEqual([
      "/v1/counts", "/v1/tasks/c1", "/v1/tasks/c1/lines/1/confirm", "/v1/tasks/c1/lines/1/approve",
    ]);
  });

  it("says so, and approves nothing, when the count already matches", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/v1/tasks/c1/lines/1/confirm") {
        return json(202, { message_id: "m", wms_id: "c1", status: "accepted", task: COUNT_TASK, line: { ...COUNT_TASK.lines[0], status: "done", actual_qty: "48" } });
      }
      return base(url, init);
    });

    renderStock();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");

    await user.click(screen.getByRole("button", { name: "Adjust stock" }));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.type(within(panel).getByLabelText(/^Counted quantity/), "48");
    await user.click(within(panel).getByText("Count variance", { selector: "button" }));
    await user.click(within(panel).getByRole("button", { name: "Adjust" }));

    expect(await screen.findByText("Counted 48 at PF-01-02-A. It already matched.")).toBeInTheDocument();
    expect(posted(fetchMock, "/v1/tasks/c1/lines/1/approve")).toHaveLength(0);
  });

  it("shows an adjustment refused by the API in gold", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/v1/counts") return json(409, { code: "task_not_open", detail: "PF-01-02-A is already being counted" });
      return base(url, init);
    });

    renderStock();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");

    await user.click(screen.getByRole("button", { name: "Adjust stock" }));
    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.type(within(panel).getByLabelText(/^Counted quantity/), "40");
    await user.click(within(panel).getByRole("button", { name: "Found" }));
    await user.click(within(panel).getByRole("button", { name: "Adjust" }));

    const notice = await screen.findByText("PF-01-02-A is already being counted");
    expect(notice).toHaveClass("text-gold");
    expect(posted(fetchMock, "/v1/tasks/c1/lines/1/confirm")).toHaveLength(0);
  });

  it("moves stock from the chosen shelf, with its batch, and reloads the lookup", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).split("?")[0] === "/v1/stock") {
        return json(200, {
          sku: "ABC123", uom: "EA", total_on_hand: "168", total_available: "158",
          locations: [
            { warehouse: "BAL-WH01", location: "PF-01-02-A", zone: "PICKFACE", batch: null, owner: "DEFAULT", on_hand: "48", reserved: "10", available: "38", received_at: "2026-08-30" },
            { warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", batch: "B2611", owner: "DEFAULT", on_hand: "120", reserved: "0", available: "120", received_at: "2026-09-03" },
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
    await user.click(within(panel).getByRole("button", { name: "Move stock" }));
    await user.selectOptions(within(panel).getByLabelText("From"), within(panel).getByRole("option", { name: "BK-04-01-C · B2611" }));
    await user.type(within(panel).getByLabelText("To"), "PF-01-02-A");
    await user.type(within(panel).getByLabelText(/^Quantity/), "12");
    await user.click(within(panel).getByRole("button", { name: "Consolidate" }));
    await user.click(within(panel).getByRole("button", { name: "Move" }));

    expect(await screen.findByText("Moved 12 EA to PF-01-02-A.")).toBeInTheDocument();
    const [move] = posted(fetchMock, "/v1/moves");
    expect(move.message_id).toEqual(expect.any(String));
    expect(move).toMatchObject({
      warehouse: "BAL-WH01", owner: "DEFAULT", sku: "ABC123", batch: "B2611", qty: "12", uom: "EA",
      from_location: "BK-04-01-C", to_location: "PF-01-02-A", reason: "consolidate",
    });
    // the lookup is asked again so the shelves are right
    const lookups = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/v1/stock?"));
    expect(lookups.length).toBeGreaterThan(1);
  });

  it("puts a field error from a move under its field", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/v1/moves") return json(422, { errors: [{ field: "qty", message: "only 38 available at PF-01-02-A" }] });
      return base(url, init);
    });

    renderStock();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");

    const panel = screen.getByRole("complementary", { name: "Detail" });
    await user.click(within(panel).getByRole("button", { name: "Move stock" }));
    await user.type(within(panel).getByLabelText("To"), "BK-04-01-C");
    await user.type(within(panel).getByLabelText(/^Quantity/), "400");
    await user.click(within(panel).getByRole("button", { name: "Move" }));

    expect(await screen.findByText("only 38 available at PF-01-02-A")).toHaveClass("text-gold");
  });

  it("keeps one muted owner chip on one owner, and filters on the owner where there are more", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url).split("?")[0];
      if (path === "/v1/warehouses") return json(200, { items: [{ ...WAREHOUSE, settings: { multi_owner: true } }], total: 1 });
      if (path === "/v1/owners") {
        return json(200, { items: [
          { wms_id: "1", code: "DEFAULT", name: "Q7", contact: null, email: null, phone: null, settings: {}, note: null, active: true, created_at: "2026-01-01T00:00:00Z" },
          { wms_id: "2", code: "NORTHCO", name: "Northco", contact: null, email: null, phone: null, settings: {}, note: null, active: true, created_at: "2026-01-01T00:00:00Z" },
        ], total: 2 });
      }
      return base(url, init);
    });

    renderStock();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("SKU"), "ABC123{Enter}");
    await screen.findByText("Brake pad set · EA · batch tracked");

    expect(screen.queryByText("Owner: DEFAULT")).not.toBeInTheDocument();
    const ownersCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/v1/owners"));
    expect(String(ownersCall![0])).toContain("active=true");

    await user.click(await screen.findByRole("button", { name: "NORTHCO" }));
    await waitFor(() => {
      const last = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/v1/stock?")).pop();
      expect(last).toContain("owner=NORTHCO");
    });
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/v1/products/ABC123?owner=NORTHCO"))).toBe(true);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/v1/stock/ledger?") && u.includes("owner=NORTHCO"))).toBe(true);
  });

  it("keeps a single muted owner chip while one owner is all there is", async () => {
    renderStock();
    expect(await screen.findByText("Owner: DEFAULT")).toBeInTheDocument();
    expect(screen.getByText("Owner: DEFAULT")).not.toHaveAttribute("title");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/v1/owners"))).toBe(false);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("title") ?? "").not.toMatch(/step/i);
    }
  });
});
