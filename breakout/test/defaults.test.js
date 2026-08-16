// Regression tests for the SHIPPED DEFAULTS, run against a committed slice of real Coinbase
// BTC daily bars.
//
// The fixture is deliberately the out-of-sample slice: the defaults were chosen on BTC bars
// before 2023-01-01 and this file starts after that (plus 250 bars of indicator warmup). So a
// pass here means the defaults still work on data they were never fitted to — and a future
// parameter change that only looks good in-sample will fail this test.
//
// These are not assertions that the strategy is good. They pin the claims the README makes.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const backtest = require("../server/backtest");
const { DEFAULT_PARAMS, PRESETS } = require("../server/config");

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/btc-1d-oos.json"), "utf8"));
const bars = fx.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const run = (over = {}) => backtest.run(bars, over).stats;

test("fixture is the held-out period and long enough to mean something", () => {
  assert.ok(bars.length > 1000, `only ${bars.length} bars`);
  const evalBars = bars.filter(b => b.t >= fx.evalFrom);
  assert.ok(evalBars.length > 1200, "the scored period should dominate the warmup");
  assert.ok(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t), "strictly ascending");
  assert.ok(bars.every(b => b.h >= b.l && b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c),
    "OHLC must be internally consistent");
});

test("the shipped defaults are the validated runner configuration", () => {
  assert.deepEqual(DEFAULT_PARAMS.tpR, [], "no static targets by default");
  assert.equal(DEFAULT_PARAMS.slMode, "atr");
  assert.equal(DEFAULT_PARAMS.slAtrMult, 2);
  assert.equal(DEFAULT_PARAMS.trailAfterTp, 0, "trail arms from entry when there are no targets");
  assert.ok(DEFAULT_PARAMS.trailAtrMult > 0, "the trail is the only exit, so it must be on");
});

test("defaults are profitable on out-of-sample BTC daily bars", () => {
  const s = run({});
  assert.ok(s.trades >= 15, `too few trades to judge: ${s.trades}`);
  assert.ok(s.expectancyR > 0, `expectancy ${s.expectancyR}R should be positive`);
  assert.ok(s.profitFactor > 1, `profit factor ${s.profitFactor} should exceed 1`);
  assert.ok(s.netProfitPct > 0, `net ${s.netProfitPct}% should be positive`);
});

test("costs stay small relative to the risk unit on the default timeframe", () => {
  const s = run({});
  assert.ok(s.avgCostR < 0.15, `fees are ${s.avgCostR}R per trade — the cost trap is back`);
  assert.equal(s.cappedTrades, 0, "risk-based sizing should not be hitting the leverage cap");
});

test("the scale-out ladder underperforms the runner on the same bars", () => {
  // This is the reason the defaults changed, so it is worth pinning: capping winners at fixed
  // targets while losers stay whole costs more than the higher win rate returns.
  const runner = run({});
  const ladder = run(PRESETS.ladder.params);
  assert.ok(ladder.winRate > runner.winRate, "the ladder does win more often");
  assert.ok(ladder.expectancyR < runner.expectancyR,
    `ladder ${ladder.expectancyR}R vs runner ${runner.expectancyR}R`);
});

test("intraday timeframes are cost-dominated, which is why the default is daily", () => {
  // Same bars, but priced as if each one were a 15m bar: the stop is then a tiny fraction of
  // price. Simulated here by shrinking the risk distance via a much tighter stop.
  const tight = run({ slMode: "atr", slAtrMult: 0.2, maxRiskAtr: 8 });
  const normal = run({});
  assert.ok(tight.avgCostR > normal.avgCostR * 3,
    "a tighter stop must raise cost per R, since notional rises as risk distance shrinks");
});

test("every preset produces a runnable result on real bars", () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    const s = run(preset.params);
    assert.ok(s.trades > 0, `preset ${key} produced no trades`);
    assert.ok(Number.isFinite(s.expectancyR), `preset ${key} produced a broken expectancy`);
  }
});
