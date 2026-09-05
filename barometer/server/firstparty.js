/**
 * First-party ingest — the open end of the platform.
 *
 * Whoever owns the VeSync device data (the IoT platform team) aggregates readings to ZIP3
 * on their side and POSTs them here. Barometer never receives a device id, a household, or
 * a raw coordinate. The contract:
 *
 *   POST /api/firstparty/readings
 *   Authorization: Bearer <FIRSTPARTY_INGEST_TOKEN>
 *   { "readings": [ { "zip3": "972", "brand": "levoit", "metric": "indoor_pm25",
 *                     "value": 41.2, "deviceCount": 1840, "observedAt": "2026-09-05T14:00:00Z" }, ... ] }
 *
 * Accepted metrics: indoor_pm25 (µg/m³, corrected), filter_life_pct, run_hours_delta_pct,
 * cook_sessions_delta_pct. Rows below the privacy floor are accepted but never scored.
 */
const db = require('./db')
const grid = require('./grid')
const { PRIVACY } = require('./config')

const METRICS = new Set(['indoor_pm25', 'filter_life_pct', 'run_hours_delta_pct', 'cook_sessions_delta_pct'])

function ingest(readings) {
  if (!Array.isArray(readings)) throw new Error('readings must be an array')
  const now = new Date().toISOString()
  let accepted = 0, belowFloor = 0; const rejected = []
  db.tx(() => {
    readings.forEach((r, i) => {
      const zip3 = String(r.zip3 || '').padStart(3, '0')
      if (!grid.get(zip3)) return rejected.push({ i, reason: `unknown zip3 ${zip3}` })
      if (!METRICS.has(r.metric)) return rejected.push({ i, reason: `unknown metric ${r.metric}` })
      const value = Number(r.value); const devices = Number(r.deviceCount)
      if (!Number.isFinite(value)) return rejected.push({ i, reason: 'value must be a number' })
      if (!Number.isInteger(devices) || devices < 0) return rejected.push({ i, reason: 'deviceCount must be a non-negative integer' })
      const at = r.observedAt ? new Date(r.observedAt) : new Date()
      if (Number.isNaN(at.getTime())) return rejected.push({ i, reason: 'observedAt is not a date' })
      db.run('INSERT INTO firstparty_readings(zip3,brand,metric,value,device_count,observed_at,received_at) VALUES(?,?,?,?,?,?,?)',
        [zip3, r.brand || null, r.metric, value, devices, at.toISOString(), now])
      accepted++
      if (devices < PRIVACY.minDevicesPerCell) belowFloor++
    })
    // keep 7 days
    db.run("DELETE FROM firstparty_readings WHERE observed_at < ?", [new Date(Date.now() - 7 * 86400000).toISOString()])
  })
  return { accepted, belowFloor, rejected, privacyFloor: PRIVACY.minDevicesPerCell }
}

function status() {
  const r = db.get('SELECT COUNT(*) AS n, MAX(observed_at) AS latest, COUNT(DISTINCT zip3) AS cells FROM firstparty_readings')
  const scored = db.get('SELECT COUNT(DISTINCT zip3) AS cells FROM firstparty_readings WHERE device_count >= ?', [PRIVACY.minDevicesPerCell])
  return { connected: (r && r.n > 0) || false, readings: r ? r.n : 0, cells: r ? r.cells : 0, cellsAboveFloor: scored ? scored.cells : 0, latest: r ? r.latest : null, privacyFloor: PRIVACY.minDevicesPerCell, metrics: [...METRICS] }
}

module.exports = { ingest, status, METRICS }
