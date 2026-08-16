const test = require("node:test");
const assert = require("node:assert");
const strategy = require("../server/strategy");
const { synthetic } = require("../server/candles");

// 60 bars oscillating inside 99–101 (ATR = 2), then one bar that breaks out.
function rangeThenBreak({ close = 103, high = null, vol = 100, breakVol = 100, pre = 60 } = {}) {
  const bars = [];
  for (let i = 0; i < pre; i++) {
    const c = i % 2 ? 100.5 : 99.5;
    bars.push({ t: i * 900, o: 100, h: 101, l: 99, c, v: vol });
  }
  bars.push({ t: pre * 900, o: 100.5, h: high ?? Math.max(close, 101), l: 99.8, c: close, v: breakVol });
  bars.push({ t: (pre + 1) * 900, o: close, h: close + 1, l: close - 1, c: close, v: vol });
  return bars;
}

const noFilters = { volFilter: false, flatFilter: false, trendFilter: false };

test("a close beyond the range high produces an accepted long signal", () => {
  const bars = rangeThenBreak();
  const sigs = strategy.detectSignals(bars, noFilters);
  const s = sigs.find(x => x.i === 60);
  assert.ok(s, "expected a signal on the breakout bar");
  assert.equal(s.side, "long");
  assert.equal(s.accepted, true);
  assert.equal(s.range.high, 101);
  assert.equal(s.range.low, 99);
  assert.ok(Math.abs(s.atr - 2) < 1e-6);
});

test("a wick beyond the level is not a break when closeBeyondLevel is on", () => {
  const bars = rangeThenBreak({ close: 100.5, high: 110 });
  assert.equal(strategy.detectSignals(bars, noFilters).length, 0);
  const wicks = strategy.detectSignals(bars, { ...noFilters, closeBeyondLevel: false });
  assert.equal(wicks.length, 1, "wick mode should see it");
  assert.equal(wicks[0].side, "long");
});

test("the buffer scales with ATR — a marginal break is ignored", () => {
  const bars = rangeThenBreak({ close: 101.1 });     // only 0.05 ATR past the level
  assert.equal(strategy.detectSignals(bars, noFilters).length, 0);
  assert.equal(strategy.detectSignals(bars, { ...noFilters, breakoutBufferAtr: 0.01 }).length, 1);
});

test("volume filter rejects a break with no volume expansion", () => {
  const quiet = strategy.detectSignals(rangeThenBreak({ breakVol: 100 }), { flatFilter: false, volMult: 1.4 });
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].accepted, false);
  assert.deepEqual(quiet[0].reasons, ["volume"]);

  const loud = strategy.detectSignals(rangeThenBreak({ breakVol: 300 }), { flatFilter: false, volMult: 1.4 });
  assert.equal(loud[0].accepted, true);
});

test("direction restricts which side can fire", () => {
  const bars = rangeThenBreak();
  assert.equal(strategy.detectSignals(bars, { ...noFilters, direction: "short" }).length, 0);
  assert.equal(strategy.detectSignals(bars, { ...noFilters, direction: "long" }).length, 1);
});

test("a break below the range low is a short with a stop above the broken level", () => {
  const bars = rangeThenBreak({ close: 97 });
  bars[60] = { t: 60 * 900, o: 99.5, h: 100.2, l: 96.5, c: 97, v: 100 };
  const s = strategy.detectSignals(bars, noFilters)[0];
  assert.equal(s.side, "short");
  assert.equal(s.level, 99);
  assert.ok(s.plan.sl > s.level, "stop sits just above the boundary that broke");
  assert.ok(s.plan.tps[0] < s.plan.entry);
});

test("targets are exact R multiples of the entry-to-stop distance", () => {
  const ctx = { level: 101, high: 101, low: 99 };
  const plan = strategy.buildPlan("long", 103, ctx, 2, strategy.withDefaults({ tpR: [1, 2, 3, 5] }));
  assert.ok(Math.abs(plan.sl - 100.5) < 1e-9);       // broken level - 0.25 ATR
  assert.ok(Math.abs(plan.risk - 2.5) < 1e-9);
  plan.tps.forEach((tp, k) => assert.ok(Math.abs(tp - (103 + [1, 2, 3, 5][k] * 2.5)) < 1e-9));
});

test("stop modes place risk at different structures", () => {
  const ctx = { level: 101, high: 101, low: 99 };
  const p = (o) => strategy.withDefaults({ slBufferAtr: 0.25, ...o });
  assert.ok(Math.abs(strategy.buildPlan("long", 103, ctx, 2, p({ slMode: "level" })).sl - 100.5) < 1e-9);
  assert.ok(Math.abs(strategy.buildPlan("long", 103, ctx, 2, p({ slMode: "range" })).sl - 98.5) < 1e-9);
  assert.ok(Math.abs(strategy.buildPlan("long", 103, ctx, 2, p({ slMode: "atr", slAtrMult: 1.5 })).sl - 100) < 1e-9);
});

test("structure stops never come out tighter than half an ATR", () => {
  // Entry barely above the level it broke — structure alone would leave ~0 risk.
  const plan = strategy.buildPlan("long", 100.05, { level: 100, high: 100, low: 99.99 }, 2,
    strategy.withDefaults({ slBufferAtr: 0 }));
  assert.ok(plan.risk >= 1 - 1e-9, `risk ${plan.risk} should be floored at 0.5 ATR`);
});

test("allocations are normalized to the number of targets", () => {
  assert.deepEqual(strategy.normalizeAlloc([1, 1], 2), [0.5, 0.5]);
  const three = strategy.normalizeAlloc([0.5, 0.25, 0.15, 0.1], 3);
  assert.equal(three.length, 3);
  assert.ok(Math.abs(three.reduce((s, v) => s + v, 0) - 1) < 1e-9);
});

test("cooldown thins clustered signals without hiding the raw breakouts", () => {
  const bars = synthetic("BTC-USD", "15m", 1500, 11);
  const counts = [1, 5, 20].map(cooldownBars => {
    const sigs = strategy.detectSignals(bars, { ...noFilters, cooldownBars });
    return { raw: sigs.length, accepted: sigs.filter(s => s.accepted).length };
  });
  assert.equal(counts[0].raw, counts[2].raw, "every breakout is still reported");
  assert.ok(counts[0].accepted > counts[1].accepted, "a longer cooldown takes fewer of them");
  assert.ok(counts[1].accepted > counts[2].accepted);
  const clustered = strategy.detectSignals(bars, { ...noFilters, cooldownBars: 20 }).filter(s => !s.accepted);
  assert.ok(clustered.some(s => s.reasons.includes("cooldown")));
});

test("no lookahead: truncating the series cannot change earlier signals", () => {
  const bars = synthetic("BTC-USD", "15m", 800, 7);
  const params = { volMult: 1.2, minAdx: 10 };
  const full = strategy.detectSignals(bars, params);
  const cut = 500;
  const partial = strategy.detectSignals(bars.slice(0, cut), params);
  const expected = full.filter(s => s.i < cut);
  assert.ok(expected.length > 3, "need a few signals to make this meaningful");
  assert.equal(partial.length, expected.length);
  for (let k = 0; k < expected.length; k++) {
    assert.equal(partial[k].i, expected[k].i);
    assert.equal(partial[k].side, expected[k].side);
    assert.equal(partial[k].accepted, expected[k].accepted);
    assert.ok(Math.abs(partial[k].plan.sl - expected[k].plan.sl) < 1e-9);
  }
});
