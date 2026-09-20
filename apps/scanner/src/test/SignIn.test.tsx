import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/Session";
import { SignIn } from "../pages/SignIn";

const SESSION = {
  token: "tok", expires_in: 43200,
  operator: { code: "op-017", name: "Sam Lee", roles: ["operator"], supervisor: false },
  warehouses: ["BAL-WH01"], device: "SCN-BAL-07", idle_logout_minutes: 15,
};

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

const fetchMock = vi.fn();

function renderSignIn() {
  return render(
    <MemoryRouter initialEntries={["/sign-in"]}>
      <SessionProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/" element={<div>Menu</div>} />
          <Route path="/locked" element={<div>Locked</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("SignIn", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("wms.scanner.device", "SCN-BAL-07");
    window.localStorage.setItem("wms.scanner.warehouse", "BAL-WH01");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the known device and posts operator ID and PIN, then opens the menu", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, SESSION));
    const user = userEvent.setup();
    renderSignIn();
    expect(screen.getByText("SCN-BAL-07 · BAL-WH01 · known device")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Operator ID"), "op-017");
    for (const d of ["1", "2", "3", "4"]) await user.click(screen.getByRole("button", { name: d }));
    expect(screen.getByRole("img", { name: "4 digits entered" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Menu")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/auth/scanner-login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ device_id: "SCN-BAL-07", warehouse: "BAL-WH01", operator_id: "op-017", pin: "1234" });
    expect(JSON.parse(window.localStorage.getItem("wms.scanner.session") ?? "null")).toMatchObject({ token: "tok" });
  });

  it("shows a wrong PIN in a notice and clears the PIN", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { detail: "wrong PIN", code: "wrong_pin", tries_left: 4 }));
    const user = userEvent.setup();
    renderSignIn();
    await user.type(screen.getByLabelText("Operator ID"), "op-017");
    await user.click(screen.getByRole("button", { name: "9" }));
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/wrong PIN/i)).toBeInTheDocument();
    expect(screen.queryByText("Menu")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "0 digits entered" })).toBeInTheDocument();
  });

  it("sends a locked account to the locked screen", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { detail: "op-022 is locked after too many wrong PINs; a supervisor can unlock it", code: "locked" }));
    const user = userEvent.setup();
    renderSignIn();
    await user.type(screen.getByLabelText("Operator ID"), "op-022");
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Locked")).toBeInTheDocument();
  });

  it("asks for the device and warehouse when none is saved", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    renderSignIn();
    expect(screen.getByText("set up this scanner")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Device ID"), "SCN-BAL-09");
    await user.type(screen.getByLabelText("Warehouse code"), "BAL-WH01");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("SCN-BAL-09 · BAL-WH01 · known device")).toBeInTheDocument();
    expect(window.localStorage.getItem("wms.scanner.device")).toBe("SCN-BAL-09");
  });
});
