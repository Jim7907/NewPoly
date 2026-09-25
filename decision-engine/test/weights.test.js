"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { WeightLearner } = require("../server/learning/weights");

const sig = (id, score, confidence = 1) => ({ id, family: "technical", score, confidence });

test("correct signals go up, wrong go down, neutral untouched", () => {
  const L = new WeightLearner({ eta: 0.1, decay: 0 });
  L.update([sig("a", 0.8), sig("b", -0.8), sig("c", 0), sig("d", 0.5, 0)], 1);
  assert.ok(Math.abs(L.get("a") - Math.exp(0.08)) < 1e-12);
  assert.ok(Math.abs(L.get("b") - Math.exp(-0.08)) < 1e-12);
  assert.strictEqual(L.get("c"), 1);
  assert.strictEqual(L.get("d"), 1);
  assert.strictEqual(L.get("unknown"), 1);
  L.update([sig("b", -1, 0.5)], 0); // bearish and y=0 → correct
  assert.ok(Math.abs(L.get("b") - Math.exp(-0.08 + 0.05)) < 1e-12);
  const rep = L.report();
  assert.deepStrictEqual(rep.b, { w: +Math.exp(-0.03).toFixed(4), n: 2, hitRate: 0.5 });
  assert.strictEqual(rep.a.hitRate, 1);
  assert.ok(!("c" in rep));
});

test("weights are clamped to [0.25, 4]", () => {
  const L = new WeightLearner({ eta: 1, decay: 0 });
  for (let i = 0; i < 50; i++) L.update([sig("good", 1), sig("bad", 1)], i % 1 === 0 ? 1 : 0) , L.update([sig("bad", -1)], 1);
  assert.strictEqual(L.get("good"), 4);
  assert.ok(L.get("bad") >= 0.25);
  const L2 = new WeightLearner({ eta: 1, decay: 0 });
  for (let i = 0; i < 50; i++) L2.update([sig("x", 1)], 0);
  assert.strictEqual(L2.get("x"), 0.25);
});

test("decay pulls weights back toward 1", () => {
  const L = new WeightLearner({ eta: 0.5, decay: 0.05 });
  for (let i = 0; i < 10; i++) L.update([sig("a", 1), sig("b", 1)], 1);
  for (let i = 0; i < 10; i++) L.update([sig("b", 1)], 0);
  const high = L.get("a");
  assert.ok(high > 1.5);
  for (let i = 0; i < 200; i++) L.update([sig("z", 0.1, 0.1)], 1); // unrelated updates tick the clock
  assert.ok(L.get("a") < high && L.get("a") > 1 && L.get("a") < 1.01);
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
  L.update([sig("a", 0.7, 0.9), sig("b", -0.3, 0.4)], 1);
  L.update([sig("a", 0.7, 0.9)], 0);
  const R = WeightLearner.fromJSON(JSON.parse(JSON.stringify(L)));
  assert.deepStrictEqual(R.report(), L.report());
  assert.strictEqual(R.get("a"), L.get("a"));
  assert.strictEqual(R.eta, 0.2);
  R.update([sig("a", 1)], 1); L.update([sig("a", 1)], 1);
  assert.strictEqual(R.get("a"), L.get("a"));
  const junk = WeightLearner.fromJSON({ weights: { q: { w: 99, n: "x" } } });
  assert.strictEqual(junk.get("q"), 4);
  assert.strictEqual(WeightLearner.fromJSON(null).get("q"), 1);
});
