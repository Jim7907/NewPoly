/** NASA FIRMS active fire detections (VIIRS, last 24h, USA). Needs FIRMS_MAP_KEY (free). Counted per cell within 150 km, distance-weighted. */
const grid = require('../grid')
const { getText } = require('./http')
module.exports = {
  id: 'nasa_firms', name: 'NASA FIRMS fire detections', family: 'environmental', cadence: '40 */2 * * *', requires: 'FIRMS_MAP_KEY', metrics: ['fires'],
  async fetch() {
    const csv = await getText(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${process.env.FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/USA/1`)
    const lines = csv.trim().split('\n'); const head = lines.shift().split(',')
    const iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude'), iFrp = head.indexOf('frp'), iConf = head.indexOf('confidence')
    const counts = new Map()
    for (const line of lines) {
      const c = line.split(','); const lat = +c[iLat], lon = +c[iLon]
      if (!lat || !lon) continue
      if (iConf >= 0 && /^l/i.test(c[iConf])) continue  // drop low-confidence
      const frp = iFrp >= 0 ? +c[iFrp] || 1 : 1
      for (const { cell, km } of grid.within(lat, lon, 150)) {
        const w = (1 - km / 150) * Math.min(3, Math.max(1, Math.log10(frp + 1)))
        counts.set(cell.zip3, (counts.get(cell.zip3) || 0) + w)
      }
    }
    const now = new Date().toISOString()
    return [...counts].map(([zip3, v]) => ({ metric: 'fires', geo: { kind: 'zip3', key: zip3 }, value: +v.toFixed(2), unit: 'weighted detections', observedAt: now }))
  }
}
