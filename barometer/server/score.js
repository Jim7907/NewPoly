/**
 * Score: one demand index (0–100) per brand family, per ZIP3, per horizon, plus
 * opportunity detection (clusters of hot cells). Rules-plus-weights, transparent
 * by design: every index carries the list of contributions that produced it.
 */
const db = require('./db')
const grid = require('./grid')
const normalise = require('./normalise')
const { BRANDS, HORIZONS, DETECT, shape } = require('./config')
const log = require('./log')
const feeds = require('./feeds')

const FAMILY_KEY = (brand, family) => `${brand}:${family}`

/** Weights may be refitted from holdout results; those overrides live in settings. */
function weightsFor(brand, family) {
  const overrides = db.setting(`weights:${brand}:${family}`, null)
  return BRANDS[brand].families[family].signals.map(s => ({ ...s, weight: overrides && overrides[s.metric] != null ? overrides[s.metric] : s.weight }))
}

function scoreCell(cellMetrics, signals, horizon, expected) {
  let num = 0, den = 0; const drivers = []
  for (const s of signals) {
    if (!s.horizons.includes(horizon)) continue
    if (!expected.has(s.metric)) continue            // no enabled feed produces it: leave it out of the denominator
    den += s.weight
    const h = cellMetrics && cellMetrics.get(s.metric); const rec = h && h.get(horizon)
    if (!rec) continue
    const pressure = shape(s.shape, rec.value); if (pressure == null) continue
    const c = pressure * rec.fresh * s.weight
    num += c
    drivers.push({ metric: s.metric, value: rec.value, pressure: +pressure.toFixed(3), fresh: +rec.fresh.toFixed(2), weight: s.weight, contribution: +c.toFixed(2), feed: rec.feed, observedAt: rec.observedAt, meta: rec.meta || null })
  }
  if (den === 0) return { idx: 0, drivers: [] }
  const idx = Math.round(100 * num / den)
  const total = drivers.reduce((a, d) => a + d.contribution, 0) || 1
  drivers.forEach(d => { d.share = +(100 * d.contribution / total).toFixed(1) })
  drivers.sort((a, b) => b.contribution - a.contribution)
  return { idx, drivers }
}

function computeAll() {
  const t0 = Date.now()
  const { byCell, measured, byFeed } = normalise.snapshot()
  const expected = feeds.expectedMetrics(measured, byFeed)
  const now = new Date().toISOString()
  let n = 0
  db.tx(() => {
    db.run('DELETE FROM cell_scores')
    for (const [brand, b] of Object.entries(BRANDS)) {
      for (const [family] of Object.entries(b.families)) {
        const signals = weightsFor(brand, family)
        const key = FAMILY_KEY(brand, family)
        for (const horizon of Object.keys(HORIZONS)) {
          for (const c of grid.all()) {
            const { idx, drivers } = scoreCell(byCell.get(c.zip3), signals, horizon, expected)
            db.run('INSERT INTO cell_scores(brand,zip3,horizon,idx,drivers,computed_at) VALUES(?,?,?,?,?,?)', [key, c.zip3, horizon, idx, JSON.stringify(drivers), now])
            n++
          }
        }
      }
    }
  })
  log.info('score', `${n} cell scores in ${Date.now() - t0}ms; expected ${expected.size} metrics, measured ${measured.size}`)
  return { cells: n, measured: [...measured], expected: [...expected] }
}

// ---------- opportunity detection ----------
const TITLES = {
  aqi: 'Air quality event', pm25_fc: 'Smoke plume forecast', fires: 'Wildfire activity', alert_air: 'Air quality alert',
  pollen: 'Pollen peak', fp_pm25: 'Indoor air degrading', fp_filter: 'Filter replacement window',
  dew_point_f: 'Dry indoor air', rh: 'Dry indoor air', temp_min_f: 'Cold snap', ili: 'Flu activity rising', fp_run: 'Device use surging',
  power_price_c: 'High electricity prices', power_yoy: 'Electricity prices climbing', temp_max_f: 'Heat wave', alert_heat: 'Heat advisory',
  food_yoy: 'Grocery inflation', recipe_velocity: 'Recipe trend surge', fp_cook: 'Cooking at home surging',
  cal_newyear: 'New year reset', cal_backtoschool: 'Back to school', cal_shedding: 'Shedding season'
}
function titleFor(drivers) {
  const top = drivers[0]; if (!top) return 'Demand building'
  const second = drivers[1]
  if (second && second.share > 25 && TITLES[second.metric] && TITLES[top.metric]) return `${TITLES[top.metric]} and ${TITLES[second.metric].toLowerCase()}`
  return TITLES[top.metric] || 'Demand building'
}
const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'Washington DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' }

function cluster(cells) {
  const parent = new Map(cells.map(c => [c.zip3, c.zip3]))
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a, b) => parent.set(find(a), find(b))
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    if (grid.haversineKm(cells[i].lat, cells[i].lon, cells[j].lat, cells[j].lon) <= DETECT.clusterKm) union(cells[i].zip3, cells[j].zip3)
  }
  const groups = new Map()
  for (const c of cells) { const r = find(c.zip3); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c) }
  return [...groups.values()]
}

function forecastFor(brand, family, idx, cellCount, horizon) {
  const f = BRANDS[brand].families[family]
  const days = horizon === 'act' ? 7 : 5
  const holdoutCells = new Set(db.all('SELECT zip3 FROM holdout').map(r => r.zip3))
  const units = Math.round(f.baselineDailyUnitsPerCell * cellCount * f.elasticity * (idx / 100) * days)
  return { units, revenue: Math.round(units * f.avgPrice), days, basis: 'baseline units × elasticity × index × days; replaced by backtested elasticity once sales history is loaded', holdoutNote: holdoutCells.size ? `${holdoutCells.size} holdout cells excluded from activation` : 'no holdout locked yet' }
}

function detect() {
  const now = new Date().toISOString()
  const found = []
  for (const [brand, b] of Object.entries(BRANDS)) {
    for (const [family] of Object.entries(b.families)) {
      const key = FAMILY_KEY(brand, family)
      for (const horizon of ['act', 'schedule']) {
        const rows = db.all('SELECT zip3, idx, drivers FROM cell_scores WHERE brand=? AND horizon=? AND idx>=?', [key, horizon, DETECT.cellThreshold])
        const cells = rows.map(r => ({ ...grid.get(r.zip3), idx: r.idx, drivers: db.parse(r.drivers, []) }))
        const groups = cluster(cells)
        // an outlying cell of the same event (same top driver, overlapping states) joins the main cluster
        const topOf = (g) => { const agg = {}; for (const c of g) for (const d of c.drivers) agg[d.metric] = (agg[d.metric] || 0) + d.share; return Object.entries(agg).sort((a, b) => b[1] - a[1])[0]?.[0] }
        for (let i = 0; i < groups.length; i++) for (let j = groups.length - 1; j > i; j--) {
          const si = new Set(groups[i].map(c => c.state)); if (topOf(groups[i]) === topOf(groups[j]) && groups[j].some(c => si.has(c.state))) { groups[i].push(...groups[j]); groups.splice(j, 1) }
        }
        for (const group of groups) {
          const maxIdx = Math.max(...group.map(c => c.idx))
          if (group.length < DETECT.minCells && maxIdx < DETECT.singleCellThreshold) continue
          const mean = group.reduce((a, c) => a + c.idx, 0) / group.length
          const idx = Math.round(0.6 * maxIdx + 0.4 * mean)
          // aggregate drivers across the cluster
          const agg = new Map()
          for (const c of group) for (const d of c.drivers) { const a = agg.get(d.metric) || { metric: d.metric, share: 0, value: 0, n: 0, feed: d.feed }; a.share += d.share; a.value += d.value; a.n++; agg.set(d.metric, a) }
          const drivers = [...agg.values()].map(a => ({ metric: a.metric, share: +(a.share / group.length).toFixed(1), value: +(a.value / a.n).toFixed(1), feed: a.feed, cells: a.n })).sort((x, y) => y.share - x.share)
          const states = [...new Set(group.map(c => c.state))].sort((x, y) => group.filter(c => c.state === y).length - group.filter(c => c.state === x).length)
          const signature = `${key}|${horizon}|${states.slice(0, 3).join(',')}|${drivers[0] ? drivers[0].metric : ''}`
          found.push({
            brand, family, key, horizon, idx, zip3s: group.map(c => c.zip3).sort(), states, drivers, signature,
            title: titleFor(drivers), where: states.slice(0, 4).map(s => STATE_NAMES[s] || s).join(' · ') + (states.length > 4 ? ` · +${states.length - 4}` : ''),
            forecast: forecastFor(brand, family, idx, group.length, horizon)
          })
        }
      }
    }
  }
  // one opportunity per signature (keep the strongest), then upsert; fade ones that disappeared
  const bySig = new Map()
  for (const o of found) { const cur = bySig.get(o.signature); if (!cur || o.idx > cur.idx || (o.idx === cur.idx && o.zip3s.length > cur.zip3s.length)) bySig.set(o.signature, o) }
  found.length = 0; found.push(...bySig.values())
  const open = db.all("SELECT id, signature, status FROM opportunities WHERE status NOT IN ('done','dismissed','faded')")
  const seen = new Set()
  db.tx(() => {
    for (const o of found) {
      const ex = open.find(x => x.signature === o.signature)
      seen.add(o.signature)
      if (ex) {
        db.run('UPDATE opportunities SET title=?, where_text=?, zip3s=?, states=?, idx=?, drivers=?, forecast=?, updated_at=? WHERE id=?',
          [o.title, o.where, JSON.stringify(o.zip3s), JSON.stringify(o.states), o.idx, JSON.stringify(o.drivers), JSON.stringify(o.forecast), now, ex.id])
      } else {
        const id = 'opp_' + Math.random().toString(36).slice(2, 10)
        db.run('INSERT INTO opportunities(id,brand,title,where_text,zip3s,states,idx,horizon,status,drivers,forecast,signature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, o.key, o.title, o.where, JSON.stringify(o.zip3s), JSON.stringify(o.states), o.idx, o.horizon, 'detected', JSON.stringify(o.drivers), JSON.stringify(o.forecast), o.signature, now, now])
        db.audit('system', 'opportunity.detected', { id, brand: o.key, title: o.title, idx: o.idx, cells: o.zip3s.length })
      }
    }
    for (const ex of open) {
      if (!seen.has(ex.signature) && !['live', 'scheduled'].includes(ex.status)) db.run("UPDATE opportunities SET status='faded', updated_at=? WHERE id=?", [now, ex.id])
    }
  })
  log.info('score', `${found.length} opportunities detected`)
  return found
}

function ladderLabel(idx) { let l = DETECT.ladder[0][1]; for (const [t, name] of DETECT.ladder) if (idx >= t) l = name; return l }

module.exports = { computeAll, detect, scoreCell, weightsFor, ladderLabel, FAMILY_KEY, STATE_NAMES, TITLES }
