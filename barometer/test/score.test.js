const test = require('node:test'); const assert = require('node:assert')
const { shape, BRANDS, FRESHNESS } = require('../server/config')
const { scoreCell } = require('../server/score')
const { freshness, windowFor } = require('../server/normalise')

test('AQI shape steps at the public category boundaries', () => {
  assert.ok(shape('aqi', 101) > shape('aqi', 100), 'crossing 100 -> 101 raises pressure')
  assert.ok(shape('aqi', 151) > shape('aqi', 150)); assert.strictEqual(shape('aqi', 500), 1); assert.strictEqual(shape('aqi', 0), 0)
})
test('descending shapes (dew point, filter life) invert correctly', () => {
  assert.ok(shape('dew_low_f', 10) > shape('dew_low_f', 40)); assert.ok(shape('fp_filter', 10) > shape('fp_filter', 90))
})
test('every brand signal weight is positive and shapes exist', () => {
  for (const b of Object.values(BRANDS)) for (const f of Object.values(b.families)) for (const s of f.signals) { assert.ok(s.weight > 0, s.metric); assert.notStrictEqual(shape(s.shape, 1), undefined) }
})
test('a lone alert does not read as an extreme index once corroborating feeds are expected', () => {
  const signals = BRANDS.cosori.families.kitchen.signals
  const cell = new Map([['alert_heat', new Map([['act', { value: 3, fresh: 1, feed: 'nws_alerts' }]])]])
  const onlyAlert = scoreCell(cell, signals, 'act', new Set(['alert_heat']))
  const withWeather = scoreCell(cell, signals, 'act', new Set(['alert_heat', 'temp_max_f', 'food_yoy']))
  assert.strictEqual(onlyAlert.idx, 100); assert.ok(withWeather.idx < 40, `got ${withWeather.idx}`)
})
test('heat plus an extreme warning is an opportunity; heat alone is not', () => {
  const signals = BRANDS.cosori.families.kitchen.signals; const expected = new Set(['alert_heat', 'temp_max_f'])
  const hot = new Map([['alert_heat', new Map([['act', { value: 3, fresh: 1, feed: 'nws' }]])], ['temp_max_f', new Map([['act', { value: 104, fresh: 1, feed: 'om' }]])]])
  const warm = new Map([['temp_max_f', new Map([['act', { value: 96, fresh: 1, feed: 'om' }]])]])
  assert.ok(scoreCell(hot, signals, 'act', expected).idx >= 55); assert.ok(scoreCell(warm, signals, 'act', expected).idx < 55)
})
test('drivers carry shares that sum to 100', () => {
  const signals = BRANDS.levoit.families.air.signals; const expected = new Set(['aqi', 'pm25_fc', 'alert_air'])
  const cell = new Map([['aqi', new Map([['act', { value: 180, fresh: 1, feed: 'a' }]])], ['pm25_fc', new Map([['act', { value: 120, fresh: 1, feed: 'b' }]])]])
  const r = scoreCell(cell, signals, 'act', expected)
  assert.ok(Math.abs(r.drivers.reduce((a, d) => a + d.share, 0) - 100) < 0.5); assert.strictEqual(r.drivers[0].metric, 'aqi')
})
test('freshness decays a stale feed to zero instead of freezing it', () => {
  const now = Date.now(); const [full, zero] = FRESHNESS.aqi
  assert.strictEqual(freshness('aqi', new Date(now - (full - 1) * 3600000).toISOString(), now), 1)
  assert.strictEqual(freshness('aqi', new Date(now - (zero + 1) * 3600000).toISOString(), now), 0)
  const mid = freshness('aqi', new Date(now - ((full + zero) / 2) * 3600000).toISOString(), now); assert.ok(mid > 0.4 && mid < 0.6)
})
test('horizon windows: slow series apply everywhere, forecasts only to their window', () => {
  assert.ok(windowFor('watch', 0)); assert.ok(windowFor('act', 24)); assert.ok(!windowFor('act', 120)); assert.ok(windowFor('schedule', 120)); assert.ok(!windowFor('schedule', 24))
})
