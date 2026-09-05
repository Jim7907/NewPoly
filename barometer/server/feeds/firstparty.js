/**
 * First-party device signals — the Levoit/VeSync fleet connection is deliberately left OPEN.
 *
 * Nothing here talks to VeSync's IoT platform. Instead the platform exposes
 *   POST /api/firstparty/readings   (see routes/firstparty.js and README "First-party adapter")
 * which accepts readings ALREADY AGGREGATED to ZIP3 by whoever owns the device data. This feed
 * turns the last 6 hours of those readings into signals, enforcing the privacy floor: a cell is
 * scored only if it carries at least PRIVACY.minDevicesPerCell devices.
 *
 * Metrics accepted: indoor_pm25 (µg/m³, already corrected), filter_life_pct, run_hours_delta_pct,
 * cook_sessions_delta_pct. Anything else is stored but ignored by the score.
 */
const db = require('../db')
const { PRIVACY } = require('../config')
const MAP = { indoor_pm25: 'fp_pm25', filter_life_pct: 'fp_filter', run_hours_delta_pct: 'fp_run', cook_sessions_delta_pct: 'fp_cook' }
module.exports = {
  id: 'firstparty', name: 'VeSync device fleet (open adapter)', family: 'firstparty', cadence: '*/15 * * * *', requires: null, metrics: ['fp_pm25','fp_filter','fp_run','fp_cook'], presentOnly: true,
  async fetch() {
    const since = new Date(Date.now() - 6 * 3600000).toISOString()
    const rows = db.all(`SELECT zip3, metric, value, device_count, observed_at FROM firstparty_readings WHERE observed_at >= ? ORDER BY observed_at DESC`, [since])
    const seen = new Set(); const out = []
    for (const r of rows) {
      const metric = MAP[r.metric]; if (!metric) continue
      if (r.device_count < PRIVACY.minDevicesPerCell) continue      // below the floor: never scored, never counted as seen
      const k = metric + '|' + r.zip3; if (seen.has(k)) continue; seen.add(k)
      out.push({ metric, geo: { kind: 'zip3', key: r.zip3 }, value: r.value, observedAt: r.observed_at, meta: { devices: r.device_count } })
    }
    return out
  }
}
