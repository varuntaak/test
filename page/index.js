import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { Geolocation, Compass, Vibrator, VIBRATOR_SCENE_DURATION } from '@zos/sensor'
import { localStorage } from '@zos/storage'
import { getDeviceInfo } from '@zos/device'

const STORAGE_KEY = 'trackback_route'
const EARTH_RADIUS = 6371000 // m

const ARRIVE_RADIUS = 15 // m — close enough to a waypoint to count it as passed
const START_RADIUS = 12 // m — close enough to the start to end the walk
const DRIFT_RADIUS = 40 // m — trigger the off-route buzz past this distance
const MIN_POINT_DIST = 5 // m — minimum spacing between recorded route points
const LOOKAHEAD = 12 // waypoints to scan ahead for a "rejoined further along" skip
const VIBRATE_COOLDOWN = 15000 // ms between repeated drift buzzes

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function toRad(deg) {
  return (deg * Math.PI) / 180
}

function toDeg(rad) {
  return (rad * 180) / Math.PI
}

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const s1 = Math.sin(dLat / 2)
  const s2 = Math.sin(dLon / 2)
  const a = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)))
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2))
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1))
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// Signed difference target-minus-current in (-180, 180], positive = turn right.
function angleDiff(target, current) {
  return ((target - current + 540) % 360) - 180
}

function cardinal(bearingDeg) {
  return CARDINALS[Math.round(bearingDeg / 45) % 8]
}

// Flat-earth projection (meters) around the start point, good enough for a walk.
function project(lat, lon, lat0, lon0) {
  const x = toRad(lon - lon0) * Math.cos(toRad(lat0)) * EARTH_RADIUS
  const y = toRad(lat - lat0) * EARTH_RADIUS
  return { x: x, y: y }
}

Page({
  state: {
    mode: 'idle', // idle | recording | trackback | done
    route: [], // [{lat, lon}], route[0] is always the start point
    idx: 0, // trackback: index of the next route point still to reach, counting down to 0
  },

  gps: { lat: 0, lon: 0, valid: false },
  heading: { angle: 0, calibrated: false },
  lastDriftVibrate: 0,

  onInit() {
    const saved = localStorage.getItem(STORAGE_KEY, null)
    if (saved && saved.route && saved.route.length) {
      this.state = saved
    }
  },

  build() {
    const info = getDeviceInfo()
    this.W = info.width
    this.H = info.height

    this.canvas = createWidget(widget.CANVAS, { x: 0, y: 0, w: this.W, h: this.H })

    this.statusText = createWidget(widget.TEXT, {
      x: 10,
      y: Math.round(this.H * 0.06),
      w: this.W - 20,
      h: Math.round(this.H * 0.14),
      color: 0xffffff,
      text_size: 22,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text_style: text_style.WRAP,
      text: '',
    })

    this.dirText = createWidget(widget.TEXT, {
      x: 10,
      y: Math.round(this.H * 0.2),
      w: this.W - 20,
      h: Math.round(this.H * 0.16),
      color: 0xffcc33,
      text_size: 26,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text_style: text_style.WRAP,
      text: '',
    })

    this.actionBtnGeom = { x: Math.round(this.W / 2 - 85), y: this.H - 90, w: 170, h: 64 }
    this.actionBtn = createWidget(widget.BUTTON, Object.assign({}, this.actionBtnGeom, {
      radius: 32,
      text: '',
      text_size: 26,
      normal_color: 0x2277ff,
      press_color: 0x1a55cc,
      click_func: () => this.onActionClick(),
    }))

    this.resetBtnGeom = { x: this.W - 90, y: 10, w: 80, h: 44 }
    this.resetBtn = createWidget(widget.BUTTON, Object.assign({}, this.resetBtnGeom, {
      radius: 22,
      text: 'Reset',
      text_size: 18,
      normal_color: 0x882222,
      press_color: 0x661111,
      click_func: () => this.onResetClick(),
    }))

    this.geolocation = new Geolocation()
    this.onGpsChange = () => {
      if (this.geolocation.getStatus() === 'A') {
        this.gps.lat = this.geolocation.getLatitude()
        this.gps.lon = this.geolocation.getLongitude()
        this.gps.valid = true
      }
    }
    this.geolocation.onChange(this.onGpsChange)
    this.geolocation.start()

    this.compass = new Compass()
    this.onCompassChange = () => {
      this.heading.calibrated = !!this.compass.getStatus()
      if (this.heading.calibrated) {
        const angle = this.compass.getDirectionAngle()
        if (angle !== 'INVALID') this.heading.angle = angle
      }
    }
    this.compass.onChange(this.onCompassChange)
    this.compass.start()

    this.vibrator = new Vibrator()

    this.updateButtonLabel()
    this.render()

    this.tickCount = 0
    this.timer = setInterval(() => this.tick(), 1000)
  },

  onActionClick() {
    const mode = this.state.mode
    if (mode === 'idle' || mode === 'done') {
      if (!this.gps.valid) return
      this.state = {
        mode: 'recording',
        route: [{ lat: this.gps.lat, lon: this.gps.lon }],
        idx: 0,
      }
    } else if (mode === 'recording') {
      if (this.state.route.length < 2) return
      this.state.mode = 'trackback'
      this.state.idx = this.state.route.length - 1
    } else if (mode === 'trackback') {
      this.state.mode = 'idle'
    }
    this.save()
    this.updateButtonLabel()
    this.render()
  },

  onResetClick() {
    this.state = { mode: 'idle', route: [], idx: 0 }
    localStorage.removeItem(STORAGE_KEY)
    this.updateButtonLabel()
    this.render()
  },

  updateButtonLabel() {
    const labels = { idle: 'Start', recording: 'TrackBack', trackback: 'Stop', done: 'New Route' }
    this.actionBtn.setProperty(prop.MORE, Object.assign({}, this.actionBtnGeom, {
      text: labels[this.state.mode] || 'Start',
    }))
  },

  tick() {
    this.tickCount++
    const mode = this.state.mode

    if (mode === 'recording' && this.gps.valid) {
      const last = this.state.route[this.state.route.length - 1]
      const d = haversine(last.lat, last.lon, this.gps.lat, this.gps.lon)
      if (d >= MIN_POINT_DIST) {
        this.state.route.push({ lat: this.gps.lat, lon: this.gps.lon })
      }
    } else if (mode === 'trackback' && this.gps.valid) {
      this.updateTrackback()
    }

    if (this.tickCount % 5 === 0 || mode !== this.lastSavedMode) {
      this.save()
      this.lastSavedMode = mode
    }

    this.render()
  },

  // Advances state.idx toward 0 (the start). Scans a lookahead window so that
  // rejoining the route further along skips ahead instead of retracing it.
  updateTrackback() {
    const route = this.state.route
    const start = route[0]
    let idx = this.state.idx

    let advanced = true
    while (advanced && idx > 0) {
      advanced = false
      const lo = Math.max(0, idx - LOOKAHEAD)
      for (let j = lo; j <= idx; j++) {
        if (haversine(this.gps.lat, this.gps.lon, route[j].lat, route[j].lon) < ARRIVE_RADIUS) {
          idx = j - 1
          advanced = true
          break
        }
      }
    }
    if (idx < 0) idx = 0
    this.state.idx = idx

    const distStart = haversine(this.gps.lat, this.gps.lon, start.lat, start.lon)
    if (idx === 0 && distStart < START_RADIUS) {
      this.state.mode = 'done'
      this.buzz()
      this.save()
      return
    }

    let minDist = Infinity
    for (let i = 0; i <= idx; i++) {
      const d = haversine(this.gps.lat, this.gps.lon, route[i].lat, route[i].lon)
      if (d < minDist) minDist = d
    }
    const now = Date.now()
    if (minDist > DRIFT_RADIUS && now - this.lastDriftVibrate > VIBRATE_COOLDOWN) {
      this.buzz()
      this.lastDriftVibrate = now
    }
  },

  buzz() {
    this.vibrator.setMode(VIBRATOR_SCENE_DURATION)
    this.vibrator.start()
  },

  save() {
    localStorage.setItem(STORAGE_KEY, this.state)
  },

  render() {
    this.canvas.clear({ x: 0, y: 0, w: this.W, h: this.H })
    if (this.state.route.length) {
      this.drawMap()
    }
    this.updateTexts()
  },

  drawMap() {
    const route = this.state.route
    const mode = this.state.mode
    const start = route[0]
    const cx = Math.round(this.W / 2)
    const cy = Math.round(this.H * 0.6)

    const curLat = this.gps.valid ? this.gps.lat : route[route.length - 1].lat
    const curLon = this.gps.valid ? this.gps.lon : route[route.length - 1].lon

    let maxDist = 20
    const projPts = []
    for (let i = 0; i < route.length; i++) {
      const p = project(route[i].lat, route[i].lon, start.lat, start.lon)
      projPts.push(p)
      const d = Math.sqrt(p.x * p.x + p.y * p.y)
      if (d > maxDist) maxDist = d
    }
    const curProj = project(curLat, curLon, start.lat, start.lon)
    const curDist = Math.sqrt(curProj.x * curProj.x + curProj.y * curProj.y)
    if (curDist > maxDist) maxDist = curDist

    const usable = Math.min(this.W, this.H) * 0.36
    const scale = usable / maxDist

    const toScreen = (p) => ({ x: cx + p.x * scale, y: cy - p.y * scale })
    const screenPts = []
    for (let i = 0; i < projPts.length; i++) screenPts.push(toScreen(projPts[i]))
    const curScreen = toScreen(curProj)

    // Edges up to and including state.idx are the part still to walk during trackback.
    const orangeUpTo = mode === 'trackback' || mode === 'done' ? this.state.idx : -1

    this.canvas.setPaint({ color: 0x2ecc71, line_width: 4 })
    for (let i = 1; i < screenPts.length; i++) {
      const isOrange = orangeUpTo >= 0 && i <= orangeUpTo
      this.canvas.drawLine({
        x1: screenPts[i - 1].x,
        y1: screenPts[i - 1].y,
        x2: screenPts[i].x,
        y2: screenPts[i].y,
        color: isOrange ? 0xff8800 : 0x2ecc71,
      })
    }

    this.canvas.drawCircle({ center_x: screenPts[0].x, center_y: screenPts[0].y, radius: 8, color: 0x2277ff })

    if (mode === 'trackback') {
      this.drawArrow(curScreen)
    } else {
      this.canvas.drawCircle({ center_x: curScreen.x, center_y: curScreen.y, radius: 7, color: 0xffffff })
    }
  },

  drawArrow(pos) {
    const target = this.state.route[this.state.idx]
    const brg = bearing(this.gps.lat, this.gps.lon, target.lat, target.lon)
    const rad = toRad(brg)
    const len = 16
    const tipX = pos.x + Math.sin(rad) * len
    const tipY = pos.y - Math.cos(rad) * len
    this.canvas.setPaint({ color: 0xff8800, line_width: 5 })
    this.canvas.drawLine({ x1: pos.x, y1: pos.y, x2: tipX, y2: tipY, color: 0xff8800 })
    this.canvas.drawCircle({ center_x: tipX, center_y: tipY, radius: 5, color: 0xff8800 })
    this.canvas.drawCircle({ center_x: pos.x, center_y: pos.y, radius: 5, color: 0xffffff })
  },

  updateTexts() {
    const mode = this.state.mode
    let line1 = ''
    let line2 = ''

    if (mode === 'idle') {
      line2 = this.gps.valid ? 'Press Start to record a route' : 'Waiting for GPS...'
    } else {
      const start = this.state.route[0]
      const distStart = this.gps.valid
        ? haversine(this.gps.lat, this.gps.lon, start.lat, start.lon)
        : 0
      line1 = Math.round(distStart) + ' m from start'

      if (mode === 'recording') {
        line2 = 'Recording route...'
      } else if (mode === 'done') {
        line2 = 'You are back!'
      } else if (mode === 'trackback' && this.gps.valid) {
        const target = this.state.route[this.state.idx]
        const brg = bearing(this.gps.lat, this.gps.lon, target.lat, target.lon)
        if (this.heading.calibrated) {
          const diff = angleDiff(brg, this.heading.angle)
          if (Math.abs(diff) < 15) {
            line2 = 'Straight ahead'
          } else if (diff > 0) {
            line2 = 'Turn right ' + Math.round(diff) + '°'
          } else {
            line2 = 'Turn left ' + Math.round(-diff) + '°'
          }
        } else {
          line2 = 'Head ' + cardinal(brg)
        }
      }
    }

    this.statusText.setProperty(prop.MORE, { text: line1 })
    this.dirText.setProperty(prop.MORE, { text: line2 })
  },

  onDestroy() {
    if (this.timer) clearInterval(this.timer)
    if (this.geolocation) {
      this.geolocation.offChange(this.onGpsChange)
      this.geolocation.stop()
    }
    if (this.compass) {
      this.compass.offChange(this.onCompassChange)
      this.compass.stop()
    }
    this.save()
  },
})
