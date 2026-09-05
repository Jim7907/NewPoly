/**
 * PurpleAir low-cost sensors — dense coverage. Needs PURPLEAIR_API_KEY. Readings are corrected with
 * the EPA equation used on the AirNow Fire and Smoke Map (Barkjohn et al. 2022):
 *   PM2.5 = 0.524 × PA_cf1 − 0.0862 × RH + 5.75, capped at the sensor's linear range.
 */
const grid = require('../grid')
const { getJson } = require('./http')
function epaCorrect(cf1, rh) { if (cf1 == null) return null; const v = 0.524 * Math.min(cf1, 300) - 0.0862 * (rh ?? 50) + 5.75; return Math.max(0, v) }
module.exports = {
  id: 'purpleair', name: 'PurpleAir sensors', family: 'environmental', cadence: '25 * * * *', requires: 'PURPLEAIR_API_KEY', metrics: ['pm25'],
  epaCorrect,
  async fetch() {
    const data = await getJson('https://api.purpleair.com/v1/sensors', {
      headers: { 'X-API-Key': process.env.PURPLEAIR_API_KEY },
      params: { fields: 'latitude,longitude,pm2.5_cf_1,humidity,last_seen', location_type: 0, max_age: 3600, nwlng: -125, nwlat: 50, selng: -66, selat: 24 }
    })
    const idx = Object.fromEntries((data.fields || []).map((f, i) => [f, i]))
    const acc = new Map()
    for (const row of data.data || []) {
      const lat = row[idx.latitude], lon = row[idx.longitude]; if (lat == null || lon == null) continue
      const v = epaCorrect(row[idx['pm2.5_cf_1']], row[idx.humidity]); if (v == null) continue
      const { cell, km } = grid.nearest(lat, lon); if (!cell || km > 60) continue
      const a = acc.get(cell.zip3) || { sum: 0, n: 0 }; a.sum += v; a.n += 1; acc.set(cell.zip3, a)
    }
    const now = new Date().toISOString(); const out = []
    for (const [zip3, a] of acc) if (a.n >= 3) out.push({ metric: 'pm25', geo: { kind: 'zip3', key: zip3 }, value: +(a.sum / a.n).toFixed(1), unit: 'ug/m3', observedAt: now, meta: { sensors: a.n, corrected: 'EPA' } })
    return out
  }
}
