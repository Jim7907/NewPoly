const test = require("node:test");
const assert = require("node:assert");
const { calibration, perAsset } = require("../server/calib");

test("calibration metrics on a simple set", () => {
  // Perfectly-calibrated, all wins predicted at 1.0 -> brier 0
  const rows = [
    { side: "UP", pSide: 0.99, resolvedUp: 1 },
    { side: "DOWN", pSide: 0.99, resolvedUp: 0 },
    { side: "UP", pSide: 0.99, resolvedUp: 1 },
  ];
  const c = calibration(rows);
  assert.equal(c.n, 3);
  assert.equal(c.winRate, 100);
  assert.ok(c.brier < 0.01);
});

test("calibration handles a loss", () => {
  const rows = [
    { side: "UP", pSide: 0.8, resolvedUp: 1 },
    { side: "UP", pSide: 0.8, resolvedUp: 0 }, // predicted UP, resolved DOWN -> loss
  ];
  const c = calibration(rows);
  assert.equal(c.winRate, 50);
  assert.ok(c.brier > 0);
  assert.ok(c.logloss > 0);
});

test("empty input safe", () => {
  assert.equal(calibration([]).n, 0);
});

test("perAsset aggregates resolved trades", () => {
  const pa = perAsset([
    { asset: "BTC", status: "won", pnl: 1.2 },
    { asset: "BTC", status: "lost", pnl: -5 },
    { asset: "ETH", status: "won", pnl: 2 },
    { asset: "SOL", status: "open", pnl: null },
  ]);
  assert.equal(pa.BTC.n, 2);
  assert.equal(pa.BTC.winRate, 50);
  assert.equal(pa.ETH.winRate, 100);
  assert.ok(!pa.SOL); // open trades excluded
});
