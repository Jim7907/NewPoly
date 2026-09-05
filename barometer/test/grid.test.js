const test = require('node:test'); const assert = require('node:assert')
const grid = require('../server/grid')
test('grid has the national ZIP3 set with centroids and states', () => {
  assert.strictEqual(grid.all().length, 891)
  assert.strictEqual(grid.states().length, 51)
  const pdx = grid.get('972'); assert.strictEqual(pdx.state, 'OR'); assert.ok(pdx.lat > 45 && pdx.lat < 46)
})
test('nearest cell resolves a point and respects distance', () => {
  const { cell, km } = grid.nearest(45.52, -122.68)
  assert.strictEqual(cell.state, 'OR'); assert.ok(km < 60)
})
test('within returns sorted neighbours', () => {
  const near = grid.within(45.52, -122.68, 120)
  assert.ok(near.length >= 3); for (let i = 1; i < near.length; i++) assert.ok(near[i].km >= near[i - 1].km)
})
