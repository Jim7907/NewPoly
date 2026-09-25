const test = require("node:test");
const assert = require("node:assert");
const BT = require("../server/learning/backtest");

const DAY = 86400000;
const STOCK = { id: "STOCK:TEST", symbol: "TEST", assetClass: "stock", etf: false };
const NOCOST = { FEE_BPS_STOCK: 0, FEE_BPS_CRYPTO: 0, SLIPPAGE_BPS: 0 };
const OPEN = { MIN_CONFIDENCE: 0, MIN_PROB_EDGE: 0, MIN_AGREEMENT: 0 };

const flat = (n, px = 100) => Array.from({ length: n }, (_, k) => ({ t: k * DAY, o: px, h: px + 1, l: px - 1, c: px, v: 1 }));
// deterministic noisy random walk (seeded LCG)
function walk(n, drift = 0, seed = 7) {
  let s = seed >>> 0, px = 100;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, (_, k) => {
    const o = px, r = drift + (rnd() - 0.5) * 0.04;
    const c = o * Math.exp(r);
    px = c;
    return { t: k * DAY, o, h: Math.max(o, c) * (1 + rnd() * 0.01), l: Math.min(o, c) * (1 - rnd() * 0.01), c, v: 1000 };
  });
}
const bull = (conf = 1) => () => [{ id: "tech.trend.stub", family: "technical", score: 1, confidence: conf, reason: "stub" }];
const stubs = (extra = {}) => ({ technical: bull(), regime: () => ({ trend: "range", vol: "normal" }), regimeSignals: () => [], ml: null, atr: () => 2, ...extra });

test("stop: long entered at next open, exits at the stop price when a bar trades through it", () => {
  const c = flat(300);
  c[252] = { ...c[252], l: 90, c: 92 };                              // crash bar after entry at 251
  const r = BT.run({ candles: c, asset: STOCK, horizon: "swing", cfg: NOCOST, thresholds: OPEN, analyzers: stubs(), warmup: 250, useML: false });
  const t0 = r.trades[0];
  assert.strictEqual(t0.entryT, c[251].t);
  assert.strictEqual(t0.side, "long");
  assert.strictEqual(t0.reason, "stop");
  assert.strictEqual(t0.stop, 96);
  assert.strictEqual(t0.exit, 96);
  assert.ok(Math.abs(t0.ret - -0.04) < 1e-12);
});

test("target and gap fills; stop wins when both levels are inside one bar", () => {
  const c = flat(300);
  c[252] = { ...c[252], h: 107, c: 105 };                            // target 106
  c[258] = { ...c[258], o: 110, h: 111, l: 109, c: 110 };            // gap above next trade's target
  c[256] = { ...c[256], h: 110, l: 90 };                             // both levels → stop
  const r = BT.run({ candles: c, asset: STOCK, horizon: "swing", cfg: NOCOST, thresholds: OPEN, analyzers: stubs(), warmup: 250, useML: false });
  assert.strictEqual(r.trades[0].reason, "target");
  assert.strictEqual(r.trades[0].exit, 106);
  const both = r.trades.find(t => t.exitT === c[256].t);
  assert.ok(both && both.reason === "stop", JSON.stringify(r.trades.slice(0, 4)));
  const gap = r.trades.find(t => t.exitT === c[258].t);
  assert.ok(gap && gap.reason === "target" && gap.exit === 110, "gap through target fills at the open");
});

test("horizon exit after `ahead` bars; fees + slippage are charged", () => {
  const c = flat(300);
  // wide ATR so the expected move clears the 2× round-trip cost gate
  const r = BT.run({ candles: c, asset: STOCK, horizon: "swing", thresholds: OPEN, analyzers: stubs({ atr: () => 8 }), warmup: 250, useML: false,
    cfg: { FEE_BPS_STOCK: 10, SLIPPAGE_BPS: 5 } });
  const t0 = r.trades[0];
  assert.strictEqual(t0.reason, "horizon");
  assert.strictEqual(t0.bars, 5);
  // entry 100·1.0005, exit 100·0.9995, minus 2×10 bps fee
  assert.ok(Math.abs(t0.ret - (0.9995 / 1.0005 - 1 - 0.002)) < 1e-6);
  assert.ok(r.metrics.totalReturn < 0, "flat market + costs loses money");
  assert.strictEqual(r.metrics.costs.roundTripBps, 30);
});

test("no lookahead: analyzers only ever see candles[0..i]; decisions enter strictly later", () => {
  const c = walk(400, 0.001);
  const seen = [];
  const guard = (w, ctx) => { assert.strictEqual(w[w.length - 1], c[ctx.i]); seen.push(ctx.i); return [{ id: "tech.trend.stub", family: "technical", score: 1, confidence: 1 }]; };
  const mlGuard = (w, ctx) => { assert.strictEqual(w.length, ctx.i + 1); return []; };
  const r = BT.run({ candles: c, asset: STOCK, horizon: "swing", cfg: NOCOST, thresholds: OPEN, warmup: 250,
    analyzers: stubs({ technical: guard, ml: mlGuard, regime: (w, ctx) => { assert.strictEqual(w[w.length - 1], c[ctx.i]); return { trend: "range", vol: "normal" }; } }) });
  assert.ok(seen.length > 100);
  for (const t of r.trades) assert.ok(t.entryT > c[250].t);
  // a future-peeking stub cannot be constructed from the window: last bar is always the decision bar
  assert.strictEqual(r.equity.length, 400 - 250);
});

test("walk-forward output shape, calibration pairs, signal stats, buy-and-hold comparison", () => {
  const c = walk(700, 0.002);
  const trend = (w) => {
    const n = w.length, r = w[n - 1].c / w[n - 21].c - 1;
    return [{ id: "tech.trend.tsmom", family: "technical", score: Math.max(-1, Math.min(1, r * 10)), confidence: 0.9, reason: "20d momentum" },
      { id: "tech.meanrev.zscore", family: "technical", score: -Math.max(-1, Math.min(1, r * 5)), confidence: 0.5, reason: "z" }];
  };
  const r = BT.run({ candles: c, asset: STOCK, horizon: "swing", analyzers: stubs({ technical: trend }), warmup: 250, stride: 2 });
  const m = r.metrics;
  for (const k of ["cagr", "sharpe", "sortino", "maxDD", "nTrades", "exposure", "brier", "ece"]) assert.ok(Number.isFinite(m[k]), k);
  assert.ok(m.buyHold && Number.isFinite(m.buyHold.cagr) && m.buyHold.totalReturn > 0);
  assert.ok(r.calibrationPairs.length > 100);
  for (const q of r.calibrationPairs) assert.ok(q.p > 0 && q.p < 1 && (q.y === 0 || q.y === 1));
  assert.ok(r.signalStats["tech.trend.tsmom"].n > 50);
  assert.ok(r.signalStats["tech.trend.tsmom"].hits <= r.signalStats["tech.trend.tsmom"].n);
  assert.ok(Array.isArray(r.notes) && r.notes.some(s => /effective sample/.test(s)));
  assert.strictEqual(r.equity.length, 700 - 250);
  assert.ok(m.maxDD >= 0 && m.maxDD < 1);
  // deterministic
  const r2 = BT.run({ candles: c, asset: STOCK, horizon: "swing", analyzers: stubs({ technical: trend }), warmup: 250, stride: 2 });
  assert.deepStrictEqual(r2.metrics, m);
});

test("ML is optional: a throwing ML analyzer is dropped gracefully", () => {
  const c = walk(400);
  const r = BT.run({ candles: c, asset: STOCK, horizon: "swing", thresholds: OPEN, cfg: NOCOST, warmup: 250,
    analyzers: stubs({ ml: () => { throw new Error("boom"); } }) });
  assert.strictEqual(r.metrics.useML, false);
  assert.ok(r.notes.some(n => /Analyzer errors/.test(n)));
  assert.ok(r.trades.length > 0);
});

test("cost gate: with a narrow ATR and real costs the engine does not trade", () => {
  const r = BT.run({ candles: flat(300), asset: STOCK, horizon: "swing", thresholds: OPEN, analyzers: stubs(), warmup: 250,
    cfg: { FEE_BPS_STOCK: 10, SLIPPAGE_BPS: 5 } });
  assert.strictEqual(r.metrics.nTrades, 0);
});

test("small samples get an honest caveat; short input returns empty result", () => {
  const r = BT.run({ candles: flat(300), asset: STOCK, horizon: "swing", analyzers: stubs({ technical: () => [] }), warmup: 250 });
  assert.strictEqual(r.metrics.nTrades, 0);
  assert.ok(r.notes.some(n => /Only 0 trades/.test(n)));
  const e = BT.run({ candles: flat(50), asset: STOCK, analyzers: stubs() });
  assert.strictEqual(e.metrics, null);
  assert.deepStrictEqual(e.trades, []);
});

test("sharpeSignificance / wilson / ece helpers", () => {
  const good = Array.from({ length: 500 }, (_, k) => 0.002 + ((k * 7919) % 13 - 6) * 0.001);
  const s = BT.sharpeSignificance(good, 10);
  assert.ok(s.psr > 0.99 && s.dsr <= s.psr);
  const noise = Array.from({ length: 500 }, (_, k) => ((k * 7919) % 13 - 6) * 0.001);
  assert.ok(BT.sharpeSignificance(noise, 10).dsr < 0.6);
  const [lo, hi] = BT.wilson(55, 100);
  assert.ok(lo < 0.55 && hi > 0.55 && lo > 0.44 && hi < 0.65);
  assert.ok(Math.abs(BT.ece([{ p: 0.6, y: 1 }, { p: 0.6, y: 0 }], 1) - 0.1) < 1e-12);
});
