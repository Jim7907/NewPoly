/**
 * The holdout: 20–25 ZIP3 cells locked out of every write, permanently, so every result
 * can be measured against areas that saw no spend. Chosen once, stratified across states
 * by cell count, favouring typical (median land area) cells. Never changed automatically.
 */
const db = require('./db')
const grid = require('./grid')
const { HOLDOUT } = require('./config')

function list() { return db.all('SELECT zip3, reason, locked_at FROM holdout ORDER BY zip3').map(r => ({ ...r, ...grid.get(r.zip3) })) }
function set() { return new Set(db.all('SELECT zip3 FROM holdout').map(r => r.zip3)) }

function ensure(seed = 7) {
  if (db.get('SELECT COUNT(*) AS n FROM holdout').n > 0) return list()
  // deterministic pseudo-random so a fresh install on the VPS picks the same cells as a fresh install locally
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const cells = grid.all(); const target = HOLDOUT.targetCells
  const byState = new Map(); for (const c of cells) { if (!byState.has(c.state)) byState.set(c.state, []); byState.get(c.state).push(c) }
  // allocate by state share, largest states first, at most one cell per small state
  const alloc = [...byState].map(([st, arr]) => ({ st, arr, want: arr.length / cells.length * target })).sort((a, b) => b.want - a.want)
  const chosen = []
  for (const a of alloc) {
    let n = Math.round(a.want); if (n === 0 && chosen.length < target && rnd() < a.want) n = 1
    const sorted = [...a.arr].sort((x, y) => x.landKm2 - y.landKm2)
    const mid = sorted.slice(Math.floor(sorted.length * 0.25), Math.ceil(sorted.length * 0.75)) // typical cells only
    const pool = mid.length ? mid : sorted
    for (let i = 0; i < n && pool.length && chosen.length < target; i++) chosen.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
  }
  const now = new Date().toISOString()
  db.tx(() => { for (const c of chosen) db.run('INSERT OR IGNORE INTO holdout(zip3,reason,locked_at) VALUES(?,?,?)', [c.zip3, 'stratified holdout, locked at first boot', now]) })
  db.audit('system', 'holdout.locked', { cells: chosen.map(c => c.zip3) })
  return list()
}

module.exports = { ensure, list, set }
