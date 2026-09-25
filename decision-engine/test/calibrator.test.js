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

test("no extrapolation: scores beyond training support map to the boundary; tiny tail blocks are merged", () => {
  const { Calibrator } = require("../server/learning/calibrator");
  const pairs = [];
  for (let i = 0; i < 3000; i++) { const p = 0.45 + 0.1 * (i % 100) / 100; pairs.push({ p, y: i % 2 }); }
  pairs.push({ p: 0.9, y: 1 }, { p: 0.91, y: 1 }, { p: 0.92, y: 1 });   // 3 lucky outliers
  const c = new Calibrator().fit(pairs, { ahead: 1 });
  assert.ok(c.apply(0.95) < 0.6, `extrapolated ${c.apply(0.95)}`);
  assert.ok(Math.abs(c.apply(0.95) - c.apply(c.support[1])) < 1e-9);
  const c2 = Calibrator.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(c2.apply(0.95), c.apply(0.95));
});

// ── Audit regressions (2026-09) ──
// Persistent score (AR(1), like the pooled pRaw) + overlapping 5-bar labels: PAV blocks have far
// fewer independent outcomes than their size, so an unshrunk isotonic map invents edges on noise.
function persistent(n, k, seed, ahead = 5) {
  const r = rng(seed), g = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const s = [], ret = [];
  let z = 0;
  for (let t = 0; t < n + ahead; t++) { z = 0.9 * z + Math.sqrt(0.19) * g(); s.push(z); ret.push(0.0006 + 0.02 * (k * z / Math.sqrt(ahead) + Math.sqrt(1 - k * k) * g())); }
  const out = [];
  for (let t = 0; t < n; t++) { let f = 0; for (let j = 1; j <= ahead; j++) f += ret[t + j]; out.push({ p: 1 / (1 + Math.exp(-0.15 * s[t])), y: f > 0 ? 1 : 0 }); }
  return out;
}

test("audit: out-of-fold λ shrink removes spurious edges on an uninformative, persistent score", () => {
  const train = persistent(6000, 0, 21), test = persistent(20000, 0, 22);
  const c = new Calibrator().fit(train, { ahead: 5 });
  const base = train.reduce((s, q) => s + q.y, 0) / train.length;
  assert.ok(c.lambda <= 0.25, `λ=${c.lambda}`);
  const spurious = test.filter(q => Math.abs(c.apply(q.p) - base) >= 0.04).length / test.length;
  assert.ok(spurious < 0.01, `share of bars with a fake ≥0.04 edge: ${spurious}`);
  const rel = c.reliability();
  assert.ok(rel.oof && Number.isFinite(rel.oof.brier) && Number.isFinite(rel.oof.bss) && rel.oof.n > 1000);
  assert.strictEqual(rel.lambda, c.lambda);
  // λ = 0 → the calibrator admits it has no demonstrated skill
  if (c.lambda === 0) assert.strictEqual(c.reliable, false);
});

test("audit: an informative score keeps most of its resolution (λ high) and beats the base rate OOS", () => {
  const train = persistent(15000, 0.15, 31), test = persistent(30000, 0.15, 32);
  const c = new Calibrator().fit(train, { ahead: 5 });
  assert.ok(c.lambda >= 0.6, `λ=${c.lambda}`);
  assert.strictEqual(c.reliable, true);
  const base = train.reduce((s, q) => s + q.y, 0) / train.length;
  const bCal = test.reduce((s, q) => s + (c.apply(q.p) - q.y) ** 2, 0) / test.length;
  const bBase = test.reduce((s, q) => s + (base - q.y) ** 2, 0) / test.length;
  assert.ok(bCal < bBase, `${bCal} vs base ${bBase}`);
  // monotone, and λ/base survive serialization
  let prev = -1;
  for (let p = 0; p <= 1; p += 0.01) { const q = c.apply(p); assert.ok(q >= prev - 1e-12); prev = q; }
  const r = Calibrator.fromJSON(JSON.parse(JSON.stringify(c)));
  for (const p of [0.3, 0.45, 0.5, 0.55, 0.7]) assert.strictEqual(r.apply(p), c.apply(p));
  assert.strictEqual(r.lambda, c.lambda);
});

test("audit: pre-audit (v2) serialized calibrators keep their behaviour (λ = 1)", () => {
  const legacy = { v: 2, method: "platt", n: 500, nEff: 500, ahead: 1, platt: { a: 0.5, b: 0.1 }, iso: null, wIso: 0, support: null };
  const c = Calibrator.fromJSON(legacy);
  const expect = 1 / (1 + Math.exp(-(0.5 * Math.log(0.7 / 0.3) + 0.1)));
  assert.ok(Math.abs(c.apply(0.7) - expect) < 1e-12);
});
