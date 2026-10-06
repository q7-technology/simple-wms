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

/** Reached by RFC, not by URL. Not in SUBSCRIBERS: the tests that want it layer it on. */
const SAP_SUBSCRIBER: Subscriber = {
  wms_id: "s5", name: "sap-erp", url: "rfc://PRD", transport: "sap_rfc",
  settings: {
    connection: { ashost: "sap.example", sysnr: "00", client: "100", user: "WMS", passwd_env: "SAP_PASSWORD" },
    plant_by_warehouse: { "BAL-WH01": "1000" },
    storage_location: "0001",
    movement_types: { "delivery.shipped": "601" },
  },
  event_types: ["receipt.confirmed", "delivery.shipped"], warehouses: ["*"], owner: "*", active: true,
  created_at: now, status: "ok", last_delivery_at: now, pending: 0, failed: 0,
};

const PASSWD_REFUSAL =
  "an SAP password does not belong in the database; name an environment variable with "
  + "passwd_env and set it on the host";

const EVENTS: OutboundEvent[] = [
  { wms_id: "e1", event_id: "0192-aaaa-8a21", event_type: "delivery.shipped", subscriber: "ERP bridge", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "0080012340", occurred_at: now, status: "pending", attempts: 4, next_attempt_at: now, last_error: "503 from listener", delivered_at: null },
  { wms_id: "e2", event_id: "0192-aaaa-8a19", event_type: "delivery.packed", subscriber: "Carrier A", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "0080012338", occurred_at: now, status: "delivered", attempts: 1, next_attempt_at: null, last_error: null, delivered_at: now },
  { wms_id: "e3", event_id: "0192-aaaa-8a30", event_type: "delivery.shipped", subscriber: "EDI broker", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "0080012341", occurred_at: now, status: "failed", attempts: 5, next_attempt_at: null, last_error: "connection refused", delivered_at: null },
  { wms_id: "e4", event_id: "0192-aaaa-8a31", event_type: "stock.adjusted", subscriber: "ERP bridge", warehouse: "BAL-WH01", owner: "DEFAULT", external_ref: "L-889201", occurred_at: now, status: "pending", attempts: 0, next_attempt_at: now, last_error: null, delivered_at: null },
];

const WAREHOUSES = [{
  wms_id: "w1", code: "BAL-WH01", site: "BAL", name: "Ballarat", active: true,
  settings: {
    erp_counts_gr: true, batch_from_production_order: true, receipt_tolerance_pct: 2, supplier_tolerance_pct: 5,
    allow_ship_short: false, supervisor_for_short_pick: true, auto_pick_mode: "auto", batch_pick_max_orders: 6,
    idle_logout_minutes: 15, pin_lockout_tries: 5, known_devices_only: true, queue_offline_confirmations: true,
    fifo_by_received_date: true, blind_counts: true, decimals_allowed: true, multi_owner: false,
    gs1_company_prefix: null, sscc_extension_digit: 3, platen_url: null, retry_failed_print_jobs: true,
    default_copies: 1, ledger_retention_years: 7, duplicate_window_hours: 24, allow_hard_deletes: false,
  },
}];

const MELBOURNE = { ...WAREHOUSES[0], wms_id: "w2", code: "MEL-WH01", site: "MEL", name: "Melbourne" };

const PATTERNS = [
  {
    wms_id: "p1", warehouse: "BAL-WH01", name: "Supplier Co carton",
    pattern: "^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>\\d+)$",
    type: "product", order: 100, fields: ["sku", "batch", "qty"], note: null, active: true,
    created_by: "leighton", created_at: now,
  },
  {
    wms_id: "p2", warehouse: null, name: "Old shelf label",
    pattern: "^SHELF-(?P<location>[A-Z0-9-]+)$",
    type: "location", order: 200, fields: ["location"], note: null, active: false,
    created_by: "leighton", created_at: now,
  },
];

const UNKNOWN = [
  { raw: "SUPABC123-B2601-24", seen: 12, last_seen_at: now, expecting: "product" },
  { raw: "??0099887766", seen: 3, last_seen_at: now, expecting: null },
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
      if (url === "/v1/warehouses") return jsonResponse(200, { items: WAREHOUSES, total: 1 });
      if (url.startsWith("/v1/print-points")) return jsonResponse(200, { items: [], total: 0 });
      if (url.startsWith("/v1/scan-patterns/unknown")) return jsonResponse(200, { items: UNKNOWN, total: UNKNOWN.length });
      if (url === "/v1/scan-patterns/try" && method === "POST") {
        const body = JSON.parse(String(init.body)) as { pattern: string; raw: string };
        if (body.pattern.includes("colour")) {
          return jsonResponse(422, { errors: [{ field: "pattern", message: "the WMS has no use for colour" }] });
        }
        if (body.raw === "SUPABC123-B2601-24" && body.pattern.startsWith("^SUP")) {
          return jsonResponse(200, { matches: true, fields: { sku: "ABC123", batch: "B2601", qty: "24" } });
        }
        return jsonResponse(200, { matches: false, fields: {} });
      }
      if (url === "/v1/scan-patterns" && method === "POST") return jsonResponse(201, { ...PATTERNS[0], wms_id: "p9", name: "Supplier Co carton" });
      if (url.startsWith("/v1/scan-patterns") && method === "GET") return jsonResponse(200, { items: PATTERNS, total: PATTERNS.length });
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

  /** Layer a few replies over the base mock; anything it does not answer falls through. */
  function layer(over: (url: string, init: RequestInit) => Response | undefined) {
    const base = fetchMock;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const mine = over(url, init);
      if (mine) {
        if ((init?.method ?? "GET") === "POST") {
          posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        }
        return mine;
      }
      return base(url, init);
    }));
  }

  /** Two warehouses, so a plant left blank can be told from one that is filled in. */
  function twoWarehouses(url: string) {
    return url === "/v1/warehouses"
      ? jsonResponse(200, { items: [WAREHOUSES[0], MELBOURNE], total: 2 })
      : undefined;
  }

  /** Fill in the SAP connection of whichever subscriber form is open. */
  async function fillSapConnection(user: ReturnType<typeof userEvent.setup>, panel: ReturnType<typeof within>) {
    await user.type(panel.getByLabelText(/^Application server host/), "sap.example");
    await user.type(panel.getByLabelText(/^System number/), "00");
    await user.type(panel.getByLabelText(/^Client/), "100");
    await user.type(panel.getByLabelText(/^User/), "WMS");
    await user.type(panel.getByLabelText(/^Password from environment variable/), "SAP_PASSWORD");
    await user.type(panel.getByLabelText(/^Default storage location/), "0001");
  }

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

  it("lists the site's scan patterns and the scans nothing could read", async () => {
    renderPage();
    expect(await screen.findByText("Supplier Co carton")).toBeInTheDocument();
    // Reads, sentence-cased; the fields it finds; the expression itself.
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getByText("sku, batch, qty")).toBeInTheDocument();
    expect(screen.getByText("^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>\\d+)$")).toBeInTheDocument();
    // A null warehouse applies everywhere, and an inactive pattern is Off.
    expect(screen.getByText("Old shelf label")).toBeInTheDocument();
    // The event-queue filter chip is also "All"; the cell is the one that is not a button.
    expect(screen.getAllByText("All").filter((el) => el.tagName !== "BUTTON")).toHaveLength(1);
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("Tried after GS1 and JSON, before the plain lookup.")).toBeInTheDocument();

    // The unread scans, most seen first, with what the step was expecting.
    expect(screen.getByText("SUPABC123-B2601-24")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("??0099887766")).toBeInTheDocument();

    // Both lists are asked for by warehouse.
    expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/scan-patterns?warehouse=BAL-WH01")).toBe(true);
    expect(fetchMock.mock.calls.some((c) => c[0] === "/v1/scan-patterns/unknown?warehouse=BAL-WH01")).toBe(true);
  });

  it("opens a pattern from an unread scan with the raw text already in the try box", async () => {
    renderPage();
    await screen.findByText("SUPABC123-B2601-24");
    const user = userEvent.setup();
    const write = await screen.findAllByRole("button", { name: "Write a pattern" });
    expect(write).toHaveLength(2);
    await user.click(write[0]);

    const panel = within(screen.getByRole("complementary", { name: "Detail" }));
    expect(panel.getByText("Scan pattern")).toBeInTheDocument();
    expect(panel.getByLabelText(/^Try it against/)).toHaveValue("SUPABC123-B2601-24");
  });

  it("tries a pattern before it is saved and says what it found", async () => {
    renderPage();
    await screen.findByText("SUPABC123-B2601-24");
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Write a pattern" }))[0]);
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    expect(panel.getByText("No match yet.")).toBeInTheDocument();
    await user.click(panel.getByLabelText(/^Pattern/));
    await user.paste("^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>[0-9]+)$");
    await user.click(panel.getByRole("button", { name: "Try" }));

    expect(await panel.findByText("Matches · sku ABC123 · batch B2601 · qty 24")).toBeInTheDocument();
    const call = posted.find((p) => p.url === "/v1/scan-patterns/try")!;
    expect(call.body).toEqual({
      pattern: "^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>[0-9]+)$",
      raw: "SUPABC123-B2601-24",
    });
  });

  it("shows the API's complaint under the pattern when it will not do", async () => {
    renderPage();
    await screen.findByText("SUPABC123-B2601-24");
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Write a pattern" }))[0]);
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));
    await user.click(panel.getByLabelText(/^Pattern/));
    await user.paste("^(?P<colour>.+)$");
    await user.click(panel.getByRole("button", { name: "Try" }));
    expect(await panel.findByText("the WMS has no use for colour")).toBeInTheDocument();
  });

  it("saves a new pattern for the current warehouse", async () => {
    renderPage();
    await screen.findByText("SUPABC123-B2601-24");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New pattern" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    await user.type(panel.getByLabelText(/^Name/), "Supplier Co carton");
    await user.click(panel.getByLabelText(/^Pattern/));
    await user.paste("^SUP(?P<sku>[A-Z0-9]+)$");
    await user.selectOptions(panel.getByLabelText(/^Reads/), "product");
    await user.click(panel.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/scan-patterns")).toBe(true));
    const call = posted.find((p) => p.url === "/v1/scan-patterns")!;
    expect(call.body).toEqual({
      warehouse: "BAL-WH01", name: "Supplier Co carton", pattern: "^SUP(?P<sku>[A-Z0-9]+)$",
      type: "product", order: 100, note: null, active: true,
    });
  });

  it("selects a pattern from the table into the form", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Old shelf label"));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));
    expect(panel.getByLabelText(/^Name/)).toHaveValue("Old shelf label");
    expect(panel.getByLabelText(/^Reads/)).toHaveValue("location");
    expect(panel.getByLabelText(/^Warehouse/)).toHaveValue("");
    expect(panel.getByLabelText(/^Order/)).toHaveValue(200);
    // It is off already, so there is nothing to turn off.
    expect(panel.queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
  });

  /* --- SAP ---------------------------------------------------------------- */

  it("marks the SAP subscriber in the list and leaves the HTTP ones quiet", async () => {
    layer((url, init) => (url === "/v1/subscribers" && (init?.method ?? "GET") === "GET"
      ? jsonResponse(200, { items: [...SUBSCRIBERS, SAP_SUBSCRIBER], total: SUBSCRIBERS.length + 1 })
      : undefined));
    renderPage();

    expect(await screen.findByText("sap-erp")).toBeInTheDocument();
    expect(screen.getAllByText("SAP")).toHaveLength(1);
    // The other four say so quietly.
    expect(screen.getAllByText("HTTP")).toHaveLength(SUBSCRIBERS.length);
  });

  it("reveals the SAP connection fields without taking away what HTTP needs", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add subscriber" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    // Nothing SAP until it is chosen.
    expect(panel.queryByLabelText(/^Application server host/)).not.toBeInTheDocument();
    await user.selectOptions(panel.getByLabelText(/^Transport/), "sap_rfc");

    expect(panel.getByLabelText(/^Application server host/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^System number/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^Client/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^User/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^Password from environment variable/)).toBeInTheDocument();
    expect(panel.getByLabelText("Plant for BAL-WH01")).toBeInTheDocument();
    expect(panel.getByLabelText(/^Default storage location/)).toBeInTheDocument();

    // The password is named, never kept.
    expect(panel.getByText(/The password itself is set on the worker host and is never stored here\./)).toBeInTheDocument();
    // The URL is a label for people now, not something the worker fetches.
    expect(panel.getByText("A label for people, such as rfc://PRD. Nothing fetches it.")).toBeInTheDocument();
    // Same queue, same retries, one goods movement each.
    expect(panel.getByText(/same queue and the same retries as any other subscriber/)).toBeInTheDocument();
    expect(panel.getByText(/becomes a goods movement posting/)).toBeInTheDocument();

    // Everything HTTP needed is still here.
    expect(panel.getByLabelText(/^Name/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^URL/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^Event types/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^Warehouses/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^Owner/)).toBeInTheDocument();
    expect(panel.getByLabelText(/^Secret/)).toBeInTheDocument();
  });

  it("posts an SAP subscriber with its settings, and only the plants that were filled in", async () => {
    layer((url) => twoWarehouses(url));
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add subscriber" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    await user.type(panel.getByLabelText(/^Name/), "sap-erp");
    await user.selectOptions(panel.getByLabelText(/^Transport/), "sap_rfc");
    await user.type(panel.getByLabelText(/^URL/), "rfc://PRD");
    await user.type(panel.getByLabelText(/^Event types/), "receipt.confirmed, delivery.shipped");
    await fillSapConnection(user, panel);
    // Ballarat posts to plant 1000; Melbourne is not in SAP yet.
    await user.type(panel.getByLabelText("Plant for BAL-WH01"), "1000");
    expect(panel.getByLabelText("Plant for MEL-WH01")).toHaveValue("");
    await user.click(panel.getByRole("button", { name: "Add subscriber" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/subscribers")).toBe(true));
    const call = posted.find((p) => p.url === "/v1/subscribers")!;
    expect(call.body).toEqual({
      name: "sap-erp", url: "rfc://PRD", event_types: ["receipt.confirmed", "delivery.shipped"],
      warehouses: ["*"], owner: "*", transport: "sap_rfc", active: true,
      settings: {
        connection: { ashost: "sap.example", sysnr: "00", client: "100", user: "WMS", passwd_env: "SAP_PASSWORD" },
        plant_by_warehouse: { "BAL-WH01": "1000" },
        storage_location: "0001",
      },
    });
  });

  it("posts an HTTP subscriber the way it always did", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add subscriber" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    await user.type(panel.getByLabelText(/^Name/), "Carrier B");
    await user.type(panel.getByLabelText(/^URL/), "https://carrier-b/hook");
    await user.type(panel.getByLabelText(/^Event types/), "delivery.packed");
    await user.click(panel.getByRole("button", { name: "Add subscriber" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/subscribers")).toBe(true));
    const call = posted.find((p) => p.url === "/v1/subscribers")!;
    expect(call.body).toEqual({
      name: "Carrier B", url: "https://carrier-b/hook", event_types: ["delivery.packed"],
      warehouses: ["*"], owner: "*", transport: "http", active: true,
    });
    expect(call.body as Record<string, unknown>).not.toHaveProperty("settings");
  });

  it("opens an existing SAP subscriber with its settings and saves them back", async () => {
    layer((url, init) => {
      if (url === "/v1/subscribers" && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, { items: [...SUBSCRIBERS, SAP_SUBSCRIBER], total: SUBSCRIBERS.length + 1 });
      }
      if (url === "/v1/subscribers" && init?.method === "POST") return jsonResponse(200, SAP_SUBSCRIBER);
      return twoWarehouses(url);
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("sap-erp"));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    expect(panel.getByLabelText(/^Transport/)).toHaveValue("sap_rfc");
    expect(panel.getByLabelText(/^Application server host/)).toHaveValue("sap.example");
    expect(panel.getByLabelText(/^Password from environment variable/)).toHaveValue("SAP_PASSWORD");
    expect(panel.getByLabelText("Plant for BAL-WH01")).toHaveValue("1000");
    expect(panel.getByLabelText("Plant for MEL-WH01")).toHaveValue("");

    await user.type(panel.getByLabelText("Plant for MEL-WH01"), "2000");
    await user.click(panel.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/subscribers")).toBe(true));
    const call = posted.find((p) => p.url === "/v1/subscribers")!;
    expect(call.body).toEqual({
      name: "sap-erp", url: "rfc://PRD", event_types: ["receipt.confirmed", "delivery.shipped"],
      warehouses: ["*"], owner: "*", transport: "sap_rfc", active: true,
      settings: {
        connection: { ashost: "sap.example", sysnr: "00", client: "100", user: "WMS", passwd_env: "SAP_PASSWORD" },
        plant_by_warehouse: { "BAL-WH01": "1000", "MEL-WH01": "2000" },
        storage_location: "0001",
        // A site's own numbering is kept, not dropped by a save from here.
        movement_types: { "delivery.shipped": "601" },
      },
    });
  });

  it("shows the API's refusal about the password under the password field", async () => {
    layer((url, init) => (url === "/v1/subscribers" && init?.method === "POST"
      ? jsonResponse(422, { errors: [{ field: "body", message: `Value error, ${PASSWD_REFUSAL}` }] })
      : undefined));
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add subscriber" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    await user.type(panel.getByLabelText(/^Name/), "sap-bad");
    await user.selectOptions(panel.getByLabelText(/^Transport/), "sap_rfc");
    await user.type(panel.getByLabelText(/^URL/), "rfc://PRD");
    await user.type(panel.getByLabelText(/^Event types/), "receipt.confirmed");
    await user.type(panel.getByLabelText("Plant for BAL-WH01"), "1000");
    await user.click(panel.getByRole("button", { name: "Add subscriber" }));

    expect(await panel.findByText(PASSWD_REFUSAL)).toBeInTheDocument();
    // Under the field the reader has to change, in the API's own words.
    expect(panel.getByLabelText(/passwd_env and set it on the host/))
      .toBe(panel.getByLabelText(/^Password from environment variable/));
    // Not repeated as a raw "body: ..." notice.
    expect(panel.queryByText(/^body:/)).not.toBeInTheDocument();
  });

  it("shows the API's refusal about the plants with the warehouse rows", async () => {
    layer((url, init) => (url === "/v1/subscribers" && init?.method === "POST"
      ? jsonResponse(422, { errors: [{ field: "body", message: "Value error, an SAP subscriber needs plant_by_warehouse in its settings" }] })
      : undefined));
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add subscriber" }));
    const panel = within(screen.getByRole("complementary", { name: "Detail" }));

    await user.type(panel.getByLabelText(/^Name/), "sap-bad");
    await user.selectOptions(panel.getByLabelText(/^Transport/), "sap_rfc");
    await user.type(panel.getByLabelText(/^URL/), "rfc://PRD");
    await user.type(panel.getByLabelText(/^Event types/), "receipt.confirmed");
    await user.click(panel.getByRole("button", { name: "Add subscriber" }));

    expect(await panel.findByText("an SAP subscriber needs plant_by_warehouse in its settings")).toBeInTheDocument();
    expect(panel.queryByText("Only the warehouses you fill in are sent.")).not.toBeInTheDocument();
  });
});
