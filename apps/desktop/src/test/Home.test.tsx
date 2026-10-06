import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import { addDays, warehouseDay } from "../lib/goal";
import { reloadGamePrefs } from "../lib/gamePrefs";
import { json, path, query, renderApp, stubApi } from "./harness";

const TODAY = warehouseDay(null);
const day = (n: number) => addDays(TODAY, n);

const NEXT = {
  wms_id: "41", external_ref: "SO-2047", owner: "DEFAULT", warehouse: "BAL-WH01", pick_mode: "single",
  priority: "high", required_by: day(1), ship_to: { name: "Ridgeline Hardware" }, carrier_hint: null,
  carrier: null, tracking_no: null, allow_short: false, status: "allocated", short: false,
  staging_location: null, note: null, created_at: `${TODAY}T00:00:00Z`, allocated_at: null, picked_at: null,
  packed_at: null, shipped_at: null, cancelled_at: null,
  lines: [{ delivery_line: 1 }, { delivery_line: 2 }, { delivery_line: 3 }], packages: [], task: null,
  pack_task: null, events: [],
};

/** Four shipping days averaging 40, so the app suggests 45. Two of them
 * reached 45, so the streak is two. 31 out today. */
const SHIPPED_ROWS = [
  { day: day(-4), deliveries: 34 },
  { day: day(-3), deliveries: 30 },
  { day: day(-2), deliveries: 46 },
  { day: day(-1), deliveries: 50 },
  { day: TODAY, deliveries: 31 },
];

function homeApi(over: Partial<Record<string, unknown>> = {}, scopes?: string[]) {
  return stubApi((url) => {
    const p = path(url);
    if (p === "/v1/receipts") {
      expect(query(url).get("status")).toBe("expected,arrived,receiving");
      return json(200, over.receipts ?? { items: [], total: 7 });
    }
    if (p === "/v1/deliveries") {
      expect(query(url).get("status")).toBe("new,allocated,picking,picked,packing,packed");
      return json(200, over.deliveries ?? { items: [NEXT], total: 5 });
    }
    if (p === "/v1/reports/stock-on-hand") {
      expect(query(url).get("group_by")).toBe("product");
      return json(200, over.stock ?? {
        report: "stock-on-hand", rows: Array.from({ length: 12 }, (_, i) => ({ sku: `SKU-${i}` })), totals: {},
      });
    }
    if (p === "/v1/reports/shipped") {
      expect(query(url).get("to")).toBe(TODAY);
      expect(query(url).get("from")).toBe(day(-28));
      return json(200, over.shipped ?? { report: "shipped", rows: SHIPPED_ROWS, totals: {} });
    }
    if (p === "/v1/stock/ledger") {
      return json(200, over.ledger ?? {
        items: [{
          wms_id: "9", at: new Date().toISOString(), movement_type: "receipt", reason: null,
          warehouse: "BAL-WH01", location: "DOCK-1", zone: "INBOUND", sku: "GLOVE-L", batch: null,
          owner: "DEFAULT", qty_change: "120", uom: "EA", received_at: null, actor: "op-1", device: null,
          task_id: null, external_ref: null, container_id: null, note: null,
        }],
        total: 1,
      });
    }
    return null;
  }, { scopes });
}

beforeEach(() => {
  window.localStorage.clear();
  reloadGamePrefs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  api.setSession(null);
});

describe("Map home", () => {
  it("fills the zone counters from the API", async () => {
    homeApi();
    renderApp("/");
    const zones = await screen.findByRole("group", { name: "Zones" });
    expect(await within(zones).findByText("7")).toBeInTheDocument();
    expect(await within(zones).findByText("12")).toBeInTheDocument();
    expect(await within(zones).findByText("5")).toBeInTheDocument();
    expect(within(zones).getByRole("button", { name: /Arriving 7/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Pretend warehouse/ })).toBeInTheDocument();
  });

  it("opens the panel for a counter in the drawer", async () => {
    homeApi();
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: /Arriving/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/receiving");
    expect(await screen.findByRole("region", { name: "Receiving" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Back to the map" }));
    await user.click(await screen.findByRole("button", { name: /Leaving/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/deliveries");

    await user.click(screen.getByRole("link", { name: "Back to the map" }));
    await user.click(await screen.findByRole("button", { name: /Stored/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/stock");
  });

  it("suggests a goal from the last four weeks and shows the streak", async () => {
    homeApi();
    renderApp("/");
    const goal = await screen.findByRole("region", { name: "Today's goal" });
    expect(await within(goal).findByText("Ship 45 orders")).toBeInTheDocument();
    expect(within(goal).getByText("14 to go")).toBeInTheDocument();
    expect(within(goal).getByText(/You usually ship about 40 a day/)).toBeInTheDocument();
    expect(within(goal).getByText("2-day goal streak")).toBeInTheDocument();
    expect(within(goal).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "31");
  });

  it("keeps a manager's own goal for this warehouse, and can go back to the suggestion", async () => {
    homeApi();
    const user = userEvent.setup();
    const first = renderApp("/");
    const goal = await screen.findByRole("region", { name: "Today's goal" });
    await within(goal).findByText("Ship 45 orders");
    await user.click(within(goal).getByRole("button", { name: "Edit" }));
    await user.click(within(goal).getByRole("button", { name: "Raise today's goal" }));
    await user.click(within(goal).getByRole("button", { name: "Raise today's goal" }));
    expect(within(goal).getByText("Ship 55 orders")).toBeInTheDocument();
    expect(window.localStorage.getItem("wms.goal.BAL-WH01")).toBe("55");
    expect(within(goal).getByText(/Your own goal for this warehouse. The app would suggest 45/)).toBeInTheDocument();
    first.unmount();
    cleanup();

    // Comes back after a reload.
    renderApp("/");
    const again = await screen.findByRole("region", { name: "Today's goal" });
    expect(await within(again).findByText("Ship 55 orders")).toBeInTheDocument();
    await user.click(within(again).getByRole("button", { name: "Edit" }));
    await user.click(within(again).getByRole("button", { name: "Use suggestion (45)" }));
    expect(within(again).getByText("Ship 45 orders")).toBeInTheDocument();
    expect(window.localStorage.getItem("wms.goal.BAL-WH01")).toBeNull();
  });

  it("shows the soonest open delivery as next up, with a way in", async () => {
    homeApi();
    renderApp("/");
    const next = await screen.findByRole("region", { name: "Next up" });
    expect(await within(next).findByText("Ridgeline Hardware")).toBeInTheDocument();
    expect(within(next).getByText("Delivery SO-2047")).toBeInTheDocument();
    expect(within(next).getByText("Stock held")).toBeInTheDocument();
    expect(within(next).getByText("High priority")).toBeInTheDocument();
    expect(within(next).getByText("4 more deliveries after this one.")).toBeInTheDocument();
    expect(within(next).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/deliveries/SO-2047");
  });

  it("tells what just happened from the ledger", async () => {
    homeApi();
    renderApp("/");
    const feed = await screen.findByRole("region", { name: "What just happened" });
    expect(await within(feed).findByText(/Received 120 EA of GLOVE-L/)).toBeInTheDocument();
  });

  it("reads sensibly when the warehouse is empty", async () => {
    homeApi({
      receipts: { items: [], total: 0 }, deliveries: { items: [], total: 0 },
      stock: { report: "stock-on-hand", rows: [], totals: {} },
      shipped: { report: "shipped", rows: [], totals: {} }, ledger: { items: [], total: 0 },
    });
    renderApp("/");
    expect(await screen.findByText("Nothing waiting to go. Every order is out the door.")).toBeInTheDocument();
    expect(await screen.findByText("Nothing has moved in this warehouse yet.")).toBeInTheDocument();
    expect(await screen.findByText("Ship 5 orders")).toBeInTheDocument();
    expect(screen.getByText("Nothing shipped in the last 4 weeks yet, so the goal starts small.")).toBeInTheDocument();
    expect(screen.getByText("No streak yet")).toBeInTheDocument();
  });

  it("says what went wrong when the API refuses", async () => {
    stubApi(() => json(403, { detail: "missing scope stock:read" }));
    renderApp("/");
    expect(await screen.findByText("Could not load the latest movements: missing scope stock:read")).toBeInTheDocument();
    expect(screen.getByText("Could not load the deliveries: missing scope stock:read")).toBeInTheDocument();
    expect(screen.getByText("Could not read what shipped: missing scope stock:read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Arriving/ })).toHaveTextContent("—");
  });

  it("does not ask for stock numbers someone may not see, and says so kindly", async () => {
    const { calls } = homeApi({}, ["tasks:read"]);
    renderApp("/");
    const zones = await screen.findByRole("group", { name: "Zones" });
    expect(await within(zones).findByText("7")).toBeInTheDocument();
    expect(within(zones).getByRole("button", { name: /Stored/ })).toHaveTextContent("—");
    expect(within(zones).getByRole("button", { name: /Stored/ })).toHaveAttribute("title", "You don't have access to stock numbers");
    expect(screen.getByText("You don't have access to stock numbers, so shipments can't be counted here.")).toBeInTheDocument();
    expect(screen.getByText("You don't have access to stock numbers, so the latest movements are hidden.")).toBeInTheDocument();
    expect(await screen.findByText("Ridgeline Hardware")).toBeInTheDocument();
    expect(calls.filter((u) => u.startsWith("/v1/reports") || u.startsWith("/v1/stock"))).toEqual([]);
    expect(screen.queryByText(/Could not/)).not.toBeInTheDocument();
  });

  it("has a dock with the big jobs and the All panels button", async () => {
    homeApi();
    renderApp("/");
    const dock = await screen.findByRole("navigation", { name: "Shortcuts" });
    expect(within(dock).getByRole("link", { name: "Orders" })).toHaveAttribute("href", "/deliveries");
    expect(within(dock).getByRole("link", { name: "Products" })).toHaveAttribute("href", "/products");
    expect(within(dock).getByRole("link", { name: "Reports" })).toHaveAttribute("href", "/reports");
    expect(within(dock).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(within(dock).getByRole("link", { name: "All panels" })).toHaveAttribute("href", "/menu");
  });
});
