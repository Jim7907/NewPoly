/**
 * Measurement: what the spend added, not what the weather did.
 *
 * Treated cells (the plan's cells) against the locked holdout cells, difference-in-differences on
 * daily units from the `sales` table: lift = (treated_post / treated_pre) / (control_post / control_pre) − 1.
 * The confidence interval is a bootstrap over treated cells. Sales arrive by POST /api/sales
 * (Data Kiosk export, retail feeds, or a CSV) — nothing here is estimated without them.
 */
const db = require('./db')
const holdout = require('./holdout')
const { BRANDS } = require('./config')
const { splitKey } = require('./plans')

function dailyUnits(brand, zip3s, from, to) {
  if (!zip3s.length) return new Map()
  const q = `SELECT zip3, day, SUM(units) AS u, SUM(revenue) AS r FROM sales WHERE brand=? AND day>=? AND day<=? AND zip3 IN (${zip3s.map(() => '?').join(',')}) GROUP BY zip3, day`
  const rows = db.all(q, [brand, from, to, ...zip3s])
  const m = new Map(); for (const r of rows) { if (!m.has(r.zip3)) m.set(r.zip3, []); m.get(r.zip3).push({ day: r.day, units: r.u, revenue: r.r }) }
  return m
}
const dayStr = (d) => new Date(d).toISOString().slice(0, 10)
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000)

function results(planId, opts = {}) {
  const plan = db.get('SELECT * FROM plans WHERE id=?', [planId]); if (!plan) throw new Error('plan not found')
  const opp = db.get('SELECT * FROM opportunities WHERE id=?', [plan.opportunity_id])
  const { brand, family } = splitKey(plan.brand)
  const fam = BRANDS[brand].families[family]
  const cells = db.parse(opp.zip3s, [])
  const held = [...holdout.set()]
  const launched = plan.launched_at || plan.approved_at || plan.created_at
  const days = opts.days || db.parse(opp.forecast, {}).days || 7
  const preFrom = dayStr(addDays(launched, -14)), preTo = dayStr(addDays(launched, -1))
  const postFrom = dayStr(launched), postTo = dayStr(addDays(launched, days))
  const T = dailyUnits(brand, cells, preFrom, postTo), C = dailyUnits(brand, held, preFrom, postTo)
  const sum = (m, from, to, k = 'units') => { let s = 0; for (const rows of m.values()) for (const r of rows) if (r.day >= from && r.day <= to) s += r[k]; return s }
  const perCell = (m, from, to) => [...m.entries()].map(([z, rows]) => ({ z, v: rows.filter(r => r.day >= from && r.day <= to).reduce((a, r) => a + r.units, 0) }))
  const tPre = sum(T, preFrom, preTo), tPost = sum(T, postFrom, postTo), cPre = sum(C, preFrom, preTo), cPost = sum(C, postFrom, postTo)
  const hasData = tPre > 0 && cPre > 0
  const series = []
  for (let d = new Date(preFrom); dayStr(d) <= postTo; d = addDays(d, 1)) {
    const day = dayStr(d)
    const t = [...T.values()].flat().filter(r => r.day === day).reduce((a, r) => a + r.units, 0)
    const c = [...C.values()].flat().filter(r => r.day === day).reduce((a, r) => a + r.units, 0)
    series.push({ day, treated: t, control: c, phase: day < postFrom ? 'pre' : 'campaign' })
  }
  if (!hasData) return { planId, hasData: false, note: 'no sales rows for the treated or holdout cells in this window; POST /api/sales to load Data Kiosk or retail exports', window: { preFrom, preTo, postFrom, postTo }, treatedCells: cells.length, holdoutCells: held.length, series }
  const ratio = (cPost / cPre) || 1
  const counterfactual = tPre * ratio
  const lift = tPost / counterfactual - 1
  // bootstrap over treated cells
  const preC = perCell(T, preFrom, preTo), postC = perCell(T, postFrom, postTo)
  const N = preC.length; const lifts = []
  let s = 11; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  for (let b = 0; b < 500; b++) {
    let p = 0, q = 0
    for (let i = 0; i < N; i++) { const k = Math.floor(rnd() * N); p += preC[k].v; q += postC[k] ? postC[k].v : 0 }
    if (p > 0) lifts.push(q / (p * ratio) - 1)
  }
  lifts.sort((a, b) => a - b)
  const ci = lifts.length ? [lifts[Math.floor(lifts.length * 0.05)], lifts[Math.floor(lifts.length * 0.95)]] : [null, null]
  const incUnits = Math.round(tPost - counterfactual)
  const incRevenue = Math.round(incUnits * fam.avgPrice)
  const spend = plan.budget
  const writes = db.all('SELECT channel, amount FROM writes WHERE plan_id=? AND status IN ("sent","undone")', [planId])
  const byChannel = writes.map(w => ({ channel: w.channel, spend: w.amount, share: +(w.amount / Math.max(1, spend)).toFixed(3), note: 'incremental revenue is attributed by spend share; per-channel holdouts are a later phase' }))
  const caveats = []; if (cells.length < 5) caveats.push(`only ${cells.length} treated cell(s): the interval is not reliable below 5`); if (Date.parse(postTo) > Date.now()) caveats.push('campaign window still open; figures are partial')
  return { planId, hasData: true, caveats, window: { preFrom, preTo, postFrom, postTo }, treatedCells: cells.length, holdoutCells: held.length,
    lift: +lift.toFixed(4), ci90: ci.map(x => x == null ? null : +x.toFixed(4)), significant: ci[0] != null && ci[0] > 0,
    treated: { pre: tPre, post: tPost }, control: { pre: cPre, post: cPost }, counterfactual: Math.round(counterfactual),
    incrementalUnits: incUnits, incrementalRevenue: incRevenue, spend, roas: spend ? +(incRevenue / spend).toFixed(2) : null, byChannel, series }
}

/** Refit: nudge each signal's weight toward how well its pressure lined up with measured lift across finished plans. Bounded, logged, reversible. */
function refit(brandKey) {
  const { brand, family } = splitKey(brandKey)
  const fam = BRANDS[brand].families[family]
  const plans = db.all("SELECT id FROM plans WHERE brand=? AND status IN ('live','done','killed')", [brandKey])
  const rows = []
  for (const p of plans) { const r = results(p.id); if (!r.hasData) continue; const opp = db.get('SELECT drivers FROM opportunities WHERE id=(SELECT opportunity_id FROM plans WHERE id=?)', [p.id]); rows.push({ lift: r.lift, drivers: db.parse(opp.drivers, []) }) }
  if (rows.length < 3) return { refit: false, reason: `need at least 3 measured plans, have ${rows.length}` }
  const current = db.setting(`weights:${brand}:${family}`, Object.fromEntries(fam.signals.map(s => [s.metric, s.weight])))
  const next = { ...current }
  for (const sig of fam.signals) {
    const xs = rows.map(r => (r.drivers.find(d => d.metric === sig.metric) || { share: 0 }).share / 100), ys = rows.map(r => r.lift)
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length
    const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), vx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), vy = ys.reduce((a, y) => a + (y - my) ** 2, 0)
    const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0
    next[sig.metric] = Math.max(1, Math.round(current[sig.metric] * (1 + 0.1 * corr)))
  }
  db.setSetting(`weights:${brand}:${family}`, next)
  db.audit('system', 'weights.refit', { brand: brandKey, from: current, to: next, plans: rows.length })
  return { refit: true, plans: rows.length, from: current, to: next }
}

module.exports = { results, refit }
