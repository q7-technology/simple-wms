# Game Mode design

A second look for Simple WMS, kept next to the original design. The original
(`design/screens/`, `docs/screens.md`) is still what the app is built to.

The idea: the manager runs the warehouse from a pretend 3D map, like a
strategy game, and every job opens as a panel that slides over it. The
scanner screens do the same jobs as the originals, with bigger buttons, a
pretend-scan box and a "Ding!" when a step is done.

- `index.html`: gallery of every screen. Open it in a browser.
- `screens/`: one static HTML file per screen (22 desktop pages, 15 scanner
  screens), each in its starting state. `warehouse.svg` is the map picture.
- `canvas/`: the Claude Design sources (`*.dc.html`, `canvas.json`). They
  need the design canvas to run, so they are not meant to be opened directly.

## Where it differs from the original

- Look: light, soft blue, Manrope type, instead of the dark Q7 look.
- The desktop is one map with panels over it, not a top bar with pages. The
  map shows a pretend warehouse with three zones (Arriving, Stored, Leaving);
  the panels still show real site, warehouse, zone and location codes.
- Game touches: trucks and forklifts (decoration only), sounds, weather and
  day/night (each can be switched off), a daily goal the app suggests and the
  manager can change, streaks and badges.
- Sign-in: managers use Microsoft sign-in on the desktop. Scanner workers
  scan a badge or type a username and 4-number PIN; 5 wrong PINs locks the
  account until a supervisor unlocks it; the scanner signs them out after
  8 hours, and "Switch worker" hands it over mid-shift.

All names, numbers and references on the screens are made-up samples.
