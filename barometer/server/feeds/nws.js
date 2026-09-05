/**
 * National Weather Service active alerts — no key. Alerts carry a polygon or a
 * list of UGC zones; we place polygon alerts on the cells they cover and fall
 * back to the state for zone-only alerts. Severity: Minor 1, Moderate 2, Severe/Extreme 3.
 */
const grid = require('../grid')
const { getJson } = require('./http')

const URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update'
const KINDS = [
  { metric: 'alert_air',  match: /air quality|air stagnation|smoke|dense smoke/i },
  { metric: 'alert_heat', match: /heat/i },
  { metric: 'alert_fire', match: /red flag|fire weather/i },
  { metric: 'alert_cold', match: /wind chill|extreme cold|freeze|frost|cold weather/i }
]
const SEV = { Minor: 1, Moderate: 2, Severe: 3, Extreme: 3, Unknown: 1 }

function inPolygon(lat, lon, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

module.exports = {
  id: 'nws_alerts', name: 'NWS active alerts', family: 'environmental', cadence: '*/20 * * * *', requires: null, metrics: ['alert_air','alert_heat','alert_fire','alert_cold'],
  async fetch() {
    const data = await getJson(URL, { headers: { Accept: 'application/geo+json' } })
    const out = []; const now = new Date().toISOString()
    const best = new Map() // metric|zip3 -> {value, meta}
    const put = (metric, zip3, value, meta) => {
      const k = metric + '|' + zip3
      if (!best.has(k) || best.get(k).value < value) best.set(k, { metric, zip3, value, meta })
    }
    for (const f of data.features || []) {
      const p = f.properties || {}
      const kind = KINDS.find(k => k.match.test(p.event || ''))
      if (!kind) continue
      const sev = SEV[p.severity] || 1
      const meta = { event: p.event, area: (p.areaDesc || '').slice(0, 120), ends: p.ends || p.expires }
      let placed = false
      if (f.geometry && f.geometry.type === 'Polygon') {
        const ring = f.geometry.coordinates[0]
        for (const c of grid.all()) if (inPolygon(c.lat, c.lon, ring)) { put(kind.metric, c.zip3, sev, meta); placed = true }
      }
      if (!placed) {
        const ugc = (p.geocode && p.geocode.UGC) || []
        const states = [...new Set(ugc.map(z => z.slice(0, 2)))]
        for (const st of states) for (const c of grid.inState(st)) put(kind.metric, c.zip3, sev, meta)
      }
    }
    for (const { metric, zip3, value, meta } of best.values()) out.push({ metric, geo: { kind: 'zip3', key: zip3 }, value, unit: 'severity', observedAt: now, meta })
    return out
  }
}
