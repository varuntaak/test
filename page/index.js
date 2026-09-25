// TrackBack for Zepp OS (Amazfit Active Max) — API_LEVEL 3.0+
// Replace page/index.js of a project created with `zeus create`.
//
// On-screen buttons, at most two visible at once:
//   idle       -> [Start]
//   tracking   -> [Stop]
//   stopped    -> [Go Back] [New Route]
//   backtrack  -> [Stop]              (or [New Route] once you've arrived)
// The physical START/BACK keys mirror whichever buttons are currently shown
// (START = first button, BACK = second button, or exit the app when idle).
//
// Screen: heading-up map — "up" is always the direction you're currently
// facing/moving, so the route feels like it's laid out in front of you
// rather than the map spinning as you turn on a fixed compass grid. Green
// is your recorded route, blue dot is the start. In TrackBack the walked
// part turns grey, the part still to walk turns orange, and you become an
// arrow pointing at the next waypoint (relative to your heading, so
// "straight up" always means "keep going the way you're facing"). A faint
// grid rotates with the map as an orientation reference, and a small "N"
// marker on the map edge plus a heading readout in the corner always show
// which way you're actually facing.
//
// app.json -> "permissions" must include:
//   "device:os.geolocation", "device:os.compass", "device:os.local_storage"

import { createWidget, widget, align, prop, text_style } from '@zos/ui'
import {
  onKey, offKey,
  KEY_UP, KEY_DOWN, KEY_SELECT, KEY_BACK, KEY_SHORTCUT,
  KEY_EVENT_CLICK,
} from '@zos/interaction'
import { Geolocation, Compass, Vibrator } from '@zos/sensor'
import { setPageBrightTime, resetPageBrightTime, setWakeUpRelaunch } from '@zos/display'
import { getDeviceInfo } from '@zos/device'
import { LocalStorage } from '@zos/storage'
import { exit } from '@zos/router'

// ---------- Button mapping (edit if a button doesn't respond) ----------
const START_KEYS = [KEY_SELECT, KEY_UP]
const BACK_KEYS = [KEY_BACK, KEY_DOWN, KEY_SHORTCUT]

// ---------- Tuning ----------
const MIN_STEP_M = 5         // ignore GPS jitter smaller than this
const MAX_JUMP_M = 200       // ignore sudden jumps bigger than this...
const JUMP_GRACE_MS = 20000  // ...unless GPS was lost for this long
const WAYPOINT_REACHED_M = 15
const SHORTCUT_M = 25        // snap forward if you rejoin the route further along
const OFF_ROUTE_M = 40
const ARRIVED_M = 20
const MIN_VIEW_RADIUS_M = 75 // don't zoom in closer than this around the viewer
const MAX_SEGMENTS = 400     // draw at most this many line segments
const SAVE_KEY = 'trackback_route'
const VIEW_ANCHOR_FRAC = 0.72 // how far down the map "you" sit (more room ahead)
const TURN_STRAIGHT_DEG = 20
const TURN_AROUND_DEG = 150
const GRID_STEPS_M = [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]
const GRID_TARGET_PX = 60

// ---------- Colors ----------
const C_ROUTE = 0x00c853
const C_ROUTE_DONE = 0x555555
const C_TODO = 0xff9100
const C_START = 0x2979ff
const C_ME = 0xffffff
const C_TEXT_DIM = 0x9e9e9e
const C_GRID = 0x2a2a2a
const C_NORTH = 0xffd54f

// ---------- State ----------
let state = 'idle' // idle | tracking | stopped | backtrack
let track = []     // [{lat, lon}]
let cum = []       // cumulative distance along track, for TrackBack
let distance = 0
let current = null
let gpsOk = false
let lastAddAt = 0
let recStartedAt = 0
let recAccum = 0
let unsavedPoints = 0

let ti = 0         // TrackBack: index of next waypoint (walking towards 0)
let remaining = 0
let arrived = false
let offRoute = false
let turnRel = 0    // signed degrees from current heading to the next waypoint

let heading = 0            // best-known heading, used to rotate the map
let gpsHeading = null      // course-over-ground, from consecutive GPS fixes
let compassHeading = null
let compassCalibrated = false
let blinkTick = 0

let geo, compass, vibrator, storage, tickTimer
let W, H, A, mapX, mapY
let canvas, topText, bottomText, headingText, button1, button2
let button1Action = null
let button2Action = null

// ---------- Geo helpers ----------
const RAD = Math.PI / 180
function distM(a, b) {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(s))
}
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD)
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD)
  return (Math.atan2(y, x) / RAD + 360) % 360
}
function compassPoint(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]
}
function updateHeading() {
  if (compassCalibrated && typeof compassHeading === 'number') heading = compassHeading
  else if (typeof gpsHeading === 'number') heading = gpsHeading
}

// ---------- Formatting ----------
function fmtDist(m) {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'
}
function fmtTime(ms) {
  const t = Math.floor(ms / 1000)
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return (h ? h + ':' : '') + p(m) + ':' + p(s)
}
function recElapsed() {
  return state === 'tracking' ? recAccum + (Date.now() - recStartedAt) : recAccum
}
function headingLabel() {
  const deg = Math.round(((heading % 360) + 360) % 360)
  return compassPoint(heading) + ' ' + deg + '°'
}

// ---------- Small utilities ----------
function safe(fn) { try { fn() } catch (e) { console.log('safe: ' + e) } }
function buzz() {
  safe(() => { vibrator.start(); setTimeout(() => safe(() => vibrator.stop()), 500) })
}

// ---------- Persistence (route survives the app closing) ----------
function saveRoute() {
  safe(() => {
    const data = track.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)])
    storage.setItem(SAVE_KEY, JSON.stringify({ pts: data, t: recAccum }))
    unsavedPoints = 0
  })
}
function loadRoute() {
  safe(() => {
    const raw = storage.getItem(SAVE_KEY, '')
    if (!raw) return
    const obj = JSON.parse(raw)
    track = (obj.pts || []).map((a) => ({ lat: a[0], lon: a[1] }))
    recAccum = obj.t || 0
    distance = 0
    for (let i = 1; i < track.length; i++) distance += distM(track[i - 1], track[i])
    if (track.length >= 2) state = 'stopped'
    else track = []
  })
}
function clearRoute() {
  track = []; cum = []; distance = 0; recAccum = 0
  ti = 0; arrived = false; offRoute = false; turnRel = 0
  safe(() => storage.removeItem(SAVE_KEY))
}

// ---------- GPS ----------
function onGps() {
  if (geo.getStatus() !== 'A') {
    gpsOk = false
    render()
    return
  }
  const lat = geo.getLatitude()
  const lon = geo.getLongitude()
  if (typeof lat !== 'number' || typeof lon !== 'number') return
  gpsOk = true
  const prev = current
  current = { lat, lon }
  if (prev && distM(prev, current) > 3) gpsHeading = bearing(prev, current)
  updateHeading()

  if (state === 'tracking') addPoint(current)
  if (state === 'backtrack') updateBacktrack()
  render()
}

function addPoint(p) {
  const now = Date.now()
  const last = track[track.length - 1]
  if (!last) {
    track.push(p); lastAddAt = now; unsavedPoints++
    return
  }
  const d = distM(last, p)
  if (d < MIN_STEP_M) return
  if (d > MAX_JUMP_M && now - lastAddAt < JUMP_GRACE_MS) return
  track.push(p)
  distance += d
  lastAddAt = now
  if (++unsavedPoints >= 30) saveRoute()
}

// ---------- TrackBack ----------
function startBacktrack() {
  if (track.length < 2) return
  cum = [0]
  for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + distM(track[i - 1], track[i]))
  ti = track.length - 1
  arrived = false
  offRoute = false
  turnRel = 0
  if (current) {
    // start from the closest point on the route
    let best = Infinity
    for (let i = 0; i < track.length; i++) {
      const d = distM(current, track[i])
      if (d < best) { best = d; ti = i }
    }
  }
  state = 'backtrack'
  if (current) updateBacktrack()
}

function updateBacktrack() {
  if (!current || arrived) return

  if (distM(current, track[0]) < ARRIVED_M) {
    arrived = true
    remaining = 0
    buzz()
    layoutButtons()
    return
  }

  // shortcut: if you've rejoined the route closer to the start, jump ahead
  let nearestD = Infinity
  for (let i = 0; i <= ti; i++) {
    const d = distM(current, track[i])
    if (d < nearestD) nearestD = d
    if (d < SHORTCUT_M && i < ti) { ti = i; break }
  }
  while (ti > 0 && distM(current, track[ti]) < WAYPOINT_REACHED_M) ti--

  remaining = distM(current, track[ti]) + cum[ti]
  turnRel = ((bearing(current, track[ti]) - heading + 540) % 360) - 180

  const nowOff = nearestD > OFF_ROUTE_M
  if (nowOff && !offRoute) buzz()
  offRoute = nowOff
}

function turnHint() {
  if (!current) return ''
  if (!compassCalibrated && gpsHeading == null) {
    return 'Head ' + compassPoint(bearing(current, track[ti]))
  }
  if (Math.abs(turnRel) < TURN_STRAIGHT_DEG) return 'Straight ahead'
  if (Math.abs(turnRel) > TURN_AROUND_DEG) return 'Turn around'
  return (turnRel > 0 ? 'Turn right ' : 'Turn left ') + Math.round(Math.abs(turnRel)) + '°'
}

// Arrow flashes fast while a turn is coming up; while going straight it
// mostly stays on, with a brief blink every few seconds to confirm you're
// still on course.
function arrowVisible() {
  if (Math.abs(turnRel) >= TURN_STRAIGHT_DEG) return blinkTick % 2 === 0
  return blinkTick % 5 !== 4
}

function pickGridSpacing(scale) {
  let best = GRID_STEPS_M[0]
  let bestDiff = Infinity
  for (const step of GRID_STEPS_M) {
    const diff = Math.abs(step * scale - GRID_TARGET_PX)
    if (diff < bestDiff) { bestDiff = diff; best = step }
  }
  return best
}

// ---------- Drawing ----------
// The map is heading-up: everything is drawn relative to the current (or
// last known) position, rotated so "up" on screen matches `heading`.
function drawMap() {
  canvas.clear({ x: 0, y: 0, w: A, h: A })

  const viewer = current || (track.length ? track[track.length - 1] : null)
  if (!viewer) {
    canvas.drawText({
      x: A / 2 - 90, y: A / 2 - 15, text_size: 24, color: C_TEXT_DIM,
      text: gpsOk ? 'Ready' : 'Waiting for GPS',
    })
    return
  }

  const kx = 111320 * Math.cos(viewer.lat * RAD)
  const ky = 110540
  const cx = A / 2
  const cy = Math.round(A * VIEW_ANCHOR_FRAC)

  let maxOffset = MIN_VIEW_RADIUS_M
  for (const p of track) {
    const dE = (p.lon - viewer.lon) * kx
    const dN = (p.lat - viewer.lat) * ky
    const d = Math.sqrt(dE * dE + dN * dN)
    if (d > maxOffset) maxOffset = d
  }
  const scale = (A * 0.42) / maxOffset

  const h = heading * RAD
  const cosH = Math.cos(h), sinH = Math.sin(h)
  const rot = (dE, dN) => ({
    x: Math.round(cx + (dE * cosH - dN * sinH) * scale),
    y: Math.round(cy - (dE * sinH + dN * cosH) * scale),
  })
  const toXY = (p) => rot((p.lon - viewer.lon) * kx, (p.lat - viewer.lat) * ky)

  drawGrid(cx, cy, scale, cosH, sinH)

  const drawPath = (from, to, color, width) => {
    if (to - from < 1) return
    canvas.setPaint({ color, line_width: width })
    const step = Math.max(1, Math.ceil((to - from) / MAX_SEGMENTS))
    let prev = toXY(track[from])
    for (let i = from + step; ; i += step) {
      if (i > to) i = to
      const q = toXY(track[i])
      canvas.drawLine({ x1: prev.x, y1: prev.y, x2: q.x, y2: q.y, color })
      prev = q
      if (i === to) break
    }
  }

  if (state === 'backtrack') {
    drawPath(0, track.length - 1, C_ROUTE_DONE, 4)
    drawPath(0, ti, C_TODO, 5)
  } else if (track.length) {
    drawPath(0, track.length - 1, C_ROUTE, 4)
  }

  if (track.length) {
    const s = toXY(track[0])
    canvas.drawCircle({ center_x: s.x, center_y: s.y, radius: 8, color: C_START })
  }

  drawNorthTick(cx, cy, cosH, sinH)

  if (state === 'backtrack' && !arrived) {
    if (arrowVisible()) drawArrow(cx, cy)
  } else {
    canvas.drawCircle({ center_x: cx, center_y: cy, radius: 6, color: C_ME })
  }
}

function drawGrid(cx, cy, scale, cosH, sinH) {
  const spacing = pickGridSpacing(scale)
  const halfSpan = A / scale
  const lines = Math.ceil(halfSpan / spacing) + 1
  const rot = (dE, dN) => ({
    x: cx + (dE * cosH - dN * sinH) * scale,
    y: cy - (dE * sinH + dN * cosH) * scale,
  })
  canvas.setPaint({ color: C_GRID, line_width: 1 })
  for (let i = -lines; i <= lines; i++) {
    const o = i * spacing
    let p1 = rot(o, -halfSpan), p2 = rot(o, halfSpan)
    canvas.drawLine({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: C_GRID })
    p1 = rot(-halfSpan, o); p2 = rot(halfSpan, o)
    canvas.drawLine({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: C_GRID })
  }
}

function drawNorthTick(cx, cy, cosH, sinH) {
  const r = A * 0.46
  const x = cx + (0 * cosH - 1 * sinH) * r
  const y = cy - (0 * sinH + 1 * cosH) * r
  canvas.drawText({ x: Math.round(x - 8), y: Math.round(y - 10), text_size: 18, color: C_NORTH, text: 'N' })
}

function drawArrow(cx, cy) {
  const rad = turnRel * RAD // 0 = straight up on screen = "keep going"
  const pt = (ang, r) => ({
    x: Math.round(cx + r * Math.sin(ang)),
    y: Math.round(cy - r * Math.cos(ang)),
  })
  const tip = pt(rad, 18)
  canvas.drawPoly({
    data_array: [tip, pt(rad + 140 * RAD, 12), pt(rad - 140 * RAD, 12), tip],
    color: C_ME,
  })
}

function renderText() {
  let top = '', bottom = ''
  const gps = gpsOk ? '' : ' · no GPS'
  switch (state) {
    case 'idle':
      top = gpsOk ? 'GPS ready' : 'Searching GPS...'
      bottom = 'Press Start to record a route'
      break
    case 'tracking':
      top = 'REC ' + fmtTime(recElapsed()) + ' · ' + fmtDist(distance) + gps
      bottom = 'Recording route...'
      break
    case 'stopped':
      top = 'Stopped · ' + fmtDist(distance)
      bottom = 'Go Back to retrace it, or start a New Route'
      break
    case 'backtrack':
      if (arrived) {
        top = 'You are back!'
        bottom = 'Press New Route to walk again'
      } else {
        top = fmtDist(remaining) + ' to start' + gps
        bottom = (offRoute ? 'Off route · ' : '') + turnHint()
      }
      break
  }
  topText.setProperty(prop.TEXT, top)
  bottomText.setProperty(prop.TEXT, bottom)
  headingText.setProperty(prop.TEXT, headingLabel())
}

function render() {
  try {
    drawMap()
    renderText()
  } catch (e) {
    console.log('[tb] render FAILED: ' + e)
  }
}

function tick() {
  blinkTick++
  render()
}

// ---------- Actions & buttons ----------
function startRecording() {
  recStartedAt = Date.now()
  lastAddAt = Date.now()
  state = 'tracking'
  if (current) addPoint(current)
}
function stopRecording() {
  recAccum += Date.now() - recStartedAt
  state = 'stopped'
  saveRoute()
}
function endBacktrack() {
  state = 'stopped'
}
function onStartPressed() { startRecording(); layoutButtons(); render() }
function onStopPressed() { stopRecording(); layoutButtons(); render() }
function onGoBackPressed() { startBacktrack(); layoutButtons(); render() }
function onStopBacktrackPressed() { endBacktrack(); layoutButtons(); render() }
function onNewRoutePressed() { clearRoute(); startRecording(); layoutButtons(); render() }

function getButtons() {
  if (state === 'tracking') return [{ label: 'Stop', action: onStopPressed }]
  if (state === 'stopped') {
    return [
      { label: 'Go Back', action: onGoBackPressed },
      { label: 'New Route', action: onNewRoutePressed },
    ]
  }
  if (state === 'backtrack') {
    return arrived
      ? [{ label: 'New Route', action: onNewRoutePressed }]
      : [{ label: 'Stop', action: onStopBacktrackPressed }]
  }
  return [{ label: 'Start', action: onStartPressed }]
}

function layoutButtons() {
  const btns = getButtons()
  const btnH = Math.round(H * 0.13)
  const y = H - btnH - Math.round(H * 0.025)

  if (btns.length === 1) {
    const w = Math.round(W * 0.55)
    const x = Math.round((W - w) / 2)
    button1.setProperty(prop.MORE, { x, y, w, h: btnH, text: btns[0].label })
    button2.setProperty(prop.MORE, { x: 0, y: H + 40, w: 10, h: 10, text: '' })
    button1Action = btns[0].action
    button2Action = null
  } else {
    const sideMargin = Math.round(W * 0.06)
    const gap = Math.round(W * 0.03)
    const w = Math.round((W - sideMargin * 2 - gap) / 2)
    button1.setProperty(prop.MORE, { x: sideMargin, y, w, h: btnH, text: btns[0].label })
    button2.setProperty(prop.MORE, { x: sideMargin + w + gap, y, w, h: btnH, text: btns[1].label })
    button1Action = btns[0].action
    button2Action = btns[1].action
  }
}

function handleKey(key, event) {
  const isStart = START_KEYS.indexOf(key) !== -1
  const isBack = BACK_KEYS.indexOf(key) !== -1
  if (!isStart && !isBack) return false // leave other keys to the system
  if (event !== KEY_EVENT_CLICK) return true

  if (isStart) {
    if (button1Action) button1Action()
  } else if (isBack) {
    if (button2Action) button2Action()
    else if (state === 'idle') { exit(); return true }
  }
  return true
}

// ---------- Page ----------
Page({
  build() {
    const info = getDeviceInfo()
    W = info.width
    H = info.height
    A = Math.round(Math.min(W, H) * 0.55) // leaves room for text above and buttons below

    const topTextY = Math.round(H * 0.035)
    const topTextH = Math.round(H * 0.09)
    const hintTextY = topTextY + topTextH + Math.round(H * 0.01)
    const hintTextH = Math.round(H * 0.075)
    mapY = hintTextY + hintTextH + Math.round(H * 0.015)
    mapX = Math.round((W - A) / 2)

    topText = createWidget(widget.TEXT, {
      x: 0, y: topTextY, w: W, h: topTextH,
      text_size: 24, color: 0xffffff,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: '',
    })
    headingText = createWidget(widget.TEXT, {
      x: W - 100, y: 6, w: 92, h: 24,
      text_size: 15, color: C_TEXT_DIM,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: '',
    })
    bottomText = createWidget(widget.TEXT, {
      x: Math.round(W * 0.1), y: hintTextY, w: Math.round(W * 0.8), h: hintTextH,
      text_size: 18, color: C_TEXT_DIM,
      align_h: align.CENTER_H, align_v: align.TOP,
      text_style: text_style.WRAP,
      text: '',
    })
    canvas = createWidget(widget.CANVAS, { x: mapX, y: mapY, w: A, h: A })

    button1 = createWidget(widget.BUTTON, {
      x: 0, y: 0, w: 10, h: 10, text: '', text_size: 22,
      normal_color: 0x2979ff, press_color: 0x1a55cc, radius: 16,
      click_func: () => { if (button1Action) button1Action() },
    })
    button2 = createWidget(widget.BUTTON, {
      x: 0, y: 0, w: 10, h: 10, text: '', text_size: 22,
      normal_color: 0x455a64, press_color: 0x2c3a40, radius: 16,
      click_func: () => { if (button2Action) button2Action() },
    })

    storage = new LocalStorage()
    vibrator = new Vibrator()
    compass = new Compass()
    compass.onChange(() => {
      compassCalibrated = !!compass.getStatus()
      if (compassCalibrated) {
        const a = compass.getDirectionAngle()
        if (typeof a === 'number') { compassHeading = a; updateHeading() }
      }
    })
    safe(() => compass.start())

    geo = new Geolocation()
    geo.onChange(onGps)
    geo.start()

    loadRoute()
    layoutButtons()

    // keep the app on screen while you walk
    safe(() => setPageBrightTime({ brightTime: 60 * 60 * 1000 }))
    safe(() => setWakeUpRelaunch({ relaunch: true }))

    tickTimer = setInterval(tick, 1000)
    onKey({ callback: handleKey })
    render()
  },

  onDestroy() {
    if (state === 'tracking') stopRecording()
    else if (track.length) saveRoute()
    if (tickTimer) clearInterval(tickTimer)
    safe(() => geo.offChange(onGps))
    safe(() => geo.stop())
    safe(() => compass.stop())
    safe(() => offKey())
    safe(() => resetPageBrightTime())
  },
})
