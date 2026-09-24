# TrackBack

A Zepp OS watch app that records the route you walk away from a start point,
then guides you back along it.

## What you see

- The map is always north-up. Your route is a green line, the start is a blue
  dot, and you are a white dot.
- During TrackBack, the path still to walk turns orange and you become an
  arrow pointing to the next point on the route.
- The text shows how far you are from the start, plus directions like
  "Turn left 40°" or "Straight ahead" using the watch's compass.
- The watch vibrates if you drift more than about 40 m off the route, and
  again when you're back at the start.
- If you rejoin the route further along, it skips ahead instead of making you
  retrace the loop.
- The route is saved on the watch, so it survives the app closing.

## Setup

1. Run `zeus create trackback`.
2. Replace `page/index.js` with the file in this repo.
3. In `app.json`, add these permissions: `"device:os.geolocation"`,
   `"device:os.compass"`, `"device:os.local_storage"`.
4. Run `zeus preview` and scan the QR code in the Zepp app.

## Buttons

- **Start** (idle/done) — begin recording a new route from your current GPS
  position.
- **TrackBack** (while recording, once at least two points are logged) —
  switch to guided-return mode.
- **Stop** (while in TrackBack) — abandon guidance and return to idle.
- **Reset** (always available, top-right) — clear the saved route entirely.

## Things to check on your first walk

- Screen and GPS: there's no map background, only your own trail. The app
  must stay open on screen while you walk, because GPS stops if you leave it.
- Buttons: if a button doesn't respond, note which one and it can be
  remapped.
- Compass: the compass may need calibrating first (draw a figure-8 with your
  wrist). Until it's calibrated, you'll get plain directions like "Head SW"
  instead of turns.

## Status

Tested against the Zepp OS sensor/UI/storage API surface (Geolocation,
Compass, Vibrator, `@zos/storage` localStorage, and the CANVAS widget) as
documented, plus a logic-only simulated GPS walk. It has not yet been run in
the Zepp OS simulator or on a real watch — the recording/trackback state
machine, drift and arrival detection, and skip-ahead logic are implemented in
`page/index.js` and worth exercising there first.
