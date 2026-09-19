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
- `batch: null` = WMS picks by FIFO. Set it to force a batch.
- Stock is reserved immediately; the reply says what could not be allocated.
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
`from_location: null` = FIFO source. The WMS uses this same body for
replenishments it raises itself from min/max. Event: `replenishment.completed`.

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
Event: `stock.moved`.

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
Event: `delivery.packed`. Fires the `carton-label` print point.

### GET /v1/stock?sku=ABC123&warehouse=BAL-WH01 — where is it?
```json
{
  "sku": "ABC123",
  "total_on_hand": 168,
  "total_available": 158,
  "locations": [{
    "warehouse": "BAL-WH01",
    "location": "PF-01-02-A",
    "zone": "PICKFACE",
    "batch": null,
    "on_hand": 48,
    "reserved": 10,
    "available": 38,
    "received_at": "2026-08-30"
  }]
}
```
Omit `warehouse` to search every site. `GET /v1/locations/{id}/stock` is the
reverse: what is on a shelf. Filters: `batch`, `owner`.

### POST /v1/locations/suggest — where should it go?
```json
{ "warehouse": "BAL-WH01", "sku": "ABC123", "batch": null, "qty": 120, "uom": "EA", "purpose": "putaway" }
```
```json
{ "suggestions": [
  { "location": "BK-04-01-C", "reason": "same_sku_has_space" },
  { "location": "BK-04-02-A", "reason": "empty_in_preferred_zone" }
] }
```

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
Formats tried in order: GS1 → JSON in QR → custom per-site patterns → plain
text lookup. A production-order QR resolves to
`{ "type": "production_order", "fields": { "po", "sku", "batch", "qty" } }`.

### Also
- `POST /v1/products`, `POST /v1/locations` — master data.
- `POST /v1/imports/{type}` — CSV upload with preview (`dry_run: true`).
- `POST /v1/auth/scanner-login` — `{ device_id, operator_id, pin, warehouse }`
  → `{ token, expires_in, operator, warehouses }`.
- `POST /v1/api-clients` — `{ name, scopes, warehouses, owner, ip_allowlist }`.

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
| `delivery.allocated` | lines: qty_ordered, qty_allocated | ERP |
| `delivery.picked` | lines: qty_picked, short reasons | ERP |
| `delivery.packed` | packages: package_no, weight, dims, contents | Carriers, Platen |
| `delivery.shipped` | carrier, tracking_no, short, lines: qty_ordered/qty_shipped, packages | ERP, carriers, EDI |
| `delivery.cancelled` | reason | ERP |
| `transfer.shipped` | transfer_ref, from/to warehouse, lines qty_requested/qty_shipped, packages | ERP |
| `transfer.received` | transfer_ref, complete, lines qty_shipped/qty_received/variance | ERP |
| `production.components_issued` | po_ref, lines qty_requested/qty_issued, deliver_to | ERP |
| `production.received` | po_ref, sku, batch, qty, location | ERP (unless ERP already counted GR) |

### `delivery.shipped` data
```json
{
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
