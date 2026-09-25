"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Calibrator, reliabilityOf, fitIsotonic } = require("../server/learning/calibrator");

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// raw p is overconfident: true probability = 0.5 + 0.4·(p − 0.5)
function overconfident(n, seed = 1) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) { const p = r(); out.push({ p, y: r() < 0.5 + 0.4 * (p - 0.5) ? 1 : 0 }); }
  return out;
}

test("n_eff < 30: identity-with-shrink, reliable:false", () => {
  const c = new Calibrator().fit(overconfident(20));
  assert.strictEqual(c.reliability().reliable, false);
  assert.strictEqual(c.method, "identity-shrink");
  assert.ok(Math.abs(c.apply(0.9) - 0.7) < 1e-12);
  assert.ok(Math.abs(c.apply(0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(c.apply(0.1) - 0.3) < 1e-12);
  const empty = new Calibrator();
  assert.strictEqual(empty.apply(0.8), 0.65);
  assert.strictEqual(empty.apply(NaN), 0.5);
  // 100 pairs of a 5-bar label = n_eff 20 → still unreliable
  const c5 = new Calibrator().fit(overconfident(100), { ahead: 5 });
  assert.strictEqual(c5.method, "identity-shrink");
  assert.strictEqual(c5.reliability().nEff, 20);
});

test("method switches on n_eff = n / ahead", () => {
  const m = (n, ahead) => new Calibrator().fit(overconfident(n, n), { ahead }).method;
  assert.strictEqual(m(150, 1), "platt");
  assert.strictEqual(m(1500, 5), "isotonic+platt"); // n_eff 300 → blend starts (w_iso = 0)
  assert.strictEqual(m(1499, 5), "platt");
  assert.strictEqual(m(600, 1), "isotonic+platt");
  assert.strictEqual(m(2000, 1), "isotonic");
  assert.strictEqual(m(2000, 5), "isotonic+platt");
});

test("Platt corrects overconfidence", () => {
  const c = new Calibrator().fit(overconfident(150, 2));
  assert.strictEqual(c.method, "platt");
  assert.strictEqual(c.reliability().reliable, true);
  assert.ok(c.apply(0.95) < 0.85, `apply(0.95)=${c.apply(0.95)}`);
  assert.ok(c.apply(0.05) > 0.15);
  assert.ok(c.platt.a > 0 && c.platt.a < 1);
});

test("blend and isotonic improve Brier / ECE over raw, in and out of sample", () => {
  for (const n of [600, 3000]) {
    const c = new Calibrator().fit(overconfident(n, 3));
    const rel = c.reliability();
    assert.ok(rel.brier < rel.raw.brier);
    assert.ok(rel.ece < rel.raw.ece);
    assert.strictEqual(rel.bins.reduce((s, b) => s + b.n, 0), n);
    for (const k of ["n", "brier", "logloss", "ece"]) assert.ok(Number.isFinite(rel[k]));
    const held = overconfident(3000, 99);
    const bRaw = held.reduce((s, q) => s + (q.p - q.y) ** 2, 0) / held.length;
    const bCal = held.reduce((s, q) => s + (c.apply(q.p) - q.y) ** 2, 0) / held.length;
    assert.ok(bCal < bRaw, `n=${n}`);
  }
});

test("reliabilityOf: equal-mass bins, no fitting", () => {
  const pairs = overconfident(1000, 5).map(q => ({ p: 0.4 + 0.2 * q.p, y: q.y })); // clustered 0.4–0.6
  const r = reliabilityOf(pairs);
  assert.strictEqual(r.n, 1000);
  assert.strictEqual(r.bins.length, 10);
  for (const b of r.bins) assert.strictEqual(b.n, 100);
  for (let i = 1; i < r.bins.length; i++) assert.ok(r.bins[i].lo >= r.bins[i - 1].hi);
  const brier = pairs.reduce((s, q) => s + (q.p - q.y) ** 2, 0) / pairs.length;
  assert.ok(Math.abs(r.brier - brier) < 1e-6);
  assert.strictEqual(Calibrator.reliabilityOf, reliabilityOf);
  // perfectly calibrated constant → ECE 0, ties kept in one bin
  const flat = Array.from({ length: 100 }, (_, i) => ({ p: 0.5, y: i % 2 }));
  const rf = reliabilityOf(flat);
  assert.strictEqual(rf.bins.length, 1);
  assert.strictEqual(rf.ece, 0);
  assert.deepStrictEqual(reliabilityOf([]), { n: 0, brier: null, logloss: null, ece: null, bins: [] });
});

test("output is monotone non-decreasing in p and bounded, for every method", () => {
  for (const n of [10, 100, 600, 3000]) {
    const c = new Calibrator().fit(overconfident(n, n));
    let prev = -1;
    for (let p = 0; p <= 1.00001; p += 0.001) {
      const q = c.apply(p);
      assert.ok(q >= prev - 1e-12, `n=${n} not monotone at ${p}`);
      assert.ok(q >= 0.01 && q <= 0.99);
      prev = q;
    }
  }
});

test("anti-informative input does not get inverted", () => {
  const r = rng(4), pairs = [];
  for (let i = 0; i < 100; i++) { const p = r(); pairs.push({ p, y: r() < 1 - p ? 1 : 0 }); }
  const c = new Calibrator().fit(pairs);
  assert.ok(c.apply(0.9) >= c.apply(0.1));
});

test("PAV produces non-decreasing blocks", () => {
  const iso = fitIsotonic([{ p: 0.1, y: 1 }, { p: 0.2, y: 0 }, { p: 0.3, y: 0 }, { p: 0.4, y: 1 }, { p: 0.5, y: 1 }]);
  for (let i = 1; i < iso.ys.length; i++) assert.ok(iso.ys[i] >= iso.ys[i - 1]);
  for (let i = 1; i < iso.xs.length; i++) assert.ok(iso.xs[i] > iso.xs[i - 1]);
});

test("serialization round-trip", () => {
  for (const [n, ahead] of [[5, 1], [120, 1], [800, 1], [3000, 1], [3000, 5]]) {
    const c = new Calibrator().fit(overconfident(n, 7), { ahead });
    const r = Calibrator.fromJSON(JSON.parse(JSON.stringify(c)));
    for (const p of [0, 0.03, 0.2, 0.5, 0.77, 0.99, 1]) assert.strictEqual(r.apply(p), c.apply(p));
    assert.deepStrictEqual(r.reliability(), c.reliability());
    assert.strictEqual(r.method, c.method);
    assert.strictEqual(r.nEff, c.nEff);
  }
  const junk = Calibrator.fromJSON({ method: "platt" }); // missing params → safe fallback
  assert.strictEqual(junk.apply(0.9), 0.7);
  assert.strictEqual(Calibrator.fromJSON(null).apply(0.5), 0.5);
});

test("ignores malformed pairs", () => {
  const c = new Calibrator().fit([{ p: NaN, y: 1 }, null, { p: 0.4, y: 2 }, ...overconfident(40), { p: 0.6, y: true }]);
  assert.strictEqual(c.n, 41);
});
