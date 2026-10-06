import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import { GAME_PREFS_KEY, reloadGamePrefs } from "../lib/gamePrefs";
import { deliveryRecord, json, path, renderApp, stubApi } from "./harness";

beforeEach(() => {
  window.localStorage.clear();
  reloadGamePrefs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  api.setSession(null);
});

function stored() {
  return JSON.parse(window.localStorage.getItem(GAME_PREFS_KEY) ?? "{}");
}

describe("Panels open in a drawer over the map", () => {
  it("closes with the X, back to the map", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/menu");
    expect(await screen.findByRole("region", { name: "All panels" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Back to the map" }));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    expect(await screen.findByRole("group", { name: "Zones" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "All panels" })).not.toBeInTheDocument();
  });

  it("closes with Escape", async () => {
    stubApi();
    renderApp("/settings");
    expect(await screen.findByRole("region", { name: "Settings" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("leaves Escape alone while someone is clearing a search box", async () => {
    stubApi();
    renderApp("/menu");
    await screen.findByRole("region", { name: "All panels" });
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "SKU" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent("/menu");
  });

  it("keeps the map behind the drawer, out of the way of screen readers", async () => {
    stubApi();
    renderApp("/menu");
    await screen.findByRole("region", { name: "All panels" });
    expect(screen.queryByRole("img", { name: /Pretend warehouse/ })).not.toBeInTheDocument();
    expect(document.querySelector("svg[aria-hidden='true'] [data-layer='truck-in']")).not.toBeNull();
  });
});

describe("All panels menu", () => {
  it("lists every panel in four groups", async () => {
    stubApi();
    renderApp("/menu");
    const nav = await screen.findByRole("navigation", { name: "All panels" });
    for (const g of ["Going out", "Coming in", "In the warehouse", "Scores and setup"]) {
      expect(within(nav).getByRole("heading", { name: g })).toBeInTheDocument();
    }
    const links = within(nav).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "/deliveries", "/deliveries/batches", "/tasks",
      "/receiving", "/production", "/transfers",
      "/stock", "/products", "/replenishment", "/locations", "/containers",
      "/reports", "/users", "/integrations", "/printing", "/import", "/owners", "/settings",
    ]);
    expect(within(nav).getByRole("link", { name: /Containers.*Later/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Owners.*Later/ })).toBeInTheDocument();
  });

  it("opens a panel from the menu", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/menu");
    const nav = await screen.findByRole("navigation", { name: "All panels" });
    await user.click(within(nav).getByRole("link", { name: /Task board/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/tasks");
    expect(await screen.findByRole("region", { name: "Task board" })).toBeInTheDocument();
  });
});

describe("Game feel preferences", () => {
  it("turns sounds and day and night off from the top bar, and remembers", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/menu");
    const sound = await screen.findByRole("button", { name: "Game sounds" });
    const sky = screen.getByRole("button", { name: "Day and night" });
    expect(sound).toHaveAttribute("aria-pressed", "true");
    expect(sky).toHaveAttribute("aria-pressed", "true");

    await user.click(sound);
    await user.click(sky);
    expect(sound).toHaveAttribute("aria-pressed", "false");
    expect(sky).toHaveAttribute("aria-pressed", "false");
    expect(stored()).toMatchObject({ sound: false, dayNight: false });

    // a fresh read from storage, as after a reload
    act(() => reloadGamePrefs());
    expect(screen.getByRole("button", { name: "Game sounds" })).toHaveAttribute("aria-pressed", "false");
  });

  it("saves sounds, volume and moving trucks from Settings, in this browser only", async () => {
    const patched: string[] = [];
    stubApi((url, init) => {
      if ((init.method ?? "GET") !== "GET") patched.push(url);
      if (path(url) === "/v1/warehouses/BAL-WH01") return json(200, { code: "BAL-WH01", settings: {} });
      return null;
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const feel = await screen.findByRole("region", { name: "Game feel" });
    await user.click(within(feel).getByRole("switch", { name: /Moving trucks and forklifts/ }));
    fireEvent.change(within(feel).getByRole("slider"), { target: { value: "25" } });
    await user.click(within(feel).getByRole("switch", { name: /Sounds/ }));
    expect(stored()).toEqual({ sound: false, volume: 25, dayNight: true, motion: false });
    expect(within(feel).getByRole("switch", { name: /Moving trucks and forklifts/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Game sounds" })).toHaveAttribute("aria-pressed", "false");
    expect(within(feel).getByText(/the WMS has no weather feed/)).toBeInTheDocument();
    expect(patched).toEqual([]);
  });

  it("stops the forklifts moving when motion is off", async () => {
    window.localStorage.setItem(GAME_PREFS_KEY, JSON.stringify({ motion: false }));
    reloadGamePrefs();
    stubApi();
    renderApp("/menu");
    await screen.findByRole("region", { name: "All panels" });
    const forklifts = document.querySelectorAll("[data-layer='forklift']");
    expect(forklifts).toHaveLength(2);
    forklifts.forEach((f) => expect(f.getAttribute("class")).toBeNull());
  });
});

describe("Top bar search", () => {
  it("opens a delivery when the reference is one", async () => {
    stubApi((url) => (url === "/v1/deliveries/SO-2047" ? json(200, deliveryRecord("SO-2047")) : null));
    const user = userEvent.setup();
    renderApp("/menu");
    await user.type(await screen.findByRole("searchbox", { name: "Find a product or order" }), "SO-2047{Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deliveries/SO-2047"));
    expect(await screen.findByRole("region", { name: "Delivery" })).toBeInTheDocument();
    expect((await screen.findAllByText(/Ridgeline Hardware/)).length).toBeGreaterThan(0);
  });

  it("looks anything else up as stock", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/menu");
    await user.type(await screen.findByRole("searchbox", { name: "Find a product or order" }), "ABC123{Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/stock?sku=ABC123"));
    expect(await screen.findByRole("region", { name: "Stock" })).toBeInTheDocument();
  });
});

describe("Escape in the drawer", () => {
  it("goes up one level: a delivery back to deliveries, then to the map", async () => {
    stubApi((url) => (url === "/v1/deliveries/SO-2047" ? json(200, deliveryRecord("SO-2047")) : null));
    renderApp("/deliveries/SO-2047");
    expect((await screen.findAllByText(/Ridgeline Hardware/)).length).toBeGreaterThan(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/deliveries$/);
    expect(await screen.findByRole("region", { name: "Deliveries (orders)" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("goes from the batch builder back to deliveries", async () => {
    stubApi();
    renderApp("/deliveries/batches");
    expect(await screen.findByRole("region", { name: "Batch pick" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/deliveries$/);
  });

  it("leaves a field alone, even an empty one, so nothing half typed is lost", async () => {
    stubApi();
    renderApp("/menu");
    await screen.findByRole("region", { name: "All panels" });
    const box = screen.getByRole("searchbox", { name: "Find a product or order" });
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent("/menu");
  });

  it("leaves anything inside a form alone", async () => {
    stubApi();
    renderApp("/menu");
    await screen.findByRole("region", { name: "All panels" });
    const form = document.createElement("form");
    const button = document.createElement("button");
    form.appendChild(button);
    screen.getByRole("navigation", { name: "All panels" }).appendChild(form);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent("/menu");
    form.remove();
  });

  it("leaves a dialog in the page to close itself", async () => {
    stubApi();
    renderApp("/menu");
    await screen.findByRole("region", { name: "All panels" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent("/menu");
    dialog.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("the X always goes all the way to the map", async () => {
    stubApi((url) => (url === "/v1/deliveries/SO-2047" ? json(200, deliveryRecord("SO-2047")) : null));
    const user = userEvent.setup();
    renderApp("/deliveries/SO-2047");
    expect((await screen.findAllByText(/Ridgeline Hardware/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("link", { name: "Back to the map" }));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });
});

describe("Focus and the drawer", () => {
  it("moves focus into the drawer when it opens, and back to the opener when it closes", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/");
    const dock = await screen.findByRole("navigation", { name: "Shortcuts" });
    await user.click(within(dock).getByRole("link", { name: "All panels" }));
    const close = await screen.findByRole("link", { name: "Back to the map" });
    expect(close).toHaveFocus();
    expect(screen.getByRole("region", { name: "All panels" })).toContainElement(close);

    await user.click(close);
    const again = await screen.findByRole("navigation", { name: "Shortcuts" });
    expect(within(again).getByRole("link", { name: "All panels" })).toHaveFocus();
  });

  it("returns focus to a zone counter closed with Escape", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: /Leaving/ }));
    expect(await screen.findByRole("link", { name: "Back to the map" })).toHaveFocus();
    await screen.findByRole("region", { name: "Deliveries (orders)" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(await screen.findByRole("button", { name: /Leaving/ })).toHaveFocus();
  });

  it("falls back to the map's heading when nothing on the map opened the drawer", async () => {
    stubApi();
    const user = userEvent.setup();
    renderApp("/menu");
    await user.click(await screen.findByRole("link", { name: "Back to the map" }));
    expect(await screen.findByRole("heading", { name: "Warehouse map" })).toHaveFocus();
  });
});
