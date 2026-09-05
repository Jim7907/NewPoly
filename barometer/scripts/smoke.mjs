/**
 * End-to-end smoke test against a running Barometer (default http://localhost:3004).
 * Loads demo data, simulates a smoke event over OR + WA through the manual signal feed,
 * and drives one opportunity through creative → plan → gate → approve → launch → undo → results.
 * Safe to run on a fresh install: writes stay dry-run unless LIVE_WRITES=true on the server.
 *   node scripts/smoke.mjs [baseUrl] [firstpartyToken]
 */
const B = (process.argv[2] || 'http://localhost:3004') + '/api'
const TOKEN = process.argv[3] || process.env.FIRSTPARTY_INGEST_TOKEN || 'test-token'
const j = async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d }
const get = (p) => fetch(B + p).then(j)
const post = (p, b, h = {}) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-actor': 'smoke', ...h }, body: JSON.stringify(b || {}) }).then(j)
const patch = (p, b) => fetch(B + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j)
const step = (n, v) => console.log('▸', n, typeof v === 'string' ? v : JSON.stringify(v).slice(0, 240))
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m) }

const st = await get('/status'); step('status', { grid: st.gridCells, holdout: st.holdoutCells, live: st.liveWrites, feeds: st.feeds.filter(f => f.enabled).length, model: st.creativeModel })
assert(st.gridCells === 891, 'grid has 891 cells'); assert(st.holdoutCells >= 20 && st.holdoutCells <= 25, 'holdout 20–25 cells')
step('demo seed', await post('/demo/seed', { confirm: 'DEMO' }))
const obs = []
for (const s of ['OR', 'WA']) { obs.push({ metric: 'aqi', geo: { kind: 'state', key: s }, value: 178 }, { metric: 'pm25_fc', geo: { kind: 'state', key: s }, value: 130, horizonHours: 24 }, { metric: 'alert_air', geo: { kind: 'state', key: s }, value: 3 }, { metric: 'fires', geo: { kind: 'state', key: s }, value: 18 }) }
step('manual signals', await post('/feeds/manual', { observations: obs }))
step('poll manual', await post('/feeds/run?id=manual'))
await new Promise(r => setTimeout(r, 2000))
const opps = await get('/opportunities'); step('opportunities', opps.map(o => `${o.brand} ${o.idx} ${o.title} [${o.where_text}] cells=${o.zip3s.length} creatives=${o.creativeCount}`))
const opp = opps.find(o => o.brand === 'levoit:air'); assert(opp, 'a levoit:air opportunity was detected'); assert(opp.idx >= 55, 'index above threshold')
const full = await get(`/opportunities/${opp.id}`); step('drivers', full.drivers.map(d => `${d.metric} ${d.share}%`).join(', ')); step('brief.angle', full.creatives.brief && full.creatives.brief.angle); step('creatives', full.creatives.creatives.map(c => `${c.format}:${c.status} "${c.headline}"`))
assert(full.creatives.creatives.length === 8, '8 creatives drafted')
const bad = await post('/claims/check', { text: 'Protect your family from flu with HEPA', brand: 'levoit:air' }); step('claim check (bad copy)', bad); assert(!bad.pass, 'health language is blocked')
const cr = full.creatives.creatives[0]
step('approve creative', (await post(`/creatives/${cr.id}/status`, { status: 'approved' })).status)
const edited = await patch(`/creatives/${cr.id}`, { headline: 'Kills germs and prevents flu' }); step('edit with denied words ->', edited.status); assert(edited.status === 'blocked', 'denied words block the creative')
await patch(`/creatives/${cr.id}`, { headline: cr.headline }); await post(`/creatives/${cr.id}/status`, { status: 'approved' })
const plan = await post(`/opportunities/${opp.id}/plan`, {}); step('plan', { id: plan.id, budget: plan.budget, gate: plan.gate.summary, lines: plan.lines.map(l => `${l.channel} $${l.amount}${l.holdsForPerson ? ' HOLD' : ''}`), holdoutExcluded: plan.gate.holdoutExcluded })
step('gate checks', plan.gate.checks.map(c => `${c.sku} cover=${c.coverDays}d ${c.status}${c.rerouteTo ? '→' + c.rerouteTo : ''}`))
assert(plan.gate.checks.some(c => c.status === 'hold' && c.rerouteTo), 'thin SKU is held and rerouted')
try { await post(`/plans/${plan.id}/launch`); assert(false, 'launch before approval must fail') } catch (e) { step('launch before approve ->', e.message) }
await post('/settings/kill-switch', { on: true })
try { await post(`/plans/${plan.id}/approve`); assert(false, 'approve under kill switch must fail') } catch (e) { step('approve under kill switch ->', e.message) }
await post('/settings/kill-switch', { on: false })
step('approve', (await post(`/plans/${plan.id}/approve`)).status)
const launched = await post(`/plans/${plan.id}/launch`); step('launch', { status: launched.status, undoUntil: launched.undo_until, writes: launched.writes.map(w => `${w.channel}:${w.status}${w.dry_run ? '(dry)' : ''}`) })
assert(launched.status === 'live', 'plan is live'); assert(launched.writes.every(w => w.dry_run), 'every write is dry-run without LIVE_WRITES')
const held = launched.writes.find(w => w.status === 'held'); if (held) step('release held write', (await post(`/writes/${held.id}/release`)).status)
const metaW = launched.writes.find(w => w.channel === 'meta'); step('meta payload', { customLocations: metaW.payload.adset.targeting.geo_locations.custom_locations.length, creative: metaW.payload.creative })
const dspW = launched.writes.find(w => w.channel === 'amazon_dsp'); step('dsp index sample', dspW.payload.postalCodeIndex.slice(0, 3))
const holdout = new Set((await get('/holdout')).map(h => h.zip3))
const leak = launched.writes.flatMap(w => (w.payload.postalCodeIndex || []).map(p => p.postalCodePrefix).concat(w.payload.zip3s || [], (w.payload.segment ? w.payload.segment.definition.condition_groups[0].conditions[0].filter.value : []))).filter(z => holdout.has(z))
step('holdout leak check', leak.length ? 'LEAK ' + leak : `none of ${holdout.size} holdout cells in any write`); assert(!leak.length, 'holdout never written')
step('undo', (await post(`/plans/${plan.id}/stop`, { reason: 'smoke test undo' })).status)
const res = await get(`/plans/${plan.id}/results`); step('results', { hasData: res.hasData, lift: res.lift, ci: res.ci90, treated: res.treated, control: res.control, inc: res.incrementalRevenue, series: res.series.length })
assert(res.hasData, 'results computed from demo sales')
const unauth = await fetch(B + '/firstparty/readings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"readings":[]}' }).then(r => r.status); step('firstparty unauthorized ->', unauth); assert(unauth === 400, 'ingest refuses without token')
step('firstparty ingest', await post('/firstparty/readings', { readings: [{ zip3: '972', brand: 'levoit', metric: 'indoor_pm25', value: 44, deviceCount: 1840 }, { zip3: '973', metric: 'indoor_pm25', value: 30, deviceCount: 120 }, { zip3: '999', metric: 'indoor_pm25', value: 1, deviceCount: 5000 }] }, { Authorization: 'Bearer ' + TOKEN }))
step('firstparty status', await get('/firstparty/status'))
step('audit tail', (await get('/audit?limit=8')).map(a => a.action))
console.log('SMOKE OK')
