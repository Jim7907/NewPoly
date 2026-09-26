"use strict";
const test = require("node:test");
const assert = require("node:assert");
const ml = require("../server/analysis/ml");

// Seeded synthetic daily candles. phi = AR(1) coefficient of log returns (0 → pure random walk).
function gen(n, seed, phi = 0) {
  const rnd = ml.mulberry32(seed);
  const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  let c = 100, r = 0;
  const out = [], t0 = Date.UTC(2020, 0, 1);
  for (let i = 0; i < n; i++) {
    r = phi * r + 0.02 * g();
    const o = c; c = o * Math.exp(r);
    out.push({ t: t0 + i * 86400000, o, h: Math.max(o, c) * (1 + 0.005 * rnd()), l: Math.min(o, c) * (1 - 0.005 * rnd()), c, v: 1000 * (1 + rnd()) });
  }
  return out;
}

test("FEATURE_NAMES matches feature vector length; warm-up returns null", () => {
  const cs = gen(300, 1);
  assert.strictEqual(ml.buildFeatures(cs, 10), null);
  assert.strictEqual(ml.buildFeatures(cs, ml.WARMUP - 1), null);
  const f = ml.buildFeatures(cs, 200);
  assert.strictEqual(f.length, ml.FEATURE_NAMES.length);
  assert.ok(f.every(Number.isFinite));
  assert.strictEqual(ml.buildFeatures([], 0), null);
  assert.strictEqual(ml.buildFeatures(cs, 999), null);
});

test("zero lookahead: mutating candles after i leaves features at i unchanged", () => {
  const cs = gen(400, 7);
  for (const i of [60, 61, 150, 250, 398]) {
    const before = ml.buildFeatures(cs, i);
    const mutated = cs.map((k, j) => (j > i ? { t: k.t, o: k.o * 3, h: k.h * 5, l: k.l * 0.1, c: k.c * (j % 2 ? 4 : 0.2), v: k.v * 100 } : k));
    const truncated = cs.slice(0, i + 1);
    assert.deepStrictEqual(ml.buildFeatures(mutated, i), before, `mutation leaked into bar ${i}`);
    assert.deepStrictEqual(ml.buildFeatures(truncated, i), before);
  }
  // the batch matrix used in training agrees with the per-bar builder
  const rows = ml.featureMatrix(cs);
  const mutRows = ml.featureMatrix(cs.map((k, j) => (j > 300 ? { ...k, c: k.c * 2, h: k.h * 2 } : k)));
  for (const i of [60, 120, 250, 300]) {
    assert.deepStrictEqual(rows[i], ml.buildFeatures(cs, i));
    assert.deepStrictEqual(mutRows[i], rows[i]);
  }
});

test("bad inputs never produce NaN", () => {
  const cs = gen(200, 3).map((k, j) => (j % 17 === 0 ? { ...k, v: NaN, h: undefined } : k));
  const f = ml.buildFeatures(cs, 150);
  assert.ok(f && f.every(Number.isFinite));
  assert.deepStrictEqual(ml.signals(gen(50, 1), { ahead: 5 }), []);
  assert.deepStrictEqual(ml.signals(null, { ahead: 5 }), []);
});

test("auc helper", () => {
  assert.strictEqual(ml.auc([{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }]), 1);
  assert.strictEqual(ml.auc([{ p: 0.1, y: 1 }, { p: 0.9, y: 0 }]), 0);
  assert.strictEqual(ml.auc([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.5);
  assert.strictEqual(ml.auc([{ p: 0.5, y: 1 }]), 0.5);
  assert.ok(Math.abs(ml.auc([{ p: 0.2, y: 0 }, { p: 0.4, y: 1 }, { p: 0.6, y: 0 }, { p: 0.8, y: 1 }]) - 0.75) < 1e-12);
});

test("LogisticModel learns a linear boundary, is deterministic, round-trips JSON", () => {
  const rnd = ml.mulberry32(11), X = [], y = [];
  for (let i = 0; i < 400; i++) {
    const a = rnd() * 10 - 5, b = rnd() * 1000; // very different scales → standardization matters
    X.push([a, b]); y.push(a + 0.002 * (b - 500) + (rnd() - 0.5) > 0 ? 1 : 0);
  }
  const m = new ml.LogisticModel().fit(X, y, { l2: 1 });
  const m2 = new ml.LogisticModel().fit(X, y, { l2: 1 });
  assert.deepStrictEqual(m.toJSON(), m2.toJSON());
  assert.ok(m.predictProba([4, 500]) > 0.95);
  assert.ok(m.predictProba([-4, 500]) < 0.05);
  const r = ml.LogisticModel.fromJSON(JSON.parse(JSON.stringify(m)));
  assert.strictEqual(r.predictProba([1.3, 20]), m.predictProba([1.3, 20]));
  const gd = new ml.LogisticModel().fit(X, y, { solver: "gd", epochs: 500, lr: 0.5 });
  assert.ok(gd.predictProba([4, 500]) > 0.9);
});

test("GBMClassifier learns an interaction (AND), is deterministic, round-trips JSON", () => {
  const rnd = ml.mulberry32(5), X = [], y = [];
  for (let i = 0; i < 600; i++) { const a = rnd() - 0.5, b = rnd() - 0.5; X.push([a, b, rnd()]); y.push(a > 0 && b > 0 ? 1 : 0); }
  const g = new ml.GBMClassifier({ seed: 3 }).fit(X, y);
  const g2 = new ml.GBMClassifier({ seed: 3 }).fit(X, y);
  assert.deepStrictEqual(g.toJSON(), g2.toJSON());
  assert.ok(g.trees.length >= 1 && g.trees.length <= 200);
  assert.ok(g.predictProba([0.3, 0.3, 0.5]) > 0.7, `${g.predictProba([0.3, 0.3, 0.5])}`);
  assert.ok(g.predictProba([0.3, -0.3, 0.5]) < 0.3);
  assert.ok(g.predictProba([-0.3, 0.3, 0.5]) < 0.3);
  const r = ml.GBMClassifier.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.strictEqual(r.predictProba([0.1, -0.2, 0.3]), g.predictProba([0.1, -0.2, 0.3]));
});

test("defaults depend on bar spacing (research §5.1)", () => {
  const d = ml.resolveOpts(gen(100, 1), { ahead: 5 });
  assert.deepStrictEqual([d.minTrain, d.step, d.deadZone], [500, 20, 0.15]);
  const intra = gen(100, 1).map((k, i) => ({ ...k, t: Date.UTC(2024, 0, 1) + i * 900000 })); // 15m bars
  const m = ml.resolveOpts(intra, { ahead: 8, costBps: 10 });
  assert.deepStrictEqual([m.minTrain, m.step, m.deadZone, m.minAbsRet], [3000, 96, 0.2, 0.002]);
});

test("walk-forward is purged + embargoed: every OOS prediction comes from a model whose labels ended by then", () => {
  // Structural check: the first OOS bar is ≥ warm-up + minTrain + ahead (purge) + embargo (≥ ahead).
  const cs = gen(500, 2);
  const r = ml.trainWalkForward(cs, { ahead: 5, minTrain: 200, step: 20 });
  const firstIdx = cs.findIndex(k => k.t === r.oosPredictions[0].t);
  assert.ok(firstIdx >= ml.WARMUP + 200 - 1 + 5 + 5, `first OOS bar ${firstIdx}`);
  // OOS covers every bar with a known label from there on
  assert.strictEqual(r.nOos, cs.length - 5 - firstIdx);
  for (const q of r.oosPredictions) assert.ok(q.p > 0 && q.p < 1 && (q.y === 0 || q.y === 1));
});

test("(a) pure random walk: OOS AUC ≈ 0.5 and confidence ≈ 0 (leakage guard)", () => {
  const aucs = [];
  for (const seed of [101, 102, 103, 104, 105, 106]) {
    const cs = gen(1000, seed);
    const r = ml.trainWalkForward(cs, { ahead: 1 });
    aucs.push(r.oosAuc);
    assert.ok(Math.abs(r.oosAuc - 0.5) < 0.08, `seed ${seed}: AUC ${r.oosAuc}`);
    const conf = ml.confidenceFrom(r.oosAuc, r.stability, r.oosPredictions, 1);
    assert.ok(conf < 0.2, `seed ${seed}: confidence ${conf}`);
  }
  const mean = aucs.reduce((a, b) => a + b, 0) / aucs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean AUC ${mean}`);
  // overlapping 5-bar labels: the lower confidence bound must keep confidence at 0
  for (const seed of [1, 2]) {
    const s = ml.signals(gen(1000, seed), { ahead: 5, noCache: true });
    assert.strictEqual(s[0].id, "ml.ensemble.pup");
    assert.strictEqual(s[0].confidence, 0, `seed ${seed}`);
    assert.match(s[0].reason, /OOS AUC \d\.\d{3} over \d+ bars .*not distinguishable from chance/);
  }
});

test("(b) planted AR(1) φ=0.3 structure: OOS AUC clearly > 0.55 and confidence > 0", () => {
  for (const seed of [1, 2, 3]) {
    const cs = gen(1000, seed, 0.3);
    const r = ml.trainWalkForward(cs, { ahead: 1 });
    assert.ok(r.oosAuc > 0.56, `seed ${seed}: AUC ${r.oosAuc}`);
    assert.ok(r.oosAccuracy > r.baseline.accuracy, "beats majority-class baseline");
    assert.ok(r.oosBrier < r.baseline.brier, "beats base-rate Brier");
    const s = ml.signals(cs, { ahead: 1, noCache: true });
    assert.ok(s[0].confidence > 0.3, `seed ${seed}: confidence ${s[0].confidence}`);
    // prediction direction follows the last return (positive autocorrelation)
    const lastRet = Math.log(cs[cs.length - 1].c / cs[cs.length - 2].c);
    if (Math.abs(lastRet) > 0.02) assert.strictEqual(Math.sign(s[0].score), Math.sign(lastRet));
  }
});

test("signals shape, determinism, and caching", () => {
  ml.clearCache();
  const cs = gen(600, 9);
  const t0 = Date.now();
  const wf = ml.trainWalkForward(cs, { ahead: 5, minTrain: 250 }); // ~14 retrains of both models
  const trainMs = Date.now() - t0;
  assert.ok(wf.nOos > 250);
  assert.ok(trainMs < 1500, `600-bar walk-forward took ${trainMs}ms`);
  const s1 = ml.signals(cs, { ahead: 5, key: "SYN|86400", horizon: "swing" });
  assert.deepStrictEqual(s1.map(s => s.id), ["ml.ensemble.pup", "ml.logistic.pup", "ml.gbm.pup"]);
  for (const s of s1) {
    assert.strictEqual(s.family, "ml");
    assert.strictEqual(s.horizon, "swing");
    assert.ok(s.score >= -1 && s.score <= 1 && Number.isFinite(s.score));
    assert.ok(s.confidence >= 0 && s.confidence <= 1);
    // audit fix: score is centred on the model's base rate (a no-skill model no longer votes the drift)
    assert.ok(Math.abs(s.score - 2 * (s.value.p - s.value.baseRate)) < 1e-3);
    for (const k of ["p", "oosAuc", "n"]) assert.ok(Number.isFinite(s.value[k]));
  }
  const t1 = Date.now();
  const s2 = ml.signals(cs, { ahead: 5, key: "SYN|86400", horizon: "swing" });
  assert.ok(Date.now() - t1 < 100, "cached call should be fast");
  assert.deepStrictEqual(s2, s1);
  // a few new bars → cached model reused (no retrain) but prediction uses the new last bar
  const more = gen(603, 9);
  const e1 = ml.getModel("SYN|86400", cs, { ahead: 5 });
  assert.strictEqual(ml.getModel("SYN|86400", more, { ahead: 5 }), e1);
  assert.strictEqual(ml.getModel("SYN|86400", more.slice(3), { ahead: 5 }), e1, "rolling window reuses the model");
  const s3 = ml.signals(more, { ahead: 5, key: "SYN|86400", horizon: "swing" });
  assert.notDeepStrictEqual(s3[0].value.p, s1[0].value.p); // predicts from the new last bar
  assert.notStrictEqual(ml.getModel("SYN|86400", gen(640, 9), { ahead: 5 }), e1);
  assert.notStrictEqual(ml.getModel("SYN|86400", gen(600, 10), { ahead: 5 }), ml.getModel("SYN|86400", gen(640, 9), { ahead: 5 }), "replaced history retrains");
  assert.notStrictEqual(ml.getModel("SYN|86400", gen(640, 9), { ahead: 3 }), e1, "options are part of the identity");
});

test("not enough OOS history → confidence 0 with honest reason", () => {
  const cs = gen(350, 4, 0.3);
  const s = ml.signals(cs, { ahead: 5, noCache: true });
  assert.ok(s.length === 3);
  for (const x of s) { assert.strictEqual(x.confidence, 0); assert.match(x.reason, /not enough out-of-sample/); }
});

// ── Audit regressions (2026-09) ──
test("audit: a no-skill model on a drifting series does not cast a constant drift vote", () => {
  // strong upward drift, no autocorrelation: P(up over 5 bars) ≈ 0.6 unconditionally, no signal
  const up = gen(900, 12).map((k, i, a) => ({ ...k }));
  let c = 100; const rnd = ml.mulberry32(99);
  const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  for (const k of up) { const o = c; c = o * Math.exp(0.004 + 0.02 * g()); Object.assign(k, { o, c, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998 }); }
  const s = ml.signals(up, { ahead: 5, noCache: true, minTrain: 300 })[0];
  assert.ok(s.value.baseRate > 0.55, `base ${s.value.baseRate}`);
  const legacy = 2 * s.value.p - 1;
  assert.ok(Math.abs(s.score) < Math.abs(legacy), `centred ${s.score} vs legacy ${legacy}`);
  assert.ok(Math.abs(s.score - 2 * (s.value.p - s.value.baseRate)) < 1e-3);
});

test("audit: inference features pro-rate a still-forming last bar's volume", () => {
  const cs = gen(400, 3);
  const now = cs.at(-1).t + 0.2 * 86400000;                  // 20% into the last bar
  const partial = cs.map((k, i) => (i === cs.length - 1 ? { ...k, v: k.v * 0.2 } : k));
  const iv = ml.FEATURE_NAMES.indexOf("vol_z_20");
  const fFull = ml.buildFeatures(cs, cs.length - 1), fPart = ml.buildFeatures(partial, partial.length - 1);
  assert.ok(fPart[iv] < fFull[iv] - 1, "raw partial bar looks like a volume collapse");
  const I = require("../server/analysis/indicators");
  const fProj = ml.buildFeatures(I.projectFormingVolume(partial, { now }), partial.length - 1);
  assert.ok(Math.abs(fProj[iv] - fFull[iv]) < 1e-9, `${fProj[iv]} vs ${fFull[iv]}`);
});
