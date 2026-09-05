require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cron = require('node-cron')
const path = require('path')
const fs = require('fs')
const db = require('./db')
const log = require('./log')
const grid = require('./grid')
const feeds = require('./feeds')
const score = require('./score')
const holdout = require('./holdout')
const inventory = require('./inventory')
const plans = require('./plans')
const creative = require('./creative')
const channels = require('./channels')
const measure = require('./measure')
const firstparty = require('./firstparty')
const demo = require('./demo')
const { BRANDS, HORIZONS, CHANNELS, ROUTING, MONEY, PRIVACY, DETECT } = require('./config')

const PORT = process.env.PORT || 3003
const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '25mb' }))

const actor = (req) => req.get('x-actor') || (req.body && req.body.actor) || 'web'
const wrap = (fn) => async (req, res) => { try { res.json(await fn(req, res)) } catch (e) { res.status(400).json({ error: e.message }) } }
const oppFull = (id) => {
  const o = db.get('SELECT * FROM opportunities WHERE id=?', [id]); if (!o) throw new Error('opportunity not found')
  const cells = db.parse(o.zip3s, [])
  const held = holdout.set()
  return { ...o, zip3s: cells, states: db.parse(o.states, []), drivers: db.parse(o.drivers, []), forecast: db.parse(o.forecast, {}),
    label: score.ladderLabel(o.idx), holdoutCells: cells.filter(z => held.has(z)).length,
    cells: cells.map(z => ({ ...grid.get(z), idx: (db.get('SELECT idx FROM cell_scores WHERE brand=? AND zip3=? AND horizon=?', [o.brand, z, o.horizon]) || {}).idx })),
    creatives: creative.forOpportunity(id), plans: db.all('SELECT id, status, budget, created_at, approved_at, launched_at, undo_until FROM plans WHERE opportunity_id=? ORDER BY created_at DESC', [id]) }
}

// ---------- pipeline ----------
let scoring = false
async function pipeline(reason) {
  if (scoring) return; scoring = true
  try {
    score.computeAll(); score.detect()
    // draft creative for anything new, a few per cycle so a burst of opportunities cannot stall the loop
    const fresh = db.all("SELECT id FROM opportunities WHERE status='detected' AND id NOT IN (SELECT opportunity_id FROM briefs) ORDER BY idx DESC LIMIT 5")
    for (const o of fresh) { try { await creative.generate(o.id, 'system') } catch (e) { log.warn('creative', e.message) } }
    // expire the undo window on live plans is implicit (checked at stop time); mark finished plans done
    const ended = db.all("SELECT id, launched_at, opportunity_id FROM plans WHERE status='live'")
    for (const p of ended) { const opp = db.get('SELECT forecast FROM opportunities WHERE id=?', [p.opportunity_id]); const days = db.parse(opp && opp.forecast, {}).days || 7
      if (Date.now() - Date.parse(p.launched_at) > days * 86400000) { db.run("UPDATE plans SET status='done', ended_at=? WHERE id=?", [new Date().toISOString(), p.id]); db.run("UPDATE opportunities SET status='done' WHERE id=?", [p.opportunity_id]) } }
    db.persist()
  } catch (e) { log.error('pipeline', e.message) } finally { scoring = false }
}

// ---------- routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }))
app.get('/api/status', wrap(() => ({
  feeds: feeds.status(), channels: channels.status(), firstparty: firstparty.status(), holdoutCells: holdout.set().size,
  killSwitch: plans.killSwitch(), liveWrites: channels.liveWrites(), creativeModel: creative.MODEL, creativeEnabled: !!process.env.ANTHROPIC_API_KEY,
  spendToday: plans.liveSpendToday(), money: MONEY, privacy: PRIVACY, detect: DETECT, gridCells: grid.all().length,
  lastScore: (db.get('SELECT MAX(computed_at) AS at FROM cell_scores') || {}).at,
  counts: { opportunities: db.get("SELECT COUNT(*) AS n FROM opportunities WHERE status NOT IN ('faded','dismissed','done')").n, plansLive: db.get("SELECT COUNT(*) AS n FROM plans WHERE status='live'").n, awaiting: db.get("SELECT COUNT(*) AS n FROM plans WHERE status='awaiting_approval'").n, heldWrites: db.get("SELECT COUNT(*) AS n FROM writes WHERE status='held'").n }
})))
app.get('/api/brands', wrap(() => Object.entries(BRANDS).map(([id, b]) => ({ id, name: b.name, color: b.color, families: Object.entries(b.families).map(([fid, f]) => ({ id: fid, key: `${id}:${fid}`, name: f.name, skus: f.skus, signals: score.weightsFor(id, fid), claims: f.claims, avgPrice: f.avgPrice, elasticity: f.elasticity })), routing: ROUTING[id] }))))
app.get('/api/config', wrap(() => ({ horizons: HORIZONS, channels: CHANNELS, money: MONEY, detect: DETECT })))

app.get('/api/feeds', wrap(() => feeds.status()))
app.post('/api/feeds/run', wrap(async (req) => { const id = req.query.id; const out = id ? [await feeds.runFeed(feeds.FEEDS.find(f => f.id === id))] : await feeds.runAll(); pipeline('manual'); return out }))
app.post('/api/feeds/manual', wrap((req) => { const obs = req.body.observations || []; const cur = db.setting('manual_observations', []); const now = new Date().toISOString()
  for (const o of obs) { if (!o.metric || !o.geo || o.value == null) throw new Error('each observation needs metric, geo, value'); o.observedAt = o.observedAt || now }
  db.setSetting('manual_observations', [...cur, ...obs]); db.audit(actor(req), 'feeds.manual', { count: obs.length }); return { stored: obs.length } }))
app.post('/api/score/run', wrap(async () => { await pipeline('manual'); return { ok: true } }))

app.get('/api/grid', wrap((req) => {
  const brand = req.query.brand || 'levoit:air', horizon = req.query.horizon || 'act'
  const idx = new Map(db.all('SELECT zip3, idx FROM cell_scores WHERE brand=? AND horizon=?', [brand, horizon]).map(r => [r.zip3, r.idx]))
  const held = holdout.set()
  return { brand, horizon, cells: grid.all().map(c => ({ zip3: c.zip3, state: c.state, lat: c.lat, lon: c.lon, idx: idx.get(c.zip3) ?? 0, holdout: held.has(c.zip3) })) }
}))
app.get('/api/grid/states', wrap((req) => {
  const brand = req.query.brand || 'levoit:air', horizon = req.query.horizon || 'act'
  const rows = db.all('SELECT zip3, idx FROM cell_scores WHERE brand=? AND horizon=?', [brand, horizon])
  const acc = new Map(); for (const r of rows) { const c = grid.get(r.zip3); if (!c) continue; const a = acc.get(c.state) || { state: c.state, max: 0, sum: 0, n: 0 }; a.max = Math.max(a.max, r.idx); a.sum += r.idx; a.n++; acc.set(c.state, a) }
  return [...acc.values()].map(a => ({ state: a.state, max: a.max, mean: Math.round(a.sum / a.n), cells: a.n, label: score.ladderLabel(a.max) }))
}))
app.get('/api/grid/:zip3', wrap((req) => { const c = grid.get(req.params.zip3); if (!c) throw new Error('unknown zip3')
  const scores = db.all('SELECT brand, horizon, idx, drivers FROM cell_scores WHERE zip3=?', [c.zip3]).map(r => ({ ...r, drivers: db.parse(r.drivers, []) }))
  return { ...c, holdout: holdout.set().has(c.zip3), scores } }))

app.get('/api/opportunities', wrap((req) => {
  const st = req.query.status; const brand = req.query.brand
  const rows = db.all(`SELECT * FROM opportunities WHERE 1=1 ${st ? 'AND status=?' : "AND status NOT IN ('faded','dismissed','done')"} ${brand ? 'AND brand LIKE ?' : ''} ORDER BY idx DESC, updated_at DESC`, [...(st ? [st] : []), ...(brand ? [brand + '%'] : [])])
  return rows.map(o => ({ ...o, zip3s: db.parse(o.zip3s, []), states: db.parse(o.states, []), drivers: db.parse(o.drivers, []), forecast: db.parse(o.forecast, {}), label: score.ladderLabel(o.idx),
    creativeCount: db.get('SELECT COUNT(*) AS n FROM creatives WHERE opportunity_id=?', [o.id]).n, approvedCreatives: db.get("SELECT COUNT(*) AS n FROM creatives WHERE opportunity_id=? AND status='approved'", [o.id]).n,
    channels: Object.keys(ROUTING[o.brand.split(':')[0]] || {}).length, plan: db.get('SELECT id, status, budget FROM plans WHERE opportunity_id=? ORDER BY created_at DESC LIMIT 1', [o.id]) }))
}))
app.get('/api/opportunities/:id', wrap((req) => oppFull(req.params.id)))
app.post('/api/opportunities/:id/dismiss', wrap((req) => { db.run("UPDATE opportunities SET status='dismissed', updated_at=? WHERE id=?", [new Date().toISOString(), req.params.id]); db.audit(actor(req), 'opportunity.dismissed', { id: req.params.id }); return { ok: true } }))
app.post('/api/opportunities/:id/creatives', wrap((req) => creative.generate(req.params.id, actor(req))))
app.patch('/api/creatives/:id', wrap((req) => creative.update(req.params.id, req.body, actor(req))))
app.post('/api/creatives/:id/status', wrap((req) => creative.setStatus(req.params.id, req.body.status, actor(req))))
app.post('/api/claims/check', wrap((req) => creative.checkClaims(req.body.text || '', req.body.brand || 'levoit:air')))

app.post('/api/opportunities/:id/plan', wrap((req) => plans.build(req.params.id, { budget: req.body.budget, notes: req.body.notes, actor: actor(req) })))
app.get('/api/plans', wrap((req) => plans.list(req.query.status)))
app.get('/api/plans/:id', wrap((req) => { const p = plans.get(req.params.id); if (!p) throw new Error('plan not found'); return p }))
app.post('/api/plans/:id/approve', wrap((req) => plans.approve(req.params.id, actor(req))))
app.post('/api/plans/:id/launch', wrap((req) => plans.launch(req.params.id, actor(req), channels)))
app.post('/api/plans/:id/stop', wrap((req) => plans.stop(req.params.id, actor(req), channels, req.body.reason)))
app.post('/api/writes/:id/release', wrap((req) => plans.release(req.params.id, actor(req), channels)))
app.get('/api/plans/:id/results', wrap((req) => measure.results(req.params.id, { days: req.query.days ? Number(req.query.days) : undefined })))
app.post('/api/measure/refit', wrap((req) => measure.refit(req.body.brand)))

app.get('/api/channels', wrap(() => channels.status()))
app.get('/api/inventory', wrap((req) => inventory.list(req.query.brand)))
app.post('/api/inventory', wrap((req) => ({ updated: inventory.upsert(req.body.rows || [], req.body.source || 'manual') })))
app.post('/api/inventory/sync-amazon', wrap(() => inventory.amazon.sync()))
app.get('/api/holdout', wrap(() => holdout.list()))
app.post('/api/sales', wrap((req) => { const rows = req.body.rows || []; let n = 0
  db.tx(() => { for (const r of rows) { if (!r.brand || !r.zip3 || !r.day) continue; db.run('INSERT INTO sales(brand,sku,zip3,day,units,revenue,source) VALUES(?,?,?,?,?,?,?)', [r.brand, r.sku || null, String(r.zip3).padStart(3, '0'), r.day, Number(r.units) || 0, Number(r.revenue) || 0, req.body.source || 'import']); n++ } })
  db.audit(actor(req), 'sales.imported', { rows: n }); return { imported: n } }))

app.get('/api/firstparty/status', wrap(() => firstparty.status()))
app.post('/api/firstparty/readings', wrap((req) => {
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!process.env.FIRSTPARTY_INGEST_TOKEN || tok !== process.env.FIRSTPARTY_INGEST_TOKEN) { const e = new Error('unauthorized: set FIRSTPARTY_INGEST_TOKEN and send it as a Bearer token'); throw e }
  const r = firstparty.ingest(req.body.readings); db.audit('firstparty', 'firstparty.ingest', r); return r
}))

app.get('/api/audit', wrap((req) => db.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', [Number(req.query.limit) || 100]).map(a => ({ ...a, detail: db.parse(a.detail) }))))
app.post('/api/settings/kill-switch', wrap((req) => ({ killSwitch: plans.setKillSwitch(!!req.body.on, actor(req)) })))
app.post('/api/demo/seed', wrap((req) => { if (req.body.confirm !== 'DEMO') throw new Error('send {"confirm":"DEMO"} to load synthetic sales and inventory'); return demo.seed() }))
app.post('/api/demo/clear', wrap(() => demo.clear()))

// built UI
const dist = path.join(__dirname, '../dist')
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html'))) }

// ---------- boot ----------
;(async () => {
  await db.init()
  inventory.seedCatalog()
  holdout.ensure()
  app.listen(PORT, () => log.info('http', `Barometer on :${PORT} — live writes ${channels.liveWrites() ? 'ON' : 'off'}, creative model ${creative.MODEL}${process.env.ANTHROPIC_API_KEY ? '' : ' (no key: templates)'}`))
  feeds.schedule(() => pipeline('feed'))
  cron.schedule('*/15 * * * *', () => pipeline('cron'))
  // first run in the background so the UI is up immediately
  feeds.runAll().then(() => pipeline('boot')).catch(e => log.error('boot', e.message))
})()
