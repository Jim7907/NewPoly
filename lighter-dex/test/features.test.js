import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntryWithTpSl, buildPositionTpSl, buildTriggerOrder, pnlAt, validateTpSl } from '../src/lighter/orders.js';
import { GROUPING, ORDER_TYPE, TIME_IN_FORCE } from '../src/lighter/config.js';
import { pnlChange, summarizeFills, toFill } from '../src/lighter/history.js';
import { TA_SOURCE } from '../src/indicators/ta-source.js';
import { BUILTINS } from '../src/indicators/builtins.js';
import { normalizeResult, parseHeader } from '../src/indicators/runner.js';
import { liqWarnings, parseAlertRequest, priceAlertHit } from '../alerts/logic.js';

const ETH = { market_id: 0, symbol: 'ETH', price_decimals: 2, size_decimals: 4, min_base_amount: '0.0020', min_quote_amount: '10' };

// ---------- TP/SL ----------
test('validateTpSl checks direction', () => {
  assert.equal(validateTpSl({ isLong: true, refPrice: 2000, tp: '2100', sl: '1900' }), null);
  assert.match(validateTpSl({ isLong: true, refPrice: 2000, tp: '1900', sl: '' }), /above/);
  assert.match(validateTpSl({ isLong: true, refPrice: 2000, tp: '', sl: '2100' }), /below/);
  assert.equal(validateTpSl({ isLong: false, refPrice: 2000, tp: '1900', sl: '2100' }), null);
  assert.match(validateTpSl({ isLong: false, refPrice: 2000, tp: '2100', sl: '' }), /below/);
});

test('trigger order for a long: sell, reduce-only, limit below trigger', () => {
  const o = buildTriggerOrder(ETH, { kind: 'sl', isLong: true, trigger: '1900' });
  assert.equal(o.isAsk, true);
  assert.equal(o.reduceOnly, true);
  assert.equal(o.orderType, ORDER_TYPE.STOP_LOSS_LIMIT);
  assert.equal(o.timeInForce, TIME_IN_FORCE.GTT);
  assert.equal(o.triggerPrice, '190000');
  assert.equal(o.price, '186200'); // 1900 * 0.98
  assert.equal(o.baseAmount, '0'); // whole position when grouped
});

test('trigger order for a short: buy, limit above trigger', () => {
  const o = buildTriggerOrder(ETH, { kind: 'tp', isLong: false, trigger: '1500', size: '0.5' });
  assert.equal(o.isAsk, false);
  assert.equal(o.orderType, ORDER_TYPE.TAKE_PROFIT_LIMIT);
  assert.equal(o.price, '153000'); // 1500 * 1.02
  assert.equal(o.baseAmount, '5000');
});

test('entry + TP + SL is OTOCO with entry first as limit order', () => {
  const g = buildEntryWithTpSl(ETH, { isAsk: false, size: '0.1', price: '2010', kind: 'market' }, { tp: '2200', sl: '1900' });
  assert.equal(g.groupingType, GROUPING.OTOCO);
  assert.equal(g.orders.length, 3);
  assert.equal(g.orders[0].orderType, ORDER_TYPE.LIMIT);
  assert.equal(g.orders[0].timeInForce, TIME_IN_FORCE.IOC);
  assert.equal(g.orders[1].orderType, ORDER_TYPE.TAKE_PROFIT_LIMIT);
  assert.equal(g.orders[2].orderType, ORDER_TYPE.STOP_LOSS_LIMIT);
  const one = buildEntryWithTpSl(ETH, { isAsk: false, size: '0.1', price: '2010', kind: 'limit' }, { tp: '', sl: '1900' });
  assert.equal(one.groupingType, GROUPING.OTO);
  assert.equal(one.orders.length, 2);
});

test('position TP/SL: both -> OCO tied to position, one -> single sized order', () => {
  const both = buildPositionTpSl(ETH, { isLong: true, size: '1.5', tp: '2200', sl: '1900' });
  assert.equal(both.groupingType, GROUPING.OCO);
  assert.equal(both.orders[0].baseAmount, '0');
  const single = buildPositionTpSl(ETH, { isLong: false, size: '-1.5', tp: '', sl: '2100' });
  assert.equal(single.groupingType, null);
  assert.equal(single.orders[0].baseAmount, '15000');
  assert.equal(single.orders[0].isAsk, false);
});

test('pnlAt', () => {
  assert.equal(pnlAt({ isLong: true, entryPrice: 100, exitPrice: 110, size: 2 }), 20);
  assert.equal(pnlAt({ isLong: false, entryPrice: 100, exitPrice: 110, size: 2 }), -20);
});

// ---------- history ----------
test('toFill + summarizeFills from my side of trades', () => {
  const me = 42;
  const trades = [
    { trade_id: 1, market_id: 0, market_symbol: 'ETH', price: '2000', size: '1', usd_amount: '2000', bid_account_id: 42, ask_account_id: 7, is_maker_ask: true, bid_account_pnl: '0', ask_account_pnl: '5', timestamp: 1, type: 'trade' },
    { trade_id: 2, market_id: 0, market_symbol: 'ETH', price: '2100', size: '1', usd_amount: '2100', bid_account_id: 9, ask_account_id: 42, is_maker_ask: true, bid_account_pnl: '-3', ask_account_pnl: '100', timestamp: 2, type: 'trade' },
    { trade_id: 3, market_id: 1, market_symbol: 'BTC', price: '50000', size: '0.01', usd_amount: '500', bid_account_id: 42, ask_account_id: 9, is_maker_ask: false, bid_account_pnl: '-20', ask_account_pnl: '0', timestamp: 3, type: 'trade' },
  ];
  const fills = trades.map((t) => toFill(t, me));
  assert.deepEqual(fills.map((f) => [f.side, f.role, f.pnl]), [['buy', 'taker', 0], ['sell', 'maker', 100], ['buy', 'maker', -20]]);
  const s = summarizeFills(fills);
  assert.equal(s.realized, 80);
  assert.equal(s.volume, 4600);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.byMarket[0].symbol, 'ETH');
});

test('pnlChange uses cumulative series', () => {
  assert.equal(pnlChange([{ trade_pnl: -100 }, { trade_pnl: -40 }]), 60);
  assert.equal(pnlChange([]), null);
});

// ---------- indicators ----------
const ta = new Function(`${TA_SOURCE}; return ta;`)();
const candles = Array.from({ length: 60 }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5 + i * 0.1;
  return { time: 1700000000 + i * 900, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 10 + (i % 5) };
});

test('ta.sma / ema basics', () => {
  assert.deepEqual(ta.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ta.ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2); // seeded with SMA
  assert.equal(e[3], 3);
});

test('ta.rsi stays within 0..100 and is 100 on pure uptrend', () => {
  const up = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(ta.rsi(up, 14).at(-1), 100);
  for (const v of ta.rsi(ta.close(candles), 14)) if (v !== null) assert.ok(v >= 0 && v <= 100);
});

test('every built-in indicator runs and returns valid output', () => {
  for (const b of BUILTINS) {
    const out = new Function('candles', 'inputs', 'ta', b.code)(candles, b.inputs, ta);
    const r = normalizeResult(out, candles.length);
    assert.ok(r.plots.length > 0, b.id);
    assert.ok(r.plots.every((p) => p.values.some((v) => v !== null)), `${b.id} has values`);
  }
});

test('normalizeResult rejects malformed output and strips bad values', () => {
  assert.throws(() => normalizeResult(null, 3), /must return/);
  assert.throws(() => normalizeResult({ plots: [{ values: [1, 2] }] }, 3), /expected 3/);
  const r = normalizeResult({ pane: 'weird', plots: [{ name: 'x', values: [1, 'a', Infinity], color: 'url(evil)' }] }, 3);
  assert.equal(r.pane, 'overlay');
  assert.deepEqual(r.plots[0].values, [1, null, null]);
  assert.equal(r.plots[0].color, null);
});

test('parseHeader reads name and numeric inputs', () => {
  const h = parseHeader('// @name Fancy RSI\n// @input length 21\n// @input mult 1.5\nreturn {}');
  assert.equal(h.name, 'Fancy RSI');
  assert.deepEqual(h.inputs, { length: 21, mult: 1.5 });
});

// ---------- alerts ----------
const CODE = 'abcdefghijklmnopqrstuvwxyz012345';

test('parseAlertRequest validates input', () => {
  assert.ok(parseAlertRequest({ code: CODE, type: 'price', marketId: 0, symbol: 'ETH', op: 'above', price: 2500 }).alert);
  assert.match(parseAlertRequest({ code: 'short', type: 'price', marketId: 0, op: 'above', price: 1 }).error, /code/);
  assert.match(parseAlertRequest({ code: CODE, type: 'price', marketId: 0, op: 'sideways', price: 1 }).error, /op/);
  assert.match(parseAlertRequest({ code: CODE, type: 'liq', accountIndex: 5, pct: 90 }).error, /between/);
  assert.equal(parseAlertRequest({ code: CODE, type: 'price', marketId: 0, symbol: '<b>ETH</b>', op: 'below', price: 1 }).alert.symbol, 'bETHb');
});

test('priceAlertHit', () => {
  assert.equal(priceAlertHit({ op: 'above', price: 100 }, 100), true);
  assert.equal(priceAlertHit({ op: 'above', price: 100 }, 99.9), false);
  assert.equal(priceAlertHit({ op: 'below', price: 100 }, 99), true);
  assert.equal(priceAlertHit({ op: 'below', price: 100 }, NaN), false);
});

test('liqWarnings respects distance and cooldown', () => {
  const alert = { id: 'a1', pct: 5 };
  const account = { positions: [
    { market_id: 0, symbol: 'ETH', position: '1', sign: 1, liquidation_price: '1920' }, // 4% away
    { market_id: 1, symbol: 'BTC', position: '0.1', sign: -1, liquidation_price: '60000' }, // 20% away
    { market_id: 2, symbol: 'SOL', position: '0', sign: 1, liquidation_price: '1' },
  ] };
  const marks = new Map([[0, 2000], [1, 50000], [2, 100]]);
  const w = liqWarnings(alert, account, marks, {}, 1000);
  assert.equal(w.length, 1);
  assert.equal(w[0].symbol, 'ETH');
  assert.ok(Math.abs(w[0].distancePct - 4) < 1e-9);
  assert.equal(liqWarnings(alert, account, marks, { 'a1:0': 900 }, 1000).length, 0); // cooldown
  assert.equal(liqWarnings(alert, account, marks, { 'a1:0': 0 }, 2 * 3600e3).length, 1);
});
