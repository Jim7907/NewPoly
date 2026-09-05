const test = require('node:test'); const assert = require('node:assert')
const { checkClaims } = require('../server/creative')
const { epaCorrect } = require('../server/feeds/purpleair')
const { windowScore } = require('../server/feeds/calendar')
const { MONEY, PRIVACY, HOLDOUT } = require('../server/config')

test('claim check blocks health outcomes for Levoit and passes measured claims', () => {
  assert.strictEqual(checkClaims('Prevents flu and kills germs', 'levoit:air').pass, false)
  assert.strictEqual(checkClaims('HEPA filtration for rooms up to 1,980 sq ft, CADR 260', 'levoit:air').pass, true)
})
test('claim check requires the arithmetic on Cosori cost claims', () => {
  assert.strictEqual(checkClaims('Cheaper to run than your oven', 'cosori:kitchen').pass, false)
  assert.strictEqual(checkClaims('1,700 W for 18 minutes: cheaper to run than a 3,000 W oven for 45 minutes', 'cosori:kitchen').pass, true)
  assert.strictEqual(checkClaims('Healthier meals with less oil', 'cosori:kitchen').pass, false)
})
test('claim check blocks absolute promises and fear language', () => {
  assert.strictEqual(checkClaims('Guaranteed clean air', 'levoit:air').pass, false)
  assert.strictEqual(checkClaims('Toxic smoke is deadly. Act now.', 'levoit:air').pass, false)
})
test('EPA PurpleAir correction lowers raw readings and caps the nonlinear range', () => {
  assert.ok(epaCorrect(100, 50) < 100); assert.strictEqual(epaCorrect(400, 50), epaCorrect(300, 50)); assert.strictEqual(epaCorrect(null, 50), null)
})
test('calendar windows score 1 inside, taper on the lead-in, 0 otherwise', () => {
  assert.strictEqual(windowScore(new Date('2026-01-05T00:00:00Z'), [12, 26], [1, 20], 14), 1)
  assert.strictEqual(windowScore(new Date('2026-06-05T00:00:00Z'), [12, 26], [1, 20], 14), 0)
  const lead = windowScore(new Date('2026-12-19T00:00:00Z'), [12, 26], [1, 20], 14); assert.ok(lead > 0 && lead < 1)
})
test('money and privacy rules are the ones the research settled on', () => {
  assert.strictEqual(MONEY.singleWriteHoldUsd, 25000); assert.strictEqual(MONEY.undoWindowSeconds, 90); assert.strictEqual(PRIVACY.minDevicesPerCell, 1000)
  assert.ok(HOLDOUT.minCells >= 20 && HOLDOUT.maxCells <= 25)
})
