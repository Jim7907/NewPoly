/** EPA AirNow — reference-grade monitors, whole US in one bounding-box call. Needs AIRNOW_API_KEY (free). Overrides the model AQI where a monitor is close. */
const grid = require('../grid')
const { getJson } = require('./http')
module.exports = {
  id: 'epa_airnow', name: 'EPA AirNow monitors', family: 'environmental', cadence: '15 * * * *', requires: 'AIRNOW_API_KEY', metrics: ['aqi'],
  async fetch() {
    const data = await getJson('https://www.airnowapi.org/aq/data/', { params: {
      parameters: 'PM25', BBOX: '-125,24,-66,50', dataType: 'A', format: 'application/json', verbose: 0, monitorType: 0, includerawconcentrations: 0, API_KEY: process.env.AIRNOW_API_KEY
    } })
    const out = []; const now = new Date().toISOString()
    const best = new Map()
    for (const m of data || []) {
      if (m.AQI == null || m.AQI < 0) continue
      const { cell, km } = grid.nearest(m.Latitude, m.Longitude); if (!cell || km > 60) continue
      const cur = best.get(cell.zip3); if (!cur || m.AQI > cur.aqi) best.set(cell.zip3, { aqi: m.AQI, km, at: m.UTC })
    }
    for (const [zip3, v] of best) out.push({ metric: 'aqi', geo: { kind: 'zip3', key: zip3 }, value: v.aqi, unit: 'USAQI', observedAt: v.at ? v.at + ':00Z' : now, meta: { source: 'monitor', km: +v.km.toFixed(1) } })
    return out
  }
}
