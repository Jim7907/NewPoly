const test = require("node:test");
const assert = require("node:assert");
const backtest = require("../server/backtest");
const { withDefaults, buildSeries } = require("../server/strategy");
const { synthetic } = require("../server/candles");

// A signal handed straight to the simulator, so exit behaviour can be tested in isolation.
const sig = (i, side = "long") => ({
  i, side, level: side === "long" ? 101 : 99, atr: 2,
  range: { start: i - 20, end: i - 1, high: 101, low: 99 },
});

// Bars after the signal are supplied by the caller; index 0 of `after` is the signal bar (30).
function frame(after) {
  const pre = Array.from({ length: 30 }, (_, i) => ({ t: i * 900, o: 100, h: 101, l: 99, c: 100, v: 100 }));
  return [...pre, ...after.map((b, k) => ({ t: (30 + k) * 900, v: 100, ...b }))];
}

// slBufferAtr 0 puts the stop exactly on the broken level (101), so with an entry at 105 the
// risk is a round 4.00 and the targets land on 109 / 113 / 117 / 125.
const P = (over = {}) => withDefaults({ feeBps: 0, slipBps: 0, riskPct: 1, equity: 10000, slBufferAtr: 0, ...over });

test("entry fills at the next bar's open by default", () => {
  const bars = frame([
    { o: 103, h: 104, l: 102.9, c: 103.5 },   // signal bar (index 30)
    { o: 105, h: 105.5, l: 104, c: 105 },     // entry bar (index 31)
    { o: 105, h: 120, l: 105, c: 119 },
  ]);
  const p = P();
  const t = backtest.simulateTrade(bars, buildSeries(bars, p), sig(30), p, 10000);
  assert.equal(t.entryIndex, 31);
  assert.equal(t.entryPrice, 105);
  assert.equal(t.sl, 101, "stop sits on the broken level");
  assert.equal(t.risk, 4);
  assert.deepEqual(t.tps, [109, 113, 117, 125]);
});

test("targets fill in order and the remainder times out", () => {
  const p = P({ trailAfterTp: 0, maxBars: 5 });
  const bars = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 105, h: 108, l: 104.5, c: 107 },     // entry 105 — TP1 (109) not reached yet
    { o: 107, h: 114, l: 107, c: 113 },       // TP1 + TP2 (113)
    { o: 113, h: 118, l: 113, c: 117 },       // TP3 (117)
    { o: 117, h: 117.5, l: 116, c: 117 },
    { o: 117, h: 117.5, l: 116, c: 117 },
    { o: 117, h: 117.5, l: 116, c: 117 },     // index 36 = entry + 5 bars -> time stop
  ]);
  const t = backtest.simulateTrade(bars, buildSeries(bars, p), sig(30), p, 10000);
  assert.deepEqual(t.tpHits, [true, true, true, false]);
  assert.equal(t.exits[0].reason, "tp1");
  assert.equal(t.exits[0].price, 109);
  assert.equal(t.exitReason, "time");
  // 0.5 @ 1R + 0.25 @ 2R + 0.15 @ 3R + 0.10 @ 3R = 1.75R
  assert.ok(Math.abs(t.r - 1.75) < 1e-9, `got ${t.r}R`);
});

test("breakeven stop engages after TP1", () => {
  const p = P({ beAfterTp1: true, trailAfterTp: 0 });
  const bars = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 105, h: 110, l: 104.5, c: 109.5 },   // TP1 at 109 fills
    { o: 105, h: 105, l: 95, c: 96 },         // collapses back through the original stop
  ]);
  const t = backtest.simulateTrade(bars, buildSeries(bars, p), sig(30), p, 10000);
  assert.equal(t.tpHits[0], true);
  assert.equal(t.exitReason, "breakeven");
  assert.equal(t.exits[1].price, 105, "the runner exits at the entry price, not the original stop");
  assert.ok(Math.abs(t.r - 0.5) < 1e-9, "half the position banked 1R, the rest scratched");
});

test("pessimistic fills resolve an ambiguous bar as stop-first", () => {
  const bars = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 105, h: 105.2, l: 105, c: 105.1 },
    { o: 105, h: 115, l: 100, c: 102 },       // touches both the 109 target and the 101 stop
  ]);
  const pess = P({ pessimisticFills: true });
  const opti = P({ pessimisticFills: false });
  const a = backtest.simulateTrade(bars, buildSeries(bars, pess), sig(30), pess, 10000);
  const b = backtest.simulateTrade(bars, buildSeries(bars, opti), sig(30), opti, 10000);
  assert.equal(a.exitReason, "stop");
  assert.ok(Math.abs(a.r + 1) < 1e-6, "a clean stop-out is exactly -1R");
  assert.equal(b.tpHits[0], true, "the optimistic model books TP1 on the same bar");
  assert.ok(b.r > a.r);
});

test("a gap through the stop fills at the open, not at the stop price", () => {
  const p = P();
  const bars = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 105, h: 105.5, l: 104, c: 105 },
    { o: 90, h: 91, l: 88, c: 89 },
  ]);
  const t = backtest.simulateTrade(bars, buildSeries(bars, p), sig(30), p, 10000);
  assert.equal(t.exits[0].price, 90);
  assert.ok(Math.abs(t.r + 3.75) < 1e-9, "gap risk is far worse than the planned 1R");
});

test("shorts mirror longs", () => {
  const bars = frame([
    { o: 97, h: 99, l: 96.5, c: 97 },
    { o: 95, h: 95.5, l: 94, c: 94.5 },       // entry 95, stop 99 (broken level), risk 4
    { o: 94, h: 94, l: 90, c: 90.5 },         // TP1 91 fills, TP2 87 does not
    { o: 90, h: 96, l: 90, c: 95.5 },         // rips back through the breakeven stop
  ]);
  const p = P({ trailAfterTp: 0 });
  const t = backtest.simulateTrade(bars, buildSeries(bars, p), sig(30, "short"), p, 10000);
  assert.equal(t.entryPrice, 95);
  assert.equal(t.sl, 99);
  assert.deepEqual(t.tpHits, [true, false, false, false]);
  assert.equal(t.exits[0].price, 91);
  assert.equal(t.exitReason, "breakeven");
  assert.ok(Math.abs(t.r - 0.5) < 1e-9);
});

test("fees and slippage only ever reduce the result", () => {
  const bars = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 105, h: 110, l: 104.5, c: 109.5 },
    { o: 110, h: 122, l: 109, c: 121 },
  ]);
  const clean = P({ feeBps: 0, slipBps: 0 });
  const costly = P({ feeBps: 10, slipBps: 5 });
  const a = backtest.simulateTrade(bars, buildSeries(bars, clean), sig(30), clean, 10000);
  const b = backtest.simulateTrade(bars, buildSeries(bars, costly), sig(30), costly, 10000);
  assert.ok(b.pnl < a.pnl);
  assert.ok(b.fees > 0 && a.fees === 0);
});

test("retest mode waits for price to come back and expires if it does not", () => {
  const trend = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    ...Array.from({ length: 6 }, (_, k) => ({ o: 105 + k, h: 106 + k, l: 104.5 + k, c: 105.5 + k })),
  ]);
  const p = P({ entryMode: "retest", retestBars: 3 });
  assert.equal(backtest.simulateTrade(trend, buildSeries(trend, p), sig(30), p, 10000), null);

  const pullback = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 103, h: 103.5, l: 100.5, c: 102 },   // trades back through the 101 level
    { o: 102, h: 115, l: 101, c: 114 },
  ]);
  const t = backtest.simulateTrade(pullback, buildSeries(pullback, p), sig(30), p, 10000);
  assert.equal(t.entryPrice, 101, "the limit fills at the level");
  assert.equal(t.entryIndex, 31);
});

test("position size follows the risk budget and respects the leverage cap", () => {
  const bars = frame([
    { o: 103, h: 104, l: 103, c: 103.5 },
    { o: 105, h: 105.5, l: 104, c: 105 },
    { o: 105, h: 120, l: 105, c: 119 },
  ]);
  const p = P({ riskPct: 1, maxLeverage: 100 });
  const t = backtest.simulateTrade(bars, buildSeries(bars, p), sig(30), p, 10000);
  assert.ok(Math.abs(t.qty * t.risk - 100) < 1e-6, "1% of 10k = $100 at risk");
  assert.equal(t.sizeCapped, false);

  const capped = P({ riskPct: 50, maxLeverage: 1 });
  const c = backtest.simulateTrade(bars, buildSeries(bars, capped), sig(30), capped, 10000);
  assert.equal(c.sizeCapped, true);
  assert.ok(c.qty * c.entryPrice <= 10000 + 1e-6, "notional never exceeds the leverage cap");
});

test("a full run keeps positions serial and the equity curve consistent", () => {
  const bars = synthetic("BTC-USD", "15m", 1200, 11);
  const res = backtest.run(bars, { volMult: 1.2, minAdx: 12, riskPct: 1 });
  assert.ok(res.trades.length > 5, `expected trades, got ${res.trades.length}`);

  let prevExit = -1, equity = res.params.equity;
  for (const t of res.trades) {
    assert.ok(t.entryIndex > prevExit, "positions must not overlap");
    assert.ok(t.exitIndex >= t.entryIndex);
    assert.ok(t.exits.length > 0);
    const portion = t.exits.reduce((s, e) => s + e.portion, 0);
    assert.ok(Math.abs(portion - 1) < 1e-6, "the whole position must be closed out");
    equity += t.pnl;
    assert.ok(Math.abs(equity - t.equityAfter) < 1e-6, "equity compounds trade by trade");
    prevExit = t.exitIndex + res.params.cooldownBars;
  }
  assert.equal(res.stats.trades, res.trades.length);
  assert.ok(Math.abs(res.equityCurve[res.equityCurve.length - 1].equity - equity) < 1e-6);
});

test("run degrades gracefully on a series that is too short", () => {
  const res = backtest.run(synthetic("BTC-USD", "15m", 100, 3).slice(0, 40));
  assert.equal(res.trades.length, 0);
  assert.equal(res.stats.trades, 0);
  assert.equal(res.barCount, 40);
});

test("the result reports a bar COUNT, so it can be merged with the bar array server-side", () => {
  const bars = synthetic("BTC-USD", "15m", 400, 5);
  const res = backtest.run(bars, {});
  assert.equal(res.barCount, 400);
  assert.equal(res.bars, undefined, "a `bars` field here would clobber the array in the API response");
});
