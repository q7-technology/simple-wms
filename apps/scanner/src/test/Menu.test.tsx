import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Menu } from "../pages/Menu";

const SESSION = {
  token: "tok", expires_in: 43200,
  operator: { code: "op-017", name: "Sam Lee", roles: ["operator"], supervisor: false },
  warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
};

const MINE = {
  wms_id: "4411", type: "receive", title: "Receive PO-88815", status: "in_progress", warehouse: "BAL-WH01", owner: "DEFAULT",
  priority: "normal", source_type: "receipt", source_ref: "PO-88815", assigned_to: "op-017", device: "SCN-BAL-07",
  needs_supervisor: false, note: null, created_by: null, created_at: "2026-09-20T01:00:00Z", started_at: null,
  completed_at: null, cancelled_at: null, progress: { done: 2, total: 4 }, lines: [],
};
const OPEN_COUNT = { ...MINE, wms_id: "4420", type: "count", title: "Count CC-0042", status: "waiting", assigned_to: null, progress: { done: 0, total: 3 } };
const OPEN_PICK = { ...MINE, wms_id: "4421", type: "pick", title: "Pick 0080012345", status: "waiting", assigned_to: null };

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith("/v1/tasks?") && url.includes("assigned_to=op-017")) return reply(200, { items: [MINE], total: 1 });
  if (url.startsWith("/v1/tasks?")) return reply(200, { items: [OPEN_COUNT, OPEN_PICK, MINE], total: 3 });
  if (url === "/v1/scans/parse") {
    return reply(200, {
      raw: "PF-01-02-A", format: "plain", type: "location", fields: {},
      resolved: { location: "PF-01-02-A", zone: "PICKFACE", warehouse: "BAL-WH01" }, matches_expected: null, message: null,
    });
  }
  return reply(404, { detail: "not found" });
});

function LookupStub() {
  const [params] = useSearchParams();
  return <div>Lookup {params.get("location") ?? params.get("sku")}</div>;
}
function ReceiveStub() {
  const { taskId } = useParams();
  return <div>Receive task {taskId}</div>;
}

function renderMenu() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SessionProvider>
        <Routes>
          <Route path="/" element={<Menu />} />
          <Route path="/lookup" element={<LookupStub />} />
          <Route path="/receive/:taskId" element={<ReceiveStub />} />
          <Route path="/sign-in" element={<div>Sign in page</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Menu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
    window.localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
    window.localStorage.setItem("wms.scanner.session", JSON.stringify(SESSION));
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("greets the operator and lists my tasks plus open receive and count tasks, once each", async () => {
    renderMenu();
    expect(screen.getByText("Hi Sam")).toBeInTheDocument();
    expect(screen.getByText("BAL-WH01 · SCN-BAL-07 · online")).toBeInTheDocument();

    expect(await screen.findByText("Receive PO-88815")).toBeInTheDocument();
    expect(screen.getAllByText("Receive PO-88815")).toHaveLength(1);
    expect(screen.getByText("Line 3 of 4 · in progress")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Count CC-0042")).toBeInTheDocument();
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(screen.queryByText("Pick 0080012345")).not.toBeInTheDocument();

    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls).toContain("/v1/tasks?warehouse=BAL-WH01&status=waiting%2Cin_progress&assigned_to=op-017");
    expect(urls).toContain("/v1/tasks?warehouse=BAL-WH01&status=waiting");

    expect(screen.getByText("0 queued · all synced")).toBeInTheDocument();
    expect(screen.getByText("Idle logout in 15 min")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Look up" })).toHaveAttribute("href", "/lookup");
    expect(screen.getByTitle("Step 3")).toHaveTextContent("Pick");
  });

  it("routes a typed location scan to the lookup screen", async () => {
    const user = userEvent.setup();
    renderMenu();
    await screen.findByText("Receive PO-88815");
    await user.type(screen.getByLabelText("Scan or type a code"), "PF-01-02-A{Enter}");

    expect(await screen.findByText("Lookup PF-01-02-A")).toBeInTheDocument();
    const parse = fetchMock.mock.calls.find(([u]) => u === "/v1/scans/parse") as [string, RequestInit] | undefined;
    expect(parse).toBeDefined();
    expect(JSON.parse(parse![1].body as string)).toEqual({ raw: "PF-01-02-A", warehouse: "BAL-WH01" });
  });

  it("opens a receive task when its row is tapped", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(await screen.findByRole("button", { name: /Receive PO-88815/ }));
    expect(await screen.findByText("Receive task 4411")).toBeInTheDocument();
  });

  it("signs out", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign in page")).toBeInTheDocument();
    expect(window.localStorage.getItem("wms.scanner.session")).toBeNull();
  });
});
