import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { SignIn } from "../pages/SignIn";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderSignIn() {
  return render(
    <MemoryRouter initialEntries={["/sign-in"]}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/stock" element={<div>Stock page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("SignIn", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession(null);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("signs in and lands on stock", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/v1/auth/login") return jsonResponse(200, { token: "t", refresh_token: "r", expires_in: 900, user: {} });
      if (url === "/v1/auth/me") return jsonResponse(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (url === "/v1/warehouses") return jsonResponse(200, { items: [], total: 0 });
      return jsonResponse(404, {});
    });
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "leighton");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Stock page")).toBeInTheDocument();
    const loginCall = fetchMock.mock.calls.find((c) => c[0] === "/v1/auth/login");
    expect(JSON.parse(loginCall![1].body)).toEqual({ username: "leighton", password: "correct horse" });
  });

  it("says so when the password is wrong", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, { detail: "wrong username or password" }));
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "leighton");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("Wrong username or password")).toBeInTheDocument());
  });
});
