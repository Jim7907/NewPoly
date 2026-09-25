"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { WeightLearner } = require("../server/learning/weights");

const sig = (id, score, confidence = 1) => ({ id, family: "technical", score, confidence });
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("defaults: eta 0.05, clamp [0.5, 2], fixed share 0.005", () => {
  const L = new WeightLearner();
  assert.strictEqual(L.eta, 0.05); assert.strictEqual(L.min, 0.5); assert.strictEqual(L.max, 2); assert.strictEqual(L.decay, 0.005);
});

test("correct signals go up, wrong go down, neutral untouched", () => {
  const L = new WeightLearner({ eta: 0.1, decay: 0 });
  L.update([sig("a", 0.8), sig("b", -0.8), sig("c", 0), sig("d", 0.5, 0)], 1);
  close(L.get("a"), Math.exp(0.08));
  close(L.get("b"), Math.exp(-0.08));
  assert.strictEqual(L.get("c"), 1);
  assert.strictEqual(L.get("d"), 1);
  assert.strictEqual(L.get("unknown"), 1);
  L.update([sig("b", -1, 0.5)], 0); // bearish and y=0 → correct
  close(L.get("b"), Math.exp(-0.08 + 0.05));
  const rep = L.report();
  assert.deepStrictEqual(rep.b, { w: +Math.exp(-0.03).toFixed(4), n: 2, hitRate: 0.5 });
  assert.strictEqual(rep.a.hitRate, 1);
  assert.ok(!("c" in rep));
});

test("scale multiplies the learning rate (overlapping labels)", () => {
  const L = new WeightLearner({ eta: 0.1, decay: 0 });
  L.update([sig("a", 1)], 1, { scale: 0.2 });
  close(L.get("a"), Math.exp(0.02));
  L.update([sig("a", 1)], 0, { scale: 0 });
  close(L.get("a"), Math.exp(0.02));
});

test("weights are clamped to [0.5, 2]", () => {
  const L = new WeightLearner({ eta: 1, decay: 0 });
  for (let i = 0; i < 50; i++) L.update([sig("good", 1), sig("bad", -1)], 1);
  assert.strictEqual(L.get("good"), 2);
  assert.strictEqual(L.get("bad"), 0.5);
});

test("fixed-share decay pulls weights back toward 1", () => {
  const L = new WeightLearner({ eta: 0.5, decay: 0.05 });
  for (let i = 0; i < 10; i++) L.update([sig("a", 1)], 1);
  const high = L.get("a");
  assert.ok(high > 1.5);
  L.update([sig("z", 0.1, 0.1)], 1); // one unrelated update: exactly one fixed-share step
  close(L.get("a"), 0.95 * high + 0.05);
  for (let i = 0; i < 300; i++) L.update([sig("z", 0.1, 0.1)], 1);
  assert.ok(L.get("a") > 1 && L.get("a") < 1.001);
});

test("seed() sets conservative priors from backtest hit rates", () => {
  const L = new WeightLearner();
  assert.strictEqual(L.seed({ good: { n: 200, hits: 120 }, bad: { n: 200, hits: 80 }, tiny: { n: 4, hits: 4 }, none: { n: 0, hits: 0 } }), 3);
  const hg = (120 + 25) / 250, hb = (80 + 25) / 250, ht = (4 + 25) / 54;
  close(L.get("good"), hg / (1 - hg));
  close(L.get("bad"), hb / (1 - hb));
  close(L.get("tiny"), ht / (1 - ht)); // 4/4 hits barely moves the weight
  assert.ok(L.get("tiny") < 1.2);
  assert.strictEqual(L.get("none"), 1);
  const r = L.report();
  assert.strictEqual(r.good.n, 0);
  assert.deepStrictEqual(r.good.prior, { n: 200, hits: 120, hitRate: 0.6 });
  const L2 = new WeightLearner();
  L2.seed({ x: { n: 1e6, hits: 1e6 } });
  assert.strictEqual(L2.get("x"), 2);
  assert.strictEqual(L2.seed(null), 0);
});

test("ignores bad input", () => {
  const L = new WeightLearner();
  assert.strictEqual(L.update([sig("a", 1)], 3), 0);
  assert.strictEqual(L.update([null, { score: 1 }, sig("a", NaN)], 1), 0);
  assert.strictEqual(L.update(null, 1), 0);
  assert.strictEqual(L.update([sig("a", 1)], true), 1);
  assert.ok(L.get("a") > 1);
});

test("serialization round-trip", () => {
  const L = new WeightLearner({ eta: 0.2, decay: 0.01 });
  L.seed({ c: { n: 100, hits: 60 } });
  L.update([sig("a", 0.7, 0.9), sig("b", -0.3, 0.4)], 1);
  L.update([sig("a", 0.7, 0.9)], 0, { scale: 0.5 });
  const R = WeightLearner.fromJSON(JSON.parse(JSON.stringify(L)));
  assert.deepStrictEqual(R.report(), L.report());
  assert.strictEqual(R.get("a"), L.get("a"));
  assert.strictEqual(R.get("c"), L.get("c"));
  assert.strictEqual(R.eta, 0.2);
  R.update([sig("a", 1)], 1); L.update([sig("a", 1)], 1);
  assert.strictEqual(R.get("a"), L.get("a"));
  const junk = WeightLearner.fromJSON({ weights: { q: { w: 99, n: "x" } } });
  assert.strictEqual(junk.get("q"), 2);
  assert.strictEqual(WeightLearner.fromJSON(null).get("q"), 1);
});
