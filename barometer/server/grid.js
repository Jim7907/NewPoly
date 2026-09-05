/**
 * The national ZIP3 grid. Every signal, whatever its native geography, is
 * resolved onto these 891 cells before it is scored. Generated from Census
 * files by scripts/build-zip3.py and committed.
 */
const cells = require('./data/zip3.json')
const byZip = new Map(cells.map(c => [c.zip3, c]))
const byState = new Map()
for (const c of cells) { if (!byState.has(c.state)) byState.set(c.state, []); byState.get(c.state).push(c) }

const R = 6371
function haversineKm(lat1, lon1, lat2, lon2) {
  const toR = (d) => d * Math.PI / 180
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Nearest cell to a point. Linear scan over 891 cells is ~50µs; fine. */
function nearest(lat, lon) {
  let best = null, bestD = Infinity
  for (const c of cells) {
    const d = haversineKm(lat, lon, c.lat, c.lon)
    if (d < bestD) { bestD = d; best = c }
  }
  return { cell: best, km: bestD }
}

/** Cells within a radius of a point — used to spread a point observation (a fire, a monitor). */
function within(lat, lon, km) {
  const out = []
  for (const c of cells) { const d = haversineKm(lat, lon, c.lat, c.lon); if (d <= km) out.push({ cell: c, km: d }) }
  return out.sort((a, b) => a.km - b.km)
}

/** Neighbouring cells for opportunity clustering — anything within `km`. */
function neighbours(zip3, km = 160) {
  const c = byZip.get(zip3); if (!c) return []
  return within(c.lat, c.lon, km).filter(x => x.cell.zip3 !== zip3).map(x => x.cell)
}

/** A representative sample of cells for feeds that are polled per point (Open-Meteo). One
 *  probe per cell would be 891 calls; we probe every cell but batch them 100 at a time. */
function all() { return cells }
function get(zip3) { return byZip.get(zip3) || null }
function inState(state) { return byState.get(state) || [] }
function states() { return [...byState.keys()].sort() }

module.exports = { all, get, inState, states, nearest, within, neighbours, haversineKm }
