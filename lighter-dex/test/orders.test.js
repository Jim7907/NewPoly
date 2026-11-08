import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromScaledInt, roundTo, toScaledInt } from '../src/lighter/units.js';
import { buildOrder, maxLeverage, nextClientOrderIndex, validateSize } from '../src/lighter/orders.js';
import { ORDER_TYPE, TIME_IN_FORCE } from '../src/lighter/config.js';

// Shape taken from GET /api/v1/orderBookDetails?market_id=0 (ETH perp)
const ETH = {
  market_id: 0, symbol: 'ETH', price_decimals: 2, size_decimals: 4,
  min_base_amount: '0.0020', min_quote_amount: '10.000000',
  min_initial_margin_fraction: 200, default_initial_margin_fraction: 500,
};

test('toScaledInt scales decimal strings without float error', () => {
  assert.equal(toScaledInt('2243.16', 2), '224316');
  assert.equal(toScaledInt('0.1', 4), '1000');
  assert.equal(toScaledInt('0.0020', 4), '20');
  assert.equal(toScaledInt('1.005', 2), '100'); // truncates, never rounds up
  assert.equal(toScaledInt('12', 3), '12000');
  assert.equal(toScaledInt('.5', 2), '50');
  assert.equal(toScaledInt('0.07', 2), '7'); // 0.07*100 = 7.000000000000001 in float
  assert.equal(toScaledInt('abc', 2), null);
  assert.equal(toScaledInt('', 2), null);
  assert.equal(toScaledInt('-1', 2), null);
});

test('fromScaledInt is the inverse', () => {
  assert.equal(fromScaledInt('224316', 2), '2243.16');
  assert.equal(fromScaledInt('20', 4), '0.0020');
  assert.equal(fromScaledInt('5', 0), '5');
});

test('roundTo respects direction', () => {
  assert.equal(roundTo(2243.161, 2, 'up'), '2243.17');
  assert.equal(roundTo(2243.169, 2, 'down'), '2243.16');
});

test('maxLeverage from min initial margin fraction', () => {
  assert.equal(maxLeverage(ETH), 50);
});

test('validateSize enforces market minimums', () => {
  assert.match(validateSize(ETH, '0.001', '2000'), /Min size/);
  assert.match(validateSize(ETH, '0.003', '2000'), /Min order value/);
  assert.equal(validateSize(ETH, '0.01', '2000'), null);
  assert.match(validateSize(ETH, '', '2000'), /Enter a size/);
});

test('buildOrder: market order is IOC with expiry 0', () => {
  const o = buildOrder(ETH, { isAsk: false, size: '0.5', price: '2260.10', kind: 'market' });
  assert.equal(o.baseAmount, '5000');
  assert.equal(o.price, '226010');
  assert.equal(o.orderType, ORDER_TYPE.MARKET);
  assert.equal(o.timeInForce, TIME_IN_FORCE.IOC);
  assert.equal(o.orderExpiry, 0);
  assert.equal(o.isAsk, false);
});

test('buildOrder: limit post-only reduce-only', () => {
  const o = buildOrder(ETH, { isAsk: true, size: '1', price: '2300', kind: 'limit', postOnly: true, reduceOnly: true });
  assert.equal(o.orderType, ORDER_TYPE.LIMIT);
  assert.equal(o.timeInForce, TIME_IN_FORCE.POST_ONLY);
  assert.equal(o.orderExpiry, -1);
  assert.equal(o.reduceOnly, true);
  assert.equal(o.price, '230000');
});

test('buildOrder rejects zero size', () => {
  assert.throws(() => buildOrder(ETH, { isAsk: true, size: '0.00001', price: '2300', kind: 'limit' }), /Invalid size/);
});

test('client order indexes are unique and < 2^48', () => {
  const ids = new Set(Array.from({ length: 50 }, nextClientOrderIndex));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id < 2 ** 48);
});
