const test = require('node:test'); const assert = require('node:assert')
process.env.DB_PATH = '/tmp/barometer-test-' + process.pid
const db = require('../server/db')

test('holdout is locked once, sized to config, and excluded from plan geography', async () => {
  await db.init()
  const holdout = require('../server/holdout'); const { HOLDOUT } = require('../server/config')
  const first = holdout.ensure(); const again = holdout.ensure()
  assert.ok(first.length >= HOLDOUT.minCells && first.length <= HOLDOUT.maxCells); assert.deepStrictEqual(first.map(h => h.zip3), again.map(h => h.zip3))
  assert.ok(new Set(first.map(h => h.state)).size > 8, 'spread across states')
})
test('first-party ingest validates, stores, and reports the privacy floor', async () => {
  const fp = require('../server/firstparty')
  const r = fp.ingest([{ zip3: '972', metric: 'indoor_pm25', value: 30, deviceCount: 1500 }, { zip3: '972', metric: 'indoor_pm25', value: 30, deviceCount: 20 }, { zip3: '000', metric: 'indoor_pm25', value: 1, deviceCount: 5 }, { zip3: '972', metric: 'household_id', value: 1, deviceCount: 5000 }])
  assert.strictEqual(r.accepted, 2); assert.strictEqual(r.belowFloor, 1); assert.strictEqual(r.rejected.length, 2)
  const feed = require('../server/feeds/firstparty'); const obs = await feed.fetch()
  assert.strictEqual(obs.length, 1, 'only the cell above the floor is scored'); assert.strictEqual(obs[0].metric, 'fp_pm25')
})
test('inventory gate holds a thin SKU and reroutes to a sibling', async () => {
  const inventory = require('../server/inventory'); const plans = require('../server/plans')
  inventory.seedCatalog()
  inventory.upsert([{ sku: 'LEVOIT-CORE-400S', fulfillable: 5000, inbound: 0, dailyRate: 100 }, { sku: 'LEVOIT-CORE-300S', fulfillable: 100, inbound: 0, dailyRate: 100 }], 'test')
  const g = plans.gate({ brand: 'levoit:air', idx: 80, forecast: { days: 7 } })
  const held = g.checks.find(c => c.sku === 'LEVOIT-CORE-300S'); const ok = g.checks.find(c => c.sku === 'LEVOIT-CORE-400S')
  assert.strictEqual(held.status, 'hold'); assert.strictEqual(held.rerouteTo, 'LEVOIT-CORE-400S'); assert.strictEqual(ok.status, 'ok'); assert.strictEqual(g.summary, 'rerouted'); assert.strictEqual(g.blocks, false)
})
