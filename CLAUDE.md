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
design/game-mode/    the Game Mode design the apps follow: index.html, screens/, canvas/
site/                landing page (static)
api/                 FastAPI app, Alembic migrations, worker, pytest
apps/desktop/        React desktop app (Vite), Vitest
apps/scanner/        React scanner PWA (Vite, service worker), Vitest
archive/             the first desktop and scanner apps (reference only, not built)
deploy/Caddyfile     reverse proxy and static serving
docker-compose.yml   api, worker, db, caddy
```

When building a screen, open its file in `design/game-mode/screens/` and
match layout, copy and states. `design/screens/` is the first version's
look, kept for reference with the apps in `archive/`. `docs/screens.md`
says which build step each belongs to.
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
The apps follow the Game Mode design in `design/game-mode/` (37 screens:
gallery in `index.html`, static screens in `screens/`, sources in `canvas/`).
The desktop is a map of a pretend warehouse with three zones (Arriving,
Stored, Leaving); every other screen opens as a drawer over the map. The
scanner does the same jobs with big buttons and a "Ding!" when a step is done.
Game touches (sounds, day and night, moving trucks and forklifts, the daily
goal) are per-viewer preferences kept in the browser, never in the API.

Look: page `#F3F6FD`, cards white, ink `#18233D`, secondary `#4A5672`,
primary blue `#2F6FE4`, warnings `#A8560F` on white, Manrope (self-hosted).
Zone colours: Arriving `#D8E5FF`/`#1F4FB0`, Stored `#D3EFE8`/`#0F5F59`,
Leaving `#FDE6D2`/`#8E4A0E`. The token names in each app's `src/index.css`
are unchanged from the first version, so `text-gold` still means "warning".

The first version (dark Q7 look, 35 screens, 7 flow diagrams) is in
`design/screens/`, `design/flows/` and `docs/screens.md`, with its apps in
`archive/`. The process flows in `docs/flows.md` still apply to both.
