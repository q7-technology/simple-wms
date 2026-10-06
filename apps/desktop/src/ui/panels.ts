/** Every panel the desktop has, in the groups the All panels menu shows.
 * The drawer's title comes from here too, so the two never disagree. */

export type PanelZone = "leaving" | "arriving" | "stored" | "setup";

export interface PanelLink {
  to: string;
  label: string;
  blurb: string;
  later?: boolean;
}

export interface PanelGroup {
  title: string;
  zone: PanelZone;
  items: PanelLink[];
}

export const PANEL_GROUPS: PanelGroup[] = [
  {
    title: "Going out",
    zone: "leaving",
    items: [
      { to: "/deliveries", label: "Deliveries (orders)", blurb: "Every delivery waiting to go" },
      { to: "/deliveries/batches", label: "Batch pick", blurb: "One walk for many orders" },
      { to: "/tasks", label: "Task board", blurb: "Who is doing what right now" },
    ],
  },
  {
    title: "Coming in",
    zone: "arriving",
    items: [
      { to: "/receiving", label: "Receiving", blurb: "Trucks and pallets arriving" },
      { to: "/production", label: "Production", blurb: "Parts to the line, pallets back" },
      { to: "/transfers", label: "Transfers", blurb: "Stock moving between sites" },
    ],
  },
  {
    title: "In the warehouse",
    zone: "stored",
    items: [
      { to: "/stock", label: "Stock", blurb: "Where is it, what is here" },
      { to: "/products", label: "Products", blurb: "Everything you keep" },
      { to: "/replenishment", label: "Replenishment and counts", blurb: "Refill shelves, count stock" },
      { to: "/locations", label: "Locations", blurb: "Every shelf and its rules" },
      { to: "/containers", label: "Containers", blurb: "Pallets, cartons and totes", later: true },
    ],
  },
  {
    title: "Scores and setup",
    zone: "setup",
    items: [
      { to: "/reports", label: "Reports", blurb: "Your scoreboard" },
      { to: "/users", label: "Users", blurb: "People, scanners, history" },
      { to: "/integrations", label: "Integrations", blurb: "Messages to other systems" },
      { to: "/printing", label: "Printing", blurb: "Labels and printers" },
      { to: "/import", label: "Import and export", blurb: "Bring in a CSV file" },
      { to: "/owners", label: "Owners", blurb: "Stock for other businesses", later: true },
      { to: "/settings", label: "Settings", blurb: "Warehouse switches and game feel" },
    ],
  },
];

/** The drawer's name for a path: the longest panel path that starts it. */
export function panelTitle(pathname: string): string {
  if (pathname === "/menu") return "All panels";
  let best: PanelLink | null = null;
  for (const g of PANEL_GROUPS) {
    for (const p of g.items) {
      if (pathname === p.to || pathname.startsWith(p.to + "/")) {
        if (!best || p.to.length > best.to.length) best = p;
      }
    }
  }
  if (best?.to === "/deliveries" && pathname !== "/deliveries") return "Delivery";
  return best?.label ?? "Panel";
}
