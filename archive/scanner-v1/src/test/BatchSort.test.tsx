import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { BatchSort } from "../pages/BatchSort";
import type { PickBatch } from "../api/types";

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

const batch = (stops: PickBatch["stops"], doneStops: number): PickBatch => ({
  wms_id: "b1", external_ref: "BP-0001", owner: "DEFAULT", warehouse: "BAL-WH01", status: "picking",
  assigned_to: "op-017", note: null, created_by: null, created_at: "2026-09-20T00:00:00Z",
  started_at: "2026-09-20T00:01:00Z", completed_at: null, cancelled_at: null, orders: 3, lines: 4,
  done_stops: doneStops, stops,
  totes: [
    { tote: "1", delivery: "0080012347", ship_to: "Repco", status: "picking", lines: 1 },
    { tote: "2", delivery: "0080012349", ship_to: "Autobarn", status: "picking", lines: 1 },
    { tote: "3", delivery: "0080012350", ship_to: "Supercheap", status: "picking", lines: 1 },
  ],
});

const STOP: PickBatch["stops"] = [{
  stop: 1, location: "PF-01-02-A", zone: "PICKFACE", pick_sequence: 120,
  sku: "ABC123", name: "Brake pad set", batch: null, qty: "18", uom: "EA",
  picks: [
    { tote: "1", delivery: "0080012347", qty: "6" },
    { tote: "2", delivery: "0080012349", qty: "8" },
    { tote: "3", delivery: "0080012350", qty: "4" },
  ],
}];

const SHELF_SCAN = { raw: "PF-01-02-A", format: "plain", type: "location", fields: {}, resolved: { location: "PF-01-02-A", zone: "PICKFACE" }, matches_expected: true, message: null };
const PRODUCT_SCAN = { raw: "09312345000029", format: "gs1", type: "product", fields: { gtin: "09312345000029" }, resolved: { sku: "ABC123", name: "Brake pad set", uom: "EA" }, matches_expected: true, message: null };

function renderSort(path = "/sort/BP-0001") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/sort" element={<BatchSort />} />
          <Route path="/sort/:ref" element={<BatchSort />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function walkToTheSort(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByText("Stop 1 of 1")).toBeInTheDocument();
  expect(screen.getByText("BP-0001")).toBeInTheDocument();
  expect(screen.getByText("Batch pick · 3 orders")).toBeInTheDocument();
  expect(screen.getByText("Sam · BAL")).toBeInTheDocument();
  expect(screen.getByText("PF-01-02-A")).toBeInTheDocument();
  expect(screen.getByText("PICKFACE · walk order")).toBeInTheDocument();
  expect(screen.getByText("EA to pick here")).toBeInTheDocument();
  // the sort is hidden until the shelf and the product are scanned
  expect(screen.queryByText("Tote 1")).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("Scan"), "PF-01-02-A{Enter}");
  expect(await screen.findByText("Scan the product to confirm")).toBeInTheDocument();
  expect(screen.queryByText("Tote 1")).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("Scan"), "09312345000029{Enter}");
  expect(await screen.findByText("Tote 1")).toBeInTheDocument();
}

describe("BatchSort", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("scans the shelf then the product, shows the totes, and confirms the stop through the queue", async () => {
    let stopsLeft = STOP;
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/pick-batches/BP-0001" && method === "GET") return { body: batch(stopsLeft, stopsLeft.length ? 0 : 1) };
      if (url === "/v1/scans/parse") {
        if (body.raw === "PF-01-02-A") return { body: SHELF_SCAN };
        if (body.raw === "09312345000029") return { body: PRODUCT_SCAN };
      }
      if (url === "/v1/pick-batches/BP-0001/stops/1/confirm") {
        stopsLeft = [];
        return { status: 202, body: { message_id: body.message_id, wms_id: "b1", status: "accepted", picked: "18", picks: STOP[0].picks, batch_status: "picked", stops_left: 0 } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderSort();

    await walkToTheSort(user);
    expect(screen.getByText("Tote 2")).toBeInTheDocument();
    expect(screen.getByText("0080012349")).toBeInTheDocument();
    expect(screen.getByLabelText("Tote 2 quantity")).toHaveTextContent("8");
    expect(screen.getByText("18 of 18 sorted")).toBeInTheDocument();
    expect(screen.getByText("TOTE 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm stop" }));

    // the batch reloads and the walk is finished
    expect(await screen.findByText("3 orders picked")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/pick-batches/BP-0001/stops/1/confirm");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.operator).toBe("op-017");
    expect(sent.device).toBe("SCN-BAL-07");
    // every tote got what it asked for, so no picks are sent
    expect(sent.picks).toBeUndefined();
  });

  it("shorts one tote with a reason and a supervisor badge", async () => {
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/pick-batches/BP-0001" && method === "GET") return { body: batch(STOP, 0) };
      if (url === "/v1/scans/parse") {
        if (body.raw === "PF-01-02-A") return { body: SHELF_SCAN };
        if (body.raw === "09312345000029") return { body: PRODUCT_SCAN };
      }
      if (url === "/v1/pick-batches/BP-0001/stops/1/confirm") {
        return { status: 202, body: { message_id: body.message_id, wms_id: "b1", status: "accepted", picked: "16", picks: [], batch_status: "picking", stops_left: 1 } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderSort();

    await walkToTheSort(user);

    // two fewer in tote 2 than the batch asked for
    await user.click(screen.getByRole("button", { name: "Less in tote 2" }));
    await user.click(screen.getByRole("button", { name: "Less in tote 2" }));
    expect(screen.getByLabelText("Tote 2 quantity")).toHaveTextContent("6");
    expect(screen.getByText("16 of 18 sorted")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Short" }));
    expect(await screen.findByText("Sorted 16 of 18")).toBeInTheDocument();
    expect(screen.getByText("2 EA missing from PF-01-02-A")).toBeInTheDocument();

    const confirmShort = screen.getByRole("button", { name: "Confirm short" });
    expect(confirmShort).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Fewer here than the system says" }));
    await user.type(screen.getByLabelText("Supervisor badge"), "SUP-0042{Enter}");
    await waitFor(() => expect(confirmShort).toBeEnabled());
    await user.click(confirmShort);

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/pick-batches/BP-0001/stops/1/confirm");
    expect(call).toBeDefined();
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent.picks).toEqual([
      { tote: "1", qty: "6" },
      { tote: "2", qty: "6" },
      { tote: "3", qty: "4" },
    ]);
    expect(sent.reason).toBe("short_on_shelf");
    expect(sent.supervisor_badge).toBe("SUP-0042");
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists the open batches and says so when a scanned reference is not one of them", async () => {
    mockFetch((url, method) => {
      if (url.startsWith("/v1/pick-batches?") && method === "GET") return { body: { items: [batch(STOP, 0)], total: 1 } };
      return undefined;
    });
    const user = userEvent.setup();
    renderSort("/sort");

    expect(await screen.findByText("BP-0001 · 3 orders · 1 stop")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Scan"), "BP-9999{Enter}");
    expect(await screen.findByText("No open batch for BP-9999 · choose one from the list")).toBeInTheDocument();
  });
});
