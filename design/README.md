# Design exports

Static HTML exports of the Claude Design file **Simple WMS UI** (Screens and
Process flows pages) and the source artboards, so the design travels with the
repo.

- `index.html` — gallery of everything below. Open it in a browser.
- `screens/` — 20 desktop screens (1440×900) and 15 scanner PWA screens (390×844).
  Scanner screens link to each other the way the prototype does.
- `flows/` — overview plus six swimlane process flows as inline SVG.
- `canvas/` — the original artboard sources (`*.dc.html`, `canvas.json`) from the
  Design file, in case they need to go back into a canvas. They are not meant
  to be opened directly.

All names, references and quantities on the screens are sample placeholders.
- `deck/` — the "Simple WMS build brief" deck sources (one HTML section per
  slide plus `deck.json`). Best read from the Claude Slides page, which can
  also export it as PowerPoint or PDF; kept here so the content is in git.
