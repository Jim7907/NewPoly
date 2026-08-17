const test = require("node:test");
const assert = require("node:assert");
const stats = require("../server/stats");

const trade = (pnl, r, side = "long", tpHits = [false, false, false, false], reason = "stop") => ({
  pnl, r, side, tpHits, exitReason: reason, fees: 1, bars: 10, mfe: Math.max(r, 0), mae: Math.min(r, 0),
});

const params = { equity: 1000, tpR: [1, 2, 3, 5] };
const bars = [{ t: 0 }, { t: 365.25 * 24 * 3600 }];   // exactly one year of data

test("empty summary is safe to render", () => {
  const s = stats.empty(500);
  assert.equal(s.trades, 0);
  assert.equal(s.finalEquity, 500);
  assert.deepEqual(s.tpRates, []);
});

test("core ratios are computed from the trade list", () => {
  const trades = [
    trade(200, 2, "long", [true, true, false, false], "tp2"),
    trade(-100, -1, "long"),
    trade(300, 3, "short", [true, true, true, false], "trail"),
    trade(-100, -1, "short"),
  ];
  const curve = [{ equity: 1000 }, { equity: 1200 }, { equity: 1100 }, { equity: 1400 }, { equity: 1300 }];
  const s = stats.summarize(trades, curve, params, bars);

  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 2.5);                  // 500 profit / 200 loss
  assert.equal(s.grossProfit, 500);
  assert.equal(s.grossLoss, 200);
  assert.equal(s.expectancyR, 0.75);                  // (2 - 1 + 3 - 1) / 4
  assert.equal(s.netProfitPct, 30);                   // 1300 vs 1000 starting equity
  assert.equal(s.payoff, 2.5);
});

test("per-target hit rates and the direction split are broken out", () => {
  const trades = [
    trade(200, 2, "long", [true, true, false, false], "tp2"),
    trade(-100, -1, "long"),
    trade(300, 3, "short", [true, true, true, false], "trail"),
    trade(-100, -1, "short"),
  ];
  const s = stats.summarize(trades, [{ equity: 1000 }, { equity: 1300 }], params, bars);
  assert.deepEqual(s.tpRates.map(t => t.rate), [50, 50, 25, 0]);
  assert.equal(s.tpRates[0].hits, 2);
  assert.equal(s.long.trades, 2);
  assert.equal(s.long.winRate, 50);
  assert.equal(s.short.avgR, 1);
  assert.deepEqual(s.exitReasons, { tp2: 1, stop: 2, trail: 1 });
});

test("drawdown is measured peak to trough", () => {
  const dd = stats.drawdown([{ equity: 100 }, { equity: 150 }, { equity: 90 }, { equity: 120 }]);
  assert.equal(dd.abs, 60);
  assert.equal(dd.pct, 40);
});

test("streaks count consecutive outcomes", () => {
  const s = stats.streaks([trade(1, 1), trade(1, 1), trade(-1, -1), trade(-1, -1), trade(-1, -1), trade(1, 1)]);
  assert.equal(s.maxWinStreak, 2);
  assert.equal(s.maxLossStreak, 3);
});

test("profit factor is null (not Infinity) when nothing lost", () => {
  const s = stats.summarize([trade(100, 1, "long", [true, false, false, false], "tp1")], [{ equity: 1000 }, { equity: 1100 }], params, bars);
  assert.equal(s.profitFactor, null);
  assert.equal(s.losses, 0);
});

test("cagr and sharpe reflect the elapsed span", () => {
  const trades = [trade(500, 2), trade(-100, -1), trade(300, 1.5), trade(-100, -1)];
  const curve = [{ equity: 1000 }, { equity: 1500 }, { equity: 1400 }, { equity: 1700 }, { equity: 1600 }];
  const s = stats.summarize(trades, curve, params, bars);
  assert.ok(Math.abs(s.cagr - 60) < 0.5, `one year, 1000 -> 1600 is ~60% CAGR, got ${s.cagr}`);
  assert.ok(s.sharpe > 0);
});

test("cost per trade in R and leverage-cap hits are reported", () => {
  const trades = [
    { ...trade(-100, -2.6), costR: 1.5, sizeCapped: true },
    { ...trade(50, 0.4), costR: 1.3, sizeCapped: false },
  ];
  const s = stats.summarize(trades, [{ equity: 1000 }, { equity: 950 }], params, bars);
  assert.equal(s.avgCostR, 1.4);
  assert.equal(s.cappedTrades, 1);
});
