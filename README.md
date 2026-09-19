# Simple WMS

An open source, self-hosted warehouse management system with standard inputs
and outputs, so it connects to any ERP, web store, carrier or print service.

- **Append-only stock ledger** — nothing overwritten, cancel never delete
- **Everything is a task** — receive, put away, pick, pack, ship, move, count, replenish, transfer, production
- **Scanner PWA** — installs from the browser on Android handhelds, works through Wi-Fi drops
- **One API, one event envelope** — signed, queued, retried
- **Multi-warehouse from day one** — transfers with an in-transit bucket
- **Prints nothing itself** — template + JSON to Platen or any print service

Status: **planning**. The spec is complete; code starts at build step 1.

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
```

Code lands in `api/`, `apps/desktop/` and `apps/scanner/` as the build steps
in `docs/brief.md` are done.

## Stack

Python 3.12 + FastAPI · PostgreSQL 16 · Vite + React + Tailwind (desktop and
scanner PWA) · Docker Compose · Caddy.

## Getting started (once step 1 lands)

```
git clone https://github.com/q7-technology/simple-wms
cd simple-wms
cp .env.example .env
docker compose up -d
```

## Support

The software is free. Q7 Technology offers setup, hosting, integration and
ongoing support on a fixed monthly retainer: https://q7technology.com.au

## Licence

MIT © 2026 Q7 Technology
