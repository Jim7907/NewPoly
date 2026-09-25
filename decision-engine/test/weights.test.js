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

// ── Audit regressions (2026-09) ──
function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }

test("audit: with baseRate, no-skill always-bull / always-bear signals stay near 1 (drift is not skill)", () => {
  const run = (baseRate) => {
    const L = new WeightLearner(), r = lcg(7);
    for (let t = 0; t < 3000; t++) {
      const y = r() < 0.57 ? 1 : 0;                       // stock-like weekly up-rate, independent of votes
      L.update([sig("bull", 0.6, 0.6), sig("bear", -0.6, 0.6)], y, { scale: 1 / 5, baseRate });
    }
    return [L.get("bull"), L.get("bear")];
  };
  const [bull0, bear0] = run(undefined);                   // legacy (b = 0.5): drift leaks into weights
  assert.ok(bull0 > 1.5 && bear0 < 0.8, `legacy ${bull0} ${bear0}`);
  const [bull, bear] = run(0.57);
  assert.ok(Math.abs(bull - 1) < 0.15 && Math.abs(bear - 1) < 0.15, `neutral ${bull} ${bear}`);
  // b = 0.5 reproduces the old ±1 rule exactly
  const A = new WeightLearner({ eta: 0.1, decay: 0 }), B = new WeightLearner({ eta: 0.1, decay: 0 });
  A.update([sig("a", 0.8)], 1); B.update([sig("a", 0.8)], 1, { baseRate: 0.5 });
  assert.strictEqual(A.get("a"), B.get("a"));
});

test("audit: seed() pools repeated calls instead of overwriting (warm start seeds per asset)", () => {
  const L = new WeightLearner();
  L.seed({ x: { n: 2000, hits: 1200 } });
  L.seed({ x: { n: 200, hits: 90 } });
  const h = (1290 + 25) / 2250;
  close(L.get("x"), h / (1 - h), 1e-12);
  assert.deepStrictEqual(L.report().x.prior, { n: 2200, hits: 1290, hitRate: +(1290 / 2200).toFixed(4) });
});

test("audit: seed() removes drift from hit rates and shrinks on n_eff = n/ahead", () => {
  // no-skill votes: always-bull hits the 57% base rate, always-bear 43%
  const L = new WeightLearner();
  L.seed({ bull: { n: 1000, hits: 570, nLong: 1000, yUp: 570, ahead: 5 }, bear: { n: 1000, hits: 430, nLong: 0, yUp: 570, ahead: 5 } });
  close(L.get("bull"), 1, 1e-9);
  close(L.get("bear"), 1, 1e-9);
  // a genuinely skilled balanced signal keeps its edge, but overlapping labels shrink it more
  const S = new WeightLearner(), S1 = new WeightLearner();
  S.seed({ s: { n: 1000, hits: 560, nLong: 500, yUp: 500, ahead: 5 } });
  S1.seed({ s: { n: 1000, hits: 560, nLong: 500, yUp: 500, ahead: 1 } });
  assert.ok(S.get("s") > 1 && S.get("s") < S1.get("s"), `${S.get("s")} vs ${S1.get("s")}`);
  assert.strictEqual(S.report().s.prior.skillHitRate, 0.56);
  // survives serialization
  const R = WeightLearner.fromJSON(JSON.parse(JSON.stringify(S)));
  assert.strictEqual(R.get("s"), S.get("s"));
  R.seed({ s: { n: 1000, hits: 560, nLong: 500, yUp: 500, ahead: 5 } });
  S.seed({ s: { n: 1000, hits: 560, nLong: 500, yUp: 500, ahead: 5 } });
  assert.strictEqual(R.get("s"), S.get("s"));
});

test("audit: clearPriors() lets a fresh warm start re-seed without pooling stale backtests", () => {
  const L = new WeightLearner();
  L.seed({ x: { n: 1000, hits: 600 } });
  assert.strictEqual(L.clearPriors(), 1);
  L.seed({ x: { n: 1000, hits: 450 } });
  const h = (450 + 25) / 1050;
  close(L.get("x"), h / (1 - h), 1e-12);
});
