// What the strategy does on stocks, pinned against 24 years of real SPY bars.
//
// This fixture is out-of-sample by construction: the defaults were selected on BTC daily bars
// and no equity data took any part in choosing them. The result is negative, and these tests
// exist so that stays documented rather than quietly drifting — a future change that makes the
// shipped defaults look good on equities should have to come and edit this file deliberately.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const backtest = require("../server/backtest");
const cfg = require("../server/config");

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/spy-1d.json"), "utf8"));
const bars = fx.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const run = (over = {}) => backtest.run(bars, over).stats;

test("the equity fixture is real, long, and well formed", () => {
  assert.ok(bars.length >= 5000, `only ${bars.length} bars`);
  const years = (bars[bars.length - 1].t - bars[0].t) / (365.25 * 24 * 3600);
  assert.ok(years > 20, `only ${years.toFixed(1)} years`);
  assert.ok(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t), "strictly ascending");
  assert.ok(bars.every(b => b.h >= b.l && b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c));
});

test("the shipped defaults LOSE on equity indices", () => {
  // Not a bug and not a regression: index breakouts on daily bars mean-revert, and the
  // defaults are tuned for crypto. Recorded so the README's claim stays true.
  const s = run({});
  assert.ok(s.trades > 40, `sample too small: ${s.trades}`);
  assert.ok(s.expectancyR < 0, `expected a negative edge, got ${s.expectancyR}R`);
  assert.ok(s.profitFactor < 1, `expected PF below 1, got ${s.profitFactor}`);
});

test("the short side is what loses; long-only is materially better", () => {
  const both = run({});
  const long = run({ direction: "long" });
  const short = run({ direction: "short" });
  assert.ok(short.expectancyR < both.expectancyR, "shorts drag the combined result down");
  assert.ok(long.expectancyR > both.expectancyR, "removing them recovers most of the damage");
  assert.ok(long.expectancyR > short.expectancyR + 0.3, "and the gap between sides is large");
});

test("costs are not the explanation on equities", () => {
  // On crypto 15m the fees were the whole story. Here they are small, so the negative result
  // is the signal itself failing rather than being taxed away.
  const s = run({});
  assert.ok(s.avgCostR < 0.15, `costs ${s.avgCostR}R are large enough to confound the result`);
  const free = run({ feeBps: 0, slipBps: 0 });
  assert.ok(free.expectancyR < 0, "still negative even with zero fees and zero slippage");
});

test("equity symbols are configured to fetch from Yahoo", () => {
  const equities = cfg.SYMBOLS.filter(s => s.asset === "equity");
  assert.ok(equities.length >= 10, "expected a real equity universe");
  assert.ok(equities.every(s => s.source === "yahoo"));
  assert.ok(cfg.SYMBOLS.filter(s => s.asset === "crypto").every(s => s.source === "coinbase"));
  assert.ok(cfg.PRESETS.equity, "an equity preset should exist");
  assert.equal(cfg.PRESETS.equity.params.direction, "long", "and it should be long-only");
});
