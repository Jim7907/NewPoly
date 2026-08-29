const test = require("node:test");
const assert = require("node:assert");
const c = require("../server/calib");

// Ten baskets: seven covered the outcome, three did not.
const baskets = Array.from({ length: 10 }, (_, i) => {
  const won = i < 7;
  return {
    status: won ? "won" : "lost", coverProb: 0.7, station: i % 2 ? "WSSS" : "EGLC",
    regime: i < 5 ? "tight" : "normal", leadDays: 1,
    obsValue: 31, center: 30.8 + (won ? 0 : 1.5),
    pnl: won ? 12 : -20, outlay: 20,
    legs: [{ prob: 0.4, won: won ? 1 : 0 }, { prob: 0.3, won: 0 }],
  };
});

test("reliability computes Brier, log-loss and ECE", () => {
  const r = c.reliability([{ p: 0.9, win: 1 }, { p: 0.9, win: 1 }, { p: 0.1, win: 0 }, { p: 0.1, win: 0 }]);
  assert.equal(r.n, 4);
  assert.ok(Math.abs(r.brier - 0.01) < 1e-9, "a well-calibrated, sharp forecaster scores near zero");
  assert.ok(r.ece < 0.11);
  assert.equal(c.reliability([]).n, 0);
});

test("legCalibration scores every rung across settled baskets", () => {
  const r = c.legCalibration(baskets);
  assert.equal(r.n, 20, "two rungs per basket");
  assert.ok(r.brier > 0 && r.ece != null);
  assert.equal(c.legCalibration([{ status: "open", legs: [{ prob: 0.4, won: null }] }]).n, 0);
});

test("coverCalibration contrasts the ladder's claim with what happened", () => {
  const r = c.coverCalibration(baskets);
  assert.equal(r.n, 10);
  assert.ok(Math.abs(r.claimedCover - 0.7) < 1e-9, "claimed 70% cover");
  assert.equal(r.realizedCover, 70, "and covered 70% of the time");
});

test("centerError measures residual bias the correction has not caught", () => {
  const r = c.centerError(baskets);
  assert.equal(r.n, 10);
  assert.ok(r.mae > 0);
  assert.ok(r.within1 >= r.withinHalf);
  assert.equal(c.centerError([]).n, 0);
});

test("groupBy reports realized economics per key and ignores open baskets", () => {
  const byRegime = c.groupBy(baskets, b => b.regime);
  assert.equal(byRegime.tight.n, 5);
  assert.equal(byRegime.tight.hitRate, 100);
  assert.equal(byRegime.normal.n, 5);
  assert.equal(byRegime.normal.hitRate, 40);
  assert.ok(byRegime.tight.roi > byRegime.normal.roi);
  assert.deepEqual(c.groupBy([{ status: "open", regime: "tight" }], b => b.regime), {});
});
