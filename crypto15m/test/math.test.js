const test = require("node:test");
const assert = require("node:assert");
const m = require("../server/math");

test("normCdf known values", () => {
  assert.ok(Math.abs(m.normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(m.normCdf(1.0) - 0.8413) < 1e-3);
  assert.ok(Math.abs(m.normCdf(-1.0) - 0.1587) < 1e-3);
  assert.ok(m.normCdf(5) > 0.999);
});

test("pUp clamps", () => {
  assert.equal(m.pUp(100), 0.95);   // clamp hi
  assert.equal(m.pUp(-100), 0.05);  // clamp lo
  assert.ok(Math.abs(m.pUp(0) - 0.5) < 1e-6);
});

test("leadZ scaling: shrinking tau magnifies z", () => {
  const z1 = m.leadZ(0.002, 0.0001, 300);
  const z2 = m.leadZ(0.002, 0.0001, 60);
  assert.ok(z2 > z1, "less time left => larger |z| for same lead");
  assert.equal(m.leadZ(0.002, 0, 60), 0); // guard zero sigma
});

test("takerFeeFrac cheaper at extremes", () => {
  assert.ok(Math.abs(m.takerFeeFrac(0.5, 0.036) - 0.018) < 1e-6);   // 1.8% at 0.5
  assert.ok(m.takerFeeFrac(0.9, 0.036) < m.takerFeeFrac(0.5, 0.036));
});

test("netEdge and EV are fee-aware", () => {
  const net = m.netEdge(0.85, 0.78, 0.036, 0.005);
  assert.ok(Math.abs(net - (0.07 - 0.036 * 0.22 - 0.005)) < 1e-6);
  assert.ok(m.evPerDollar(0.85, 0.78, 0.036, 0) > 0);
  assert.ok(m.evPerDollar(0.50, 0.78, 0.036, 0) < 0); // losing bet
});

test("kellyFraction capped and zero on no-edge", () => {
  assert.equal(m.kellyFraction(0.7, 0.7, 0.15, 0.04), 0);  // no edge
  assert.equal(m.kellyFraction(0.6, 0.7, 0.15, 0.04), 0);  // negative
  const f = m.kellyFraction(0.85, 0.78, 0.15, 0.04);
  assert.ok(f > 0 && f <= 0.04);
});

test("imbalances", () => {
  assert.ok(m.bookImbalance([{ size: 3 }], [{ size: 1 }]) > 0);
  assert.equal(m.bookImbalance([], []), 0);
  assert.ok(m.tradeFlowImbalance([{ side: "buy", size: 2 }, { side: "sell", size: 1 }]) > 0);
});
