# Simple WMS scanner

The execution surface: do the work, confirm it, move on. A PWA for Android
handhelds (390 px wide, 56 px touch targets), installed from the browser,
served by Caddy at `/scan/`.

Vite + React 19 + TypeScript + Tailwind v4. Screens follow
`design/screens/Scanner*.html` and `docs/screens.md`.

## Run

```
cd apps/scanner
npm install
npm run dev          # http://<your ip>:5174/scan/, proxies /v1 to http://127.0.0.1:8000
npm test             # Vitest
npm run build        # dist/, which Caddy serves at /scan/ in docker compose
```

Sign in needs a registered device (Users screen or `POST /v1/devices`) and
an operator with a PIN or badge.

## How it stays useful through a Wi-Fi drop

- `public/sw.js` caches the app shell, so the app opens offline. API calls
  always go to the network. A new build takes over on the next launch.
- `src/lib/queue.ts` is the retry queue. Every confirmation gets its
  `message_id` when it is created and is sent through the queue, so a retry
  after a drop gets the same reply and never doubles a movement. Queued items
  survive a reload and drain when the connection is back.
- The current task lives in component state, so an operator can finish it
  from memory. Starting a new one needs the connection, because stock
  numbers may have changed.

## Scanning

`src/lib/useScanWedge.ts` listens for keyboard-wedge scanners (a fast burst
of keys and Enter). An `<input data-scan="true">` also delivers its value on
Enter, so a code can be typed. Every scan goes to `POST /v1/scans/parse`,
which reads GS1, JSON and plain codes and says what it found; a screen that
expected something else shows the "That is a location" card.

## Layout

```
src/api/            fetch wrapper and response types (same as the desktop)
src/auth/Session.tsx operator session, device and warehouse, idle logout, online state, the queue
src/lib/            queue, scan wedge, formatting
src/ui/             the kit: Screen, Header, Footer, cards, scan hint, supervisor panel, qty stepper
src/pages/          one file per screen
src/test/           Vitest with mocked fetch
```
