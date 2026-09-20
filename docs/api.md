# Simple WMS — API

Base path `/v1`. JSON in, JSON out. Every inbound body shares the same
envelope fields; every outbound event shares one envelope. Quantities are
decimals and always carry a unit of measure.

## Shared rules

- **Inbound envelope:** `message_id` (uuid, required), `external_ref`,
  `warehouse`, `owner` (default `DEFAULT`).
- **Idempotent:** the same `message_id` twice returns the same reply and does
  nothing extra. Duplicates are remembered for 24 hours (configurable).
- **Reply:** `202 Accepted` with `{ "message_id", "wms_id", "status" }`.
  Validation problems are `422` with a list of field errors.
- **Auth:** `Authorization: Bearer <api key>` for systems, session token for
  the apps. Keys are scoped to actions, warehouses and an owner.
- **Cross-warehouse:** `/moves` rejects a move between warehouses and points
  to `/transfers`.

## Inbound

### POST /v1/deliveries — pick order
```json
{
  "message_id": "uuid",
  "external_ref": "0080012345",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "pick_mode": "single",
  "priority": "normal",
  "required_by": "2026-09-22",
  "ship_to": {
    "name": "Acme Auto Parts",
    "address": "12 Example St",
    "suburb": "Geelong", "state": "VIC",
    "postcode": "3220", "country": "AU"
  },
  "carrier_hint": null,
  "allow_short": true,
  "lines": [{
    "delivery_line": 10,
    "sku": "ABC123",
    "batch": null,
    "qty": 10,
    "uom": "EA"
  }]
}
```
- `pick_mode`: `single`, `batch` or `auto` (WMS decides by order size/zone).
  Batch picking arrives with build step 5; until then every mode picks singly.
- `batch: null` = WMS picks by FIFO. Set it to force a batch.
- Stock is reserved immediately; the reply says what could not be allocated:
```json
{ "message_id": "uuid", "wms_id": "41", "status": "accepted",
  "allocation": [{ "delivery_line": 10, "sku": "ABC123", "qty_ordered": "10",
                   "qty_allocated": "4", "uom": "EA", "short": "6" }] }
```
- A reservation holds stock at one shelf, so nothing is promised twice:
  `GET /v1/stock` keeps the same `on_hand` and drops `available`.
- One `pick` task is raised, in walk order by pick sequence, with a line per
  shelf the stock was reserved at. Picking moves the stock to the warehouse's
  staging area; it leaves the building at ship. A warehouse with no staging
  zone is a `422` naming what to add.
- Statuses: `new`, `allocated` (stock held, pick task waiting), `picking`
  (the first line is off the shelf), `picked`, `packing` (a carton is closed
  but not the last), `packed`, `shipped`, `cancelled`.
- `GET /v1/deliveries?warehouse=&status=` lists (soonest required first, then
  priority); `GET /v1/deliveries/{ref}` returns the delivery with its lines,
  packages, both tasks and the events sent.
- `POST /v1/deliveries/{ref}/ship` — `{ message_id, carrier, tracking_no,
  shipped_by }`. Writes one ledger line per carton line out of staging.
  Refused `409 short_not_allowed` when the order is short and
  `allow_short` is false.
- `POST /v1/deliveries/{ref}/cancel` — `{ message_id, reason }`. Cancels the
  open tasks and gives every reservation back. Anything already picked to the
  bench raises a high-priority put-away task, so no stock is stranded there.
  A shipped delivery cannot be cancelled. Cancel, never delete.
- Events: `delivery.allocated`, `delivery.picked`, `delivery.packed`,
  `delivery.shipped`, `delivery.cancelled`.

### POST /v1/receipts — expected inbound receipt
```json
{
  "message_id": "uuid",
  "external_ref": "PO-88815",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "supplier": "Supplier Co",
  "expected_at": "2026-09-22",
  "lines": [{
    "line": 1, "sku": "ABC123", "batch": null, "qty": 120, "uom": "EA"
  }]
}
```
Creates the receipt and one `receive` task with a line per receipt line.
`batch` may be left null on a batch-tracked product; the scanner reads it
off the label and the API refuses a different batch from the one given.
`GET /v1/receipts?warehouse=&status=` lists (statuses `expected`,
`arrived`, `receiving`, `complete`, `closed_short`, `cancelled`);
`GET /v1/receipts/{ref}` returns the receipt with its lines, the task, every
put-away ledger line and the events sent. `POST /v1/receipts/{ref}/arrived`
with `{ message_id, dock, carrier }` marks the truck at the dock.
Events: `receipt.confirmed` (per put-away), `receipt.closed`.

### POST /v1/production-orders
```json
{
  "message_id": "uuid",
  "external_ref": "PRD-1000456",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "required_by": "2026-09-22T06:00:00Z",
  "output": { "sku": "FG-900", "batch": "B2609A", "qty": 500, "uom": "EA" },
  "components": [{
    "line": 1,
    "sku": "RM-120",
    "batch": null,
    "qty": 1000,
    "uom": "EA",
    "deliver_to": "LINE-03-IN"
  }]
}
```
- Reserves components and creates pick tasks; last step is "drop at
  `deliver_to`". Short issue allowed; remainder stays open.
- `output.batch` is optional. If present it must match the batch read from
  the production order's QR at receipt time.
- Events: `production.components_issued`, `production.received`.

### POST /v1/production-orders/{ref}/receipts — finished goods, one call per pallet
```json
{
  "message_id": "uuid",
  "warehouse": "BAL-WH01",
  "sku": "FG-900",
  "batch": "B2609A",
  "qty": 120,
  "uom": "EA",
  "to_location": "BK-04-01-C",
  "container_id": null,
  "operator": "op-017",
  "device_id": "SCN-BAL-07"
}
```
Running total against `output.qty`; over-receipt beyond tolerance needs a
supervisor. If the warehouse setting "ERP counted GR" is on, no event fires.

### POST /v1/replenishments
```json
{
  "message_id": "uuid",
  "external_ref": "REP-1001",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "priority": "normal",
  "lines": [{
    "line": 1,
    "sku": "ABC123",
    "qty": 48,
    "uom": "EA",
    "to_location": "PF-01-02-A",
    "from_location": null,
    "batch": null
  }]
}
```
`from_location: null` = FIFO source: the oldest received stock of that
product in the warehouse, chosen when the task is created. The WMS uses this
same body for replenishments it raises itself from min/max (`source`:
`api`, `min_max` or `manual`). Creates one `replenish` task; each line is
confirmed on the scanner as a move. Event: `replenishment.completed`.

### POST /v1/moves — within one warehouse
```json
{
  "message_id": "uuid",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "sku": "ABC123",
  "batch": null,
  "qty": 12,
  "uom": "EA",
  "from_location": "BK-04-01-C",
  "to_location": "PF-01-02-A",
  "container_id": null,
  "reason": "tidy",
  "operator": "op-017"
}
```
Done on the spot: one `move` task, already complete, with two ledger lines
(out of `from_location`, into `to_location`). The received date travels
with the stock. Refused with a field error if the quantity is not available
or the destination allows one product or one batch only. Event: `stock.moved`.

### POST /v1/counts — blind cycle count
```json
{
  "message_id": "uuid",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "locations": ["PF-01-02-A", "PF-01-03-B"],
  "zone": null,
  "sku": null,
  "priority": "normal"
}
```
Give `locations`, or a `zone` for every active shelf in it, and optionally a
`sku` to count only that product. One `count` task with a line per product
and batch recorded on those shelves. The expected quantity is hidden from a
line until it is counted. A count that matches verifies the shelf and writes
nothing. A variance parks the line and the task in `needs_supervisor`; a
supervisor approves it with a reason (`stock.adjusted`, one adjustment
ledger line) or asks for a recount. The short-pick flow raises the same task.

### POST /v1/transfers — between warehouses
```json
{
  "message_id": "uuid",
  "external_ref": "STO-4500012",
  "owner": "DEFAULT",
  "from_warehouse": "BAL-WH01",
  "to_warehouse": "MEL-WH01",
  "required_by": "2026-09-25",
  "priority": "normal",
  "lines": [{
    "line": 1, "sku": "ABC123", "batch": null, "qty": 120, "uom": "EA"
  }]
}
```
Pick and pack at the sender → ship (stock → in-transit bucket) → expected
receipt auto-created at the receiver → receive (stock → shelves). Batch and
received date travel with the stock. A variance stays in transit until closed
with a reason (`stock.adjusted`). Events: `transfer.shipped`,
`transfer.received`.

### POST /v1/deliveries/{ref}/pack
```json
{
  "message_id": "uuid",
  "warehouse": "BAL-WH01",
  "packed_by": "op-017",
  "complete": true,
  "packages": [{
    "package_no": 1,
    "type": "carton",
    "container_id": null,
    "weight_kg": 8.4,
    "length_cm": 40, "width_cm": 30, "height_cm": 25,
    "lines": [{
      "delivery_line": 10, "sku": "ABC123", "batch": null, "qty": 6, "uom": "EA"
    }]
  }]
}
```
Event: `delivery.packed`. Fires the `carton-label` print point (step 4).
Call it once per bench load; `complete: true` closes the packing. A carton
line cannot hold more than was picked for that delivery line.

### GET /v1/stock?sku=ABC123&warehouse=BAL-WH01 — where is it?
```json
{
  "sku": "ABC123",
  "uom": "EA",
  "total_on_hand": "168",
  "total_available": "158",
  "locations": [{
    "warehouse": "BAL-WH01",
    "location": "PF-01-02-A",
    "zone": "PICKFACE",
    "batch": null,
    "owner": "DEFAULT",
    "on_hand": "48",
    "reserved": "10",
    "available": "38",
    "received_at": "2026-08-30"
  }]
}
```
Omit `warehouse` to search every site. Locations come back oldest receipt
first (FIFO order). Quantities are decimal strings so nothing rounds them.
`GET /v1/locations/{id}/stock` is the reverse: what is on a shelf. Filters:
`batch`, `owner`.

### POST /v1/locations/suggest — where should it go?
```json
{ "warehouse": "BAL-WH01", "sku": "ABC123", "batch": null, "qty": 120, "uom": "EA", "purpose": "putaway" }
```
```json
{ "suggestions": [
  { "location": "BK-04-01-C", "zone": "BULK", "reason": "same_sku_has_space" },
  { "location": "BK-04-02-A", "zone": "PICKFACE", "reason": "empty_in_preferred_zone" }
], "flag": null }
```
Rules in order: same product with space → empty shelf in the product's
preferred zone → any allowed empty shelf → an overflow location, with
`flag: "overflow"` so someone finds it a home. Shelf mixing rules and a
capacity in the same unit are respected. The operator may override; the
ledger records where it really went.

### POST /v1/scans/parse
```json
{ "raw": "]Q3010931234500001210B2609A\u001d37120", "expecting": "product" }
```
```json
{
  "format": "gs1",
  "type": "product",
  "fields": { "gtin": "09312345000012", "batch": "B2609A", "qty": 120 },
  "resolved": { "sku": "FG-900" }
}
```
Formats tried in order: GS1 (with or without a symbology prefix such as
`]Q3` or `]C1`, and Digital Link URLs) → JSON in QR → plain text lookup.
Plain text is matched as a location code or barcode (in `warehouse` if
given), then a SKU, a product barcode (carton barcodes carry their
`qty`), an operator badge, a receipt reference, then a task (`T-123`).
`type` is one of `product`, `location`, `container`, `production_order`,
`operator`, `receipt`, `task` or `unknown`. With `expecting` set, the reply
adds `matches_expected` and a friendly `message` such as "That is a
location. This step wants a product." Unknown scans are written to the
audit log with their raw text. A production-order QR resolves to
`{ "type": "production_order", "fields": { "po", "sku", "batch", "qty" } }`.
Custom per-site patterns come later.

## Tasks

Everything is a task: receive, put away, pick, pack, ship, move, count,
replenish, transfer, production issue and receipt. Documents create tasks;
the scanner works them; confirming a line writes the ledger. Every action
body carries the envelope so a scanner can retry it after a Wi-Fi drop and
get the same reply.

### GET /v1/tasks?warehouse=BAL-WH01&status=waiting,in_progress&type=receive
Filters `status` and `type` (comma separated), `assigned_to`, `source_ref`,
`owner`, `limit`, `offset`. `GET /v1/tasks/{id}` returns one.
```json
{
  "wms_id": "4411",
  "type": "receive",
  "title": "Receive PO-88815",
  "status": "in_progress",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "priority": "normal",
  "source_type": "receipt",
  "source_ref": "PO-88815",
  "assigned_to": "op-017",
  "device": "SCN-BAL-07",
  "needs_supervisor": false,
  "progress": { "done": 1, "total": 5 },
  "lines": [{
    "line_no": 1, "source_line": 1, "sku": "ABC123", "name": "Brake pad set",
    "batch": null, "expected_qty": "120", "actual_qty": "120", "variance": null,
    "uom": "EA", "from_location": null, "to_location": "BK-04-01-C",
    "container_id": null, "status": "done", "reason": null, "completed_at": "2026-09-19T22:22:00Z"
  }]
}
```
Task statuses: `waiting`, `in_progress`, `needs_supervisor`, `done`,
`cancelled`. Line statuses: `open`, `done`, `short`, `variance`, `cancelled`.

### Actions
All reply `202` with `{ message_id, wms_id, status, task, line }`.
- `POST /v1/tasks/{id}/start` — `{ message_id, operator, device }`. Assigns
  the task to the operator and starts the clock.
- `POST /v1/tasks/{id}/assign` — `{ message_id, assigned_to }` (desktop).
- `POST /v1/tasks/{id}/cancel` — `{ message_id, reason }`. Cancel, never delete.
- `POST /v1/tasks/{id}/close` — `{ message_id, reason }`. Close short: open
  lines become `short`; a receipt becomes `closed_short` and `receipt.closed`
  says so.
- `POST /v1/tasks/{id}/lines/{line_no}/confirm`
  ```json
  { "message_id": "uuid", "qty": 120, "uom": "EA", "batch": "B2611",
    "location": "BK-05-01-A", "from_location": null, "container_id": null,
    "reason": null, "note": null, "operator": "op-017", "device": "SCN-BAL-07",
    "supervisor_badge": null }
  ```
  What it does depends on the task type. `receive`: `qty` goes on to
  `location`; the line closes when the expected quantity is reached, and a
  quantity over the warehouse's receipt tolerance is `409` with
  `code: "needs_supervisor"` until a `supervisor_badge` is scanned.
  `move` and `replenish`: `qty` goes from `from_location` (or the line's) to
  `location` (or the line's). `pick`: `qty` comes off the line's shelf and
  goes to staging; more than the line wants is a `422`. `count`: `qty` is
  what was counted; a match
  closes the line, a difference parks it as `variance` (a supervisor badge
  plus `reason` adjusts on the spot).
- `POST /v1/tasks/{id}/lines/{line_no}/short` — a pick line that cannot be
  filled:
  ```json
  { "message_id": "uuid", "qty": 6, "reason": "not_found",
    "operator": "op-017", "device": "SCN-BAL-07", "supervisor_badge": "0042" }
  ```
  Takes `qty` off the shelf, closes the line short and gives the rest of the
  reservation back. Always needs a supervisor badge (`409 needs_supervisor`
  without one). Reasons: `not_found`, `short_on_shelf`, `damaged`,
  `location_unreadable`, `customer_cancelled`. The first three raise a
  high-priority count task for that shelf, because the shelf and the system
  disagree. An unreadable location barcode removes the line and raises no
  count.
- `POST /v1/tasks/{id}/lines/{line_no}/approve` — `{ message_id, reason,
  note, supervisor_badge }`. Accepts a counted quantity: one adjustment
  ledger line and `stock.adjusted`. Needs a supervisor badge or a role with
  `tasks:approve`.
- `POST /v1/tasks/{id}/lines/{line_no}/recount` — `{ message_id }`. Back to open.

Errors: `409` with a `code` (`needs_supervisor`, `task_not_open`,
`line_finished`, `no_variance`) when the state does not allow it; `422`
with field errors when the body is wrong (unknown shelf, not enough stock,
mixing rule, batch mismatch).

### POST /v1/imports/{type} — CSV with preview
`type` is `products`, `locations` or `receipts`. Templates:
`GET /v1/imports/templates/{type}`.
```json
{ "message_id": "uuid", "warehouse": "BAL-WH01", "owner": "DEFAULT",
  "csv": "sku,name,uom,...\nABC123,Brake pad set,EA,...", "dry_run": true, "skip_problems": true }
```
```json
{ "rows_read": 312, "ready": 309, "problems": 3, "committed": false, "imported": 0,
  "summary": "as 41 receipts",
  "preview": [{ "row": 18, "problem": "sku: unknown sku ABC12", "data": { "sku": "ABC12", "...": "..." } }] }
```
Problems come first in the preview. A dry run commits nothing. With
`skip_problems: false` a run with problems is `422` and nothing is written.
Receipts group rows by `reference`; a receipt with any bad line is skipped
whole. Products and locations create or update, like their endpoints.

### Master data

All four create or update by code (`status` in the reply says which). Fields
left out of an update keep their value. Only a key with the `master:write`
scope may call them; `master:read` for the GET side.

#### POST /v1/sites
```json
{ "message_id": "uuid", "code": "BAL", "name": "Ballarat", "timezone": "Australia/Melbourne" }
```

#### POST /v1/warehouses
```json
{ "message_id": "uuid", "code": "BAL-WH01", "site": "BAL", "name": "Ballarat 1",
  "settings": { "erp_counts_gr": false, "allow_ship_short": true, "blind_counts": true,
                "receipt_tolerance_pct": 5, "idle_logout_minutes": 15 } }
```

#### POST /v1/zones
```json
{ "message_id": "uuid", "warehouse": "BAL-WH01", "code": "PICKFACE", "name": "Pick face", "kind": "pickface" }
```
`kind`: `bulk`, `pickface`, `packing`, `staging`, `in_transit`, `overflow`,
`line_side`. Picked stock waits in a `packing` zone (a `staging` zone if
there is none), and neither is offered for put-away or reservation.

#### POST /v1/locations
```json
{
  "message_id": "uuid",
  "warehouse": "BAL-WH01",
  "code": "BK-04-01-C",
  "zone": "BULK",
  "type": "shelf",
  "access": "ground",
  "mixing": "mixed",
  "capacity": 2, "capacity_uom": "PALLET",
  "pick_sequence": 410,
  "barcode": "LOC-BK-04-01-C",
  "active": true
}
```
`type`: `shelf`, `floor`, `rack`, `dock`, `line_side`, `in_transit`.
`access`: `ground`, `step`, `forklift`. `mixing`: `mixed`, `single_sku`,
`single_batch`. `GET /v1/locations?warehouse=BAL-WH01` lists them in pick
sequence; filters `zone`, `active`, `limit`, `offset`.

#### POST /v1/products
```json
{
  "message_id": "uuid",
  "owner": "DEFAULT",
  "sku": "ABC123",
  "name": "Widget",
  "uom": "EA",
  "decimals_allowed": false,
  "batch_tracked": false,
  "preferred_zone": "PICKFACE",
  "pickface_min": 24, "pickface_max": 96,
  "barcodes": [
    { "barcode": "09312345000012", "kind": "gtin" },
    { "barcode": "19312345000019", "kind": "carton", "qty_per": 12 }
  ],
  "active": true
}
```
`barcodes`, when present, replaces the whole set. A barcode belongs to one
product. `GET /v1/products?q=widg` lists; `GET /v1/products/{sku}` fetches one.
Products are unique per owner and sku.

### GET /v1/locations/{id}/stock — what is here?
`{id}` is the WMS id or the location code (add `warehouse=` if the code is
used in more than one warehouse). Filters: `batch`, `owner`.
```json
{
  "wms_id": "17",
  "warehouse": "BAL-WH01",
  "location": "BK-04-01-C",
  "zone": "BULK",
  "stock": [{
    "sku": "ABC123", "name": "Widget", "batch": null, "owner": "DEFAULT",
    "on_hand": "120", "reserved": "0", "available": "120", "uom": "EA",
    "received_at": "2026-08-30"
  }]
}
```
Quantities are returned as decimal strings so nothing rounds them.

### GET /v1/stock/ledger — the movements behind a balance
Newest first. Filters: `sku`, `location`, `warehouse`, `batch`, `owner`,
`movement_type`, `limit`, `offset`. Each row is one signed change at one
location, so a move is two rows.
```json
{ "items": [{
  "wms_id": "889201", "at": "2026-09-19T04:12:00Z",
  "movement_type": "adjustment", "reason": "count_variance",
  "warehouse": "BAL-WH01", "location": "PF-01-02-A", "zone": "PICKFACE",
  "sku": "ABC123", "batch": null, "owner": "DEFAULT",
  "qty_change": "-2", "uom": "EA", "received_at": "2026-08-30",
  "actor": "op-017", "device": "SCN-BAL-07", "task_id": "4411",
  "external_ref": null, "container_id": null, "note": null
}], "total": 1 }
```

### Also
- `GET /v1/health` — `{ "status": "ok" }` once the database answers.
- `POST /v1/imports/{type}` — CSV upload with preview (`dry_run: true`).
- `POST /v1/auth/scanner-login` — `{ device_id, warehouse, operator_id, pin }`
  or `{ device_id, warehouse, badge }` → `{ token, expires_in, operator:
  { code, name, roles, supervisor }, warehouses, device, idle_logout_minutes }`.
  The device must be registered (`403` otherwise, when "known devices only"
  is on). A wrong PIN is `401` with `code: "wrong_pin"` and `tries_left`;
  after the warehouse's lockout count it is `code: "locked"` until
  `POST /v1/auth/scanner-unlock` `{ device_id, warehouse, operator_id,
  supervisor_badge, new_pin }` or the desktop unlocks it. Every try is in
  the audit log. Operator tokens last a shift (12 h); the idle logout is
  the scanner's job. `POST /v1/auth/supervisor-check` `{ badge, warehouse }`
  says whether a badge is a supervisor here.

## Desktop sign in and admin

These are called by a signed-in person, not by another system, so they are
plain REST (201 on create, 200 otherwise) and do not carry the message
envelope. Everything they change is written to the audit log.

### POST /v1/auth/login
```json
{ "username": "leighton", "password": "..." }
```
```json
{ "token": "wms_s....", "expires_in": 900, "refresh_token": "wms_r....",
  "user": { "wms_id": "1", "username": "leighton", "display_name": "Leighton L.",
            "role": "admin", "warehouses": ["*"] } }
```
The token goes in `Authorization: Bearer` like an API key and lasts 15
minutes. `POST /v1/auth/refresh` with `{ "refresh_token" }` returns a new pair
and spends the old refresh token (14 day life, rotates on every use).
`POST /v1/auth/logout` with the refresh token ends the session. `GET
/v1/auth/me` returns the caller and their scopes. A wrong password is `401`
and an audit row; so is a deactivated user.

Roles and what they may do: `admin` everything; `supervisor` master data,
stock, tasks, read integrations and users; `inventory_controller` master
data, stock, tasks; `receiver` and `picker` read master data and stock, work
tasks.

### Warehouse settings
`GET /v1/warehouses/{code}` returns the warehouse with every switch filled in
from defaults. `PATCH /v1/warehouses/{code}/settings` merges the keys sent:
```json
{ "erp_counts_gr": true, "receipt_tolerance_pct": 10, "idle_logout_minutes": 15 }
```
Keys: `erp_counts_gr`, `batch_from_production_order`, `receipt_tolerance_pct`,
`supplier_tolerance_pct`, `allow_ship_short`, `supervisor_for_short_pick`,
`auto_pick_mode` (`single`/`batch`/`auto`), `batch_pick_max_orders`,
`idle_logout_minutes`, `pin_lockout_tries`, `known_devices_only`,
`queue_offline_confirmations`, `fifo_by_received_date`, `blind_counts`,
`decimals_allowed`, `platen_url`, `retry_failed_print_jobs`, `default_copies`,
`ledger_retention_years`, `duplicate_window_hours`, `allow_hard_deletes`
(always false; `422` if you try).

### API clients (keys)
- `POST /v1/api-clients` — `{ name, scopes, warehouses, owner, ip_allowlist }`
  → `201` with the key in `key`, shown this once. Hash stored.
- `GET /v1/api-clients` — each with `key_prefix`, `last_used_at`,
  `duplicates_24h` and `last_duplicate_at` (repeated message ids seen).
- `POST /v1/api-clients/{id}/rotate` — new key returned once; old one dead.
- `POST /v1/api-clients/{id}/revoke` — deactivates. Never deleted.
Needs the `integration:admin` scope (`integration:read` to list).

### Subscribers
- `POST /v1/subscribers` — `{ name, url, secret?, event_types, warehouses,
  owner, active }`. Creates or updates by name. `event_types` takes exact
  names, `transfer.*` or `*`. On create the HMAC `secret` is generated if not
  given and returned once (`201`); on update it is never returned (`200`).
- `GET /v1/subscribers` — with `status` (`idle`, `ok`, `retrying`, `failed`),
  `last_delivery_at`, `pending` and `failed` counts.

### Event queue
- `GET /v1/events` — newest first. Filters `status`, `subscriber`,
  `event_type`, `external_ref`, `limit`, `offset`. Each row: `event_id`,
  `event_type`, `subscriber`, `attempts`, `next_attempt_at`, `status`,
  `last_error`, `delivered_at`, `external_ref`.
- `POST /v1/events/{id}/retry` — "retry now": back to pending, attempts reset.

### Users, operators and devices
- `POST /v1/users` — `{ username, display_name, email, role, warehouses,
  password }` (12 characters minimum). `GET /v1/users`. `PATCH /v1/users/{id}`.
  `POST /v1/users/{id}/deactivate`, `/reactivate`, `/password`. You cannot
  deactivate yourself.
- `POST /v1/operators` — `{ code, name, pin, badge, roles, warehouses }`;
  roles from `picker`, `packer`, `receiver`, `counter`, `supervisor`. `GET`,
  `PATCH /{id}`, `POST /{id}/reset-pin` `{ pin }`, `/unlock`, `/deactivate`,
  `/reactivate`. PINs are hashed; never returned.
- `POST /v1/devices` — `{ code, name, warehouse }` registers a scanner (or
  updates by code). `GET /v1/devices`. `POST /v1/devices/{id}/deactivate`.
- `GET /v1/audit-log` — insert-only. Newest first. Filters `actor`, `action`
  (prefix), `limit`, `offset`.
Needs `access:admin` to change, `access:read` to list.

### Scopes
A key carries a list of scopes, `area:verb` or `area:*` or `*`:
`master:read`, `master:write`, `stock:read`, `stock:write`, `tasks:read`,
`tasks:write`, `integration:read`, `integration:admin`, `access:read`,
`access:admin`. It also carries the warehouse codes it may touch (or `*`)
and one owner (or `*`). A signed-in person gets scopes from their role and
warehouses from their account. A call outside any of those is `403`.
A missing or unknown key is `401`.

## Outbound events

One envelope. Subscribers choose event types and a URL; each subscriber has
its own HMAC secret. Events are queued per subscriber and retried with backoff
(1 min, 5 min, 30 min, 2 h) until the listener answers 2xx. Failures show on
the Integrations page with a "retry now" button.

```json
{
  "event_id": "uuid",
  "event_type": "delivery.shipped",
  "occurred_at": "2026-09-19T04:12:00Z",
  "warehouse": "BAL-WH01",
  "owner": "DEFAULT",
  "external_ref": "0080012345",
  "data": {}
}
```
Headers: `X-WMS-Signature: sha256=<hmac of body>`, `X-WMS-Event-Id`.

| Event | `data` carries | Typical listener |
|---|---|---|
| `receipt.confirmed` | sku, batch, qty, uom, location, receipt_ref | ERP |
| `stock.moved` | sku, batch, qty, from, to, reason | ERP |
| `stock.adjusted` | sku, batch, location, qty_change, uom, reason, ledger_id | ERP |
| `replenishment.completed` | replen_ref, lines with qty moved | ERP |
| `delivery.allocated` | delivery_ref, complete, lines: qty_ordered, qty_allocated | ERP |
| `delivery.picked` | delivery_ref, complete, lines: qty_picked, short_reason | ERP |
| `delivery.packed` | delivery_ref, packages: package_no, weight, dims, contents | Carriers, Platen |
| `delivery.shipped` | carrier, tracking_no, short, lines: qty_ordered/qty_shipped, packages | ERP, carriers, EDI |
| `delivery.cancelled` | delivery_ref, reason | ERP |
| `transfer.shipped` | transfer_ref, from/to warehouse, lines qty_requested/qty_shipped, packages | ERP |
| `transfer.received` | transfer_ref, complete, lines qty_shipped/qty_received/variance | ERP |
| `production.components_issued` | po_ref, lines qty_requested/qty_issued, deliver_to | ERP |
| `production.received` | po_ref, sku, batch, qty, location | ERP (unless ERP already counted GR) |

### `delivery.shipped` data
```json
{
  "delivery_ref": "0080012345",
  "carrier": "TBC",
  "tracking_no": null,
  "short": true,
  "lines": [{
    "delivery_line": 10, "sku": "ABC123", "batch": null,
    "qty_ordered": 10, "qty_shipped": 6, "uom": "EA"
  }],
  "packages": [{ "package_no": 1, "weight_kg": 8.4, "sscc": null }]
}
```

### `stock.adjusted` data
```json
{
  "sku": "ABC123", "batch": null, "location": "PF-01-02-A",
  "qty_change": -2, "uom": "EA", "reason": "count_variance", "ledger_id": "L-889201"
}
```

## Print jobs (to Platen)

Same queue as events. One job per print point firing.
```json
{
  "job_id": "uuid",
  "template": "carton-label",
  "version": "v3",
  "printer": "packing-bench-2",
  "copies": 1,
  "reference": { "type": "delivery", "ref": "0080012345", "package_no": 1 },
  "data": {
    "ship_to": { "name": "Acme Auto Parts", "address": "12 Example St", "suburb": "Geelong", "state": "VIC", "postcode": "3220" },
    "delivery_ref": "0080012345",
    "package_no": 1, "package_count": 2,
    "weight_kg": 8.4,
    "carrier": null, "tracking_no": null,
    "sscc": null,
    "lines": [{ "sku": "ABC123", "qty": 10, "uom": "EA" }]
  }
}
```
Platen replies `accepted`, then `printed` or `failed`; the WMS stores the
status against the task. Document types and their fixed data shapes:
`location-label`, `product-label`, `carton-label`, `pallet-label`,
`pick-list`, `packing-slip`, `transfer-docket`. Adding a field is a new
version; old versions keep working.
