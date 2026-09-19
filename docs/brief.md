# Simple WMS — build brief

A small warehouse system with standard inputs and outputs, so it can be
connected to a variety of different systems. Open source (MIT), self-hosted,
built by Q7 Technology in Ballarat.

## The idea in one sentence

A warehouse system that tracks where every unit sits, turns every job into a
scannable task, and talks to any other system through one API and one event
envelope.

- **Desktop = control.** Create, watch, approve, configure.
- **Scanner = execution.** Do the work, confirm it, move on.
- **API = the only door.** Other systems never touch the database.

## Principles

1. **Append-only ledger.** Stock is never overwritten. Every change is a new
   line with who, where, when, batch, owner, device. Cancel instead of delete.
2. **Everything is a task.** Receive, put away, pick, pack, move, count,
   replenish, transfer, production issue and receipt share one task engine.
3. **Decimals and units everywhere.** Nothing assumes whole numbers. Every
   quantity carries a unit of measure.
4. **Build for one, leave room for many.** Owner tag and container field exist
   from day one, switched off in the UI until needed.

## Scope decisions

| Question | Decision | Why it matters |
|---|---|---|
| Size | Multiple warehouses and sites | Warehouse is a first-class object; transfers from day one |
| Input device | Handheld Android scanners running a PWA | Installed from the browser; works through Wi-Fi drops; PIN login |
| First integrations | None, just a clean API | Design the envelope first, subscribers later |
| Stock tracking | Product, quantity, batch/lot | No expiry dates; batch is a per-product switch |
| Ownership | One owner now, room for many | Owner column on every stock line |
| Pallets and cartons | Hooks only, switch on later | `container_id` present but unused |
| Hosting | Self-hosted Docker | One compose file, Postgres, backups |
| Picking | Single or batch, chosen per order (or auto) | `pick_mode` on the delivery body |
| Printing | Nothing itself; sends to Platen | Template name + JSON, Platen renders |
| Licence | MIT | |
| Repo | github.com/q7-technology/simple-wms | |

## Features

### Platform and stock
- Structure: site → warehouse → zone → location. Pick sequence per location
  for walk order. Location type, access class (ground/step/forklift), mixing
  rule, capacity, barcode.
- Stock ledger: on hand, reserved, available per location, batch and owner.
  FIFO by received date. Received date travels with transfers.
- Products: unit, decimals allowed, batch tracking switch, preferred zone,
  min/max at pick face, many barcodes per product (GTIN, carton, supplier).
- Lookup: where is it (by product), what is here (by shelf), one or all
  warehouses. Same call feeds the scanner and the API.
- Putaway rules, tried in order: same product with space → empty shelf in
  preferred zone → any allowed empty shelf → overflow location and flag.
  Operator can override; the ledger records where it really went.
- Master data editable on desktop or by CSV import with a preview that names
  problem rows before anything commits.

### Work (as tasks)
- Receive and put away: expected receipts from ERP, ASN or CSV. Over-receipt
  tolerance with supervisor override. Location label via Platen.
- Pick: for a delivery, production order or transfer. Single or batch. Walk by
  pick sequence. Short pick with reason code and supervisor badge; raises a
  count task for that shelf. An unreadable location barcode removes the line
  with a reason code.
- Pack and ship: cartons with weight and size. Carton label via Platen. Ship
  short is allowed; the ERP hears the real shipped quantity.
- Replenish: triggered by min/max after a pick, by the ERP, or by hand. FIFO
  source unless one is given.
- Count and adjust: blind cycle counts. Variance needs a reason and a
  supervisor. Adjustment is a ledger line and an event.
- Transfer: one order, two legs. Stock sits in an in-transit bucket between
  them. Variance stays open until closed with a reason.

### Production
- Pick components with the same engine, drop at a line-side location, event
  `production.components_issued`. Short issue allowed, remainder stays open.
- Scan the production order to put away finished goods, pallet by pallet,
  running total against expected.
- Batch comes from the order's QR code: read-only on screen, blocked if
  missing or mismatched with the API-supplied batch.
- Over-receipt tolerance with supervisor badge.
- Per-warehouse switch: has the ERP already counted the goods receipt? If yes,
  the WMS only assigns bins and sends no event.

### Scanning
- One parser for every scan, tried in order: GS1 (QR, DataMatrix, GS1-128,
  Digital Link), JSON in a QR, per-site custom patterns, plain text lookup
  (location, SKU, production order, delivery, badge).
- Handles the group separator (GS, 0x1D) and symbology prefixes (`]Q3`, `]C1`).
- One code can fill product, batch and quantity at once.
- Each screen says what it expects; a wrong type gives a friendly message.
- Unknown scans are logged with raw text so new patterns can be built.
- Runs on the scanner and behind `POST /v1/scans/parse`.

### Printing (Platen)
- The WMS prints nothing. It sends template name, JSON data, printer, copies,
  job_id and a reference to Platen; Platen replies accepted / printed / failed.
- Print points map event → template → printer per site.
- Fixed, versioned data shapes per document type: location label, product
  label, carton label, pick list, packing slip, transfer docket, pallet label.
- Same durable queue as events. Reprint resends the same data as a new job.

### Security
- Desktop: username/password or OIDC single sign-on; short-lived session +
  refresh token; optional 2FA for admins.
- Scanner: badge scan or operator ID + PIN; known devices only; idle logout;
  lockout after 5 wrong tries. Supervisors create accounts, IT audits them.
- Systems: one scoped API key per system (actions × warehouses × owner),
  rotatable, hash stored, optional IP allowlist. Webhooks HMAC-signed.
- Roles: picker, receiver, supervisor, inventory controller, admin,
  integration. Every check: this role, this warehouse, this owner?
- Supervisor badge on the same scanner for short ship, stock adjustment,
  over-tolerance receipt.
- Audit: every ledger line and task stores who, device, when. Logins, failed
  logins, key use and permission changes in an insert-only audit log. Users
  are deactivated, never deleted.

## Technical stack

- **API:** Python 3.12 + FastAPI, Pydantic v2, SQLAlchemy 2, Alembic.
  Python so `pyrfc` is available for a future SAP RFC adapter.
- **Database:** PostgreSQL 16. Ledger table with a trigger that blocks UPDATE
  and DELETE. Row-level owner filter ready for 3PL.
- **Queue:** Postgres tables `outbound_event` and `print_job`, drained by a
  Python worker with backoff. No broker until volume says so.
- **Desktop:** Vite + React + TypeScript + Tailwind.
- **Scanner:** same repo, second entry point, PWA. Service worker caches the
  shell; keyboard-wedge and camera scan input; current task in memory with a
  retry queue for Wi-Fi drops; updates on next launch.
- **Hosting:** Ubuntu + Docker Compose: `api`, `worker`, `db`, `caddy` (TLS),
  static builds. Secrets in `.env`. Nightly `pg_dump` plus VM backup.

Nothing talks to Postgres except `api` and `worker`.

## Data model (tables that matter)

| Table | Holds | Key rule |
|---|---|---|
| site, warehouse, zone, location | Structure | location: pick_sequence, type, access, mixing, capacity, barcode |
| product, product_barcode | Master data | uom, decimals, batch_tracked, preferred_zone, min/max per location |
| stock_ledger | Every movement, append-only | qty_change, from/to location, batch, owner, container_id, task_id, actor, device, at |
| stock_balance | Materialised on hand per location/batch/owner | rebuilt from the ledger; reserved and available derived |
| task, task_line | All work | type, status, assigned_to, source_ref; expected vs actual per line |
| delivery, receipt, production_order, transfer, replenishment | Documents that create tasks | external_ref + message_id unique per owner |
| package, container | Cartons, pallets, totes | nesting ready; sscc nullable |
| subscriber, outbound_event, print_point, print_job | Integration | one queue table, per-subscriber HMAC secret |
| user, operator, device, api_client, audit_log | Access | audit_log insert-only; users deactivated not deleted |

## Build order

Each step leaves something usable.

1. **Skeleton:** sites, locations, products, users, ledger, API with
   message ids and the retry queue. Docker Compose up.
2. **Inbound:** receive, put away, move, count. Scanner PWA begins.
3. **Outbound:** deliveries, single pick, pack, ship, outbound events.
4. **Platen:** print points, job status, reprint.
5. **More work:** batch pick + sort, production orders, transfers.
6. **Switches:** containers/SSCC, multi-owner, reports.

API first, screens second, for every step.

## Switched on later

- Containers and SSCC (GS1 company prefix, nested cartons on pallets).
- Multiple owners / 3PL (portal users, per-owner subscriptions, billing export).
- EDI/ASN as a subscriber via a broker.
- Carrier integration as a subscriber on `delivery.packed`.
- SAP RFC adapter (pyrfc) turning events into BAPI calls, or n8n in between.
- Reports: stock on hand, movements by day, pick rate per operator,
  variance history — all from the ledger.

## Paid support

The software is free. Q7 Technology offers setup and hosting, integration,
go-live and training, and ongoing support on a fixed monthly retainer.

## Open questions

- Is this purely a Q7 product, or the seed of something else?
- Which ERP goes first when one does (SAP adapter vs plain webhook receiver)?
- Platen's exact job API: status callback or polling; where printer names live.
- Batch master table with attributes, or batch as a string on the ledger?
- Camera scanning as a phone fallback, or scanners only?
- Idle logout and PIN length the floor will accept.
- Blind counts by default, or show expected quantity?
- Ledger retention before archiving.

## Related artefacts

- `design/` in this repo: static exports of the Claude Design file "Simple
  WMS UI" (35 screens, 7 flow diagrams), the build-brief deck sources and
  the original artboards. Start at `design/index.html`.
- `site/index.html`: the landing page.
- The live, editable versions stay in Claude: the Design file, the deck
  "Simple WMS build brief" and the design "Simple WMS landing page".
