import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { api } from "../api/client";
import type { ApiClientRow, OutboundEvent, Subscriber } from "../api/types";
import { AuthProvider } from "../auth/AuthContext";
import { Integrations } from "../pages/Integrations";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const now = new Date().toISOString();

const CLIENTS: ApiClientRow[] = [
  {
    wms_id: "c1", name: "ERP bridge", key_prefix: "wms_k_erp1", scopes: ["stock:read", "tasks:write"],
    warehouses: ["BAL-WH01", "MEL-WH01"], owner: "DEFAULT", ip_allowlist: ["10.0.5.20"], active: true,
    created_at: "2026-09-04T01:00:00Z", rotated_at: null, last_used_at: now, duplicates_24h: 17, last_duplicate_at: now,
  },
];

const SUBSCRIBERS: Subscriber[] = [
  { wms_id: "s1", name: "ERP bridge", url: "https://erp/hook", event_types: ["delivery.shipped", "transfer.*"], warehouses: ["*"], owner: "*", active: true, created_at: now, status: "retrying", last_delivery_at: now, pending: 3, failed: 0 },
  { wms_id: "s2", name: "Carrier A", url: "https://carrier/hook", event_types: ["delivery.packed"], warehouses: ["*"], owner: "*", active: true, created_at: now, status: "ok", last_delivery_at: now, pending: 0, failed: 0 },
  { wms_id: "s3", name: "EDI broker", url: "https://edi/hook", event_types: ["delivery.shipped"], warehouses: ["*"], owner: "*", active: true, created_at: now, status: "failed", last_delivery_at: null, pending: 0, failed: 2 },
  { wms_id: "s4", name: "Platen", url: "https://platen/hook", event_types: ["print.*"], warehouses: ["*"], owner: "*", active: true, created_at: now, status: "idle", last_delivery_at: null, pending: 0, failed: 0 },
];

const EVENTS: OutboundEvent[] = [
  { wms_id: "e1", event_id: "0192-aaaa-8a21", event_type: "delivery.shipped", subscriber: "ERP bridge", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "0080012340", occurred_at: now, status: "pending", attempts: 4, next_attempt_at: now, last_error: "503 from listener", delivered_at: null },
  { wms_id: "e2", event_id: "0192-aaaa-8a19", event_type: "delivery.packed", subscriber: "Carrier A", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "0080012338", occurred_at: now, status: "delivered", attempts: 1, next_attempt_at: null, last_error: null, delivered_at: now },
  { wms_id: "e3", event_id: "0192-aaaa-8a30", event_type: "delivery.shipped", subscriber: "EDI broker", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "0080012341", occurred_at: now, status: "failed", attempts: 5, next_attempt_at: null, last_error: "connection refused", delivered_at: null },
  { wms_id: "e4", event_id: "0192-aaaa-8a31", event_type: "stock.adjusted", subscriber: "ERP bridge", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "L-889201", occurred_at: now, status: "pending", attempts: 0, next_attempt_at: now, last_error: null, delivered_at: null },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/integrations"]}>
      <AuthProvider>
        <Integrations />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Integrations", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: { url: string; body: unknown }[];

  beforeEach(() => {
    posted = [];
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/v1/auth/refresh") return jsonResponse(200, { token: "t2", refresh_token: "r2", expires_in: 900 });
      if (url === "/v1/auth/me") return jsonResponse(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (url === "/v1/warehouses") return jsonResponse(200, { items: [], total: 0 });
      if (url === "/v1/api-clients" && method === "GET") return jsonResponse(200, { items: CLIENTS, total: CLIENTS.length });
      if (url === "/v1/api-clients" && method === "POST") {
        return jsonResponse(201, { ...CLIENTS[0], wms_id: "c9", name: "Carrier A", key_prefix: "wms_k_new1", key: "wms_k_new1_SECRETVALUE" });
      }
      if (url === "/v1/subscribers" && method === "GET") return jsonResponse(200, { items: SUBSCRIBERS, total: SUBSCRIBERS.length });
      if (url.startsWith("/v1/events?") && method === "GET") return jsonResponse(200, { items: EVENTS, total: EVENTS.length });
      if (/^\/v1\/events\/[^/]+\/retry$/.test(url) && method === "POST") return jsonResponse(200, { ...EVENTS[0], attempts: 0 });
      return jsonResponse(404, { detail: `no mock for ${method} ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    api.setSession(null);
  });

  it("renders subscribers and events with the right pills", async () => {
    renderPage();
    expect((await screen.findAllByText("Carrier A")).length).toBeGreaterThan(0);
    expect(screen.getByText("delivery.shipped, transfer.*")).toBeInTheDocument();

    // Subscriber pills: OK, Retrying, Failed, Idle.
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();

    // Event rows.
    expect(await screen.findByText("evt-…8a21")).toBeInTheDocument();
    // The filter chip is also called "Delivered"; the pill is the one that is not a button.
    expect(screen.getAllByText("Delivered").filter((el) => el.tagName !== "BUTTON")).toHaveLength(1);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    // One "Retrying" for the ERP bridge subscriber and one for event 8a21.
    expect(screen.getAllByText("Retrying").filter((el) => el.tagName !== "BUTTON")).toHaveLength(2);
    // One "Failed" for the EDI broker subscriber and one for event 8a30.
    expect(screen.getAllByText("Failed").filter((el) => el.tagName !== "BUTTON")).toHaveLength(2);
    expect(screen.getByText("· 503 from listener")).toBeInTheDocument();

    // Events are asked for with the limit.
    expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/events?limit=50")).toBe(true);

    // Print points are summarised here and managed on the Printing screen.
    expect(screen.getByRole("link", { name: "Printing screen" })).toHaveAttribute("href", "/printing");
  });

  it("retries a failed or retrying event", async () => {
    renderPage();
    await screen.findByText("evt-…8a21");
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole("button", { name: "Retry now" });
    // e1 (retrying) and e3 (failed); not e2 (delivered) or e4 (queued).
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    await waitFor(() => expect(posted.some((p) => p.url === "/v1/events/e1/retry")).toBe(true));
    // The queue is reloaded after the retry.
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/v1/events?")).length).toBeGreaterThan(1));
  });

  it("creates an API key and shows it once", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create API key" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));
    await user.type(panel.getByLabelText(/^Name/), "Carrier A");
    await user.click(panel.getByRole("button", { name: "stock:read" }));
    await user.click(panel.getByRole("button", { name: "tasks:write" }));
    await user.clear(panel.getByLabelText(/^IP allowlist/));
    await user.type(panel.getByLabelText(/^IP allowlist/), "10.0.5.20, 10.0.5.21");
    await user.click(panel.getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/api-clients")).toBe(true));
    const call = posted.find((p) => p.url === "/v1/api-clients")!;
    expect(call.body).toEqual({
      name: "Carrier A", scopes: ["stock:read", "tasks:write"], warehouses: ["*"], owner: "DEFAULT",
      ip_allowlist: ["10.0.5.20", "10.0.5.21"],
    });
    expect(await screen.findByText("wms_k_new1_SECRETVALUE")).toBeInTheDocument();
    expect(screen.getByText("Copy this key now. It is shown once and never stored.")).toBeInTheDocument();
  });

  it("shows a key's details and message id counters", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("wms_k_erp1…"));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));
    expect(panel.getByText("API key")).toBeInTheDocument();
    expect(panel.getByText("stock:read, tasks:write")).toBeInTheDocument();
    expect(panel.getByText("Duplicates rejected (24 h)")).toBeInTheDocument();
    expect(panel.getByText("17")).toBeInTheDocument();
    expect(await panel.findByRole("button", { name: "Rotate key" })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });
});
