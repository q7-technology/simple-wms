import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Pick } from "../pages/Pick";
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
    token: "t", expires_in: 43200, operator: { code: "op-017", name: "Sam Lee", roles: ["picker"], supervisor: false },
    warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
  }));
  localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
  localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
}

const line = (n: number, sku: string, name: string, qty: string, from: string, over: Partial<TaskLine> = {}): TaskLine => ({
  line_no: n, source_line: n * 10, sku, name, batch: null, expected_qty: qty, actual_qty: null, variance: null, uom: "EA",
  from_location: from, to_location: "PACK-01", container_id: null, status: "open", reason: null, completed_at: null, ...over,
});

const task = (lines: TaskLine[], done: number): Task => ({
  wms_id: "1", type: "pick", title: "Pick 0080012345", status: "in_progress", warehouse: "BAL-WH01", owner: "DEFAULT",
  priority: "normal", source_type: "delivery", source_ref: "0080012345", assigned_to: "op-017", device: "SCN-BAL-07",
  needs_supervisor: false, note: "Acme Auto Parts", created_by: null, created_at: "2026-09-20T00:00:00Z",
  started_at: "2026-09-20T00:01:00Z", completed_at: null, cancelled_at: null, progress: { done, total: lines.length }, lines,
});

const LINE_1 = line(1, "GHI789", "Wiper blade 22 in", "6", "PF-01-02-A");
const LINE_2 = line(2, "JKL012", "Cabin filter", "4", "PF-01-05-C");

function renderPick(path = "/pick/1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/pick" element={<Pick />} />
          <Route path="/pick/:taskId" element={<Pick />} />
          <Route path="/pack/:ref" element={<p>pack</p>} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Pick", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("scans the shelf then the product, and confirms the line through the queue", async () => {
    const open = task([LINE_1, LINE_2], 0);
    const afterOne = task([{ ...LINE_1, actual_qty: "6", status: "done" }, LINE_2], 1);
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/tasks/1" && method === "GET") return { body: open };
      if (url === "/v1/scans/parse") {
        if (body.raw === "PF-01-02-A") return { body: { raw: body.raw, format: "plain", type: "location", fields: {}, resolved: { location: "PF-01-02-A", zone: "PICKFACE" }, matches_expected: true, message: null } };
        if (body.raw === "09312345000029") return { body: { raw: body.raw, format: "gs1", type: "product", fields: { gtin: "09312345000029" }, resolved: { sku: "GHI789", name: "Wiper blade 22 in", uom: "EA" }, matches_expected: true, message: null } };
      }
      if (url === "/v1/tasks/1/lines/1/confirm") return { status: 202, body: { message_id: body.message_id, wms_id: "1", status: "accepted", task: afterOne, line: afterOne.lines[0] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderPick();

    expect(await screen.findByText("Line 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("0080012345")).toBeInTheDocument();
    expect(screen.getByText("Sam · BAL")).toBeInTheDocument();
    expect(screen.getByText("Go to")).toBeInTheDocument();
    expect(screen.getByText("PF-01-02-A")).toBeInTheDocument();
    expect(screen.getByText("Walk order · line 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("GHI789")).toBeInTheDocument();
    expect(screen.getByText("EA to pick")).toBeInTheDocument();
    // the outstanding quantity fills the stepper once the task is in state
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(6));

    const confirm = screen.getByRole("button", { name: "Confirm pick" });
    expect(confirm).toBeDisabled();

    // the shelf first
    await user.type(screen.getByLabelText("Scan"), "PF-01-02-A{Enter}");
    expect(await screen.findByText("Scanned · take the stock from this shelf")).toBeInTheDocument();
    expect(screen.getByText("Scan the product to confirm")).toBeInTheDocument();
    expect(confirm).toBeDisabled();

    // then the product
    await user.type(screen.getByLabelText("Scan"), "09312345000029{Enter}");
    await waitFor(() => expect(confirm).toBeEnabled());

    await user.click(confirm);
    expect(await screen.findByText("Line 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("JKL012")).toBeInTheDocument();
    expect(screen.getByText("PF-01-05-C")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/tasks/1/lines/1/confirm");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent.qty).toBe("6");
    expect(sent.uom).toBe("EA");
    expect(sent.operator).toBe("op-017");
    expect(sent.device).toBe("SCN-BAL-07");
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shorts a line with a reason and a supervisor badge, and says a count was raised", async () => {
    const open = task([LINE_1, LINE_2], 0);
    const afterShort = task([{ ...LINE_1, actual_qty: "2", status: "short", reason: "not_found" }, LINE_2], 1);
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/tasks/1" && method === "GET") return { body: open };
      if (url === "/v1/tasks/1/lines/1/short") return { status: 202, body: { message_id: body.message_id, wms_id: "1", status: "accepted", task: afterShort, line: afterShort.lines[0] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderPick();

    await screen.findByText("Line 1 of 2");
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(6));
    const qty = screen.getByRole("spinbutton");
    await user.clear(qty);
    await user.type(qty, "2");

    await user.click(screen.getByRole("button", { name: "Short" }));
    expect(await screen.findByText("Picked 2 of 6")).toBeInTheDocument();
    expect(screen.getByText("4 EA missing from PF-01-02-A")).toBeInTheDocument();
    expect(screen.getByText("Short pick · line 1")).toBeInTheDocument();

    const confirmShort = screen.getByRole("button", { name: "Confirm short" });
    expect(confirmShort).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Not found on the shelf" }));
    expect(confirmShort).toBeDisabled();

    await user.type(screen.getByLabelText("Supervisor badge"), "SUP-0042{Enter}");
    await waitFor(() => expect(confirmShort).toBeEnabled());

    await user.click(confirmShort);
    expect(await screen.findByText("A count for PF-01-02-A has been raised")).toBeInTheDocument();
    expect(screen.getByText("Line 2 of 2")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/tasks/1/lines/1/short");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent.qty).toBe("2");
    expect(sent.reason).toBe("not_found");
    expect(sent.supervisor_badge).toBe("SUP-0042");
    expect(sent.operator).toBe("op-017");
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists the open picks when no order is chosen", async () => {
    mockFetch((url, method) => {
      if (url.startsWith("/v1/tasks?") && method === "GET") return { body: { items: [task([LINE_1, LINE_2], 0)], total: 1 } };
      return undefined;
    });
    renderPick("/pick");
    expect(await screen.findByText("Pick 0080012345")).toBeInTheDocument();
    expect(screen.getByText("Acme Auto Parts · 2 lines")).toBeInTheDocument();
  });
});
