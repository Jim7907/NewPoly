"use strict";
const test = require("node:test");
const assert = require("node:assert");
const T = require("../server/learning/tuner");

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} expected ${b} ± ${tol}, got ${a}`);

// ───────────── Deflated / probabilistic Sharpe ─────────────

test("deflatedSharpe reproduces the Bailey & López de Prado (2014) numerical example", () => {
  // Paper §5: N = 100 trials, annualised V[SR_n] = 1/2, best annualised SR = 2.5 over T = 1250
  // daily obs (5 years), skew = −3, kurtosis = 10 → SR0 = 0.1132 (non-annualised), DSR = 0.9004.
  const d = T.deflatedSharpe({ sr: 2.5 / Math.sqrt(250), T: 1250, skew: -3, kurt: 10 }, { nTrials: 100, srVariance: 0.5 / 250 });
  close(d.sr0, 0.1132, 5e-4, "SR0");
  close(d.dsr, 0.9004, 1e-3, "DSR");
  close(d.sr0 * Math.sqrt(250), 1.79, 0.005, "annualised SR0");
  console.log(`# DSR paper example: SR0=${d.sr0.toFixed(5)} (paper 0.1132), DSR=${d.dsr.toFixed(4)} (paper 0.9004)`);
});

test("probabilisticSharpe matches hand computations (normal and non-normal returns)", () => {
  // SR 0.1, T 101, normal: z = 0.1·√100 / √(1 + (3−1)/4·0.01) = 1/√1.005 = 0.997509 → Φ = 0.840741
  const a = T.probabilisticSharpe({ sr: 0.1, T: 101, skew: 0, kurt: 3 });
  close(a.z, 0.997509, 1e-6, "z normal");
  close(a.psr, 0.840741, 1e-5, "PSR normal");
  // SR 0.2, T 61, skew −1, kurt 6: den = √(1 + 0.2 + 5/4·0.04) = √1.25; z = 0.2·√60/√1.25 = 1.385641 → Φ = 0.917072
  const b = T.probabilisticSharpe({ sr: 0.2, T: 61, skew: -1, kurt: 6 });
  close(b.z, 1.385641, 1e-6, "z skewed");
  close(b.psr, 0.917072, 2e-5, "PSR skewed");
  // benchmark SR* equal to SR → exactly 0.5
  close(T.probabilisticSharpe({ sr: 0.3, T: 50 }, { srBenchmark: 0.3 }).psr, 0.5, 1e-9);
  // from a return series: moments are used (T = n unless tEff given)
  const r = [0.01, -0.02, 0.03, 0.015, -0.005, 0.02, 0.0, 0.01];
  const m = T.moments(r);
  const p = T.probabilisticSharpe(r);
  assert.strictEqual(p.T, 8);
  close(p.sr, m.mean / m.sd, 1e-12);
  assert.strictEqual(T.probabilisticSharpe(r, { tEff: 4 }).T, 4);
});

test("expectedMaxSharpe: hand value, N = 1 is zero, DSR falls as trials grow and equals PSR at N = 1", () => {
  // (1−γ)·Φ⁻¹(0.99) + γ·Φ⁻¹(1 − 1/(100e)) = 0.422784·2.326348 + 0.577216·2.680210 = 2.530603
  // (quantiles checked by bisection on a Simpson-integrated normal CDF)
  close(T.expectedMaxSharpe(100, 1), 2.530603, 1e-5);
  close(T.expectedMaxSharpe(100, 4), 2 * 2.530603, 2e-5);
  assert.strictEqual(T.expectedMaxSharpe(1, 1), 0);
  const base = { sr: 0.08, T: 500, skew: 0, kurt: 3 };
  const d1 = T.deflatedSharpe(base, { nTrials: 1, srVariance: 1 / 500 });
  close(d1.dsr, T.probabilisticSharpe(base).psr, 1e-12, "N=1");
  const ds = [1, 10, 100, 1000].map((n) => T.deflatedSharpe(base, { nTrials: n, srVariance: 1 / 500 }).dsr);
  for (let i = 1; i < ds.length; i++) assert.ok(ds[i] < ds[i - 1], `DSR must fall with trials: ${ds}`);
  // variance from the trials' SRs when srVariance is not given
  const d = T.deflatedSharpe(base, { nTrials: 3, trialSRs: [0.0, 0.05, 0.1] });
  close(d.srVariance, 0.0025, 1e-12);
});

// ───────────── PBO via CSCV ─────────────

test("pbo: hand-computed 4×3 example (S = 4, metric = mean) gives 4/6 with the exact logits", () => {
  // Blocks = rows. IS/OOS means for the 6 splits (IS winner → OOS rank of 3, ties averaged, ω = rank/4):
  //  J={0,1}: IS winner c0 (4.5); OOS c0 2.5, c1 2.75, c2 1.5 → rank 2 → ω .5  → λ 0      (overfit)
  //  J={0,2}: IS winner c0 (3);   OOS c0 4,   c1 2,    c2 2   → rank 3 → ω .75 → λ ln 3
  //  J={0,3}: IS winner c0 (4.5); OOS c0 2.5, c1 2.75, c2 2.5 → rank 1.5     → λ ln(3/5) (overfit)
  //  J={1,2}: IS winner c1 (2.75);OOS c0 4.5, c1 1.5,  c2 1.5 → rank 1.5     → λ ln(3/5) (overfit)
  //  J={1,3}: IS winner c0 (4);   OOS c0 3,   c1 2.25, c2 2   → rank 3       → λ ln 3
  //  J={2,3}: IS winner c1 (2.75);OOS c0 4.5, c1 1.5,  c2 2.5 → rank 1       → λ ln(1/3) (overfit)
  const M = [[5, 1, 2], [4, 2, 3], [1, 3.5, 2], [4, 2, 1]];
  const r = T.pbo(M, { S: 4, metric: "mean" });
  assert.strictEqual(r.nCombos, 6);
  close(r.pbo, 4 / 6, 1e-12);
  const want = [0, Math.log(3), Math.log(3 / 5), Math.log(3 / 5), Math.log(3), Math.log(1 / 3)].sort((a, b) => a - b);
  const got = r.logits.slice().sort((a, b) => a - b);
  for (let i = 0; i < 6; i++) close(got[i], want[i], 1e-12, `logit ${i}`);
  // a perfectly anti-persistent matrix: every IS winner is the OOS loser → PBO = 1
  assert.strictEqual(T.pbo([[0.9, 0.1, 0.5], [0.2, 0.8, 0.4], [0.1, 0.6, 0.9], [0.7, 0.3, 0.2]], { S: 4, metric: "mean" }).pbo, 1);
});

test("pbo: C(16,8) = 12870 splits; noise ≈ 0.5, a genuinely skilled configuration ≈ 0", () => {
  const noise = (seed, skilled) => {
    const r = rng(seed);
    return Array.from({ length: 320 }, () => Array.from({ length: 20 }, (_, j) => gauss(r) + (skilled && j === 7 ? 0.5 : 0)));
  };
  const a = T.pbo(noise(1, false), { S: 16 });
  assert.strictEqual(a.nCombos, 12870);
  const mean = [1, 2, 3, 4, 5, 6].map((s) => T.pbo(noise(s, false), { S: 16, keepLogits: false }).pbo).reduce((x, y) => x + y, 0) / 6;
  assert.ok(mean > 0.3 && mean < 0.7, `pure noise PBO should be ≈ 0.5, got ${mean}`);
  const sk = T.pbo(noise(9, true), { S: 16 });
  assert.ok(sk.pbo < 0.05, `skilled configuration PBO should be ≈ 0, got ${sk.pbo}`);
  assert.ok(sk.probOosLoss < 0.05);
  console.log(`# PBO: noise mean ${mean.toFixed(3)}, skilled ${sk.pbo.toFixed(4)}`);
  assert.strictEqual(T.pbo([[1, 2]], {}).pbo, null);
});

// ───────────── Diebold–Mariano / HAC ─────────────

test("neweyWestVariance and dieboldMariano match hand computations", () => {
  // x = [1,−1,1,−1]: γ0 = 1, γ1 = −3/4 → lag 1: 1 + 2·(1/2)·(−3/4) = 0.25
  close(T.neweyWestVariance([1, -1, 1, -1], 0), 1, 1e-12);
  close(T.neweyWestVariance([1, -1, 1, -1], 1), 0.25, 1e-12);
  // d = 1..5: mean 3, γ0 = 2, se = √(2/5); stat = 3/0.632456 = 4.743416; HLN(h=1) × √(4/5) → 4.242641
  const dm = T.dieboldMariano([1, 2, 3, 4, 5], { lag: 0 });
  close(dm.stat, 4.242641, 1e-6);
  close(dm.p, 2 * (1 - require("../server/decision/risk").normCdf(4.242641)), 1e-9);
  const dm0 = T.dieboldMariano([1, 2, 3, 4, 5], { lag: 0, hln: false });
  close(dm0.stat, 4.743416, 1e-6);
  // panel (Driscoll–Kraay): rows on the same date are summed first
  const d = [0.1, 0.3, -0.1, 0.1, 0.2, 0.4, 0.0, 0.2];
  const dates = [1, 1, 2, 2, 3, 3, 4, 4];
  const p = T.dieboldMariano(d, { dates, lag: 0, hln: false });
  // mean 0.15; per-date demeaned sums: 0.1, −0.3, 0.3, −0.1 → Σ² = 0.2 → se = √0.2 / 8
  close(p.stat, 0.15 / (Math.sqrt(0.2) / 8), 1e-9);
  assert.strictEqual(p.nDates, 4);
  assert.strictEqual(T.dieboldMariano([0.1, 0.2], {}).p, 1);
});

// ───────────── tuneThresholds ─────────────

test("evaluateThresholds applies the engine's edge / meta rule (hand example)", () => {
  const rows = [
    { t: 1, p: 0.60, base: 0.55, metaP: 0.60, tbLongRet: 0.02, tbShortRet: -0.03 },  // long, edge min(0.10, 0.05) = 0.05
    { t: 1, p: 0.52, base: 0.55, metaP: 0.70, tbLongRet: 0.05, tbShortRet: -0.06 },  // long vs 0.5 but below base → edge 0
    { t: 2, p: 0.40, base: 0.55, metaP: 0.58, tbLongRet: -0.02, tbShortRet: 0.01 },  // short, edge min(0.10, 0.15) = 0.10
    { t: 2, p: 0.46, base: 0.55, metaP: 0.50, tbLongRet: 0.01, tbShortRet: -0.02 },  // short, edge 0.04
  ];
  const a = T.evaluateThresholds(rows, { MIN_PROB_EDGE: 0.03 });
  assert.deepStrictEqual([a.nOpp, a.nActed], [4, 3]);
  close(a.meanRet, (0.02 + 0.01 - 0.02) / 3, 1e-12);
  close(a.precision, 2 / 3, 1e-12);
  const b = T.evaluateThresholds(rows, { MIN_PROB_EDGE: 0.03, metaThreshold: 0.55 });
  assert.strictEqual(b.nActed, 2);
  close(b.meanRet, 0.015, 1e-12);
  close(b.precision, 1, 1e-12);
  const c = T.evaluateThresholds(rows, { MIN_PROB_EDGE: 0.03 }, { costs: 0.015 });
  close(c.meanRet, (0.005 - 0.005 - 0.035) / 3, 1e-12);
});

function panel({ seed = 1, nDates = 400, nAssets = 25, skill = 1 } = {}) {
  const r = rng(seed), rows = [];
  for (let d = 0; d < nDates; d++) for (let a = 0; a < nAssets; a++) {
    const z = gauss(r);
    const p = Math.min(0.8, Math.max(0.2, 0.5 + 0.06 * z));
    const drift = skill * (p - 0.5) * 0.25;
    const move = drift + 0.02 * gauss(r);
    const metaP = Math.min(0.95, Math.max(0.05, 0.5 + (skill ? 3 * Math.abs(p - 0.5) : 0) + 0.05 * gauss(r)));
    rows.push({ t: 1e12 + d * 864e5, assetId: `A${a}`, p, base: 0.5, metaP, tbLongRet: move - 0.002, tbShortRet: -move - 0.002 });
  }
  return rows;
}

test("tuneThresholds: informative predictions pass the gate; constraints hold; nested folds are purged and OOS", () => {
  const out = T.tuneThresholds(panel({ seed: 3, skill: 1 }), { ahead: 5 });
  assert.ok(out.best, "a feasible configuration exists");
  assert.ok(out.best.activity >= 0.15 && out.best.precision >= 0.55, JSON.stringify(out.best));
  assert.ok(out.thresholds && Number.isFinite(out.thresholds.MIN_PROB_EDGE) && Number.isFinite(out.thresholds.metaThreshold));
  assert.strictEqual(out.grid.size, T.DEFAULT_GRID.edges.length * T.DEFAULT_GRID.metaThresholds.length);
  assert.ok(out.nested.nActed > 0 && out.nested.meanRet > 0, JSON.stringify(out.nested));
  assert.ok(out.dsr.dsr >= 0.5, `DSR ${out.dsr.dsr}`);
  assert.ok(out.pbo.pbo <= 0.5, `PBO ${out.pbo.pbo}`);
  assert.strictEqual(out.gate.pass, true, out.gate.reasons.join("; "));
  // outer folds: contiguous, in time order; the first fold's training window precedes it
  const f = out.nested.folds;
  for (let k = 1; k < f.length; k++) assert.ok(f[k].test[0] > f[k - 1].test[1]);
  console.log(`# tuner (informative): thresholds ${JSON.stringify(out.thresholds)}, activity ${out.best.activity.toFixed(3)}, precision ${out.best.precision.toFixed(3)}, nested mean ${out.nested.meanRet.toFixed(5)}, DSR ${out.dsr.dsr.toFixed(3)}, PBO ${out.pbo.pbo.toFixed(3)}`);
});

test("tuneThresholds: uninformative predictions are refused (no promotion on in-sample luck)", () => {
  let refused = 0;
  const log = [];
  for (const seed of [11, 12, 13, 14]) {
    const out = T.tuneThresholds(panel({ seed, skill: 0 }), { ahead: 5 });
    if (!out.gate.pass) refused++;
    log.push(`seed ${seed}: pass=${out.gate.pass} pbo=${out.pbo.pbo == null ? "n/a" : out.pbo.pbo.toFixed(2)} dsr=${out.dsr ? out.dsr.dsr.toFixed(2) : "n/a"}`);
  }
  assert.strictEqual(refused, 4, log.join(" | "));
  console.log(`# tuner (noise): ${log.join(" | ")}`);
  const tiny = T.tuneThresholds(panel({ nDates: 5, nAssets: 3 }), {});
  assert.strictEqual(tiny.gate.pass, false);
  assert.match(tiny.gate.reasons[0], /not enough OOS rows/);
});

test("tuneThresholds: zero-cost pure noise with the precision constraint off — the DSR/PBO/nested gate false-passes rarely", () => {
  // The hardest case for the gate: no costs (mean 0, not negative) and no precision floor, so only
  // the selection-bias corrections stand between noise and a promotion.
  const noisy = (seed) => {
    const r = rng(seed), rows = [];
    for (let d = 0; d < 400; d++) for (let a = 0; a < 25; a++) {
      const p = Math.min(0.8, Math.max(0.2, 0.5 + 0.06 * gauss(r))), move = 0.02 * gauss(r);
      rows.push({ t: 1e12 + d * 864e5, assetId: `A${a}`, p, base: 0.5, metaP: 0.5 + 0.1 * gauss(r), tbLongRet: move, tbShortRet: -move });
    }
    return rows;
  };
  const N = 30;
  let gate = 0, dsr = 0, pb = 0;
  for (let s = 200; s < 200 + N; s++) {
    const o = T.tuneThresholds(noisy(s), { ahead: 5, minPrecision: 0 });
    if (o.gate.pass) gate++;
    if (o.dsr && o.dsr.dsr >= 0.5) dsr++;
    if (o.pbo.pbo <= 0.5) pb++;
  }
  console.log(`# tuner zero-cost noise (${N} seeds): gate false-pass ${gate}/${N}, DSR≥0.5 alone ${dsr}/${N}, PBO≤0.5 alone ${pb}/${N}`);
  assert.ok(gate / N <= 0.1, `gate false-pass rate ${gate}/${N}`);
});

test("tuneThresholds without meta probabilities tunes MIN_PROB_EDGE only", () => {
  const rows = panel({ seed: 5, skill: 1 }).map(({ metaP, ...r }) => r);
  const out = T.tuneThresholds(rows, { ahead: 5 });
  assert.strictEqual(out.grid.metaThresholds, null);
  assert.strictEqual(out.grid.size, T.DEFAULT_GRID.edges.length);
  assert.ok(out.thresholds && !("metaThreshold" in out.thresholds));
});
