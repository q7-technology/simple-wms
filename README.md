# Simple WMS

An open source, self-hosted warehouse management system with standard inputs
and outputs, so it connects to any ERP, web store, carrier or print service.

- **Append-only stock ledger** — nothing overwritten, cancel never delete
- **Everything is a task** — receive, put away, pick, pack, ship, move, count, replenish, transfer, production
- **Scanner PWA** — installs from the browser on Android handhelds, works through Wi-Fi drops
- **One API, one event envelope** — signed, queued, retried
- **Multi-warehouse from day one** — transfers with an in-transit bucket
- **Prints nothing itself** — template + JSON to Platen or any print service

Status: **build step 3 (outbound) done**. On top of steps 1 and 2: pick
orders that reserve stock FIFO and say what could not be allocated, picking
to the packing bench, short picks with a reason and a supervisor badge that
raise a count, packing into cartons and shipping, with the whole outbound
event set. Step 4 (Platen: print points, job status, reprint) is next.

## What is in this repo

```
CLAUDE.md          rules for Claude Code when working here
docs/              the spec
  brief.md         idea, principles, decisions, features, stack, data model, build order
  api.md           every inbound body, the event envelope, event types, print jobs
  flows.md         the six process flows as Mermaid diagrams
  screens.md       all 35 screens, what each shows, which build step
design/            the designs, exported from the Claude Design file
  index.html       gallery: open in a browser
  screens/         20 desktop + 15 scanner screens as static HTML
  flows/           overview + 6 swimlane process flows
  deck/            the 23-slide build brief (sources)
  canvas/          original artboard sources
site/              the landing page (static, no build step)
api/               FastAPI app, migrations, worker, tests (see api/README.md)
apps/desktop/      React desktop app (see apps/desktop/README.md)
apps/scanner/      React scanner PWA (see apps/scanner/README.md)
deploy/            Caddyfile
docker-compose.yml api, worker, db, caddy
```

`apps/desktop/` and `apps/scanner/` land with their build steps in
`docs/brief.md`.

## Stack

Python 3.12 + FastAPI · PostgreSQL 16 · Vite + React + Tailwind (desktop and
scanner PWA) · Docker Compose · Caddy.

## Getting started

```
git clone https://github.com/q7-technology/simple-wms
cd simple-wms
cp .env.example .env            # set POSTGRES_PASSWORD and WMS_SECRET_KEY
(cd apps/desktop && npm install && npm run build)
(cd apps/scanner && npm install && npm run build)
docker compose up -d
docker compose exec api wms create-user --username you --role admin
docker compose exec api wms create-api-client --name erp
```

Open `https://<WMS_DOMAIN>/` (default `https://localhost/`, self-signed) and
sign in with the user you made. The scanner PWA is at `/scan/`; register a
device and an operator on the Users screen first. The last line prints an API key once; systems
use it as `Authorization: Bearer <key>` against `/v1/...`. Interactive API
docs are at `/docs`. See `api/README.md` and `apps/desktop/README.md` for
running either outside Docker.

## Support

The software is free. Q7 Technology offers setup, hosting, integration and
ongoing support on a fixed monthly retainer: https://q7technology.com.au

## Licence

MIT © 2026 Q7 Technology
