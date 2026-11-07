import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backtest, decideAction, lastClosedSignal, riskStop, sizeFromUsd, tpSlHit, tpSlPrices,
} from '../src/autotrade/engine.js';
import { normalizeResult, normalizeSignal } from '../src/indicators/runner.js';
import { BUILTINS } from '../src/indicators/builtins.js';
import { TA_SOURCE } from '../src/indicators/ta-source.js';

test('decideAction: both directions', () => {
  assert.deepEqual(decideAction('long', 0, 'both'), { close: false, open: 'long' });
  assert.deepEqual(decideAction('long', 1, 'both'), { close: false, open: null });
  assert.deepEqual(decideAction('long', -1, 'both'), { close: true, open: 'long' }); // reverse
  assert.deepEqual(decideAction('short', 2, 'both'), { close: true, open: 'short' });
  assert.deepEqual(decideAction('exit', -1, 'both'), { close: true, open: null });
  assert.deepEqual(decideAction('exit', 0, 'both'), { close: false, open: null });
  assert.deepEqual(decideAction(null, 1, 'both'), { close: false, open: null });
});

test('decideAction: long-only treats short signals as exits', () => {
  assert.deepEqual(decideAction('short', 1, 'long'), { close: true, open: null });
  assert.deepEqual(decideAction('short', 0, 'long'), { close: false, open: null });
  assert.deepEqual(decideAction('long', 0, 'short'), { close: false, open: null });
  assert.deepEqual(decideAction('long', -1, 'short'), { close: true, open: null });
});

test('lastClosedSignal ignores the still-forming candle', () => {
  const candles = [{ time: 0, close: 1 }, { time: 900, close: 2 }, { time: 1800, close: 3 }];
  const signals = [null, 'long', 'short'];
  // at t=2000 the 1800 candle is still open -> use 900
  assert.deepEqual(lastClosedSignal(candles, signals, '15m', 2000), { time: 900, signal: 'long', close: 2 });
  assert.deepEqual(lastClosedSignal(candles, signals, '15m', 2700), { time: 1800, signal: 'short', close: 3 });
  assert.equal(lastClosedSignal(candles, signals, '15m', 100), null);
});

test('sizeFromUsd rounds down to size step', () => {
  assert.equal(sizeFromUsd(100, 2000, 4), '0.0500');
  assert.equal(sizeFromUsd(100, 3000, 4), '0.0333');
  assert.equal(sizeFromUsd(1, 100000, 4), null); // below one step
  assert.equal(sizeFromUsd(0, 100, 2), null);
});

test('tpSlPrices for long and short', () => {
  assert.deepEqual(tpSlPrices('long', 100, 2, 1, 2), { tp: '102', sl: '99' });
  assert.deepEqual(tpSlPrices('short', 100, 2, 1, 2), { tp: '98', sl: '101' });
  assert.deepEqual(tpSlPrices('long', 100, 0, 0, 2), { tp: '', sl: '' });
});

test('tpSlHit checks stop first', () => {
  assert.deepEqual(tpSlHit('long', { tp: 110, sl: 95 }, { high: 111, low: 94 }), { price: 95, reason: 'stop-loss' });
  assert.deepEqual(tpSlHit('long', { tp: 110, sl: 95 }, { high: 111, low: 96 }), { price: 110, reason: 'take-profit' });
  assert.deepEqual(tpSlHit('short', { tp: 90, sl: 105 }, { high: 104, low: 89 }), { price: 90, reason: 'take-profit' });
  assert.equal(tpSlHit('short', { tp: 90, sl: 105 }, { high: 104, low: 91 }), null);
});

test('riskStop limits', () => {
  const cfg = { maxTradesPerDay: 5, maxLossUsd: 50 };
  assert.equal(riskStop({ tradesToday: 4, startEquity: 1000, equity: 960, consecutiveErrors: 0 }, cfg), null);
  assert.match(riskStop({ tradesToday: 5, startEquity: 1000, equity: 1000, consecutiveErrors: 0 }, cfg), /trade limit/);
  assert.match(riskStop({ tradesToday: 0, startEquity: 1000, equity: 950, consecutiveErrors: 0 }, cfg), /Loss limit/);
  assert.match(riskStop({ tradesToday: 0, startEquity: 1000, equity: 1000, consecutiveErrors: 3 }, cfg), /errors/);
});

test('backtest: fills at next open, reverses, computes stats', () => {
  const c = (t, o, h, l, cl) => ({ time: t, open: o, high: h, low: l, close: cl });
  const candles = [c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 110, 111, 109, 110), c(3, 105, 106, 104, 105), c(4, 100, 101, 99, 100)];
  const signals = [null, 'long', 'short', null, null];
  const r = backtest(candles, signals, { mode: 'both' });
  // long @ candle2 open 110, reversed @ candle3 open 105 -> -4.545%; short still open
  assert.equal(r.count, 1);
  assert.equal(r.trades[0].side, 'long');
  assert.equal(r.trades[0].entry, 110);
  assert.equal(r.trades[0].exit, 105);
  assert.ok(Math.abs(r.trades[0].retPct - (-5 / 110) * 100) < 1e-9);
  assert.equal(r.openPosition.side, 'short');
  assert.equal(r.winRate, 0);
});

test('backtest: take-profit closes the trade', () => {
  const c = (t, o, h, l, cl) => ({ time: t, open: o, high: h, low: l, close: cl });
  const candles = [c(0, 100, 100, 100, 100), c(1, 100, 100.5, 99.8, 100), c(2, 100, 103, 99.9, 102)];
  const r = backtest(candles, ['long', null, null], { tpPct: 2, slPct: 1 });
  assert.equal(r.count, 1);
  assert.equal(r.trades[0].reason, 'take-profit');
  assert.equal(r.trades[0].exit, 102);
  assert.ok(r.totalReturnPct > 1.99 && r.totalReturnPct < 2.01);
});

test('signals: aliases and validation', () => {
  assert.equal(normalizeSignal('BUY'), 'long');
  assert.equal(normalizeSignal('sell'), 'short');
  assert.equal(normalizeSignal('close'), 'exit');
  assert.equal(normalizeSignal('maybe'), null);
  const r = normalizeResult({ signals: ['buy', null, 'nope'] }, 3);
  assert.deepEqual(r.signals, ['long', null, null]);
  assert.deepEqual(r.plots, []);
  assert.throws(() => normalizeResult({ plots: [], signals: ['long'] }, 3), /one entry per candle/);
});

test('built-in strategies emit signals on oscillating prices', () => {
  const ta = new Function(`${TA_SOURCE}; return ta;`)();
  const candles = Array.from({ length: 300 }, (_, i) => {
    const p = 100 + Math.sin(i / 8) * 8;
    return { time: i * 900, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1 };
  });
  for (const s of BUILTINS.filter((b) => b.strategy)) {
    const r = normalizeResult(new Function('candles', 'inputs', 'ta', s.code)(candles, s.inputs, ta), candles.length);
    const n = r.signals.filter(Boolean).length;
    assert.ok(n >= 4, `${s.id} produced ${n} signals`);
    const bt = backtest(candles, r.signals, {});
    assert.ok(bt.count >= 2, `${s.id} backtest trades`);
  }
});
