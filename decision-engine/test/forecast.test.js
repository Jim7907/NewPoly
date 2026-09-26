const test = require("node:test");
const assert = require("node:assert");
const E = require("../server/decision/ensemble");
const DS = require("../server/research/directionStats");

const asset = { id: "STOCK:X", symbol: "X", assetClass: "stock" };
const sig = (id, family, score, confidence) => ({ id, family, score, confidence, reason: id });

test("forecast direction always follows the signals' pooled evidence, even when the action is HOLD", () => {
  const up = E.decide({ asset, horizon: "swing", price: 100, atr: 2, signals: [
    sig("tech.trend.ema_stack", "technical", 0.6, 0.8), sig("tech.momentum.rsi", "technical", -0.2, 0.5), sig("regime.hmm.state", "regime", 0.3, 0.5)] });
  assert.equal(up.forecast.direction, "UP");
  assert.ok(up.forecast.alignment > 0.5 && up.forecast.alignment <= 1);
  assert.equal(up.forecast.votes.up, 2); assert.equal(up.forecast.votes.down, 1);
  assert.ok(up.logOdds > 0);
  const down = E.decide({ asset, horizon: "swing", price: 100, atr: 2, signals: [
    sig("tech.trend.ema_stack", "technical", -0.7, 0.9), sig("macro.risk.vix", "macro", -0.4, 0.6)] });
  assert.equal(down.forecast.direction, "DOWN");
  assert.ok(down.forecast.alignment > 0.99);
  assert.equal(down.forecast.pDirection, +(1 - down.pUp).toFixed(4));
});

test("forecast direction ignores calibration: a calibrator/base rate cannot flip it against the signals", () => {
  const cal = { apply: () => 0.45, reliability: () => ({ reliable: true, n: 5000, ece: 0.01 }) };
  const d = E.decide({ asset, horizon: "swing", price: 100, atr: 2, calibrator: cal, baseRate: 0.55,
    signals: [sig("tech.trend.ema_stack", "technical", 0.5, 0.8)] });
  assert.equal(d.forecast.direction, "UP");
  assert.ok(d.pUp < 0.5);
  assert.equal(d.forecast.pDirection, 0.45);    // honest: the calibrated odds of that UP call
});

test("strength tiers are monotone in alignment", () => {
  const mk = (against) => E.decide({ asset, horizon: "swing", price: 100, atr: 2, signals: [
    sig("tech.trend.ema_stack", "technical", 0.9, 1), sig("rel.xs.mom_rank", "relative", 0.9, 1), sig("macro.risk.vix", "macro", -against, 1)] }).forecast;
  const order = { weak: 0, moderate: 1, strong: 2 };
  const a = mk(0.05), b = mk(0.6), c = mk(0.95);
  assert.ok(a.alignment >= b.alignment && b.alignment >= c.alignment);
  assert.ok(order[a.strength] >= order[b.strength] && order[b.strength] >= order[c.strength]);
});

test("directionTable tallies hits vs base rate per class/direction/alignment bucket", () => {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const up = i % 2 === 0, j = Math.floor(i / 2);
    rows.push({ assetId: "STOCK:A", symbol: "A", assetClass: "stock", price: 10, atrPct: 0.02, regime: null,
      sig: { "tech.trend.ema_stack": [up ? 0.8 : -0.8, 0.9] },
      lab: { y: up ? (j % 10 < 8 ? 1 : 0) : (j % 10 < 3 ? 1 : 0) } });   // UP calls right 80%, DOWN calls right 70%
  }
  const t = DS.directionTable({ horizon: "swing", ahead: 5, rows, signalFamily: { "tech.trend.ema_stack": "technical" } });
  assert.equal(t.rows, 400);
  assert.ok(Math.abs(t.table.stock.UP.all.hitRate - 0.8) < 1e-9);
  assert.ok(Math.abs(t.table.stock.DOWN.all.hitRate - 0.7) < 1e-9);
  assert.ok(Math.abs(t.baseRates.stock - 0.55) < 1e-9);
  const look = DS.lookup(t, "stock", { direction: "UP", alignment: 1, strength: "strong" });
  assert.equal(look.bucket, "90-100%");
  assert.ok(look.hitRate > 0.79 && look.lift > 0.2);
});

test("historical cells carry a valid Wilson CI on n_eff = n/ahead", () => {
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push({ assetId: "STOCK:A", symbol: "A", assetClass: "stock", price: 10, atrPct: 0.02,
    sig: { "tech.trend.ema_stack": [0.8, 0.9] }, lab: { y: i % 5 < 3 ? 1 : 0 } });
  const t = DS.directionTable({ horizon: "swing", ahead: 5, rows, signalFamily: {} });
  const c = t.table.stock.UP.all;
  assert.ok(Array.isArray(c.ci95) && c.ci95.every(Number.isFinite), JSON.stringify(c.ci95));
  assert.ok(c.ci95[0] < 0.6 && c.ci95[1] > 0.6);
  assert.ok(c.ci95[1] - c.ci95[0] > 0.15);          // wide: n_eff = 120, not 600
});
