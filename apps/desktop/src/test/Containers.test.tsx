import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Containers } from "../pages/Containers";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ME = {
  wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin",
  warehouses: ["*"], scopes: ["*"], kind: "user",
};
const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: {}, active: true };

const CHILDREN = [
  { container_id: "CTN-000401", type: "carton", sscc: null, status: "open" },
  { container_id: "CTN-000402", type: "carton", sscc: null, status: "closed" },
];

const PALLET = {
  wms_id: "c1", container_id: "PAL-000123", sscc: "393944660100000012", owner: "DEFAULT", type: "pallet",
  warehouse: "BAL-WH01", location: "BK-04-01-C", parent: null, status: "open", weight_kg: "210.5",
  note: null, created_at: "2026-09-19T08:45:00Z", closed_at: null,
  children: CHILDREN,
  contents: [
    { sku: "FG-900", name: "Finished goods 900", batch: "B2609A", qty: "120", uom: "EA", container_id: "PAL-000123", received_at: "2026-09-19" },
    { sku: "ABC123", name: "Brake pad set", batch: null, qty: "12.5", uom: "KG", container_id: "PAL-000123", received_at: "2026-09-19" },
  ],
  total_qty: "132.5",
};

const CARTON = {
  wms_id: "c2", container_id: "CTN-000418", sscc: null, owner: "DEFAULT", type: "carton",
  warehouse: "BAL-WH01", location: "PACK-02", parent: "PAL-000123", status: "closed", weight_kg: null,
  note: null, created_at: "2026-09-18T09:00:00Z", closed_at: "2026-09-18T10:00:00Z",
  children: [], contents: [], total_qty: "0",
};

const TOTE = {
  wms_id: "c3", container_id: "TOTE-07", sscc: null, owner: "DEFAULT", type: "tote",
  warehouse: "BAL-WH01", location: "PF-01", parent: null, status: "shipped", weight_kg: null,
  note: null, created_at: "2026-09-17T09:00:00Z", closed_at: null,
  children: [], contents: [], total_qty: "0",
};

const LIST = [PALLET, CARTON, TOTE];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/containers"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/containers" element={<Containers />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function panel() {
  return screen.getByRole("complementary", { name: "Detail" });
}

/** The container's own cell. The code turns up again in another row's "Inside". */
async function openRow(user: ReturnType<typeof userEvent.setup>, code: string) {
  await screen.findAllByText(code);
  await user.click(screen.getAllByText(code)[0]);
}

describe("Containers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (path === "/v1/auth/me") return json(200, ME);
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/containers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "c9", status: "created", container_id: body.container_id ?? "PAL-000999" });
      }
      if (path === "/v1/containers") return json(200, { items: LIST, total: LIST.length });
      if (path === "/v1/containers/PAL-000123/move") {
        const body = JSON.parse(String(init!.body));
        return json(202, { message_id: body.message_id, wms_id: "c1", status: "accepted", moved: "132.5", uom: "EA" });
      }
      if (path === "/v1/containers/PAL-000123") return json(200, PALLET);
      if (path === "/v1/containers/CTN-000418") return json(200, CARTON);
      if (path === "/v1/containers/TOTE-07") return json(200, TOTE);
      if (path === "/v1/print-jobs") {
        const body = JSON.parse(String(init!.body));
        return json(202, { message_id: body.message_id, wms_id: "p1", job_id: "j1", status: "pending" });
      }
      return json(404, { detail: `no route ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); api.setSession(null); });

  it("lists containers with their type, SSCC and status", async () => {
    renderPage();
    expect((await screen.findAllByText("PAL-000123"))[0]).toBeInTheDocument();
    expect(screen.getByText("CTN-000418")).toBeInTheDocument();
    expect(screen.getByText("TOTE-07")).toBeInTheDocument();
    expect(screen.getByText("Ballarat · pallets, cartons and totes")).toBeInTheDocument();
    expect(screen.getByText("393944660100000012")).toBeInTheDocument();
    expect(screen.getAllByText("none")).toHaveLength(2);
    expect(screen.getByText("2 cartons")).toBeInTheDocument();
    // one pill per status
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getAllByText("Closed")).toHaveLength(2); // the tile label and the carton's pill
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    // tiles count by type
    const tile = screen.getAllByText("Pallets")[1].parentElement!; // the tile, not the chip
    expect(within(tile).getByText("1")).toBeInTheDocument();
    expect(within(tile).getByText("in this warehouse")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/v1/containers?warehouse=BAL-WH01&limit=500"))).toBe(true);
  });

  it("filters the table with the type chips", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findAllByText("PAL-000123");
    await user.click(screen.getByRole("button", { name: "Cartons" }));
    // only the carton is left, and its "Inside" still names the pallet
    await waitFor(() => expect(screen.queryByText("393944660100000012")).not.toBeInTheDocument());
    expect(screen.getAllByText("PAL-000123")).toHaveLength(1);
    expect(screen.getByText("CTN-000418")).toBeInTheDocument();
    expect(screen.queryByText("TOTE-07")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByText("393944660100000012")).toBeInTheDocument();
  });

  it("asks for only the top level containers when the toggle is on", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findAllByText("PAL-000123");
    await user.click(screen.getByRole("switch", { name: /Top level only/ }));
    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("nested=false")),
    ).toBe(true));
  });

  it("opens a pallet and shows what is on it and what it holds", async () => {
    renderPage();
    const user = userEvent.setup();
    await openRow(user, "PAL-000123");
    const side = panel();
    expect(await within(side).findByText("393944660100000012")).toBeInTheDocument();
    expect(within(side).getByText("Pallet")).toBeInTheDocument();
    // contents, decimals untouched
    expect(within(side).getByText("FG-900")).toBeInTheDocument();
    expect(within(side).getByText("120 EA")).toBeInTheDocument();
    expect(within(side).getByText("12.5 KG")).toBeInTheDocument();
    expect(within(side).getByText("· B2609A")).toBeInTheDocument();
    expect(within(side).getByText("132.5 in all")).toBeInTheDocument();
    // children, each with its own status and a way off
    expect(within(side).getByText("CTN-000401")).toBeInTheDocument();
    expect(within(side).getByText("CTN-000402")).toBeInTheDocument();
    expect(within(side).getAllByRole("button", { name: "Take off" })).toHaveLength(2);
    expect(within(side).getByText("BK-04-01-C")).toBeInTheDocument();
    expect(within(side).getByText("210.5 kg")).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("says nothing is on an empty carton and offers it an SSCC", async () => {
    renderPage();
    const user = userEvent.setup();
    await openRow(user, "CTN-000418");
    const side = panel();
    expect(await within(side).findByText("no SSCC yet")).toBeInTheDocument();
    expect(within(side).getByText("Nothing has been put on it yet.")).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Give it an SSCC" })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("moves a pallet and says how much went with it", async () => {
    renderPage();
    const user = userEvent.setup();
    await openRow(user, "PAL-000123");
    const side = panel();
    await within(side).findByText("FG-900");
    await user.click(within(side).getByRole("button", { name: "Move it" }));
    await user.type(within(side).getByLabelText("To location"), "stage-01");
    await user.click(within(side).getByRole("button", { name: "Consolidate" }));
    await user.click(within(side).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === "/v1/containers/PAL-000123/move"),
    ).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/containers/PAL-000123/move")!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.message_id).toEqual(expect.any(String));
    expect(body.message_id.length).toBeGreaterThan(10);
    expect(body).toMatchObject({ to_location: "STAGE-01", reason: "consolidate" });
    expect(await screen.findByText("Moved 132.5 EA to STAGE-01.")).toBeInTheDocument();
  });

  it("takes a carton off the pallet", async () => {
    renderPage();
    const user = userEvent.setup();
    await openRow(user, "PAL-000123");
    const side = panel();
    await within(side).findByText("CTN-000401");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/containers/CTN-000401/unnest") {
        const body = JSON.parse(String(init!.body));
        return json(202, { message_id: body.message_id, wms_id: "c4", status: "accepted" });
      }
      if (path === "/v1/containers") return json(200, { items: LIST, total: LIST.length });
      if (path === "/v1/containers/PAL-000123") return json(200, PALLET);
      return json(404, { detail: `no route ${url}` });
    });
    await user.click(within(side).getAllByRole("button", { name: "Take off" })[0]);
    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === "/v1/containers/CTN-000401/unnest"),
    ).toBe(true));
  });

  it("creates a container with the message envelope", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findAllByText("PAL-000123");
    await user.click(screen.getByRole("button", { name: "New container" }));
    const side = panel();
    await user.click(within(side).getByRole("button", { name: "Tote" }));
    await user.type(within(side).getByLabelText("Code"), "tote-08");
    await user.type(within(side).getByLabelText("Location"), "pf-01");
    await user.type(within(side).getByLabelText("Weight (kg)"), "3.5");
    await user.click(within(side).getByRole("switch", { name: /Give it an SSCC/ }));
    await user.click(within(side).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === "/v1/containers" && (c[1] as RequestInit)?.method === "POST"),
    ).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/containers" && (c[1] as RequestInit)?.method === "POST")!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.message_id).toEqual(expect.any(String));
    expect(body).toMatchObject({
      warehouse: "BAL-WH01", type: "tote", container_id: "TOTE-08", location: "PF-01",
      parent: null, assign_sscc: true, weight_kg: "3.5",
    });
  });

  it("prints a pallet label for the container that is open", async () => {
    window.localStorage.setItem("wms.printer", "Office");
    renderPage();
    const user = userEvent.setup();
    await openRow(user, "PAL-000123");
    const side = panel();
    await within(side).findByText("FG-900");
    await user.click(within(side).getByRole("button", { name: "Print pallet label" }));
    expect(within(side).getByLabelText("Printer")).toHaveValue("Office");
    await user.click(within(side).getByRole("button", { name: "Print" }));

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/print-jobs")).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/print-jobs")!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toMatchObject({
      warehouse: "BAL-WH01", template: "pallet-label", printer: "Office", copies: 1,
      reference: { type: "container", ref: "PAL-000123" },
    });
    expect(await screen.findByText("Sent 1 pallet label to Office.")).toBeInTheDocument();
  });

  it("points at Settings in gold when there is no GS1 prefix", async () => {
    const ok = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/v1/containers" && init?.method === "POST") {
        return json(422, { errors: [{ field: "assign_sscc", message: "set gs1_company_prefix for BAL-WH01 first" }] });
      }
      return ok(url, init);
    });
    renderPage();
    const user = userEvent.setup();
    await openRow(user, "CTN-000418");
    const side = panel();
    await within(side).findByText("no SSCC yet");
    await user.click(within(side).getByRole("button", { name: "Give it an SSCC" }));
    expect(await within(side).findByText(/set gs1_company_prefix/)).toBeInTheDocument();
    expect(within(side).getByRole("link", { name: "Set the GS1 company prefix in Settings." })).toHaveAttribute("href", "/settings");
  });
});
