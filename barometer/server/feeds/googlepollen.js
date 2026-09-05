/** Google Pollen API — 5-day species-level forecast. Needs GOOGLE_MAPS_API_KEY. One call per cell, once a day (891 calls). Universal Pollen Index 0–5. */
const grid = require('../grid')
const { getJson, sleep } = require('./http')
module.exports = {
  id: 'google_pollen', name: 'Google Pollen forecast', family: 'environmental', cadence: '10 5 * * *', requires: 'GOOGLE_MAPS_API_KEY', metrics: ['pollen'],
  async fetch() {
    const out = []; const now = new Date().toISOString()
    for (const c of grid.all()) {
      try {
        const data = await getJson('https://pollen.googleapis.com/v1/forecast:lookup', { params: { key: process.env.GOOGLE_MAPS_API_KEY, 'location.latitude': c.lat, 'location.longitude': c.lon, days: 5 } })
        const days = data.dailyInfo || []
        const upi = (d) => Math.max(0, ...((d.pollenTypeInfo || []).map(p => (p.indexInfo && p.indexInfo.value) || 0)))
        const act = Math.max(0, ...days.slice(0, 3).map(upi)); const sched = Math.max(0, ...days.slice(3, 5).map(upi))
        const top = (d) => (d.pollenTypeInfo || []).sort((a, b) => ((b.indexInfo && b.indexInfo.value) || 0) - ((a.indexInfo && a.indexInfo.value) || 0))[0]
        const t0 = days[0] && top(days[0])
        out.push({ metric: 'pollen', geo: { kind: 'zip3', key: c.zip3 }, value: act, unit: 'UPI', horizonHours: 72, observedAt: now, meta: { type: t0 && t0.displayName } })
        if (days.length > 3) out.push({ metric: 'pollen', geo: { kind: 'zip3', key: c.zip3 }, value: sched, unit: 'UPI', horizonHours: 120, observedAt: now })
      } catch (e) { /* one cell failing must not stop the feed */ }
      await sleep(60)
    }
    return out
  }
}
