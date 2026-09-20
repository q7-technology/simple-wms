import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { ReceiveTransfer } from "../pages/ReceiveTransfer";
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
  line_no: n, source_line: n, sku, name, batch: "B2601", expected_qty: qty, actual_qty: null, variance: null, uom: "EA",
  from_location: "TRANSIT-IN", to_location: null, container_id: null, status: "open", reason: null, completed_at: null, ...over,
});

const task = (lines: TaskLine[], done: number): Task => ({
  wms_id: "1", type: "transfer_receive", title: "Receive STO-4500010", status: "in_progress", warehouse: "BAL-WH01",
  owner: "DEFAULT", priority: "normal", source_type: "transfer", source_ref: "STO-4500010", assigned_to: "op-017",
  device: "SCN-BAL-07", needs_supervisor: false, note: "from MEL-WH01", created_by: null,
  created_at: "2026-09-20T00:00:00Z", started_at: "2026-09-20T00:01:00Z", completed_at: null, cancelled_at: null,
  progress: { done, total: lines.length }, lines,
});

const LINE_1 = line(1, "ABC123", "Brake pad set", "200");
const LINE_2 = line(2, "DEF456", "Oil filter", "50");

const SHELF_SCAN = {
  raw: "BK-04-01-C", format: "plain", type: "location", fields: {},
  resolved: { location: "BK-04-01-C", zone: "BULK" }, matches_expected: true, message: null,
};

function renderTransfer(path = "/transfer-in/1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/transfer-in" element={<ReceiveTransfer />} />
          <Route path="/transfer-in/:taskId" element={<ReceiveTransfer />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("ReceiveTransfer", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("receives a full line onto a scanned shelf and moves to the next line", async () => {
    const open = task([LINE_1, LINE_2], 0);
    const afterOne = task([{ ...LINE_1, actual_qty: "200", status: "done", to_location: "BK-04-01-C" }, LINE_2], 1);
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/tasks/1" && method === "GET") return { body: open };
      if (url === "/v1/scans/parse" && body.raw === "BK-04-01-C") return { body: SHELF_SCAN };
      if (url === "/v1/tasks/1/lines/1/confirm") {
        return { status: 202, body: { message_id: body.message_id, wms_id: "1", status: "accepted", task: afterOne, line: afterOne.lines[0] } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderTransfer();

    expect(await screen.findByText("Line 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("STO-4500010")).toBeInTheDocument();
    expect(screen.getByText("Receive transfer")).toBeInTheDocument();
    expect(screen.getByText("Sam · BAL")).toBeInTheDocument();
    expect(screen.getByText("Shipped 200 EA")).toBeInTheDocument();
    expect(screen.getByText("from MEL-WH01 · batch B2601 · received date kept for FIFO")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(200));

    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText("Scan a shelf that allows this product")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Scan"), "BK-04-01-C{Enter}");
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByText("BK-04-01-C")).toBeInTheDocument();

    await user.click(confirm);
    expect(await screen.findByText("Line 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("DEF456")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/tasks/1/lines/1/confirm");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ qty: "200", uom: "EA", location: "BK-04-01-C", operator: "op-017", device: "SCN-BAL-07" });
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("warns that a short line stays in transit", async () => {
    mockFetch((url, method, body) => {
      if (url === "/v1/tasks/1" && method === "GET") return { body: task([LINE_1], 0) };
      if (url === "/v1/scans/parse" && body.raw === "BK-04-01-C") return { body: SHELF_SCAN };
      return undefined;
    });
    const user = userEvent.setup();
    renderTransfer();

    await screen.findByText("Line 1 of 1");
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(200));
    expect(screen.queryByText(/stays in transit/)).not.toBeInTheDocument();

    const qty = screen.getByRole("spinbutton");
    await user.clear(qty);
    await user.type(qty, "198");

    expect(await screen.findByText("Short by 2 EA · the difference stays in transit until someone closes it on the desktop.")).toBeInTheDocument();
  });

  it("lists the transfers waiting to be received", async () => {
    mockFetch((url, method) => {
      if (url.startsWith("/v1/tasks?") && method === "GET") return { body: { items: [task([LINE_1, LINE_2], 0)], total: 1 } };
      return undefined;
    });
    renderTransfer("/transfer-in");
    expect(await screen.findByText("STO-4500010 · from MEL-WH01")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 lines")).toBeInTheDocument();
  });
});
