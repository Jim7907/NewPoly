/**
 * Normalise: put every observation onto the ZIP3 grid, then keep one value per
 * (metric, cell, horizon window) with a freshness factor. This is the only place
 * geography and staleness are handled; the scorer never sees raw feeds.
 */
const db = require('./db')
const grid = require('./grid')
const { FRESHNESS, HORIZONS } = require('./config')

// When two feeds report the same metric for a cell, the higher-priority feed wins.
const FEED_PRIORITY = { epa_airnow: 3, purpleair: 2, openmeteo_aq: 1 }

function windowFor(horizon, horizonHours) {
  // Slow-moving series (weekly / monthly / calendar) are stored with horizonHours 0 and apply to every horizon.
  if (horizonHours === 0) return true
  const [lo, hi] = HORIZONS[horizon].hours
  return horizonHours > lo && horizonHours <= hi
}

function freshness(metric, observedAt, nowMs) {
  const f = FRESHNESS[metric]; if (!f) return 1
  const age = (nowMs - Date.parse(observedAt)) / 3600000
  if (age <= f[0]) return 1
  if (age >= f[1]) return 0
  return 1 - (age - f[0]) / (f[1] - f[0])
}

/**
 * Returns { byCell: Map<zip3, Map<metric, Map<horizon, {value, fresh, feed, observedAt, meta}>>>,
 *           measured: Set<metric> }   — metrics with any observation anywhere.
 */
function snapshot(nowMs = Date.now()) {
  const rows = db.all('SELECT feed, metric, geo_kind, geo_key, lat, lon, value, horizon_hours, observed_at, meta FROM observations')
  const byCell = new Map(); const measured = new Set(); const byFeed = new Map()
  const put = (zip3, metric, horizon, rec) => {
    let m = byCell.get(zip3); if (!m) { m = new Map(); byCell.set(zip3, m) }
    let h = m.get(metric); if (!h) { h = new Map(); m.set(metric, h) }
    const cur = h.get(horizon)
    if (!cur) { h.set(horizon, rec); return }
    const pa = FEED_PRIORITY[rec.feed] || 0, pb = FEED_PRIORITY[cur.feed] || 0
    if (pa > pb || (pa === pb && rec.value > cur.value)) h.set(horizon, rec)
  }
  for (const r of rows) {
    measured.add(r.metric); if (!byFeed.has(r.feed)) byFeed.set(r.feed, new Set()); byFeed.get(r.feed).add(r.metric)
    const fresh = freshness(r.metric, r.observed_at, nowMs); if (fresh <= 0) continue
    const rec = { value: r.value, fresh, feed: r.feed, observedAt: r.observed_at, horizonHours: r.horizon_hours, meta: db.parse(r.meta) }
    let cells
    if (r.geo_kind === 'zip3') { const c = grid.get(r.geo_key); cells = c ? [c] : [] }
    else if (r.geo_kind === 'state') cells = grid.inState(r.geo_key)
    else if (r.geo_kind === 'national') cells = grid.all()
    else if (r.geo_kind === 'point') { const n = grid.nearest(r.lat, r.lon); cells = n.cell && n.km <= 60 ? [n.cell] : [] }
    else cells = []
    for (const horizon of Object.keys(HORIZONS)) {
      if (!windowFor(horizon, r.horizon_hours)) continue
      for (const c of cells) put(c.zip3, r.metric, horizon, rec)
    }
  }
  return { byCell, measured, byFeed }
}

module.exports = { snapshot, freshness, windowFor, FEED_PRIORITY }
