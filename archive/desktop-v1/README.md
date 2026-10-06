# Simple WMS desktop

The control surface: create, watch, approve, configure. An ordinary API
client with a session token; nothing here can do what a partner can't do
with an API key.

Vite + React 19 + TypeScript + Tailwind v4. Screens follow
`design/screens/*.html` and `docs/screens.md`.

## Run

```
cd apps/desktop
npm install
npm run dev          # http://localhost:5173, proxies /v1 to http://127.0.0.1:8000
npm test             # Vitest
npm run build        # dist/, which Caddy serves at / in docker compose
```

The API must be running (`docker compose up -d` at the repo root, or
`uvicorn` from `api/`). Sign in with a user made by
`docker compose exec api wms create-user --username you --role admin`.

## Layout

```
src/api/client.ts     fetch wrapper: bearer token, refresh on 401, ApiError with field errors
src/api/types.ts      response shapes from docs/api.md
src/auth/             session context, route guard
src/ui/               the component kit (buttons, cards, pills, table, detail panel, toggles)
src/ui/Shell.tsx      top bar, nav, warehouse picker
src/pages/            one file per screen
src/lib/              formatting and data hooks
src/test/             Vitest with mocked fetch
```

Colours and type are tokens in `src/index.css`. Exceptions are gold, never
red. Green never stands alone.
