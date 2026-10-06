import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import type { PrintJob, PrintPoint, PrintTemplate } from "../api/types";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Printing } from "../pages/Printing";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const now = new Date().toISOString();

const SETTINGS = {
  erp_counts_gr: true, batch_from_production_order: true, receipt_tolerance_pct: 2, supplier_tolerance_pct: 5,
  allow_ship_short: false, supervisor_for_short_pick: true, auto_pick_mode: "auto", batch_pick_max_orders: 6,
  idle_logout_minutes: 15, pin_lockout_tries: 5, known_devices_only: true, queue_offline_confirmations: true,
  fifo_by_received_date: true, blind_counts: true, decimals_allowed: true, platen_url: "https://platen.internal/jobs",
  retry_failed_print_jobs: true, default_copies: 1, ledger_retention_years: 7, duplicate_window_hours: 24,
  allow_hard_deletes: false,
};

const TEMPLATES: PrintTemplate[] = [
  {
    template: "carton-label", version: "v3", fires_on: ["delivery.packed"],
    fields: ["ship_to", "delivery_ref", "package_no", "package_count", "weight_kg", "lines"],
    describe: "One label per carton, stuck on the box",
  },
  {
    template: "location-label", version: "v2", fires_on: ["receipt.confirmed"],
    fields: ["location", "warehouse", "zone", "barcode"],
    describe: "The shelf label with its barcode",
  },
  {
    template: "product-label", version: "v1", fires_on: [],
    fields: ["sku", "name", "uom", "barcode"],
    describe: "A product label with its barcode",
  },
];

const POINTS: PrintPoint[] = [
  {
    wms_id: "pp1", warehouse: "BAL-WH01", event_type: "delivery.packed", template: "carton-label", version: "v3",
    printer: "Packing bench 2", copies: 1, owner: "*", active: true, created_at: "2026-09-01T02:00:00Z", updated_at: null,
  },
  {
    wms_id: "pp2", warehouse: null, event_type: "receipt.confirmed", template: "location-label", version: "v2",
    printer: "Receiving dock", copies: 0, owner: "*", active: true, created_at: "2026-09-01T02:00:00Z", updated_at: null,
  },
];

const CARTON_DATA = {
  ship_to: { name: "Acme Auto Parts", suburb: "Geelong", state: "VIC", postcode: "3220" },
  delivery_ref: "0080012340",
  package_no: 1,
  package_count: 2,
  weight_kg: "8.4",
  lines: [{ sku: "ABC123", qty: "10", uom: "EA" }],
};

const JOBS: PrintJob[] = [
  {
    wms_id: "pj1", job_id: "0192-cccc-7f21", warehouse: "BAL-WH01", owner: "DEFAULT", template: "carton-label",
    version: "v3", printer: "Packing bench 2", copies: 1,
    reference: { type: "delivery", ref: "0080012340", package_no: 1 }, data: CARTON_DATA,
    status: "printed", attempts: 1, next_attempt_at: null, last_error: null, external_ref: "0080012340",
    reprint_of: null, created_at: now, sent_at: now, printed_at: now,
  },
  {
    wms_id: "pj2", job_id: "0192-cccc-7f22", warehouse: "BAL-WH01", owner: "DEFAULT", template: "carton-label",
    version: "v3", printer: "Packing bench 2", copies: 1,
    reference: { type: "delivery", ref: "0080012341", package_no: 2 }, data: { delivery_ref: "0080012341" },
    status: "pending", attempts: 0, next_attempt_at: now, last_error: null, external_ref: "0080012341",
    reprint_of: null, created_at: now, sent_at: null, printed_at: null,
  },
  {
    wms_id: "pj3", job_id: "0192-cccc-7f23", warehouse: "BAL-WH01", owner: "DEFAULT", template: "packing-slip",
    version: "v1", printer: "Packing bench 1", copies: 1,
    reference: { type: "delivery", ref: "0080012342" }, data: { delivery_ref: "0080012342" },
    status: "pending", attempts: 3, next_attempt_at: now, last_error: "no answer from Platen",
    external_ref: "0080012342", reprint_of: null, created_at: now, sent_at: now, printed_at: null,
  },
  {
    wms_id: "pj4", job_id: "0192-cccc-7f24", warehouse: "BAL-WH01", owner: "DEFAULT", template: "pick-list",
    version: "v1", printer: "Office", copies: 1,
    reference: { type: "delivery", ref: "0080012343" }, data: { delivery_ref: "0080012343" },
    status: "failed", attempts: 5, next_attempt_at: null, last_error: "out of labels",
    external_ref: "0080012343", reprint_of: null, created_at: now, sent_at: now, printed_at: null,
  },
  {
    wms_id: "pj5", job_id: "0192-cccc-7f25", warehouse: "BAL-WH01", owner: "DEFAULT", template: "product-label",
    version: "v1", printer: "Label printer", copies: 3,
    reference: { type: "product", ref: "ABC123" }, data: { sku: "ABC123" },
    status: "accepted", attempts: 1, next_attempt_at: null, last_error: null, external_ref: null,
    reprint_of: null, created_at: now, sent_at: now, printed_at: null,
  },
];

function renderPrinting() {
  return render(
    <MemoryRouter initialEntries={["/printing"]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/printing" element={<Printing />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function detail() {
  return screen.getByRole("complementary", { name: "Detail" });
}

/** Pills and filter chips share words; a chip is a button. */
function pills(label: string) {
  return screen.getAllByText(label).filter((el) => el.tagName !== "BUTTON");
}

describe("Printing", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: { url: string; body: Record<string, unknown> }[];
  let platenUrl: string | null;

  beforeEach(() => {
    posted = [];
    platenUrl = "https://platen.internal/jobs";
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = url.split("?")[0];
      if (method === "POST") posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (path === "/v1/auth/refresh") return json(200, { token: "t", refresh_token: "r2", expires_in: 900 });
      if (path === "/v1/auth/me") {
        return json(200, {
          wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin",
          warehouses: ["*"], scopes: ["*"], kind: "user",
        });
      }
      if (path === "/v1/warehouses") {
        return json(200, {
          items: [{
            wms_id: "w1", code: "BAL-WH01", site: "BAL", name: "Ballarat",
            settings: { ...SETTINGS, platen_url: platenUrl }, active: true,
          }],
          total: 1,
        });
      }
      if (path === "/v1/print-templates") return json(200, { items: TEMPLATES, total: TEMPLATES.length });
      if (path === "/v1/print-points" && method === "GET") return json(200, { items: POINTS, total: POINTS.length });
      if (path === "/v1/print-points" && method === "POST") return json(201, { ...POINTS[0], wms_id: "pp9" });
      if (path === "/v1/print-jobs" && method === "GET") return json(200, { items: JOBS, total: JOBS.length });
      if (path === "/v1/print-jobs" && method === "POST") return json(202, { ...JOBS[0], wms_id: "pj9" });
      if (/^\/v1\/print-jobs\/[^/]+\/reprint$/.test(path) && method === "POST") return json(202, { ...JOBS[0], wms_id: "pj9" });
      return json(404, { detail: `no mock for ${method} ${url}` });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    api.setSession(null);
  });

  it("lists print points and recent jobs with the right pills", async () => {
    renderPrinting();

    // A print point row is clickable; the Templates table below names the same events.
    expect(await screen.findByRole("button", { name: /^delivery\.packed carton-label v3 Packing bench 2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^receipt\.confirmed location-label v2 Receiving dock/ })).toBeInTheDocument();
    // A print point with 0 copies is off, and a null warehouse covers all of them.
    expect(screen.getByText("· off")).toBeInTheDocument();
    expect(pills("All")).toHaveLength(1);
    expect(pills("On")).toHaveLength(1);
    expect(pills("Off")).toHaveLength(1);

    // Jobs.
    expect(await screen.findByText("job-…7f21")).toBeInTheDocument();
    expect(screen.getByText("0080012340 · carton 1")).toBeInTheDocument();
    expect(pills("Printed")).toHaveLength(1);
    expect(pills("Queued")).toHaveLength(1);
    expect(pills("Retrying")).toHaveLength(1);
    expect(pills("Failed")).toHaveLength(1);
    expect(pills("Accepted")).toHaveLength(1);
    expect(screen.getByText("no answer from Platen")).toBeInTheDocument();

    // Templates, with the one nothing fires.
    expect(screen.getByText("printed by hand")).toBeInTheDocument();
    expect(screen.getByText("One label per carton, stuck on the box")).toBeInTheDocument();

    // A Platen URL is set, so no warning.
    expect(screen.getByText("Sending to https://platen.internal/jobs")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/v1/print-jobs?"))).toBe(true);
  });

  it("shows the exact JSON of the latest job for a selected print point", async () => {
    renderPrinting();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^delivery\.packed carton-label/ }));

    const panel = within(detail());
    expect(panel.getByText("Print point")).toBeInTheDocument();
    expect(panel.getByText("carton-label v3 → Packing bench 2")).toBeInTheDocument();
    expect(panel.getByText("What Platen receives")).toBeInTheDocument();

    const pre = detail().querySelector("pre");
    expect(pre).not.toBeNull();
    // pj1 is the newest carton-label job; pj2 is older and must not win.
    expect(pre!.textContent).toBe(JSON.stringify(CARTON_DATA, null, 2));
  });

  it("falls back to the template fields when nothing has printed yet", async () => {
    renderPrinting();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^receipt\.confirmed location-label/ }));
    const panel = within(detail());
    expect(panel.getByText("No job yet. These are the fields this template sends.")).toBeInTheDocument();
    expect(panel.getByText("barcode")).toBeInTheDocument();
  });

  it("reprints a job with a message id", async () => {
    renderPrinting();
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole("button", { name: "Reprint" });
    expect(buttons).toHaveLength(JOBS.length);
    await user.click(buttons[0]);

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/print-jobs/pj1/reprint")).toBe(true));
    const call = posted.find((p) => p.url === "/v1/print-jobs/pj1/reprint")!;
    expect(typeof call.body.message_id).toBe("string");
    // The list is reloaded afterwards.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/v1/print-jobs?")).length).toBeGreaterThan(1));
  });

  it("adds a print point", async () => {
    renderPrinting();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add print point" }));

    const panel = within(detail());
    await user.selectOptions(panel.getByLabelText(/^Event/), "delivery.packed");
    // Choosing the event picks the template that fires on it.
    expect(panel.getByLabelText(/^Template/)).toHaveValue("carton-label");
    await user.type(panel.getByLabelText(/^Printer/), "Packing bench 3");
    await user.click(panel.getByRole("button", { name: "Add print point" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/print-points")).toBe(true));
    expect(posted.find((p) => p.url === "/v1/print-points")!.body).toEqual({
      warehouse: "BAL-WH01", event_type: "delivery.packed", template: "carton-label",
      printer: "Packing bench 3", copies: 1, owner: "*", active: true,
    });
  });

  it("prints something on demand", async () => {
    renderPrinting();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Print something" }));

    const panel = within(detail());
    await user.type(panel.getByLabelText(/^Location code/), "PF-01-02-A");
    await user.type(panel.getByLabelText(/^Printer/), "Office");
    await user.click(panel.getByRole("button", { name: "Print" }));

    await waitFor(() => expect(posted.some((p) => p.url === "/v1/print-jobs")).toBe(true));
    const body = posted.find((p) => p.url === "/v1/print-jobs")!.body;
    expect(typeof body.message_id).toBe("string");
    expect(body.warehouse).toBe("BAL-WH01");
    expect(body.template).toBe("location-label");
    expect(body.printer).toBe("Office");
    expect(body.copies).toBe(1);
    expect(body.reference).toEqual({ type: "location", ref: "PF-01-02-A" });
    expect(await screen.findByText("Sent to Office")).toBeInTheDocument();
  });

  it("warns in gold when the warehouse has no print service", async () => {
    platenUrl = null;
    renderPrinting();
    const notice = await screen.findByText(
      "No print service is set for BAL-WH01. Jobs will wait in the queue until a Platen URL is set on the Settings screen.",
    );
    expect(notice).toBeInTheDocument();
    expect(notice.className).toContain("text-gold");
  });
});
