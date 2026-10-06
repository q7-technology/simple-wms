# Archive

The first desktop and scanner apps, kept as they were when the Game Mode
version replaced them in `apps/`.

- `desktop-v1/`: the desktop app, dark Q7 look, top bar with pages.
- `scanner-v1/`: the scanner PWA, dark Q7 look.

They follow `design/screens/` and `docs/screens.md`. Nothing here is built
by CI or served by Caddy. To run one for comparison:

```
cd archive/desktop-v1 && npm install && npm run dev
```

Don't fix bugs here. Fix them in `apps/`.
