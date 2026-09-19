# Simple WMS — screens

Designed in the Claude Design file "Simple WMS UI" and exported to
`design/screens/` (one HTML file per screen; `design/index.html` is the
gallery). Desktop is 1440 wide with a 64 px top bar, a main column and a 400 px
detail panel on the right. Scanner is 390 × 844 with 56 px touch targets and
a footer with one quiet button and one primary button.

Look: ground `#0d1117`, text `#ccd6f6`, secondary text `#8892b0`, brand blue
`#29abe2` (accent word in headings, primary buttons with dark text, borders at
20 % alpha), gold `#f7941d` for warnings, exceptions and secondary actions,
green `#4ade80` only for "delivered / verified" with a word beside it.
Cards: `rgba(13,17,23,0.6)` fill, 1 px blue-20 % border, 8 px radius.
System sans stack. Mono only for codes and JSON.

## Desktop (20)

| Screen | What it shows | Build step |
|---|---|---|
| Sign in | Password or SSO, 2FA note | 1 |
| Deliveries | Stat tiles, filter chips, table, detail panel with progress bar, lines, events sent | 3 |
| Delivery detail | Full page: ship-to, timing, lines with allocated/picked, packages, events, history | 3 |
| Batch pick builder | Tick waiting orders, see stops collapse, walk order, totes, assign | 5 |
| Task board | Waiting · In progress · Needs a supervisor · Done today | 2 |
| Receiving | Expected receipts, arrived, late; detail with lines and put-aways | 2 |
| Production orders | Components issued, receipts pallet by pallet, over-tolerance flag | 5 |
| Transfers | Picking, in transit, arrived, variance; close variance with reason | 5 |
| Stock lookup | Search, stat tiles, per-location table, ledger newest first | 1 |
| Replenishment and counts | Replen tasks, count variances to approve, min/max rules | 2 |
| Locations | Zones, pick sequence, allows, mixing, capacity; rules toggles; barcode | 1 |
| Products | Unit, batch switch, preferred zone, min/max, barcodes | 1 |
| Containers (later) | Pallets, cartons, totes, SSCC, nesting | 6 |
| Integrations and printing | Subscribers, print points, event queue with retry, API key detail | 1 |
| Print point detail | Event → template → printer, the exact JSON sent to Platen, recent jobs | 4 |
| Import and export | Upload, preview with problem rows first, template downloads | 2 |
| Reports | Shipped per day, movements by type, pick rate per operator, variance history | 6 |
| Settings | Per-warehouse toggles: ERP counts GR, ship short, blind counts, tolerances, idle logout | 1 |
| Owners (later) | 3PL switch: owners, rules, what each may send | 6 |
| Users, roles and devices | People, registered scanners, audit log; operator detail with roles and overrides | 1 |

## Scanner PWA (15)

| Screen | What it shows | Build step |
|---|---|---|
| Sign in | Badge scan or operator ID + PIN pad; known device line | 2 |
| Menu | Scan anything to start; my tasks; task tiles; queue and idle logout footer | 2 |
| Pick | Go to (big location), product + qty, scan hint, qty stepper, Short / Confirm | 3 |
| Short pick reason | Picked x of y, reason list, supervisor badge panel | 3 |
| Batch sort | Scan item → put in tote N; tote fill status | 5 |
| Pack | Picked progress, packages, item into carton, weight/dims, close carton | 3 |
| Production receipt | Order from QR, batch read-only, received so far bar, qty, suggested shelf | 5 |
| Receive | Line progress, product from GS1, qty, suggested shelf, scan to confirm | 2 |
| Move | From (scanned), product, qty, To, reason | 2 |
| Cycle count | Blind count, qty, "differs from expected" warning | 2 |
| Look up | Scan product or shelf; on hand / reserved / available; shelves oldest first | 1 |
| Receive transfer | Shipped vs received, short warning stays in transit, put away | 5 |
| Wrong scan | "That is a location" — what was read, what was expected | 2 |
| Offline | Wi-Fi dropped banner, queued confirmations, finish current task only | 2 |
| Locked out | Account locked after 5 wrong PINs; supervisor unlock | 2 |

## Patterns to reuse

- Every scanner task screen: header (back, eyebrow type, reference,
  operator·site), progress row, one or two big cards, dashed scan hint,
  qty stepper, two-button footer.
- Supervisor override is always a dashed panel with a lock icon: "Supervisor:
  scan your badge".
- Exceptions are gold, never red. Green never stands alone.
- The detail panel on the desktop always ends with two buttons: quiet on the
  left, gold or primary on the right.
