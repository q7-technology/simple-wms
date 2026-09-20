import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { Move } from "../pages/Move";

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

const location = (raw: string, code: string) => ({ body: { raw, format: "plain", type: "location", fields: {}, resolved: { location: code, zone: "BULK" }, matches_expected: true, message: null } });

function renderMove(path = "/move") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/move" element={<Move />} />
          <Route path="/" element={<p>menu</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("Move", () => {
  beforeEach(() => { localStorage.clear(); signIn(); });
  afterEach(() => vi.unstubAllGlobals());

  it("moves what is on a shelf to another shelf with a reason", async () => {
    const fetchMock = mockFetch((url, method, body) => {
      if (url === "/v1/locations/BK-04-01-C/stock?warehouse=BAL-WH01" && method === "GET") {
        return { body: { wms_id: "17", warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", stock: [
          { sku: "ABC123", name: "Brake pad set", batch: "B2601", owner: "DEFAULT", on_hand: "72", reserved: "0", available: "72", uom: "EA", received_at: "2026-08-30" },
        ] } };
      }
      if (url === "/v1/scans/parse") {
        if (body.raw === "BK-04-01-C") return location("BK-04-01-C", "BK-04-01-C");
        if (body.raw === "PF-01-02-A") return location("PF-01-02-A", "PF-01-02-A");
      }
      if (url === "/v1/moves") return { status: 202, body: { message_id: body.message_id, wms_id: "9001", status: "created" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderMove();

    expect(screen.getByText("Free move")).toBeInTheDocument();
    expect(screen.getByText("Move · within warehouse")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm move" });
    expect(confirm).toBeDisabled();

    // from shelf: the one product here is preselected
    await user.type(screen.getByLabelText("Scan"), "BK-04-01-C{Enter}");
    expect(await screen.findByText("Scanned · 72 EA ABC123 here · batch B2601")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Brake pad set")).toBeInTheDocument();
    expect(screen.getByText("Batch B2601")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(72);
    expect(screen.getByText("72 EA here")).toBeInTheDocument();

    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "12");

    // to shelf and reason
    await user.type(screen.getByLabelText("Scan"), "PF-01-02-A{Enter}");
    expect(await screen.findByText("PF-01-02-A")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Consolidate" }));
    expect(screen.getByRole("radio", { name: "Consolidate" })).toHaveAttribute("aria-checked", "true");

    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    expect(await screen.findByText("Done · Moved 12 EA to PF-01-02-A")).toBeInTheDocument();

    const call = (fetchMock.mock.calls as unknown as Call[]).find(([url]) => url === "/v1/moves");
    expect(call).toBeDefined();
    expect(call![1].method).toBe("POST");
    const sent = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      warehouse: "BAL-WH01", owner: "DEFAULT", sku: "ABC123", batch: "B2601", qty: "12", uom: "EA",
      from_location: "BK-04-01-C", to_location: "PF-01-02-A", reason: "consolidate", operator: "op-017", device: "SCN-BAL-07",
    });
    expect(sent.message_id).toMatch(/^[0-9a-f-]{36}$/);

    // back at step 1 for the next move
    expect(screen.getByText("Scan the shelf you are moving from")).toBeInTheDocument();
  });

  it("shows a field error from the WMS in a gold notice and keeps the move", async () => {
    mockFetch((url, method, body) => {
      if (url.startsWith("/v1/locations/BK-04-01-C/stock") && method === "GET") {
        return { body: { wms_id: "17", warehouse: "BAL-WH01", location: "BK-04-01-C", zone: "BULK", stock: [
          { sku: "ABC123", name: "Brake pad set", batch: null, owner: "DEFAULT", on_hand: "72", reserved: "12", available: "60", uom: "EA", received_at: null },
        ] } };
      }
      if (url === "/v1/scans/parse") return location(String(body.raw), String(body.raw));
      if (url === "/v1/moves") return { status: 422, body: { errors: [{ field: "qty", message: "only 60 available" }] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderMove();
    await user.type(screen.getByLabelText("Scan"), "BK-04-01-C{Enter}");
    await screen.findByText("Scanned · 72 EA ABC123 here");
    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "70");
    await user.type(screen.getByLabelText("Scan"), "PF-01-02-A{Enter}");
    await screen.findByText("PF-01-02-A");
    await user.click(screen.getByRole("button", { name: "Confirm move" }));
    expect(await screen.findByText("qty: only 60 available")).toBeInTheDocument();
    expect(screen.getByText("BK-04-01-C")).toBeInTheDocument();
  });
});
