// TrackBack for Zepp OS (Amazfit Active Max) — API_LEVEL 3.0+
// Replace page/index.js of a project created with `zeus create`.
//
// Buttons (Garmin-style):
//   START  : start recording -> stop recording -> start TrackBack -> end TrackBack
//   BACK   : (idle) exit app  | (stopped) resume recording | (TrackBack) end TrackBack
//   HOLD BACK while stopped   : discard route and start fresh
//
// Screen: north-up map. Green = your route, blue dot = start,
// white dot = you. In TrackBack the route turns grey, the part still
// to walk is orange, and you become an arrow pointing to the next waypoint.
//
// app.json -> "permissions" must include:
//   "device:os.geolocation", "device:os.compass", "device:os.local_storage"

import { createWidget, widget, align, prop, text_style } from '@zos/ui'
import {
  onKey, offKey,
  KEY_UP, KEY_DOWN, KEY_SELECT, KEY_BACK, KEY_SHORTCUT,
  KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS,
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
const MIN_MAP_SPAN_M = 150   // don't zoom in closer than this
const MAX_SEGMENTS = 400     // draw at most this many line segments
const SAVE_KEY = 'trackback_route'

// ---------- Colors ----------
const C_ROUTE = 0x00c853
const C_ROUTE_DONE = 0x555555
const C_TODO = 0xff9100
const C_START = 0x2979ff
const C_ME = 0xffffff
const C_TEXT_DIM = 0x9e9e9e

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

let geo, compass, vibrator, storage, tickTimer
let W, H, A, mapX, mapY
let canvas, topText, bottomText

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
  current = { lat, lon }

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
  if (current) {
    // start from the closest point on the route
    let best = Infinity
    for (let i = 0; i < track.length; i++) {
      const d = distM(current, track[i])
      if (d < best) { best = d; ti = i }
    }
  }
  safe(() => compass.start())
  state = 'backtrack'
  if (current) updateBacktrack()
}

function updateBacktrack() {
  if (!current || arrived) return

  if (distM(current, track[0]) < ARRIVED_M) {
    arrived = true
    remaining = 0
    buzz()
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

  const nowOff = nearestD > OFF_ROUTE_M
  if (nowOff && !offRoute) buzz()
  offRoute = nowOff
}

function turnHint() {
  if (!current) return ''
  const brg = bearing(current, track[ti])
  let heading = 'INVALID'
  safe(() => { if (compass.getStatus()) heading = compass.getDirectionAngle() })
  if (typeof heading !== 'number') return 'Head ' + compassPoint(brg)
  const rel = ((brg - heading + 540) % 360) - 180
  if (Math.abs(rel) < 20) return 'Straight ahead'
  if (Math.abs(rel) > 150) return 'Turn around'
  return (rel > 0 ? 'Turn right ' : 'Turn left ') + Math.round(Math.abs(rel)) + '°'
}

// ---------- Drawing ----------
function drawMap() {
  canvas.clear({ x: 0, y: 0, w: A, h: A })

  const pts = current ? track.concat([current]) : track
  if (!pts.length) {
    canvas.drawText({
      x: A / 2 - 90, y: A / 2 - 15, text_size: 24, color: C_TEXT_DIM,
      text: gpsOk ? 'Ready' : 'Waiting for GPS',
    })
    return
  }

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  const lat0 = (minLat + maxLat) / 2
  const lon0 = (minLon + maxLon) / 2
  const kx = 111320 * Math.cos(lat0 * RAD)
  const ky = 110540
  const span = Math.max((maxLon - minLon) * kx, (maxLat - minLat) * ky, MIN_MAP_SPAN_M)
  const scale = (A - 30) / span
  const toXY = (p) => ({
    x: Math.round(A / 2 + (p.lon - lon0) * kx * scale),
    y: Math.round(A / 2 - (p.lat - lat0) * ky * scale),
  })

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
    if (current && !arrived) {
      const a = toXY(current), b = toXY(track[ti])
      canvas.setPaint({ color: C_TODO, line_width: 2 })
      canvas.drawLine({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: C_TODO })
    }
  } else {
    drawPath(0, track.length - 1, C_ROUTE, 4)
  }

  if (track.length) {
    const s = toXY(track[0])
    canvas.drawCircle({ center_x: s.x, center_y: s.y, radius: 8, color: C_START })
  }

  if (current) {
    const c = toXY(current)
    if (state === 'backtrack' && !arrived) {
      const deg = bearing(current, track[ti])
      const pt = (ang, r) => ({
        x: Math.round(c.x + r * Math.sin(ang * RAD)),
        y: Math.round(c.y - r * Math.cos(ang * RAD)),
      })
      const tip = pt(deg, 16)
      canvas.drawPoly({
        data_array: [tip, pt(deg + 140, 11), pt(deg - 140, 11), tip],
        color: C_ME,
      })
    } else {
      canvas.drawCircle({ center_x: c.x, center_y: c.y, radius: 6, color: C_ME })
    }
  }
}

function renderText() {
  let top = '', bottom = ''
  const gps = gpsOk ? '' : ' · no GPS'
  switch (state) {
    case 'idle':
      top = gpsOk ? 'GPS ready' : 'Searching GPS...'
      bottom = 'Start = record route'
      break
    case 'tracking':
      top = 'REC ' + fmtTime(recElapsed()) + ' · ' + fmtDist(distance) + gps
      bottom = 'Start = stop'
      break
    case 'stopped':
      top = 'Stopped · ' + fmtDist(distance)
      bottom = 'Start = TrackBack\nBack = resume · Hold = new'
      break
    case 'backtrack':
      if (arrived) {
        top = 'You are back!'
        bottom = 'Start = done'
      } else {
        top = fmtDist(remaining) + ' to start' + gps
        bottom = (offRoute ? 'Off route · ' : '') + turnHint()
      }
      break
  }
  topText.setProperty(prop.TEXT, top)
  bottomText.setProperty(prop.TEXT, bottom)
}

function render() {
  drawMap()
  renderText()
}

// ---------- Buttons ----------
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
  safe(() => compass.stop())
  state = 'stopped'
}

function handleKey(key, event) {
  const isStart = START_KEYS.indexOf(key) !== -1
  const isBack = BACK_KEYS.indexOf(key) !== -1
  if (!isStart && !isBack) return false // leave other keys to the system

  if (isStart && event === KEY_EVENT_CLICK) {
    if (state === 'idle') startRecording()
    else if (state === 'tracking') stopRecording()
    else if (state === 'stopped') startBacktrack()
    else if (state === 'backtrack') endBacktrack()
  }

  if (isBack && event === KEY_EVENT_CLICK) {
    if (state === 'idle') { exit(); return true }
    if (state === 'stopped') startRecording()
    else if (state === 'backtrack') endBacktrack()
    // while recording, Back does nothing so you can't quit by accident
  }

  if (isBack && event === KEY_EVENT_LONG_PRESS && state === 'stopped') {
    clearRoute()
    state = 'idle'
  }

  render()
  return true
}

// ---------- Page ----------
Page({
  build() {
    const info = getDeviceInfo()
    W = info.width
    H = info.height
    A = Math.round(Math.min(W, H) * 0.68) // square map that fits a round screen
    mapX = Math.round((W - A) / 2)
    mapY = Math.round((H - A) / 2)

    topText = createWidget(widget.TEXT, {
      x: 0, y: mapY - 48, w: W, h: 44,
      text_size: 24, color: 0xffffff,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: '',
    })
    canvas = createWidget(widget.CANVAS, { x: mapX, y: mapY, w: A, h: A })
    bottomText = createWidget(widget.TEXT, {
      x: Math.round(W * 0.15), y: mapY + A + 2, w: Math.round(W * 0.7), h: 56,
      text_size: 20, color: C_TEXT_DIM,
      align_h: align.CENTER_H, align_v: align.TOP,
      text_style: text_style.WRAP,
      text: '',
    })

    storage = new LocalStorage()
    vibrator = new Vibrator()
    compass = new Compass()
    geo = new Geolocation()
    geo.onChange(onGps)
    geo.start()

    loadRoute()

    // keep the app on screen while you walk
    safe(() => setPageBrightTime({ brightTime: 60 * 60 * 1000 }))
    safe(() => setWakeUpRelaunch({ relaunch: true }))

    tickTimer = setInterval(renderText, 1000)
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
