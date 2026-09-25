# TrackBack

A Zepp OS watch app (built/tested against Amazfit Active Max, API_LEVEL 3.0+)
that records the route you walk away from a start point, then guides you
back along it.

## What you see

- The map is heading-up: "up" on screen is always the direction you're
  currently facing/moving, so the route feels laid out in front of you
  instead of the map spinning under a fixed compass. Your route is a green
  line, the start is a blue dot, and you are a white dot (an arrow during
  TrackBack). A faint grid rotates with the map for orientation, and a small
  "N" marker on the map edge plus a heading readout in the top-right corner
  always show which way you're actually facing.
- During TrackBack the walked route turns grey, the path still to walk turns
  orange, and you become an arrow pointing straight up when the next
  waypoint is ahead of your current heading (and left/right when it isn't).
  The arrow flashes quickly when a turn is coming up, and gives an
  occasional confirming blink while you're going straight.
- The text shows how far you are from the start, plus directions like
  "Turn left 40°" or "Straight ahead" using the watch's compass.
- The watch vibrates if you drift more than about 40 m off the route, and
  again when you're back at the start.
- If you rejoin the route further along, it skips ahead instead of making
  you retrace the loop.
- The route (and elapsed recording time) is saved on the watch, so it
  survives the app closing.

## Setup

### Option A — via `zeus create` (if it works for you)

1. Run `zeus create trackback`.
2. Replace `page/index.js` with the file in this repo.
3. In `app.json`, add these permissions: `"device:os.geolocation"`,
   `"device:os.compass"`, `"device:os.local_storage"`.
4. Run `zeus preview` and scan the QR code in the Zepp app.

### Option B — `zeus-project/`, skipping `zeus create`

`zeus create` currently only offers API_LEVEL up to 4.0, but the Amazfit
Active Max requires **API_LEVEL 4.2** — its bundled device database predates
this watch, which is why `create` crashes on it. `zeus-project/` in this repo
is a hand-built project folder (`app.json`, `app.js`, `page/index.js`) that
sidesteps `create` entirely, using the device's confirmed Zepp OS data:
`deviceSource` `10813697`/`10813699`, round 480×480 screen, API_LEVEL 4.2.

```bash
cp -r zeus-project trackback
cd trackback
zeus preview
```

The three required permissions are already in `zeus-project/app.json`. This
hasn't been run through `zeus preview`/`zeus build` yet — if it errors,
that'll tell us what to adjust (e.g. the `targets` block or `apiVersion`).

## Buttons

At most two buttons are ever on screen at once:

- **idle** → `[Start]`
- **tracking** (recording) → `[Stop]`
- **stopped** → `[Go Back]` `[New Route]`
- **backtrack** → `[Stop]`, or `[New Route]` once you've arrived

"New Route" always fully resets the recorded track and any TrackBack
progress before starting a fresh recording. The physical START/BACK keys
mirror whichever on-screen buttons are currently shown (START = the first
button, BACK = the second one, or exits the app when idle) — key mapping
lives at the top of `page/index.js` (`START_KEYS`, `BACK_KEYS`) if a
physical button doesn't respond on your watch.

## Things to check on your first walk

- Screen and GPS: there's no map background, only your own trail. The app
  sets a long screen-bright timer and wake-relaunch so it can stay open
  while you walk, but GPS still stops if you leave the app.
- Buttons: confirm START/BACK map to the physical buttons you expect; note
  which one if not, so `START_KEYS`/`BACK_KEYS` can be adjusted.
- Compass: the compass may need calibrating first (draw a figure-8 with your
  wrist). Until it's calibrated, you'll get plain directions like "Head SW"
  instead of turns.

## Status

Runs on the Zepp OS simulator (Amazfit Active Max profile) and has been
walked through recording, stopping, and TrackBack. The heading-up map
rotation, flashing arrow, grid, and on-screen button layout are newly added
based on that testing and haven't been re-verified on-device yet — worth a
fresh walk-through, especially checking the map actually feels "facing
forward" as you turn, and that the two-button layout isn't cramped on the
real screen.
