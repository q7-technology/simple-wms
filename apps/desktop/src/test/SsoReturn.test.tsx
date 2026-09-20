import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { SsoReturn } from "../pages/SsoReturn";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderReturn(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/sso${search}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/sso" element={<SsoReturn />} />
          <Route path="/stock" element={<div>Stock page</div>} />
          <Route path="/sign-in" element={<div>Sign in page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("SsoReturn", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession(null);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("swaps the code for a session and lands on stock", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/v1/auth/sso/callback") {
        expect(JSON.parse(init.body as string)).toEqual({ code: "c-1", state: "st-1" });
        return jsonResponse(200, { status: "signed_in", token: "t", refresh_token: "r",
                                   expires_in: 900, user: {} });
      }
      if (url === "/v1/auth/me") {
        return jsonResponse(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.",
          role: "admin", warehouses: ["*"], owner: "*", scopes: ["*"], kind: "user" });
      }
      if (url === "/v1/warehouses") return jsonResponse(200, { items: [], total: 0 });
      return jsonResponse(404, {});
    });
    renderReturn("?code=c-1&state=st-1");
    expect(await screen.findByText("Stock page")).toBeInTheDocument();
  });

  it("says plainly when the WMS has no account for them", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/v1/auth/sso/callback"
        ? jsonResponse(403, { code: "no_account",
            detail: "stranger@example.com signed in with the provider, but has no active account here. A supervisor can make one." })
        : jsonResponse(404, {}));
    renderReturn("?code=c-1&state=st-1");
    expect(await screen.findByText(/no active account here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
  });

  it("says so when the provider itself refused", async () => {
    renderReturn("?error=access_denied&error_description=You%20said%20no");
    expect(await screen.findByText("You said no")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/auth/sso/callback", expect.anything());
  });
});
