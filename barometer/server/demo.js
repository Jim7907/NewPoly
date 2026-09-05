/**
 * Demo data — synthetic, and labelled as such everywhere it appears (source='demo').
 * Lets a new install walk the whole loop (gate, launch, measurement) before real sales and
 * inventory feeds are connected. POST /api/demo/seed with {"confirm":"DEMO"}. Never runs on its own.
 */
const db = require('./db')
const grid = require('./grid')
const inventory = require('./inventory')
const { BRANDS } = require('./config')

function seed() {
  let s = 42; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const days = 45; const today = new Date(); let salesRows = 0
  db.tx(() => {
    db.run("DELETE FROM sales WHERE source='demo'")
    for (const [brand, b] of Object.entries(BRANDS)) for (const [family, f] of Object.entries(b.families)) {
      for (const c of grid.all()) {
        const base = f.baselineDailyUnitsPerCell * (0.6 + rnd() * 0.8) * Math.max(0.2, Math.log10(c.zctas + 1) / 1.5)
        for (let d = days; d >= 0; d--) {
          const day = new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10)
          const units = Math.max(0, Math.round(base * (0.8 + rnd() * 0.4)))
          db.run('INSERT INTO sales(brand,sku,zip3,day,units,revenue,source) VALUES(?,?,?,?,?,?,?)', [brand, f.skus[0], c.zip3, day, units, units * f.avgPrice, 'demo'])
          salesRows++
        }
      }
    }
  })
  const inv = []
  for (const [brand, b] of Object.entries(BRANDS)) for (const [family, f] of Object.entries(b.families)) {
    f.skus.forEach((sku, i) => {
      const daily = f.baselineDailyUnitsPerCell * 891 * (i === 0 ? 0.5 : i === 1 ? 0.3 : 0.2)
      const cover = i === 1 ? 2.5 : 12 + rnd() * 20   // second SKU deliberately thin so the gate has something to reroute
      inv.push({ sku, brand, family, fulfillable: Math.round(daily * cover), inbound: Math.round(daily * 5), dailyRate: Math.round(daily) })
    })
  }
  inventory.upsert(inv, 'demo')
  db.audit('system', 'demo.seeded', { salesRows, inventory: inv.length })
  return { salesRows, inventory: inv.length, note: 'synthetic data, source=demo; delete with POST /api/demo/clear' }
}
function clear() { db.run("DELETE FROM sales WHERE source='demo'"); db.run("UPDATE inventory SET fulfillable=0, inbound=0, daily_rate=0, source='catalog' WHERE source='demo'"); return { cleared: true } }
module.exports = { seed, clear }
