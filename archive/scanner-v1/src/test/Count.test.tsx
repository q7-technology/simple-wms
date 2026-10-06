import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Count } from "../pages/Count";
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
    token: "t", expires_in: 43200, operator: { code: "op-017", name: "Sam Lee", roles: ["counter"], supervisor: false },
    warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
  }));
  localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
  localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
}

const line = (n: number, shelf: string, sku: string, name: string, over: Partial<TaskLine> = {}): TaskLine => ({
  line_no: n, source_line: null, sku, name, batch: "B2601", expected_qty: null, actual_qty: null, variance: null, uom: "EA",
  from_location: shelf, to_location: null, container_id: null, status: "open", reason: null, completed_at: null, ...over,
});

const task = (lines: TaskLine[], done: number, status: Task["status"] = "in_progress"): Task => ({
  wms_id: "7", type: "count", title: "Count PICKFACE", status, warehouse: "BAL-WH01", owner: "DEFAULT",
  priority: "normal", source_type: "count", source_ref: "CNT-0412", assigned_to: "op-017", device: "SCN-BAL-07",
  needs_supervisor: status === "needs_supervisor", note: null, created_by: null, created_at: "2026-09-20T00:00:00Z", started_at: null,
  completed_at: null, cancelled_at: null, progress: { done, total: lines.length }, lines,
});

const location = (raw: string) => ({ body: { raw, format: "plain", type: "location", fields: {}, resolved: { location: raw.replace(/^LOC-/, ""), zone: "PICKFACE" }, matches_expected: true, message: null } });

function renderCount(path = "/count/7") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/count" element={<Count />} />
          <Route path="/count/:taskId" element={<Count />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Count", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("scans the shelf, counts and moves on when the count matches", async () => {
    const open = task([line(1, "PF-01-02-A", "ABC123", "Brake pad set"), line(2, "PF-01-03-B", "DEF456", "Rotor 280 mm")], 0);
    const afterOne = task([line(1, "PF-01-02-A", "ABC123", "Brake pad set", { actual_qty: "46", status: "done" }), line(2, "PF-01-03-B", "DEF456", "Rotor 280 mm")], 1);
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/tasks/7" && method === "GET") return { body: open };
      if (url === "/v1/scans/parse") return location(String(body.raw));
      if (url === "/v1/tasks/7/lines/1/confirm") return { status: 202, body: { message_id: body.message_id, wms_id: "7", status: "accepted", task: afterOne, line: afterOne.lines[0] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderCount();

    expect(await screen.findByText("Location 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Cycle count · CNT-0412")).toBeInTheDocument();
    expect(screen.getByText("Count PICKFACE · 2 shelves")).toBeInTheDocument();
    expect(screen.getByText("PF-01-02-A")).toBeInTheDocument();
    expect(screen.getByText("Blind count · expected quantity is hidden")).toBeInTheDocument();
    expect(screen.getByText("Scan the shelf to start")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Scan"), "PF-01-02-A{Enter}");
    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Batch B2601")).toBeInTheDocument();
    expect(screen.getByText("EA counted")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Submit count" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("spinbutton"), "46");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("Location 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("PF-01-03-B")).toBeInTheDocument();
    expect(screen.getByText("Scan the shelf to start")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/tasks/7/lines/1/confirm");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ qty: "46", uom: "EA", operator: "op-017", device: "SCN-BAL-07" });
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows the gold variance notice and the supervisor panel when the count differs", async () => {
    const open = task([line(1, "PF-01-02-A", "ABC123", "Brake pad set")], 0);
    const parked = task([line(1, "PF-01-02-A", "ABC123", "Brake pad set", { actual_qty: "46", variance: "-2", status: "variance" })], 0, "needs_supervisor");
    const approved = task([line(1, "PF-01-02-A", "ABC123", "Brake pad set", { actual_qty: "46", variance: "-2", status: "done" })], 1, "done");
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/tasks/7" && method === "GET") return { body: open };
      if (url === "/v1/scans/parse") return location(String(body.raw));
      if (url === "/v1/tasks/7/lines/1/confirm") return { status: 202, body: { message_id: body.message_id, wms_id: "7", status: "accepted", task: parked, line: parked.lines[0] } };
      if (url === "/v1/tasks/7/lines/1/approve") return { status: 202, body: { message_id: body.message_id, wms_id: "7", status: "accepted", task: approved, line: approved.lines[0] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderCount();

    await screen.findByText("Location 1 of 1");
    await user.type(screen.getByLabelText("Scan"), "LOC-PF-01-02-A{Enter}");
    await screen.findByText("ABC123");
    await user.type(screen.getByRole("spinbutton"), "46");
    await user.click(screen.getByRole("button", { name: "Submit count" }));

    expect(await screen.findByText(/Differs from expected · variance/)).toBeInTheDocument();
    expect(screen.getByText("Recount, or submit and a supervisor decides")).toBeInTheDocument();
    expect(screen.getByText("Supervisor: scan your badge to approve")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit count" })).toBeDisabled();

    // a supervisor badge approves the variance and the count is done
    await user.type(screen.getByLabelText("Supervisor badge"), "BADGE-SUP-01{Enter}");
    expect(await screen.findByText("All shelves counted")).toBeInTheDocument();
    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/tasks/7/lines/1/approve");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toMatchObject({ reason: "count_variance", supervisor_badge: "BADGE-SUP-01" });
  });

  it("shows the expected quantity when the site does not count blind", async () => {
    // The API sends the figure only where the warehouse allows it, so the
    // screen shows whatever arrives and says nothing when nothing does.
    const open = task([line(1, "PF-01-02-A", "ABC123", "Brake pad set", { expected_qty: "48" })], 0);
    mockFetch((url, method, body) => {
      if (url === "/v1/tasks/7" && method === "GET") return { body: open };
      if (url === "/v1/scans/parse") return location(String(body.raw));
      return undefined;
    });
    const user = userEvent.setup();
    renderCount();

    expect(await screen.findByText("Location 1 of 1")).toBeInTheDocument();
    expect(screen.queryByText("Blind count · expected quantity is hidden")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Scan"), "PF-01-02-A{Enter}");
    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    // Shown, but never typed in for them: the shelf still has to be counted.
    expect(screen.getByText("System says 48 EA")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
    expect(screen.getByRole("button", { name: "Submit count" })).toBeDisabled();
  });

  it("shows a different shelf as a wrong scan", async () => {
    mockFetch((url, method, body) => {
      if (url === "/v1/tasks/7" && method === "GET") return { body: task([line(1, "PF-01-02-A", "ABC123", "Brake pad set")], 0) };
      if (url === "/v1/scans/parse") return location(String(body.raw));
      return undefined;
    });
    const user = userEvent.setup();
    renderCount();
    await screen.findByText("Location 1 of 1");
    await user.type(screen.getByLabelText("Scan"), "PF-01-03-B{Enter}");
    expect(await screen.findByText("That is a different shelf")).toBeInTheDocument();
    expect(screen.getByText("You scanned PF-01-03-B. This step wants the shelf PF-01-02-A.")).toBeInTheDocument();
  });
});
