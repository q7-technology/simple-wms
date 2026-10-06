import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Owners } from "../pages/Owners";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ME = {
  wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin",
  warehouses: ["*"], scopes: ["*"], kind: "user",
};
const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: {}, active: true };

const OWNERS = [
  {
    wms_id: "o1", code: "DEFAULT", name: "Q7 house stock", contact: null, email: null, phone: null,
    settings: {}, note: null, active: true, created_at: "2026-01-04T00:00:00Z",
  },
  {
    wms_id: "o2", code: "NORTHCO", name: "Northco Distribution", contact: "Ava Chen",
    email: "ava@northco.example", phone: "03 5555 1000", settings: {}, note: "3PL client since Aug",
    active: true, created_at: "2026-08-02T00:00:00Z",
  },
  {
    wms_id: "o3", code: "RIVA", name: "Riva Parts", contact: null, email: null, phone: null,
    settings: {}, note: null, active: false, created_at: "2026-08-20T00:00:00Z",
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/owners"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/owners" element={<Owners />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function panel() {
  return screen.getByRole("complementary", { name: "Detail" });
}

describe("Owners", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (path === "/v1/auth/me") return json(200, ME);
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/owners" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(201, { ...OWNERS[1], wms_id: "o9", code: body.code, name: body.name });
      }
      if (path === "/v1/owners") return json(200, { items: OWNERS, total: OWNERS.length });
      if (path === "/v1/owners/NORTHCO/deactivate") return json(200, { ...OWNERS[1], active: false });
      return json(404, { detail: `no route ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); api.setSession(null); });

  it("lists the owners with their status", async () => {
    renderPage();
    expect(await screen.findByText("DEFAULT")).toBeInTheDocument();
    expect(screen.getByText("NORTHCO")).toBeInTheDocument();
    expect(screen.getByText("Northco Distribution")).toBeInTheDocument();
    expect(screen.getByText("Ava Chen")).toBeInTheDocument();
    expect(screen.getByText("ava@northco.example")).toBeInTheDocument();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("Deactivated")).toBeInTheDocument();
  });

  it("says one owner is on until multiple owners are switched on", async () => {
    renderPage();
    await screen.findByText("DEFAULT");
    expect(screen.getByText(
      "One owner is switched on for BAL-WH01. Turn on multiple owners in Settings to show the owner column across the screens.",
    )).toBeInTheDocument();
    expect(screen.queryByText("Multiple owners are on for BAL-WH01.")).not.toBeInTheDocument();
  });

  it("says multiple owners are on when the warehouse has the switch", async () => {
    const ok = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/v1/warehouses") return json(200, { items: [{ ...WAREHOUSE, settings: { multi_owner: true } }], total: 1 });
      return ok(url, init);
    });
    renderPage();
    expect(await screen.findByText("Multiple owners are on for BAL-WH01.")).toBeInTheDocument();
  });

  it("opens an owner and lets it be edited", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("NORTHCO"));
    const side = panel();
    expect(within(side).getByText("NORTHCO")).toBeInTheDocument();
    expect(within(side).getByLabelText("Name")).toHaveValue("Northco Distribution");
    expect(within(side).getByLabelText("Contact")).toHaveValue("Ava Chen");
    expect(within(side).getByLabelText("Phone")).toHaveValue("03 5555 1000");
    expect(within(side).getByLabelText("Note")).toHaveValue("3PL client since Aug");
    expect(within(side).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(within(side).getByText(/DEFAULT is the one everything falls back to/)).toBeInTheDocument();
  });

  it("does not offer to deactivate DEFAULT", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("DEFAULT"));
    const side = panel();
    expect(within(side).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(within(side).queryByRole("button", { name: "Reactivate" })).not.toBeInTheDocument();
    expect(within(side).getByText("The house account stays on. Add another owner instead.")).toBeInTheDocument();
  });

  it("adds an owner, upper casing the code as it is typed", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("DEFAULT");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    const side = panel();
    await user.type(within(side).getByLabelText("Code"), "riva-2");
    expect(within(side).getByLabelText("Code")).toHaveValue("RIVA-2");
    await user.type(within(side).getByLabelText("Name"), "Riva Parts");
    await user.type(within(side).getByLabelText("Email"), "ops@riva.example");
    await user.click(within(side).getByRole("button", { name: "Add owner" }));

    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === "/v1/owners" && (c[1] as RequestInit)?.method === "POST"),
    ).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/owners" && (c[1] as RequestInit)?.method === "POST")!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toMatchObject({
      code: "RIVA-2", name: "Riva Parts", contact: null, email: "ops@riva.example", phone: null,
      note: null, active: true,
    });
  });

  it("shows a field error from the API under the field", async () => {
    const ok = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/v1/owners" && init?.method === "POST") {
        return json(422, { errors: [{ field: "code", message: "upper case, digits, dash and underscore only" }] });
      }
      return ok(url, init);
    });
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("DEFAULT");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    const side = panel();
    await user.type(within(side).getByLabelText("Code"), "RIVA");
    await user.type(within(side).getByLabelText("Name"), "Riva Parts");
    await user.click(within(side).getByRole("button", { name: "Add owner" }));
    expect(await screen.findByText("upper case, digits, dash and underscore only")).toBeInTheDocument();
  });

  it("deactivates an owner once, after a confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("NORTHCO"));
    const side = panel();
    await user.click(within(side).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === "/v1/owners/NORTHCO/deactivate"),
    ).toBe(true));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
