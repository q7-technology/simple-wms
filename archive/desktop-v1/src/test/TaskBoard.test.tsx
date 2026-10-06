import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { TaskBoard } from "../pages/TaskBoard";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: { receipt_tolerance_pct: 5 }, active: true };

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const base = {
  warehouse: "BAL-WH01", owner: "DEFAULT", priority: "normal", device: null, needs_supervisor: false, note: null,
  created_by: "erp", started_at: null, completed_at: null, cancelled_at: null,
};

const TASKS = [
  {
    ...base, wms_id: "4401", type: "pick", title: "Pick 0080012347", status: "waiting", source_type: "delivery",
    source_ref: "0080012347", assigned_to: null, created_at: iso(10 * MIN), progress: { done: 0, total: 2 },
    lines: [
      { line_no: 1, source_line: 10, sku: "ABC123", name: "Brake pad set", batch: null, expected_qty: "10", actual_qty: null, variance: null, uom: "EA", from_location: "PF-01-02-A", to_location: null, container_id: null, status: "open", reason: null, completed_at: null },
      { line_no: 2, source_line: 20, sku: "DEF456", name: "Rotor 280 mm", batch: null, expected_qty: "4", actual_qty: null, variance: null, uom: "EA", from_location: "PF-01-03-B", to_location: null, container_id: null, status: "open", reason: null, completed_at: null },
    ],
  },
  {
    ...base, wms_id: "4411", type: "receive", title: "Receive PO-88815", status: "in_progress", source_type: "receipt",
    source_ref: "PO-88815", assigned_to: "Jo", device: "SCN-BAL-07", created_at: iso(60 * MIN), started_at: iso(29 * MIN),
    progress: { done: 1, total: 5 },
    lines: [
      { line_no: 1, source_line: 1, sku: "ABC123", name: "Brake pad set", batch: null, expected_qty: "120", actual_qty: "120", variance: null, uom: "EA", from_location: null, to_location: "BK-04-01-C", container_id: null, status: "done", reason: null, completed_at: iso(5 * MIN) },
    ],
  },
  {
    ...base, wms_id: "4412", type: "count", title: "Count CNT-0412", status: "needs_supervisor", source_type: "count",
    source_ref: "CNT-0412", assigned_to: "Sam", needs_supervisor: true, created_at: iso(45 * MIN), started_at: iso(20 * MIN),
    progress: { done: 0, total: 1 },
    lines: [
      { line_no: 1, source_line: null, sku: "ABC123", name: "Brake pad set", batch: null, expected_qty: "48", actual_qty: "46", variance: "-2", uom: "EA", from_location: "PF-01-02-A", to_location: null, container_id: null, status: "variance", reason: null, completed_at: null },
    ],
  },
  {
    ...base, wms_id: "4390", type: "pick", title: "Pick 0080012340", status: "done", source_type: "delivery",
    source_ref: "0080012340", assigned_to: "Sam", created_at: iso(3 * 60 * MIN), started_at: iso(2 * 60 * MIN),
    completed_at: iso(90 * MIN), progress: { done: 1, total: 1 }, lines: [],
  },
  {
    // finished yesterday: not "done today"
    ...base, wms_id: "4300", type: "pick", title: "Pick 0080012300", status: "done", source_type: "delivery",
    source_ref: "0080012300", assigned_to: "Jo", created_at: iso(2 * DAY), started_at: iso(2 * DAY),
    completed_at: iso(2 * DAY), progress: { done: 1, total: 1 }, lines: [],
  },
];

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/tasks" element={<TaskBoard />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

describe("Task board", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/tasks") return json(200, { items: TASKS, total: TASKS.length });
      if (path === "/v1/tasks/4412/lines/1/approve") {
        const body = JSON.parse(String(init?.body));
        const task = { ...TASKS[2], status: "done", lines: [{ ...TASKS[2].lines[0], status: "done", reason: body.reason }] };
        return json(202, { message_id: body.message_id, wms_id: "4412", status: "accepted", task, line: task.lines[0] });
      }
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the four columns with counts and the story under each card", async () => {
    renderBoard();
    expect(await screen.findByText("Waiting · 1")).toBeInTheDocument();
    expect(screen.getByText("In progress · 1")).toBeInTheDocument();
    expect(screen.getByText("Needs a supervisor · 1")).toBeInTheDocument();
    expect(screen.getByText("Done today · 1")).toBeInTheDocument();

    expect(screen.getByText("2 lines · delivery")).toBeInTheDocument();
    expect(screen.getByText("Jo · line 2 of 5 · 29 min")).toBeInTheDocument();
    expect(screen.getByText("−2 EA at PF-01-02-A · approve or recount")).toBeInTheDocument();
    expect(screen.queryByText("Pick 0080012300")).not.toBeInTheDocument();

    const call = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/tasks?"));
    expect(call).toContain("warehouse=BAL-WH01");
    expect(call).toContain("status=waiting%2Cin_progress%2Cneeds_supervisor%2Cdone");
  });

  it("opens a variance and approves it with a reason", async () => {
    renderBoard();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Count CNT-0412"));

    expect(await screen.findByText("Needs a supervisor · Sam · —")).toBeInTheDocument();
    expect(screen.getByText("Variance −2")).toBeInTheDocument();
    expect(screen.getByText("46 / 48 EA")).toBeInTheDocument();
    expect(screen.getByText("Approve with a reason")).toBeInTheDocument();

    await user.click(screen.getByText("Damaged"));
    await user.type(screen.getByLabelText("Note"), "box crushed");
    await user.click(screen.getByText("Approve adjustment"));

    const approve = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/tasks/4412/lines/1/approve");
    expect(approve).toBeDefined();
    const init = approve![1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.reason).toBe("damaged");
    expect(body.note).toBe("box crushed");
    expect(typeof body.message_id).toBe("string");
    expect(body.message_id.length).toBeGreaterThan(10);

    // the board reloads after the approval
    const listCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith("/v1/tasks?"));
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });
});
