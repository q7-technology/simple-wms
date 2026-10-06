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

describe("SignIn with a second factor", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession(null);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function meAndWarehouses(url: string) {
    if (url === "/v1/auth/me") {
      return jsonResponse(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.",
        role: "admin", warehouses: ["*"], owner: "*", scopes: ["*"], kind: "user", two_factor: true });
    }
    if (url === "/v1/warehouses") return jsonResponse(200, { items: [], total: 0 });
    return null;
  }

  it("asks for the code, then signs in", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/login") {
        return jsonResponse(200, { status: "totp_required", challenge: "ch-1", expires_in: 180 });
      }
      if (url === "/v1/auth/login/totp") {
        expect(JSON.parse(init.body as string)).toEqual({ challenge: "ch-1", code: "123456" });
        return jsonResponse(200, { status: "signed_in", token: "t", refresh_token: "r",
                                   expires_in: 900, user: {} });
      }
      return meAndWarehouses(url) ?? jsonResponse(404, {});
    });
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "leighton");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const code = await screen.findByLabelText(/Code from your authenticator/);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Stock page")).toBeInTheDocument();
  });

  it("says plainly when the code is wrong, and keeps the step open", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/v1/auth/login") {
        return jsonResponse(200, { status: "totp_required", challenge: "ch-1", expires_in: 180 });
      }
      if (url === "/v1/auth/login/totp") {
        return jsonResponse(401, { detail: "that code is not right", code: "wrong_code" });
      }
      return meAndWarehouses(url) ?? jsonResponse(404, {});
    });
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "leighton");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText(/Code from your authenticator/), "000000");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("That code is not right. Try the next one.")).toBeInTheDocument();
  });

  it("counts down the tries left on a wrong password", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/v1/auth/login") {
        return jsonResponse(401, { detail: "wrong username or password",
                                   code: "wrong_password", tries_left: 3 });
      }
      return meAndWarehouses(url) ?? jsonResponse(404, {});
    });
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "leighton");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong username or password · 3 tries left")).toBeInTheDocument();
  });
});


describe("SignIn with single sign-on", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession(null);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("says nothing about it when the install has no provider", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/v1/auth/sso" ? jsonResponse(200, { enabled: false, name: null })
                             : jsonResponse(404, {}));
    renderSignIn();
    expect(await screen.findByText("Single sign-on is not set up on this install."))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).not.toBeInTheDocument();
  });

  it("offers the provider by name and sends the browser to it", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/v1/auth/sso") return jsonResponse(200, { enabled: true, name: "Entra ID" });
      if (url === "/v1/auth/sso/start") {
        return jsonResponse(200, { authorize_url: "https://login.example/authorize?x=1",
                                   state: "st-1", expires_in: 600 });
      }
      return jsonResponse(404, {});
    });
    renderSignIn();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign in with Entra ID" }));
    expect(assign).toHaveBeenCalledWith("https://login.example/authorize?x=1");
  });
});
