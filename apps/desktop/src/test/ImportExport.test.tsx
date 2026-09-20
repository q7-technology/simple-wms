import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { ImportExport } from "../pages/ImportExport";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function csvResponse(text: string) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/csv" } });
}

const ME = { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" };
const WAREHOUSES = [
  { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: {}, active: true },
  { wms_id: "2", code: "MEL-WH01", site: "MEL", name: "Melbourne", settings: {}, active: true },
];
const CSV = "sku,name,uom\nABC123,Brake pad set,EA\nABC12,Mystery part,\n";

const PREVIEW = {
  message_id: "m1", type: "products", rows_read: 2, ready: 1, problems: 1, committed: false, imported: 0, summary: "as 1 product",
  preview: [
    { row: 1, problem: null, data: { sku: "ABC123", name: "Brake pad set", uom: "EA" } },
    { row: 2, problem: "uom: required", data: { sku: "ABC12", name: "Mystery part", uom: "" } },
  ],
};
const COMMITTED = { ...PREVIEW, message_id: "m2", committed: true, imported: 1 };

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/import"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/import" element={<ImportExport />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Import and export", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900 });
      if (url === "/v1/auth/me") return json(200, ME);
      if (url === "/v1/warehouses") return json(200, { items: WAREHOUSES, total: 2 });
      if (url === "/v1/imports/products" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        return json(202, body.dry_run ? PREVIEW : COMMITTED);
      }
      if (url.startsWith("/v1/reports/")) return csvResponse("sku,on_hand\nABC123,48\n");
      return json(404, { detail: `no route ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => { vi.unstubAllGlobals(); api.setSession(null); });

  it("previews pasted CSV with problems first, then imports", async () => {
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("CSV fallback")).toBeInTheDocument();
    expect(screen.getByText(/nothing is written until Import is pressed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export stock on hand" })).toBeEnabled();

    const previewButton = screen.getByRole("button", { name: "Preview" });
    expect(previewButton).toBeDisabled();

    const textarea = screen.getByLabelText("or paste CSV");
    await user.click(textarea);
    await user.paste(CSV);
    expect(screen.getByText("2 rows pasted")).toBeInTheDocument();
    expect(previewButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Products" }));
    expect(previewButton).toBeEnabled();
    await user.click(previewButton);

    // the dry run
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/imports/products");
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ warehouse: "BAL-WH01", owner: "DEFAULT", csv: CSV, dry_run: true, skip_problems: true });
      expect(typeof body.message_id).toBe("string");
    });

    // tiles and preview, problems first
    expect(await screen.findByText("Preview · problems first")).toBeInTheDocument();
    const problems = screen.getByText("Rows with problems").parentElement as HTMLElement;
    expect(within(problems).getByText("1")).toHaveClass("text-gold");
    expect(within(problems).getByText("fix or skip")).toBeInTheDocument();
    expect(within(screen.getByText("Ready to import").parentElement as HTMLElement).getByText("as 1 product")).toBeInTheDocument();
    expect(screen.getByText("uom: required")).toHaveClass("text-gold");
    expect(screen.getByText("OK")).toBeInTheDocument();
    const rows = screen.getAllByText(/^(ABC12|ABC123)$/).map((el) => el.textContent);
    expect(rows).toEqual(["ABC12", "ABC123"]);
    expect(screen.getByText("SKU")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("UOM")).toBeInTheDocument();

    // the commit
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => (c[0] as string) === "/v1/imports/products");
      expect(calls).toHaveLength(2);
      const body = JSON.parse((calls[1][1] as RequestInit).body as string);
      expect(body).toMatchObject({ warehouse: "BAL-WH01", owner: "DEFAULT", csv: CSV, dry_run: false, skip_problems: true });
    });
    expect(await screen.findByText("Imported 1 row as 1 product")).toBeInTheDocument();
    expect(screen.queryByText("Preview · problems first")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });

  it("shows a field error in gold when the commit is refused", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900 });
      if (url === "/v1/auth/me") return json(200, ME);
      if (url === "/v1/warehouses") return json(200, { items: WAREHOUSES, total: 2 });
      if (url === "/v1/imports/products" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.dry_run) return json(202, PREVIEW);
        return json(422, { errors: [{ field: "csv", message: "1 row has problems and skip_problems is off" }] });
      }
      return json(404, { detail: `no route ${url}` });
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("or paste CSV"));
    await user.paste(CSV);
    await user.click(screen.getByRole("button", { name: "Products" }));
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 row" }));
    expect(await screen.findByText("csv: 1 row has problems and skip_problems is off")).toBeInTheDocument();
    // the preview stays so the rows can be fixed
    expect(screen.getByText("Preview · problems first")).toBeInTheDocument();
  });

  it("exports stock on hand and a month of movements as CSV, with the bearer token", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Export stock on hand" }));

    const onHand = await waitFor(() => {
      const found = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/v1/reports/stock-on-hand"));
      expect(found).toBeDefined();
      return found!;
    });
    expect(String(onHand[0])).toContain("warehouse=BAL-WH01");
    expect(String(onHand[0])).toContain("format=csv");
    expect((onHand[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${api.session?.token}` });

    await user.click(screen.getByRole("button", { name: "Export movements" }));
    const movements = await waitFor(() => {
      const found = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/v1/reports/movements"));
      expect(found).toBeDefined();
      return found!;
    });
    const url = new URL(String(movements[0]), "http://x");
    expect(url.searchParams.get("warehouse")).toBe("BAL-WH01");
    expect(url.searchParams.get("format")).toBe("csv");
    const day = /^\d{4}-\d{2}-\d{2}$/;
    expect(url.searchParams.get("from")).toMatch(day);
    expect(url.searchParams.get("to")).toMatch(day);
    const days = (Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("offers every import the API takes, with no step titles left", async () => {
    renderPage();
    await screen.findByText("CSV fallback");
    for (const label of ["Deliveries (pick orders)", "Expected receipts", "Products",
                         "Locations", "Replenishments", "Transfers"]) {
      expect(screen.getByText(label, { selector: "button" })).toBeEnabled();
    }
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("title") ?? "").not.toMatch(/step/i);
    }
  });

  it("previews a delivery import the way the design shows it", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("CSV fallback");
    await user.click(screen.getByText("Deliveries (pick orders)", { selector: "button" }));
    await user.type(screen.getByLabelText(/paste/i),
      "reference,ship_to_name,line,sku,qty,uom\n0080012345,Acme,10,ABC123,10,EA");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith("/v1/imports/deliveries"));
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.dry_run).toBe(true);
    expect(body.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.csv).toContain("0080012345");
  });
});
