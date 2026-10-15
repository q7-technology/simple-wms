import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Settings } from "../pages/Settings";
import { SETTINGS, json } from "./harness";

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat", settings: SETTINGS, active: true };

const SYSTEM = {
  values: {
    message_ttl_hours: 24, worker_poll_seconds: 5.0, worker_http_timeout_seconds: 10.0,
    oidc_issuer: "https://login.example.com", oidc_client_id: "wms", oidc_redirect_uri: "", oidc_scopes: "",
    oidc_name: "", oidc_create_users: false, oidc_default_role: "picker",
  },
  secrets: { platen_key: true, oidc_client_secret: false },
  source: {
    message_ttl_hours: "settings", worker_poll_seconds: "env", worker_http_timeout_seconds: "default",
    oidc_issuer: "settings", oidc_client_id: "env", oidc_redirect_uri: "default", oidc_scopes: "default",
    oidc_name: "default", oidc_create_users: "default", oidc_default_role: "default",
    platen_key: "settings", oidc_client_secret: "default",
  },
};

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/settings" element={<Settings />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

function stub(scopes: string[] = ["*"]) {
  api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0];
    if (path === "/v1/auth/refresh") return json(200, { token: "t", refresh_token: "r2", expires_in: 900 });
    if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes, kind: "user" });
    if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
    if (path === "/v1/warehouses/BAL-WH01") return json(200, WAREHOUSE);
    if (path === "/v1/system/settings" && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      const values = { ...SYSTEM.values } as Record<string, unknown>;
      const source = { ...SYSTEM.source } as Record<string, string>;
      for (const [k, v] of Object.entries(body)) {
        if (k in values) values[k] = v ?? values[k];
        source[k] = v === null ? "env" : "settings";
      }
      return json(200, { ...SYSTEM, values, source });
    }
    if (path === "/v1/system/settings") return json(200, SYSTEM);
    return json(404, { detail: "nope" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function patchBody(fetchMock: ReturnType<typeof stub>) {
  const call = fetchMock.mock.calls.find((c) => c[0] === "/v1/system/settings" && (c[1] as RequestInit | undefined)?.method === "PATCH");
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

async function section() {
  return screen.findByRole("region", { name: "Across all warehouses" });
}

describe("Settings across all warehouses", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is hidden without the system read scope", async () => {
    const fetchMock = stub(["master:read", "master:write", "stock:read"]);
    renderSettings();
    expect(await screen.findByText("ERP already counts production stock")).toBeInTheDocument();
    expect(screen.queryByText("Across all warehouses")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/system/settings")).toBe(false);
  });

  it("shows the values and where each comes from", async () => {
    stub();
    renderSettings();
    const s = within(await section());
    expect(await s.findByLabelText("Duplicate window (h)")).toHaveValue(24);
    expect(s.getByLabelText("Worker poll (s)")).toHaveValue(5);
    expect(s.getByLabelText("HTTP timeout (s)")).toHaveValue(10);
    expect(s.getByLabelText("Issuer")).toHaveValue("https://login.example.com");
    expect(s.getByLabelText("Client ID")).toHaveValue("wms");
    expect(s.getByLabelText("Role for new accounts")).toHaveValue("picker");
    expect(s.getAllByText("From .env").length).toBeGreaterThan(0);
    expect(s.getAllByText("Built-in default").length).toBeGreaterThan(0);
    expect(s.getAllByText("Saved here").length).toBe(3);
    expect(s.getByRole("button", { name: "Use .env for Duplicate window (h)" })).toBeInTheDocument();
    expect(s.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // the warehouse group no longer carries its own duplicate window
    expect(screen.getAllByLabelText("Duplicate window (h)")).toHaveLength(1);
  });

  it("never prefills a secret", async () => {
    stub();
    renderSettings();
    const s = within(await section());
    const key = await s.findByLabelText("Platen key");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("placeholder", "Saved · type to replace");
    expect(s.getByLabelText("Client secret")).toHaveAttribute("placeholder", "Not set");
  });

  it("patches only the keys that changed", async () => {
    const fetchMock = stub();
    renderSettings();
    const user = userEvent.setup();
    const s = within(await section());
    const ttl = await s.findByLabelText("Duplicate window (h)");
    await user.clear(ttl);
    await user.type(ttl, "48");
    await user.click(s.getByRole("switch", { name: /Make accounts for new people/ }));
    await user.click(s.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ message_ttl_hours: 48, oidc_create_users: true }));
    expect(await s.findByText("Saved")).toBeInTheDocument();
    expect(s.getByLabelText("Duplicate window (h)")).toHaveValue(48);
    expect(s.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // the warehouse settings were not touched
    expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/warehouses/BAL-WH01/settings")).toBe(false);
  });

  it("Use .env sends null for that key", async () => {
    const fetchMock = stub();
    renderSettings();
    const user = userEvent.setup();
    const s = within(await section());
    await user.click(await s.findByRole("button", { name: "Use .env for Duplicate window (h)" }));
    expect(s.getByText("Uses .env after Save")).toBeInTheDocument();
    await user.click(s.getByRole("button", { name: "Use .env for Platen key" }));
    await user.click(s.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ message_ttl_hours: null, platen_key: null }));
  });

  it("sends a secret only when typed into", async () => {
    const fetchMock = stub();
    renderSettings();
    const user = userEvent.setup();
    const s = within(await section());
    await user.type(await s.findByLabelText("Client secret"), "s3cret");
    await user.click(s.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ oidc_client_secret: "s3cret" }));
    await waitFor(() => expect(s.getByLabelText("Client secret")).toHaveValue(""));
  });

  it("is read only without the system write scope", async () => {
    stub(["system:read", "master:read"]);
    renderSettings();
    const s = within(await section());
    expect(await s.findByLabelText("Duplicate window (h)")).toBeDisabled();
    expect(s.getByText(/Read only\. Changing these needs the system write scope/)).toBeInTheDocument();
    expect(s.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(s.queryByRole("button", { name: /Use \.env/ })).not.toBeInTheDocument();
  });
});
