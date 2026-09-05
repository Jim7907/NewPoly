/**
 * Plans: an opportunity becomes a media plan (channel lines with budgets and geography),
 * passes the inventory gate, waits for a person, launches through the channel adapters,
 * and can be undone inside the kill-switch window. Every rule from config.MONEY lives here.
 */
const db = require('./db')
const grid = require('./grid')
const holdout = require('./holdout')
const inventory = require('./inventory')
const { BRANDS, ROUTING, CHANNELS, MONEY } = require('./config')
const log = require('./log')

const rid = (p) => p + '_' + Math.random().toString(36).slice(2, 10)
const oppOf = (id) => { const o = db.get('SELECT * FROM opportunities WHERE id=?', [id]); if (!o) throw new Error('opportunity not found'); return { ...o, zip3s: db.parse(o.zip3s, []), states: db.parse(o.states, []), drivers: db.parse(o.drivers, []), forecast: db.parse(o.forecast, {}) } }
const splitKey = (key) => { const [brand, family] = key.split(':'); return { brand, family } }

function gate(opp) {
  const { brand, family } = splitKey(opp.brand)
  const fam = BRANDS[brand].families[family]
  const days = opp.forecast.days || 7
  const uplift = fam.elasticity * (opp.idx / 100)
  const stock = inventory.list(brand).filter(i => i.family === family)
  const checks = stock.map(i => {
    const rate = i.daily_rate > 0 ? i.daily_rate * (1 + uplift) : null
    const cover = rate ? +((i.fulfillable + 0.5 * i.inbound) / rate).toFixed(1) : null
    let status = 'unknown'
    if (cover != null) status = cover >= days ? 'ok' : cover >= days * 0.5 ? 'thin' : 'hold'
    return { sku: i.sku, name: i.name, fulfillable: i.fulfillable, inbound: i.inbound, dailyRate: i.daily_rate, coverDays: cover, needDays: days, status, source: i.source }
  })
  // reroute: any held SKU sends its share to the sibling with the most cover
  const okSkus = checks.filter(c => c.status === 'ok').sort((a, b) => b.coverDays - a.coverDays)
  for (const c of checks) if (c.status === 'hold') c.rerouteTo = okSkus[0] ? okSkus[0].sku : null
  const known = checks.filter(c => c.status !== 'unknown').length
  const summary = known === 0 ? 'no inventory data — connect Amazon SP-API or POST /api/inventory' : checks.some(c => c.status === 'hold' && !c.rerouteTo) ? 'hold: no in-stock sibling to reroute to' : checks.some(c => c.status === 'hold') ? 'rerouted' : checks.some(c => c.status === 'thin') ? 'thin cover' : 'healthy'
  return { days, uplift: +uplift.toFixed(2), checks, summary, blocks: known > 0 && checks.every(c => c.status === 'hold' || c.status === 'unknown') && !checks.some(c => c.rerouteTo) }
}

function build(oppId, opts = {}) {
  const opp = oppOf(oppId)
  const { brand, family } = splitKey(opp.brand)
  const routing = ROUTING[brand]
  const held = holdout.set()
  const cells = opp.zip3s.filter(z => !held.has(z))
  const excluded = opp.zip3s.length - cells.length
  const budget = Math.min(MONEY.eventCapUsd, Math.round((opts.budget || MONEY.budgetPerForecastRevenue * opp.forecast.revenue) / 100) * 100)
  const g = gate(opp)
  const heldShare = g.checks.filter(c => c.status === 'hold' && c.rerouteTo).length / Math.max(1, g.checks.length)
  const lines = Object.entries(routing).map(([channel, share]) => {
    const ch = CHANNELS[channel]
    const geo = ch.geo === 'zip3' ? { kind: 'zip3', cells } : ch.geo === 'dma' ? { kind: 'state', states: opp.states } : { kind: 'national', weightedBy: opp.states }
    const amount = Math.round(budget * share)
    return { channel, name: ch.name, kind: ch.kind, share, amount, geo, holdsForPerson: amount > MONEY.singleWriteHoldUsd, rerouted: heldShare > 0 ? Math.round(amount * heldShare) : 0 }
  })
  const id = rid('plan'); const now = new Date().toISOString()
  db.run('INSERT INTO plans(id,opportunity_id,brand,lines,budget,gate,status,created_at,notes) VALUES(?,?,?,?,?,?,?,?,?)',
    [id, oppId, opp.brand, JSON.stringify(lines), budget, JSON.stringify({ ...g, holdoutExcluded: excluded }), 'awaiting_approval', now, opts.notes || null])
  db.run("UPDATE opportunities SET status='ready', updated_at=? WHERE id=? AND status IN ('detected','drafting')", [now, oppId])
  db.audit(opts.actor, 'plan.built', { id, opportunity: oppId, budget, gate: g.summary })
  return get(id)
}

function get(id) {
  const p = db.get('SELECT * FROM plans WHERE id=?', [id]); if (!p) return null
  const writes = db.all('SELECT * FROM writes WHERE plan_id=? ORDER BY created_at', [id]).map(w => ({ ...w, payload: db.parse(w.payload), response: db.parse(w.response) }))
  const opportunity = oppOf(p.opportunity_id)
  const creatives = db.all('SELECT id, format, channel, headline, body, cta, status FROM creatives WHERE opportunity_id=?', [p.opportunity_id])
  const cellIndex = db.all('SELECT zip3, idx FROM cell_scores WHERE brand=? AND horizon=?', [p.brand, opportunity.horizon]).map(r => [r.zip3, r.idx])
  return { ...p, lines: db.parse(p.lines, []), gate: db.parse(p.gate, {}), writes, opportunity, creatives, cellIndex }
}
function list(status) { return (status ? db.all('SELECT id FROM plans WHERE status=? ORDER BY created_at DESC', [status]) : db.all('SELECT id FROM plans ORDER BY created_at DESC')).map(r => get(r.id)) }

function liveSpendToday() {
  const today = new Date().toISOString().slice(0, 10)
  const r = db.get("SELECT COALESCE(SUM(budget),0) AS s FROM plans WHERE status IN ('approved','launching','live') AND substr(COALESCE(launched_at, approved_at, created_at),1,10)=?", [today])
  return r ? r.s : 0
}

function killSwitch() { return db.setting('kill_switch', false) }

function approve(id, actor) {
  const p = get(id); if (!p) throw new Error('plan not found')
  if (p.status !== 'awaiting_approval') throw new Error(`plan is ${p.status}`)
  if (killSwitch()) throw new Error('kill switch is on: nothing launches until it is released')
  if (p.gate.blocks) throw new Error(`inventory gate: ${p.gate.summary}`)
  if (liveSpendToday() + p.budget > MONEY.dailyCapUsd) throw new Error(`daily cap: ${liveSpendToday() + p.budget} would exceed ${MONEY.dailyCapUsd}`)
  if (p.budget > MONEY.eventCapUsd) throw new Error(`event cap: ${p.budget} exceeds ${MONEY.eventCapUsd}`)
  const now = new Date().toISOString()
  db.run("UPDATE plans SET status='approved', approved_by=?, approved_at=? WHERE id=?", [actor || 'unknown', now, id])
  db.audit(actor, 'plan.approved', { id, budget: p.budget })
  return get(id)
}

/** Launch: hand every line to its channel adapter. Writes above the hold threshold are recorded as held. */
async function launch(id, actor, channels) {
  const p = get(id); if (!p) throw new Error('plan not found')
  if (p.status !== 'approved') throw new Error(`plan is ${p.status}, approve it first`)
  if (killSwitch()) throw new Error('kill switch is on')
  const now = new Date()
  db.run("UPDATE plans SET status='launching' WHERE id=?", [id])
  const held = holdout.set()
  for (const line of p.lines) {
    const adapter = channels.get(line.channel); if (!adapter) continue
    // the holdout is enforced here again, at the last moment before a write leaves the building
    if (line.geo.kind === 'zip3') line.geo.cells = line.geo.cells.filter(z => !held.has(z))
    const proposal = adapter.propose(p, line)
    const wid = rid('w')
    const dryRun = !adapter.live()
    const status = line.holdsForPerson ? 'held' : 'proposed'
    db.run('INSERT INTO writes(id,plan_id,channel,action,payload,amount,dry_run,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [wid, id, line.channel, proposal.action, JSON.stringify(proposal.payload), line.amount, dryRun ? 1 : 0, status, now.toISOString()])
    if (status === 'proposed') await send(wid, channels, actor)
  }
  const undoUntil = new Date(now.getTime() + MONEY.undoWindowSeconds * 1000).toISOString()
  db.run("UPDATE plans SET status='live', launched_at=?, undo_until=? WHERE id=?", [now.toISOString(), undoUntil, id])
  db.run("UPDATE opportunities SET status='live', updated_at=? WHERE id=?", [now.toISOString(), p.opportunity_id])
  db.audit(actor, 'plan.launched', { id, undoUntil })
  return get(id)
}

async function send(wid, channels, actor) {
  const w = db.get('SELECT * FROM writes WHERE id=?', [wid]); if (!w) throw new Error('write not found')
  const adapter = channels.get(w.channel)
  const payload = db.parse(w.payload)
  try {
    const resp = adapter.live() ? await adapter.write(payload) : { dryRun: true, note: 'LIVE_WRITES is off or channel has no credentials; payload recorded, nothing sent' }
    db.run("UPDATE writes SET status='sent', response=?, sent_at=? WHERE id=?", [JSON.stringify(resp), new Date().toISOString(), wid])
  } catch (e) {
    db.run("UPDATE writes SET status='failed', response=? WHERE id=?", [JSON.stringify({ error: e.message }), wid])
    log.warn('plan', `write ${wid} to ${w.channel} failed: ${e.message}`)
  }
  db.audit(actor, 'write.sent', { wid, channel: w.channel, amount: w.amount, dryRun: !adapter.live() })
}

/** A person releases a held write (one above singleWriteHoldUsd). */
async function release(wid, actor, channels) {
  const w = db.get('SELECT * FROM writes WHERE id=?', [wid]); if (!w) throw new Error('write not found')
  if (w.status !== 'held') throw new Error(`write is ${w.status}`)
  if (killSwitch()) throw new Error('kill switch is on')
  db.run("UPDATE writes SET status='proposed' WHERE id=?", [wid])
  db.audit(actor, 'write.released', { wid, amount: w.amount })
  await send(wid, channels, actor)
  return db.get('SELECT * FROM writes WHERE id=?', [wid])
}

/** Undo inside the window, or kill at any time: every sent write gets a reversal. */
async function stop(id, actor, channels, reason) {
  const p = get(id); if (!p) throw new Error('plan not found')
  if (!['live', 'launching', 'approved'].includes(p.status)) throw new Error(`plan is ${p.status}`)
  const now = new Date()
  const inWindow = p.undo_until && now.toISOString() <= p.undo_until
  for (const w of p.writes) {
    if (w.status === 'sent') {
      const adapter = channels.get(w.channel)
      try { if (adapter && adapter.live()) await adapter.reverse(w.payload, w.response) } catch (e) { log.warn('plan', `reverse ${w.id} failed: ${e.message}`) }
      db.run("UPDATE writes SET status='undone' WHERE id=?", [w.id])
    } else if (w.status === 'held' || w.status === 'proposed') db.run("UPDATE writes SET status='undone' WHERE id=?", [w.id])
  }
  const status = inWindow ? 'undone' : 'killed'
  db.run('UPDATE plans SET status=?, ended_at=?, notes=? WHERE id=?', [status, now.toISOString(), reason || null, id])
  db.run("UPDATE opportunities SET status='ready', updated_at=? WHERE id=?", [now.toISOString(), p.opportunity_id])
  db.audit(actor, inWindow ? 'plan.undone' : 'plan.killed', { id, reason })
  return get(id)
}

function setKillSwitch(on, actor) { db.setSetting('kill_switch', !!on); db.audit(actor, on ? 'killswitch.on' : 'killswitch.off', {}); return killSwitch() }

module.exports = { build, gate, get, list, approve, launch, release, stop, killSwitch, setKillSwitch, liveSpendToday, oppOf, splitKey }
