import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Receive } from "../pages/Receive";
import type { Task, TaskLine } from "../api/types";

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
    token: "t", expires_in: 43200, operator: { code: "op-017", name: "Sam Lee", roles: ["receiver"], supervisor: false },
    warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
  }));
  localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
  localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
}

const line = (n: number, sku: string, name: string, qty: string, over: Partial<TaskLine> = {}): TaskLine => ({
  line_no: n, source_line: n, sku, name, batch: null, expected_qty: qty, actual_qty: null, variance: null, uom: "EA",
  from_location: null, to_location: null, container_id: null, status: "open", reason: null, completed_at: null, ...over,
});

const task = (lines: TaskLine[], done: number): Task => ({
  wms_id: "1", type: "receive", title: "Receive PO-88815", status: "in_progress", warehouse: "BAL-WH01", owner: "DEFAULT",
  priority: "normal", source_type: "receipt", source_ref: "PO-88815", assigned_to: "op-017", device: "SCN-BAL-07",
  needs_supervisor: false, note: "Supplier Co", created_by: null, created_at: "2026-09-20T00:00:00Z", started_at: null,
  completed_at: null, cancelled_at: null, progress: { done, total: lines.length }, lines,
});

function renderReceive(path = "/receive/1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/receive" element={<Receive />} />
          <Route path="/receive/:taskId" element={<Receive />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Receive", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("scans the product, picks the shelf and confirms the line through the queue", async () => {
    const open = task([line(1, "ABC123", "Brake pad set", "120"), line(2, "DEF456", "Rotor 280 mm", "40")], 0);
    const afterOne = task([line(1, "ABC123", "Brake pad set", "120", { actual_qty: "120", status: "done", to_location: "BK-05-01-A" }), line(2, "DEF456", "Rotor 280 mm", "40")], 1);
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/tasks/1" && method === "GET") return { body: open };
      if (url === "/v1/scans/parse") {
        if (body.raw === "09312345000012") return { body: { raw: body.raw, format: "gs1", type: "product", fields: { gtin: "09312345000012", qty: "120" }, resolved: { sku: "ABC123", name: "Brake pad set", uom: "EA", batch_tracked: false, qty: "120", batch: null }, matches_expected: true, message: null } };
        if (body.raw === "BK-05-01-A") return { body: { raw: body.raw, format: "plain", type: "location", fields: {}, resolved: { location: "BK-05-01-A", zone: "BULK" }, matches_expected: true, message: null } };
      }
      if (url === "/v1/locations/suggest") return { body: { suggestions: [{ location: "BK-05-01-A", zone: "BULK", reason: "empty_in_preferred_zone" }], flag: null } };
      if (url === "/v1/tasks/1/lines/1/confirm") return { status: 202, body: { message_id: body.message_id, wms_id: "1", status: "accepted", task: afterOne, line: afterOne.lines[0] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderReceive();

    expect(await screen.findByText("Line 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("PO-88815 · Supplier Co")).toBeInTheDocument();
    expect(screen.getByText("Sam · BAL")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Expected 120 EA")).toBeInTheDocument();
    expect(screen.getByText("Scan the product")).toBeInTheDocument();

    // a GS1 product scan fills the card and the quantity
    await user.type(screen.getByLabelText("Scan"), "09312345000012{Enter}");
    expect(await screen.findByText("EA scanned from GS1 label")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(120);
    expect(await screen.findByText("BK-05-01-A")).toBeInTheDocument();
    expect(screen.getByText("Empty shelf in BULK · preferred zone")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm receipt" });
    expect(confirm).toBeDisabled();

    // the shelf scan sets the destination
    await user.type(screen.getByLabelText("Scan"), "BK-05-01-A{Enter}");
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByText("Scanned · Empty shelf in BULK · preferred zone")).toBeInTheDocument();

    await user.click(confirm);
    expect(await screen.findByText("Line 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("DEF456")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/tasks/1/lines/1/confirm");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent.qty).toBe("120");
    expect(sent.uom).toBe("EA");
    expect(sent.location).toBe("BK-05-01-A");
    expect(sent.operator).toBe("op-017");
    expect(sent.device).toBe("SCN-BAL-07");
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows the wrong-scan card when a different product is scanned", async () => {
    mockFetch((url, method, body) => {
      if (url === "/v1/tasks/1" && method === "GET") return { body: task([line(1, "ABC123", "Brake pad set", "120")], 0) };
      if (url === "/v1/scans/parse" && body.raw === "LOC-PF-01-03-B") return { body: { raw: body.raw, format: "plain", type: "location", fields: {}, resolved: { location: "PF-01-03-B" }, matches_expected: false, message: "That is a location. This step wants a product." } };
      return undefined;
    });
    const user = userEvent.setup();
    renderReceive();
    await screen.findByText("Line 1 of 1");
    await user.type(screen.getByLabelText("Scan"), "LOC-PF-01-03-B{Enter}");
    expect(await screen.findByText("That is a location")).toBeInTheDocument();
    expect(screen.getByText("You scanned PF-01-03-B. This step wants the product barcode for ABC123.")).toBeInTheDocument();
    expect(screen.getByText("format: plain · type: location")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Scan again" }));
    expect(await screen.findByText("Scan the product")).toBeInTheDocument();
  });

  it("lists open receipts when no task is chosen", async () => {
    mockFetch((url, method) => {
      if (url.startsWith("/v1/tasks?") && method === "GET") return { body: { items: [task([line(1, "ABC123", "Brake pad set", "120")], 0)], total: 1 } };
      return undefined;
    });
    renderReceive("/receive");
    expect(await screen.findByText("Receive PO-88815 · Supplier Co")).toBeInTheDocument();
  });
});
