# Simple WMS — instructions for Claude Code

Read `docs/brief.md` before touching anything. It is the product brief and the
decisions are settled unless a human changes them there first.

## What this is
An open source, self-hosted warehouse management system by Q7 Technology.
Desktop web app (control), scanner PWA (execution), one Python API, one
PostgreSQL database. Other systems only ever talk to the API.

## Four rules that never bend
1. **The stock ledger is append-only.** Never UPDATE or DELETE a ledger row.
   A mistake is corrected by a new row. Cancel, never delete, anywhere else too.
2. **Everything is a task.** Receive, put away, pick, pack, ship, move, count,
   replenish, transfer, production issue and receipt all go through the one
   task engine (`task`, `task_line`). Do not add a special-case path.
3. **Quantities are decimals with a unit of measure.** Never assume integers.
4. **The API is the only door.** The desktop and the scanner are ordinary API
   clients with a session token. If the UI can do it, a partner can too. No
   endpoint exists for the UI that isn't documented in `docs/api.md`.

## Stack (decided)
- API: Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2, Alembic. Python was
  chosen so `pyrfc` is available if an SAP RFC adapter is ever needed.
- Database: PostgreSQL 16. `stock_ledger` has a trigger blocking UPDATE/DELETE.
- Queue: a Postgres table (`outbound_event`, `print_job`) drained by a Python
  worker with backoff (1 min, 5, 30, 2 h). No Redis or RabbitMQ.
- Front ends: Vite + React + TypeScript + Tailwind. One repo, two entry
  points: `apps/desktop` and `apps/scanner`. The scanner is a PWA with a
  service worker that caches the app shell.
- Hosting: Ubuntu + Docker Compose: `api`, `worker`, `db`, `caddy`, static
  builds for both apps. Secrets in `.env` on the host.

## Repo layout
```
CLAUDE.md            this file
README.md
docs/brief.md        the product brief: read first
docs/api.md          every request body and event: the API contract
docs/flows.md        process flows (Mermaid)
docs/screens.md      screen list with build step per screen
design/index.html    gallery of every screen and flow; open a screen's HTML
design/screens/      static HTML of each screen: build to these
design/flows/        swimlane flow diagrams
design/deck/         build-brief slides (reference only)
design/canvas/       Design-file sources (do not edit; regenerated from the canvas)
site/                landing page (static)
api/                 FastAPI app, Alembic migrations, worker, pytest
apps/desktop/        React desktop app (Vite), Vitest
apps/scanner/        React scanner PWA (Vite, service worker), Vitest
deploy/Caddyfile     reverse proxy and static serving
docker-compose.yml   api, worker, db, caddy
```

When building a screen, open its file in `design/screens/` and match layout,
copy and states. `docs/screens.md` says which build step each belongs to.
Do not edit anything under `design/` or `site/` unless asked.

## Conventions
- Every inbound API body carries `message_id`, `external_ref`, `warehouse`,
  `owner`. A repeated `message_id` returns the original reply and does nothing.
- Every outbound event uses the envelope in `docs/api.md` and is HMAC-signed
  per subscriber.
- Printing: the WMS never renders labels. It sends `template` + JSON `data`
  to Platen (or any print service) through the same queue.
- Build order is in `docs/brief.md` under "Build order". Finish a step so it
  is usable before starting the next.
- Tests: pytest for the API, Vitest for the apps. A ledger invariant test
  (balances rebuild exactly from the ledger) must always pass.
- Australian English in copy. No "utilise", no "leverage".
- Git: no `Co-Authored-By` lines, no tooling or generated-by trailers, no
  session links. A commit message is the subject line and, if needed, a
  short body about the change. Nothing else.

## Design
The screens and process flows are exported under `design/` from the Claude
Design file "Simple WMS UI" (35 screens, 7 flow diagrams) and summarised in
`docs/screens.md` and `docs/flows.md`. Colours and type follow the Q7 Technology design system:
ground `#0d1117`, text `#ccd6f6`, secondary `#8892b0`, brand blue `#29abe2`,
gold `#f7941d` for warnings and secondary actions, borders blue at 20 % alpha.
