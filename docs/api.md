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
- `pick_mode`: `single`, `batch` or `auto` (the WMS decides by zone).
  `batch` and `auto` orders are offered to the batch builder below; a
  `single` order is never batched.
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
- Reserves the components and raises one `production_issue` task that walks
  the shelves and drops each line at its `deliver_to`, which must be a real
  location in that warehouse. The reply carries an `allocation` list.
- A short issue is allowed: close the task and the event reports what went.
  The shortfall shows on the order as `short` per component.
- Components sit at the line-side location until the line consumes them.
  The line is outside the WMS, so the WMS never guesses what was used; a
  count or an ERP adjustment squares it up. Stock in a `line_side` zone is
  on hand but never promised to an order.
- `output.batch` is optional. If it is set, a pallet coming back must carry
  that batch, which is what the production order's QR gives the scanner.
  Without it, a batch-tracked product still needs a batch scanned.
- `GET /v1/production-orders?warehouse=&status=` lists;
  `GET /v1/production-orders/{ref}` returns the order with its components,
  its pallets and the issue task. `POST /v1/production-orders/{ref}/cancel`
  gives the components back, and is refused once finished goods exist.
- Statuses: `new`, `issuing`, `in_production`, `complete`, `cancelled`.
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
One pallet per call. The reply carries `received_total`, `expected`,
`complete` and `event_sent`. The running total is kept against `output.qty`;
going over the warehouse's receipt tolerance is `409 needs_supervisor` until
a `supervisor_badge` is scanned. A wrong `sku` or `batch` is a `422`.

If the warehouse setting `erp_counts_gr` is on, the WMS assigns the bin and
writes the ledger line but sends no `production.received`, because the ERP
has already counted the stock. The reply says `event_sent: false`.

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

### POST /v1/counts — cycle count
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
and batch recorded on those shelves. The counter is shown what the system
thinks is on the shelf, so an obvious mistake is caught before it becomes a
variance. A site that wants a true blind count turns on `blind_counts` for
the warehouse, and then `expected_qty` is `null` on an open count line and
arrives only once the line has been counted. A count that matches verifies the shelf and writes
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
Pick at the sender → ship (stock → the in-transit bucket) → expected receipt
auto-created at the receiver → receive (stock → shelves). Batch and received
date travel with the stock, so FIFO survives the trip.

- The reply carries an `allocation` list like a delivery: line, sku,
  qty_requested, qty_allocated, uom, short.
- The **in-transit bucket is a real location** in an `in_transit` zone at the
  *receiving* warehouse, so the ledger always knows where the stock is. A
  receiver without one is a `422` on `to_warehouse` naming what to add; a
  sender without a packing or staging zone is a `422` on `from_warehouse`.
- Leg one is a `transfer_pick` task at the sender, picked to its bench like
  any other pick. Leg two is a `transfer_receive` task at the receiver, which
  puts the stock away out of the bucket onto a scanned shelf.
- `POST /v1/transfers/{ref}/ship` — `{ message_id, carrier, tracking_no,
  shipped_by }`. Writes `transfer_out` rows off the bench and into the
  bucket, raises the receiver's expected receipt and its put-away task, and
  fires `transfer.shipped`. Nothing picked is `409 nothing_picked`.
- `POST /v1/transfers/{ref}/close-variance` — `{ message_id, reason, note }`.
  Whatever never turned up stays in the bucket until this writes it off with
  a reason, one `stock.adjusted` per ledger line. `409 no_variance` when
  there is nothing left in transit.
- `POST /v1/transfers/{ref}/cancel` — before it ships only; a shipped
  transfer is `409 already_shipped`.
- `GET /v1/transfers?warehouse=&status=&direction=out|in` — both ends see a
  transfer; `direction` narrows it. `GET /v1/transfers/{ref}` returns it with
  both tasks.
- Statuses: `new`, `allocated`, `picking`, `picked`, `in_transit`,
  `receiving`, `received`, `variance` (something did not arrive), `closed`,
  `cancelled`.
- `POST /v1/transfers/{ref}/pack` — the same shape as a delivery's pack,
  with `line` instead of `delivery_line`. Packing a transfer is optional: it
  ships fine on a bare pallet and `transfer.shipped` then carries an empty
  `packages` list. A carton cannot hold more than was picked, and a transfer
  that has left cannot be packed.
- Stock in the bucket counts as on hand at the receiving warehouse and is
  never offered to a pick, because its zone is `in_transit`.

Events: `transfer.shipped`, `transfer.received`.

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
`available` means what could still be promised to an order: stock on a
packing bench, at the line or in an in-transit bucket is `on_hand` but
`available: "0"`, because it is already spoken for or not there yet.
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
`]Q3` or `]C1`, and Digital Link URLs) → JSON in QR → the site's own
patterns → plain text lookup.
Plain text is matched as a location code or barcode (in `warehouse` if
given), then a SKU, a product barcode (carton barcodes carry their
`qty`), an operator badge, a receipt reference, then a task (`T-123`).
`type` is one of `product`, `location`, `container`, `production_order`,
`operator`, `receipt`, `task` or `unknown`. With `expecting` set, the reply
adds `matches_expected` and a friendly `message` such as "That is a
location. This step wants a product." Unknown scans are written to the
audit log with their raw text. A production-order QR resolves to
`{ "type": "production_order", "fields": { "po", "sku", "batch", "qty" } }`.
A scan read by a site pattern says which one in `pattern` and sets
`format: "custom"`.

### Scan patterns — the labels only your site prints
A supplier's own carton label is nobody's standard. A pattern is a regular
expression with named parts, and the names say what the WMS found.

```json
{ "warehouse": "BAL-WH01", "name": "Supplier Co carton",
  "pattern": "^SUP(?P<sku>[A-Z0-9]+)-(?P<batch>[A-Z0-9]+)-(?P<qty>\\d+)$",
  "type": "product", "order": 100, "active": true }
```
- Names the WMS understands: `sku`, `gtin`, `batch`, `qty`, `uom`,
  `location`, `container_id`, `sscc`, `badge`, `operator`, `ref`, `po`,
  `serial`. A pattern naming anything else is a `422`, because it would find
  something nothing could use.
- `type` says what a match is: `product`, `location`, `container`,
  `operator`, `receipt`, `delivery`, `production_order` or `task`.
- `order` decides which is tried first, lowest first, so a tight pattern can
  sit ahead of a loose one. A null `warehouse` applies everywhere.
- `POST /v1/scan-patterns` creates or updates by warehouse and name, and
  compiles the pattern before saving it, so a broken one never reaches a
  scanner. `POST /v1/scan-patterns/try` — `{ pattern, raw }` → `{ matches,
  fields }` tries one before it is saved.
- `GET /v1/scan-patterns?warehouse=`, and
  `POST /v1/scan-patterns/{id}/deactivate`.
- `GET /v1/scan-patterns/unknown?warehouse=` lists the scans nothing could
  read, most seen first, with their raw text. This is what the raw text was
  kept for: it is where the next pattern comes from.

Writing a pattern needs `master:write`; reading and trying needs
`stock:read`.

## Reports

Nothing here keeps its own numbers. Every figure is read from `stock_ledger`
or from the balances that rebuild from it, so a report can never drift from
what actually happened.

`GET /v1/reports` lists them with their filters. Every report answers in one
shape, and `format=csv` downloads exactly the same thing:
```json
{ "report": "movements", "warehouse": "BAL-WH01", "owner": "DEFAULT",
  "from": "2026-09-01", "to": "2026-09-20",
  "describe": "Every movement by day and type: what came in, what went out.",
  "columns": ["day", "movement_type", "lines", "qty_in", "qty_out", "net"],
  "rows": [{ "day": "2026-09-20", "movement_type": "pick", "lines": 12,
             "qty_in": "48", "qty_out": "48", "net": "0" }],
  "totals": { "lines": 12, "qty_in": "48", "qty_out": "48" } }
```

| Report | Rows | Filters beyond warehouse and owner |
|---|---|---|
| `stock-on-hand` | sku, name, warehouse, zone, location, batch, on_hand, reserved, available, received_at | `zone`, `sku`, `group_by=location\|product` |
| `movements` | day, movement_type, lines, qty_in, qty_out, net | `from`, `to`, `sku`, `movement_type` |
| `pick-rate` | operator, lines, units, first_at, last_at, hours, lines_per_hour, units_per_hour | `from`, `to`, `operator` |
| `variances` | at, location, zone, sku, batch, qty_change, reason, actor, note, ledger_id | `from`, `to`, `sku`, `reason` |
| `shipped` | day, deliveries, lines, units, short, packages | `from`, `to` |
| `billing` | measure, detail, count, qty, uom | `from`, `to` |

`billing` is what a third-party warehouse invoices one owner for: the work
done in the window, then the space held right now. Handling rows count ledger
lines and the units they moved, in the direction that measure bills: receipts
count what arrived, picks and shipments what left, adjustments both. Cartons
shipped counts packages that went out on a delivery. The two storage rows are
read as at this moment rather than over the window, because a ledger says what
moved and never what sat still. Where an owner's stock is held in more than
one unit of measure the `uom` reads `mixed` instead of adding pallets to
eaches. A movement type the report has never heard of is billed under `Other
movements` rather than left off, so the invoice can never quietly under-count
what the warehouse did.

A day is the warehouse's day. Movements and shipments are grouped, and the
`from` and `to` window is read, on the clock of the warehouse's site, so half
past eight on a Thursday morning in Ballarat lands on Thursday and not on the
Wednesday that a UTC server would call it.

`group_by=product` on stock on hand rolls the locations up and adds
`locations` and `batches` counts. An operator with a single pick has no
measurable span, so `lines_per_hour` is `null` rather than a made-up number.
Reading a report needs `stock:read`.

## Owners

Whose stock it is. Every row in the system carries an `owner`, and a single
warehouse runs happily with just `DEFAULT`, which exists from the first
migration and cannot be switched off. A third-party warehouse adds more.

- `POST /v1/owners` — `{ code, name, contact, email, phone, settings, note,
  active }`. Codes are upper case, digits, dash and underscore. Creates or
  updates by code (`201` / `200`). Needs `access:admin`.
- `GET /v1/owners?active=`, `GET /v1/owners/{code}`.
- `POST /v1/owners/{code}/deactivate` and `/reactivate`. Deactivated, never
  deleted: their stock and their history stay exactly where they are.
- Every inbound body's `owner` is checked: unknown or inactive is a `422` on
  `owner`. Sites, warehouses, zones and locations belong to the company, not
  to an owner, so they do not carry one.
- Two owners keep their stock apart on the same shelf: the balance key is
  location, product, batch **and** owner, so `GET /v1/locations/{id}/stock`
  shows both lines and `GET /v1/stock?owner=` shows one of them.
- An API key carries one owner (or `*`). A **portal user** is a `User` with
  an `owner` other than `*`: they sign in to the desktop and see only that
  owner's products, stock, orders and tasks. Our own people keep `*`.
- Subscribers carry an owner too, so one owner's ERP hears only their own
  events.
- The per-warehouse `multi_owner` setting is off by default. The API always
  works with owners; the switch is what the screens read before showing the
  owner column.

## Containers

A container is a labelled physical thing: a pallet, a carton, a tote or a
cage. Stock is attributed to one when a movement names it, so a pallet knows
what is on it by asking the ledger, which is the only place that ever knew.

```json
{ "message_id": "uuid", "warehouse": "BAL-WH01", "owner": "DEFAULT",
  "container_id": "PAL-000123", "type": "pallet", "location": "BK-04-01-C",
  "parent": null, "assign_sscc": true, "weight_kg": 412.5 }
```
- `POST /v1/containers` creates or updates by `container_id`. Leave it out
  and the WMS gives one (`PAL-000123`, `CTN-000456`, `TOTE-000007`).
- `assign_sscc: true` mints an SSCC from the warehouse's
  `gs1_company_prefix` setting: extension digit, company prefix, serial and
  the GS1 mod-10 check digit, eighteen digits. Without a prefix it is a
  `422` naming what to set.
- `GET /v1/containers?warehouse=&type=&status=&location=&nested=false`.
  `nested=false` shows only the ones not inside something else.
  `GET /v1/containers/{ref}` takes the code or the SSCC and returns the
  container with `children` and `contents` (sku, batch, qty, uom) and
  `total_qty`.
- `POST /v1/containers/{ref}/nest` `{ parent }` puts a carton on a pallet; it
  takes the pallet's location and follows it from then on. A pallet cannot go
  in a carton, nothing holds itself, and a closed container takes nothing
  more (`409 container_closed`). `/unnest` takes it off.
- `POST /v1/containers/{ref}/move` `{ to_location, reason }` moves the
  container and everything it carries, nested cartons included: a ledger pair
  per product and batch, each naming its container. The reply says how much
  moved. Across warehouses it points at a transfer.
- `POST /v1/containers/{ref}/close` seals it; `/reopen` unseals one that has
  not shipped.
- A scanned SSCC or container code resolves to
  `{ "type": "container", "resolved": { container_id, sscc, type, status,
  location, parent } }`, and `pallet-label` prints the SSCC with what is on
  the pallet.

Statuses: `open`, `closed`, `shipped`, `retired`.

## Batches

A batch code on the ledger is a plain string and always will be, so nothing
already written depends on a record here existing. This is what that string
means: when the batch expires, when it was made, whose lot it came from, and
whether it may be sold. The table fills in behind the ledger. The first time
a batch is named on a receipt, or scanned into one, a row appears with no
expiry and a status of `released`, because a warehouse cannot hold stock it
was never told about.

- `POST /v1/batches` — `{ message_id, sku, code, expiry_date, manufactured_on,
  supplier_lot, note }`. Creates or updates by product and batch code. Fields
  left out keep their value, as everywhere else in the master data. Needs
  `master:write`.
- `GET /v1/batches?sku=&status=&expires_before=` — earliest expiry first,
  because that is the one somebody has to act on; a batch with no expiry date
  sorts last. `status` is `released` or `quarantined`. Needs `stock:read`.
- `GET /v1/batches/{sku}/{code}` — one batch, with `on_hand` across every
  warehouse and owner, because a batch is a thing in the world and not a
  thing in one building.
- `POST /v1/batches/{sku}/{code}/quarantine` — `{ message_id, reason, note }`.
  Needs `stock:write`. Event: `batch.quarantined`.
- `POST /v1/batches/{sku}/{code}/release` — `{ message_id, note }`. Needs
  `stock:write`. Event: `batch.released`.

```json
{ "wms_id": "3", "sku": "ABC123", "name": "Widget", "code": "B2601",
  "expiry_date": "2027-03-31", "manufactured_on": "2026-03-31",
  "supplier_lot": "ACME-99", "status": "released", "reason": null,
  "note": null, "on_hand": "48" }
```

Quarantining a batch moves nothing and writes nothing to the ledger. The
stock stays on the shelf and stays in the balances; it is simply never
promised to anyone again until it is released. Two rules follow from the
record, and both are in the allocator:

- A quarantined batch is skipped, so a delivery goes short rather than
  promising stock that cannot be shipped.
- A known expiry date beats the received date, so the batch that expires
  first is picked first. The older pallet is no use if it outlives the one
  behind it. Stock whose batch nobody has described is ordinary stock, picked
  oldest received first as before.

## Batch picking

One walk for several orders. Each order keeps its own pick task, its own
reservations and its own ledger lines, so nothing about a delivery changes
because it was picked alongside others. The batch decides the order of the
walk and which tote each order's items go in.

- `GET /v1/pick-batches/suggest?warehouse=` — waiting orders worth walking
  together, grouped by the zone they mostly sit in, with `lines`, `stops`
  and `saved` (lines minus stops) so the value is visible before anyone
  commits. Respects the warehouse's `batch_pick_max_orders`.
- `POST /v1/pick-batches` — `{ message_id, warehouse, deliveries: ["D1",
  "D2"], assigned_to, note }` → `BP-0001`. Every order must be waiting and
  not already in a batch; one that has started picking is a `422`.
- `GET /v1/pick-batches/{ref}` — the batch with its totes and the stops that
  are left:
```json
{
  "external_ref": "BP-0001", "status": "picking", "orders": 3, "lines": 4,
  "done_stops": 1,
  "totes": [{ "tote": "1", "delivery": "D1", "ship_to": "Repco", "status": "picked", "lines": 1 }],
  "stops": [{
    "stop": 1, "location": "PF-01-02-A", "zone": "PICKFACE", "pick_sequence": 120,
    "sku": "ABC123", "name": "Brake pad set", "batch": null, "qty": "18", "uom": "EA",
    "picks": [{ "tote": "1", "delivery": "D1", "qty": "6" },
              { "tote": "2", "delivery": "D2", "qty": "8" }]
  }]
}
```
- `POST /v1/pick-batches/{ref}/stops/{n}/confirm` — `{ message_id, picks,
  reason, supervisor_badge, operator, device }`. With no `picks` every tote
  gets what it asked for. With `picks: [{tote, qty}]` the scanner says what
  actually went in each tote as it sorts; a tote that gets less is short,
  which needs a `reason` and a `supervisor_badge` exactly like a single
  pick, and raises the same count task for that shelf. Stops renumber as
  they are done, so stop 1 is always the next one.
- `POST /v1/pick-batches/{ref}/cancel` — only the grouping goes. Every order
  keeps its task, its reservations and its place in the queue.
- Statuses: `new`, `picking`, `picked`, `cancelled`.

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
`type` is `products`, `locations`, `receipts`, `deliveries`,
`replenishments` or `transfers`. Templates:
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

Products and locations create or update, one row each, like their endpoints.
The four document types group rows by `reference`, taking the document's own
columns from its first row: a delivery's ship-to, a transfer's
`to_warehouse`, a receipt's supplier. A document with any bad line is skipped
whole and every one of its rows says so, because half an order is worse than
none. An imported delivery, replenishment or transfer reserves stock and
raises its task exactly as the API endpoint does.

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
                "receipt_tolerance_pct": 5, "idle_logout_minutes": 480 } }
```
A warehouse reads back with a `timezone`, carried down from its site. Stock
moves on the warehouse's clock, so a client shows the warehouse's times and
not the reader's: a 06:00 receipt in Perth reads 06:00 in Ballarat too. The
desktop puts the warehouse's own time of day beside the warehouse picker
whenever that clock is not the reader's.

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
{ "status": "signed_in", "token": "wms_s....", "expires_in": 900,
  "refresh_token": "wms_r....",
  "user": { "wms_id": "1", "username": "leighton", "display_name": "Leighton L.",
            "role": "admin", "warehouses": ["*"], "owner": "*" } }
```
An account with a second factor gets a challenge instead, and no tokens:
```json
{ "status": "totp_required", "challenge": "…", "expires_in": 180 }
```
Then `POST /v1/auth/login/totp` with `{ challenge, code }` returns the
session. A challenge is good once and for three minutes.

A wrong password is `401` with `code: "wrong_password"` and `tries_left`.
After the warehouse's `password_lockout_tries` the account is locked for
`password_lockout_minutes` and every attempt is `code: "locked"`, right
password included. A good sign in clears the count. An unknown username
answers exactly like a wrong password, with no `tries_left`, so the endpoint
gives nothing away about who exists. Every attempt, good or bad, is in the
audit log.
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

### Single sign-on
Optional, and off unless the install sets `WMS_OIDC_ISSUER`,
`WMS_OIDC_CLIENT_ID` and `WMS_OIDC_REDIRECT_URI`.

- `GET /v1/auth/sso` → `{ enabled, name }`. The sign-in screen offers the
  button only when this says so.
- `GET /v1/auth/sso/start` → `{ authorize_url, state, expires_in }`. Send the
  browser to the URL. It is the authorization code flow with PKCE, and the
  verifier stays on the server, so a code lifted in transit is worth nothing.
- `POST /v1/auth/sso/callback` — `{ code, state }` → the same session a
  password sign in returns. The state is good once and for ten minutes.

The code is exchanged server to server with the provider's token endpoint
over TLS, and identity comes from its userinfo endpoint. Nothing verifies a
signature, because nothing has to: the tokens arrive down an authenticated
channel from the issuer itself, not through the browser.

A person is matched by email, then by username. Someone the provider knows
but the WMS does not is `403 no_account` and is named in the message, unless
`WMS_OIDC_CREATE_USERS` is on, which makes them an account with
`WMS_OIDC_DEFAULT_ROLE` and no password. Off by default: supervisors create
accounts and IT audits them. A second factor is not asked for after single
sign-on, because the provider has already said who they are.

### Second factor
Time-based one-time passwords, the ordinary kind any authenticator app
speaks. Optional, and worth it for an admin.

- `POST /v1/auth/2fa/setup` → `{ secret, otpauth_url }`. The URL is what goes
  in a QR code. Nothing changes yet.
- `POST /v1/auth/2fa/enable` — `{ code }` proves the phone has the secret and
  switches it on. A wrong code is a `422`; asking without a setup is a
  `409 no_setup`.
- `POST /v1/auth/2fa/disable` — `{ password }`. Turning it off needs the
  password, so a borrowed screen cannot do it.
- `POST /v1/users/{id}/clear-2fa` — for a lost phone, by an admin. They set
  it up again next time they sign in.
- `POST /v1/users/{id}/unlock` — let someone back in after too many wrong
  passwords.

A code is accepted one step either side of now, because phones drift, and
never twice: the step it came from is remembered, so a code seen over a
shoulder is already spent.

### Warehouse settings
`GET /v1/warehouses/{code}` returns the warehouse with every switch filled in
from defaults. `PATCH /v1/warehouses/{code}/settings` merges the keys sent:
```json
{ "erp_counts_gr": true, "receipt_tolerance_pct": 10, "idle_logout_minutes": 480 }
```
Keys: `erp_counts_gr`, `batch_from_production_order`, `receipt_tolerance_pct`,
`supplier_tolerance_pct`, `allow_ship_short`, `supervisor_for_short_pick`,
`auto_pick_mode` (`single`/`batch`/`auto`), `batch_pick_max_orders`,
`idle_logout_minutes`, `pin_lockout_tries`, `password_lockout_tries`,
`password_lockout_minutes`, `known_devices_only`,
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
  owner, transport, settings, active }`. Creates or updates by name.
  `event_types` takes exact names, `transfer.*` or `*`. On create the HMAC
  `secret` is generated if not given and returned once (`201`); on update it
  is never returned (`200`). `transport` is `http` by default, which needs an
  `http://` or `https://` url, or `sap_rfc`, which is described under SAP.
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
`tasks:write`, `printing:read`, `printing:write`, `integration:read`,
`integration:admin`, `access:read`, `access:admin`. It also carries the warehouse codes it may touch (or `*`)
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
| `production.components_issued` | po_ref, complete, lines qty_requested/qty_issued, deliver_to | ERP |
| `production.received` | po_ref, sku, batch, qty, uom, location, container_id, operator, received_total, expected, complete | ERP (unless ERP already counted GR) |
| `batch.quarantined` | sku, batch, reason, note, on_hand | ERP, quality |
| `batch.released` | sku, batch, note, on_hand | ERP, quality |

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

## SAP

The first ERP adapter. An SAP subscriber is an ordinary row in `subscriber`
with `transport: "sap_rfc"`: the same event queue, the same backoff, the same
Integrations page. Nothing about the WMS changes shape because SAP is on the
other end.

```json
{ "name": "sap-erp", "url": "rfc://PRD", "transport": "sap_rfc",
  "event_types": ["receipt.confirmed", "delivery.shipped", "stock.adjusted"],
  "settings": {
    "connection": { "ashost": "sap.example", "sysnr": "00", "client": "100",
                    "user": "WMS", "passwd_env": "SAP_PASSWORD" },
    "plant_by_warehouse": { "BAL-WH01": "1000" },
    "storage_location": "0001",
    "movement_types": { "delivery.shipped": "601" } } }
```

The password is never stored. `passwd_env` names an environment variable and
the worker reads it from the host, beside every other secret. A body that
puts `passwd` in `connection` is refused with a `422` against
`settings.connection.passwd_env`, and one with no plants against
`settings.plant_by_warehouse`, so a form can put the message under the field
it is about.

Each event becomes one `BAPI_GOODSMVT_CREATE`, committed with
`BAPI_TRANSACTION_COMMIT`, or rolled back and retried:

| Event | `GM_CODE` | Movement type |
|---|---|---|
| `receipt.confirmed` | 01 | 101 |
| `production.received` | 02 | 101 |
| `production.components_issued` | 03 | 261 |
| `delivery.shipped` | 03 | 601 |
| `stock.moved` | 04 | 311 |
| `transfer.shipped` | 04 | 351 |
| `transfer.received` | 04 | 101 |
| `stock.adjusted` | 05 | 701 up, 702 down |

Quantities cross as the decimal strings they already are. A shelf code never
does: SAP is told a plant and a storage location, and which shelf a thing sits
on stays the WMS's business. Anything in `movement_types` overrides the table
above for a site with its own numbering.

SAP answers in a `RETURN` table rather than a status code. A row of type `E`
or `A` is a refusal: the work is rolled back, SAP's own message is kept on the
event, and the queue tries again on the usual 1 min, 5, 30, 2 h. An event type
with no mapping fails at once instead of four times, because retrying will not
invent one.

`pyrfc` needs the SAP NetWeaver RFC SDK, which is licensed and cannot be
fetched from PyPI. Download the SDK from SAP, then `pip install
'simple-wms-api[sap]'` on the worker host. Every other part of the WMS,
including the whole adapter apart from opening the connection, runs and is
tested without it.

## Print jobs (to Platen)

The WMS renders nothing. It sends a template name, a version, a printer,
copies and JSON through the same durable queue as events, and Platen (or any
print service) does the rendering.

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
    "weight_kg": "8.4",
    "carrier": null, "tracking_no": null,
    "sscc": null,
    "lines": [{ "sku": "ABC123", "qty": "10", "uom": "EA" }]
  }
}
```
Headers: `X-WMS-Job-Id`, `X-WMS-Template: carton-label/v3`. The URL is the
warehouse's `platen_url` setting; a job for a warehouse without one waits in
the queue until it is set. A refusal is retried on the same backoff as
events (1 min, 5, 30, 2 h), then marked `failed` for a reprint.

### Print points — event → template → printer
```json
{ "warehouse": "BAL-WH01", "event_type": "delivery.packed",
  "template": "carton-label", "printer": "Packing bench 2", "copies": 1,
  "owner": "*", "active": true }
```
`POST /v1/print-points` creates or updates by warehouse, event, template and
printer (`201` on create, `200` on update). A null `warehouse` covers every
warehouse. `copies: 0` or `active: false` turns it off without losing the
row. `GET /v1/print-points?warehouse=` lists;
`POST /v1/print-points/{id}/deactivate` switches one off. Needs
`integration:admin`.

Every outbound event runs its print points, whether anyone subscribes to it
or not. A template that cannot build its data prints nothing rather than
blocking the movement that caused it.

### GET /v1/print-templates
Every document type, its current version, the fields Platen receives and the
events that can fire it.

| Template | Version | Fires on | `data` |
|---|---|---|---|
| `location-label` | v2 | `receipt.confirmed` | location, warehouse, zone, barcode, type, access, pick_sequence |
| `product-label` | v1 | — | sku, name, uom, barcode, batch, batch_tracked, qty |
| `carton-label` | v3 | `delivery.packed` | ship_to, delivery_ref, package_no, package_count, weight_kg, carrier, tracking_no, sscc, lines |
| `pallet-label` | v1 | `production.received` | sku, name, batch, qty, uom, location, reference, sscc |
| `pick-list` | v1 | `delivery.allocated` | delivery_ref, ship_to, required_by, priority, pick_mode, lines |
| `packing-slip` | v1 | `delivery.packed` | delivery_ref, ship_to, carrier, tracking_no, packages, lines |
| `transfer-docket` | v1 | `transfer.shipped` | transfer_ref, from/to warehouse, carrier, tracking_no, required_by, packages, lines |

Adding a field is a new version; old versions keep working, because a
printer out there is still rendering them. A reprint sends the version that
was sent the first time.

### POST /v1/print-jobs — print one now
```json
{ "message_id": "uuid", "warehouse": "BAL-WH01", "template": "location-label",
  "printer": "Office", "copies": 3,
  "reference": { "type": "location", "ref": "PF-01-02-A" } }
```
The WMS builds the data for the template you name: `reference.ref` is a
location code, a SKU (with optional `batch` and `qty`) or a delivery
reference (with `package_no` for a carton label). Something that is not
there is a `422` on `reference`.

- `GET /v1/print-jobs?warehouse=&status=&template=&printer=&external_ref=`
  lists newest first, with the exact `data` that was sent.
- `GET /v1/print-jobs/{id}` returns one.
- `POST /v1/print-jobs/{id}/reprint` — `{ message_id, printer?, copies? }`.
  The same data again as a new job with a new `job_id`. Never re-rendered,
  never re-numbered.
- `POST /v1/print-jobs/{job_id}/status` — what Platen says afterwards:
  `{ "status": "printed" }` or `{ "status": "failed", "message": "out of
  labels" }`. Found by the `job_id` the print service was given.
  Statuses: `pending`, `accepted`, `printed`, `failed`.

Reading needs `printing:read`, printing and reprinting `printing:write`.
Supervisors, inventory controllers and scanner operators have them.
