import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RequireAuth } from "../auth/RequireAuth";
import { Receiving } from "../pages/Receiving";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const WAREHOUSE = { wms_id: "1", code: "BAL-WH01", site: "BAL", name: "Ballarat 1", settings: { receipt_tolerance_pct: 5 }, active: true };

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = localDate(now);
const THREE_DAYS_AGO = localDate(new Date(now.getTime() - 3 * 86_400_000));

const line = (n: number, sku: string, name: string, expected: string, received: string, batch: string | null = null) =>
  ({ line: n, sku, name, batch, expected_qty: expected, received_qty: received, uom: "EA" });

const base = {
  owner: "DEFAULT", warehouse: "BAL-WH01", kind: "purchase", carrier: null, note: null, arrived_at: null, closed_at: null,
  putaways: [], events: [], task: null,
};

const RECEIPTS = [
  {
    ...base, wms_id: "r1", external_ref: "PO-88815", supplier: "Supplier Co", expected_at: TODAY, dock: "Dock 1", carrier: "Toll",
    status: "receiving", created_at: now.toISOString(), arrived_at: now.toISOString(),
    expected_total: "240", received_total: "120",
    lines: [line(1, "ABC123", "Brake pad set", "120", "120"), line(2, "DEF456", "Rotor 280 mm", "120", "0", "B2611")],
    task: {
      wms_id: "4411", type: "receive", title: "Receive PO-88815", status: "in_progress", warehouse: "BAL-WH01", owner: "DEFAULT",
      priority: "normal", source_type: "receipt", source_ref: "PO-88815", assigned_to: "Jo", device: "SCN-BAL-07", needs_supervisor: false,
      note: null, created_by: "erp", created_at: now.toISOString(), started_at: now.toISOString(), completed_at: null, cancelled_at: null,
      progress: { done: 1, total: 2 }, lines: [],
    },
  },
  {
    ...base, wms_id: "r2", external_ref: "PO-88816", supplier: "Brakes Direct", expected_at: TODAY, dock: "Dock 2",
    status: "arrived", created_at: now.toISOString(), expected_total: "200", received_total: "0",
    lines: [line(1, "GHI789", "Wiper 22 in", "200", "0")],
  },
  {
    ...base, wms_id: "r3", external_ref: "PO-88809", supplier: "Rotor Works", expected_at: THREE_DAYS_AGO, dock: null,
    status: "expected", created_at: now.toISOString(), expected_total: "60", received_total: "0",
    lines: [line(1, "DEF456", "Rotor 280 mm", "60", "0")],
  },
  {
    ...base, wms_id: "r4", external_ref: "PO-88812", supplier: "Supplier Co", expected_at: "2026-08-30", dock: "Dock 1",
    status: "complete", created_at: now.toISOString(), closed_at: now.toISOString(), expected_total: "360", received_total: "360",
    lines: [line(1, "ABC123", "Brake pad set", "360", "360")],
  },
];

const DETAIL = {
  ...RECEIPTS[0],
  putaways: [
    { ledger_id: "889201", at: now.toISOString(), sku: "ABC123", batch: null, qty: "120", uom: "EA", location: "BK-04-01-C", actor: "Jo", device: "SCN-BAL-07" },
  ],
  events: [{ event_type: "receipt.confirmed", subscriber: "ERP", status: "delivered", at: now.toISOString() }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/receiving"]}>
      <AuthProvider><Routes><Route element={<RequireAuth />}><Route path="/receiving" element={<Receiving />} /></Route></Routes></AuthProvider>
    </MemoryRouter>,
  );
}

describe("Receiving", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path === "/v1/auth/refresh") return json(200, { token: "t2", refresh_token: "r2", expires_in: 900, user: {} });
      if (path === "/v1/auth/me") return json(200, { wms_id: "1", username: "leighton", display_name: "Leighton L.", role: "admin", warehouses: ["*"], scopes: ["*"], kind: "user" });
      if (path === "/v1/warehouses") return json(200, { items: [WAREHOUSE], total: 1 });
      if (path === "/v1/receipts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return json(202, { message_id: body.message_id, wms_id: "r9", status: "created" });
      }
      if (path === "/v1/receipts") return json(200, { items: RECEIPTS, total: RECEIPTS.length });
      if (path === "/v1/receipts/PO-88815") return json(200, DETAIL);
      if (path === "/v1/receipts/PO-90001") return json(200, { ...RECEIPTS[1], external_ref: "PO-90001", supplier: "Filters AU", status: "expected" });
      return json(404, { detail: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the tiles and a row per receipt with the right pill", async () => {
    renderPage();
    expect(await screen.findByText("from 2 suppliers")).toBeInTheDocument();
    expect(screen.getByText("on the receiving dock")).toBeInTheDocument();
    expect(screen.getByText("480")).toBeInTheDocument();
    expect(screen.getByText(/^PO-88809 · due /)).toBeInTheDocument();
    expect(screen.getByText("1", { selector: "span.text-gold" })).toBeInTheDocument();

    expect(screen.getByText("Receiving", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Arrived", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Late", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Complete", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("Jo · line 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Truck at Dock 2")).toBeInTheDocument();
    expect(screen.getByText("Chase supplier")).toBeInTheDocument();

    const call = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith("/v1/receipts?"));
    expect(call).toContain("warehouse=BAL-WH01");

    // the Late filter keeps only the overdue receipt
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Late" }));
    expect(screen.getByText("PO-88809")).toBeInTheDocument();
    expect(screen.queryByText("PO-88815")).not.toBeInTheDocument();
  });

  it("loads a receipt into the panel with its put-aways", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("PO-88815"));

    expect(await screen.findByText("Supplier Co · 2 lines · ref from ERP")).toBeInTheDocument();
    expect(screen.getByText("Up to 5 %")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("120 EA ABC123 → BK-04-01-C")).toBeInTheDocument();
    expect(screen.getByText("receipt.confirmed → ERP")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Print labels")).toBeDisabled();
    expect(screen.getByText("Close short")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => (c[0] as string) === "/v1/receipts/PO-88815")).toBe(true);
  });

  it("creates an expected receipt with a message_id", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Create expected receipt"));

    await user.type(screen.getByLabelText("Reference"), "PO-90001");
    await user.type(screen.getByLabelText("Supplier"), "Filters AU");
    fireEvent.change(screen.getByLabelText("Expected date"), { target: { value: "2026-09-22" } });
    await user.type(screen.getByLabelText("Dock"), "Dock 3");
    await user.type(screen.getByLabelText("SKU 1"), "JKL012");
    await user.type(screen.getByLabelText("Qty 1"), "100");
    await user.click(screen.getByText("Add line"));
    await user.type(screen.getByLabelText("SKU 2"), "MNO345");
    await user.type(screen.getByLabelText("Qty 2"), "40.5");
    await user.type(screen.getByLabelText("Batch 2"), "B2612");
    await user.click(screen.getByText("Create receipt"));

    const post = fetchMock.mock.calls.find((c) => (c[0] as string) === "/v1/receipts" && (c[1] as RequestInit).method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(typeof body.message_id).toBe("string");
    expect(body).toMatchObject({
      external_ref: "PO-90001", warehouse: "BAL-WH01", owner: "DEFAULT", supplier: "Filters AU",
      expected_at: "2026-09-22", dock: "Dock 3",
      lines: [
        { line: 1, sku: "JKL012", batch: null, qty: "100", uom: "EA" },
        { line: 2, sku: "MNO345", batch: "B2612", qty: "40.5", uom: "EA" },
      ],
    });

    // the new receipt is selected once created
    expect(await screen.findByText("Filters AU · 1 line · ref from ERP")).toBeInTheDocument();
  });
});
