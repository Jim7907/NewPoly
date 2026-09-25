// Signal report card: statistics helpers against hand computations, and verdicts on a synthetic
// panel with planted informative / harmful signals and many pure-noise signals.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../server/research/signalEval");

// Seeded PRNG (mulberry32) + Box–Muller.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ── Synthetic panel ────────────────────────────────────────────────────────────────────────
// A assets (stocks + a few crypto) × T daily dates, 5-bar overlapping labels. Returns carry a
// common market factor. Signals are score·conf = x:
//   good   : noisy view of the asset's own future 5-bar idiosyncratic return  (IC ≈ +0.1)
//   bad    : the negative of an independent noisy view of the same            (IC ≈ −0.1)
//   noise.k: persistent AR(1) noise per asset (φ = 0.9), no information
//   mkt.k  : persistent market-wide noise (same value for every asset of a date), no information
function makePanel({ seed = 7, A = 24, T = 700, ahead = 5, nNoise = 30, nMkt = 6 } = {}) {
  const r = prng(seed);
  const DAY = 86400000, t0 = Date.UTC(2022, 0, 3);
  const assets = [];
  for (let a = 0; a < A; a++) assets.push(a < A - 6 ? { id: `STOCK:S${a}`, cls: "stock" } : { id: `CRYPTO:C${a}`, cls: "crypto" });
  assets.unshift({ id: "STOCK:SPY", cls: "stock", bench: true }, { id: "CRYPTO:BTC", cls: "crypto", bench: true });
  const m = Array.from({ length: T + ahead + 1 }, () => 0.01 * gauss(r));
  const mkt = Array.from({ length: nMkt }, () => { let v = 0; return Array.from({ length: T }, () => (v = 0.9 * v + 0.44 * gauss(r))); });
  const rows = [];
  const regimes = ["trending-up/normal-vol", "ranging/normal-vol", "trending-down/high-vol"];
  for (const as of assets) {
    const beta = as.bench ? 1 : 0.6 + 0.8 * r();
    const e = Array.from({ length: T + ahead + 1 }, () => (as.bench ? 0 : 0.015 * gauss(r)));
    const noise = Array.from({ length: nNoise }, () => { let v = gauss(r); return Array.from({ length: T }, () => (v = 0.9 * v + 0.44 * gauss(r))); });
    let reg = 0;
    for (let t = 0; t < T; t++) {
      let ret = 0, idio = 0, bench = 0;
      for (let j = 1; j <= ahead; j++) { ret += beta * m[t + j] + e[t + j]; idio += e[t + j]; bench += m[t + j]; }
      const exRet = as.bench ? 0 : ret - bench;
      const sig = {};
      const sd = 0.015 * Math.sqrt(ahead);
      sig.good = [Math.tanh((idio / sd + 9 * gauss(r)) / 6), 0.8];
      sig.bad = [Math.tanh((-idio / sd + 9 * gauss(r)) / 6), 0.8];
      for (let k = 0; k < nNoise; k++) sig[`noise.${k}`] = [Math.tanh(noise[k][t] / 2), 0.5];
      for (let k = 0; k < nMkt; k++) sig[`mkt.${k}`] = [Math.tanh(mkt[k][t] / 2), 0.5];
      if (r() < 0.02) reg = Math.floor(r() * 3);
      rows.push({
        assetId: as.id, symbol: as.id.split(":")[1], assetClass: as.cls, t: t0 + t * DAY, i: t, price: 100,
        regime: { label: regimes[reg] }, sig,
        fam: { good: sig.good[0] * 0.8, noise: sig["noise.0"][0] * 0.5 },
        pRaw: 0.5 + 0.1 * sig.good[0] * 0.8,
        lab: { ret, exRet, y: ret > 0 ? 1 : 0, yEx: exRet > 0 ? 1 : 0, tbLongRet: ret - 0.0012, tEnd: t0 + (t + ahead) * DAY },
      });
    }
  }
  rows.sort((a, b) => a.t - b.t || (a.assetId < b.assetId ? -1 : 1));
  const signalIds = ["good", "bad", ...Array.from({ length: nNoise }, (_, k) => `noise.${k}`), ...Array.from({ length: nMkt }, (_, k) => `mkt.${k}`)];
  return {
    version: 2, horizon: "swing", tf: 86400, ahead, universe: assets.map((a) => a.id),
    benchmarks: { stock: "STOCK:SPY", crypto: "CRYPTO:BTC" }, signalIds, rows,
  };
}

test("neweyWestT matches a hand computation", () => {
  // x = [1, −1, 2, 0]: mean .5, centred [.5, −1.5, 1.5, −.5]; γ0 = 5/4; γ1 = (−.75 − 2.25 − .75)/4 = −.9375.
  // lag 1: lrv = 1.25 + 2·(1 − 1/2)·(−.9375) = .3125, se = √(.3125/4), t = .5/se = 1.7888544.
  const a = E.neweyWestT([1, -1, 2, 0], 1);
  close(a.mean, 0.5, 1e-12);
  close(a.lrv, 0.3125, 1e-12);
  close(a.se, Math.sqrt(0.3125 / 4), 1e-12);
  close(a.t, 1.7888544, 1e-6);
  // lag 0 = ordinary (population-variance) t: .5 / √(1.25/4) = 0.8944272.
  close(E.neweyWestT([1, -1, 2, 0], 0).t, 0.8944272, 1e-6);
  // Lag 2 by explicit loops.
  const x = [0.3, -0.1, 0.4, 0.2, -0.3, 0.5, 0.1, 0.0];
  const n = x.length, mu = x.reduce((s, v) => s + v, 0) / n;
  const g = (l) => { let s = 0; for (let t = l; t < n; t++) s += (x[t] - mu) * (x[t - l] - mu); return s / n; };
  const lrv = g(0) + 2 * ((1 - 1 / 3) * g(1) + (1 - 2 / 3) * g(2));
  close(E.neweyWestT(x, 2).t, mu / Math.sqrt(lrv / n), 1e-12);
  // Degenerate input.
  assert.equal(E.neweyWestT([1], 3).t, null);
});

test("spearman, BH-FDR and Wilson helpers", () => {
  close(E.spearman([1, 2, 2, 3], [1, 3, 2, 4]), 4.5 / Math.sqrt(22.5), 1e-12);   // average ranks for ties
  close(E.spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]), E.spearman([10, 20, 30, 40, 50], [1, 2, 3, 5, 3]), 1e-12);
  assert.equal(E.spearman([1, 1, 1], [1, 2, 3]), null);
  const bh = E.benjaminiHochberg([0.01, 0.04, 0.03, 0.2], 0.1);
  assert.deepEqual(bh.rejected, [true, true, true, false]);
  assert.equal(bh.nSignificant, 3);
  close(bh.threshold, 0.04, 1e-12);
  const bh2 = E.benjaminiHochberg([0.02, 0.5, NaN, 0.9], 0.05);
  assert.equal(bh2.m, 3);
  assert.equal(bh2.nSignificant, 0);
  const [lo, hi] = E.wilsonCI(50, 100);
  close(lo, 0.4038, 1e-4);
  close(hi, 0.5962, 1e-4);
});

test("report card: planted signal → keep, negative → invert-candidate, noise rarely kept (target ret, ts IC)", () => {
  const ds = makePanel({ seed: 11 });
  const rep = E.reportCard(ds, { target: "ret", minN: 200 });
  assert.equal(rep.mode, "ts");
  assert.equal(rep.lag, 5);
  const good = rep.signals.good, bad = rep.signals.bad;
  assert.ok(good.ic > 0.05 && good.icT > 3, `good ic ${good.ic} t ${good.icT}`);
  assert.equal(good.verdict, "keep");
  assert.equal(good.stable, true);
  assert.ok(good.hitRate > 0.5);
  assert.ok(good.meanRetWhenLong > good.meanRetWhenShort);
  assert.ok(good.nEff > 0 && good.nEff <= good.n);
  // A persistent signal (AR(1) φ=.9) on overlapping labels has far fewer effective observations;
  // a market-wide one fewer still (every asset of a date carries the same bet).
  const pers = rep.signals["noise.1"], mk = rep.signals["mkt.1"];
  assert.ok(pers.nEff < 0.6 * pers.n, `persistent nEff ${pers.nEff} / ${pers.n}`);
  assert.ok(mk.nEff < pers.nEff, `market-wide nEff ${mk.nEff}`);
  assert.ok(good.hitRateCI[0] < good.hitRate && good.hitRate < good.hitRateCI[1]);
  assert.equal(bad.verdict, "invert-candidate");
  assert.ok(bad.ic < -0.05);
  const noiseIds = ds.signalIds.filter((id) => /^(noise|mkt)\./.test(id));
  const kept = noiseIds.filter((id) => rep.signals[id].verdict === "keep");
  assert.ok(kept.length <= Math.ceil(0.10 * noiseIds.length), `noise kept: ${kept.join(",")}`);
  // Breakdowns exist and carry the headline IC.
  assert.ok(good.byClass.stock && good.byClass.crypto);
  assert.ok(Object.keys(good.byRegime).length >= 2);
  assert.ok(good.decay.ic_h1 > 0 && good.decay.ic_h2 > 0);
  // Market-wide noise has no cross-sectional dispersion → no xs IC, but a ts IC.
  assert.equal(rep.signals["mkt.0"].xs, null);
  assert.ok(rep.signals["mkt.0"].ts);
  // FDR bookkeeping + pooled family.
  assert.equal(rep.fdr.q, 0.10);
  assert.ok(rep.fdr.nSignificant >= 2);
  assert.ok(rep.families.pooled && rep.families.pooled.ic > 0);
  assert.ok(rep.summary.keep.includes("good") && rep.summary.invertCandidate.includes("bad"));
});

test("report card: relative target uses Fama–MacBeth cross-sectional IC and excludes benchmarks", () => {
  const ds = makePanel({ seed: 23 });
  const rep = E.reportCard(ds, { target: "exRet" });
  assert.equal(rep.mode, "xs");
  assert.ok(!ds.rows.some((r) => r.assetId === "STOCK:SPY" && rep.nRows === ds.rows.length));
  assert.equal(rep.nAssets, 24);                                   // benchmarks excluded
  assert.equal(rep.signals.good.verdict, "keep");
  assert.equal(rep.signals.bad.verdict, "invert-candidate");
  // Market-wide signals cannot rank assets within a date → unknown, mask default.
  assert.equal(rep.signals["mkt.0"].verdict, null);
  const noiseIds = ds.signalIds.filter((id) => /^noise\./.test(id));
  const kept = noiseIds.filter((id) => rep.signals[id].verdict === "keep");
  assert.ok(kept.length <= Math.ceil(0.10 * noiseIds.length), `noise kept: ${kept.join(",")}`);
});

test("pure noise: across seeds the keep rate stays at or below ~q", () => {
  let kept = 0, total = 0;
  for (const seed of [101, 202, 303]) {
    const ds = makePanel({ seed, A: 16, T: 500, nNoise: 30, nMkt: 4 });
    for (const target of ["ret", "tbLong"]) {
      const rep = E.reportCard(ds, { target, byRegime: false });
      for (const id of ds.signalIds.filter((i) => /^(noise|mkt)\./.test(i))) { total++; if (rep.signals[id].verdict === "keep") kept++; }
    }
  }
  assert.ok(kept / total <= 0.10, `noise keep rate ${kept}/${total}`);
});

test("signalMask maps verdicts to confidence multipliers", () => {
  const rep = { signals: {
    a: { verdict: "keep", icT: 5 }, b: { verdict: "keep", icT: 2 }, c: { verdict: "keep", icT: 3.5 },
    d: { verdict: "weak", icT: 1 }, e: { verdict: "drop", icT: -3 }, f: { verdict: "invert-candidate", icT: -6 }, g: { verdict: null, icT: null },
  } };
  const m = E.signalMask(rep);
  assert.equal(m.a, 1.5);
  assert.equal(m.b, 1);
  close(m.c, 1.25, 1e-9);
  assert.equal(m.d, 0.6);
  assert.equal(m.e, 0);
  assert.equal(m.f, 0);
  assert.equal(m.g, E.MASK_DEFAULT);
  // On a real report: low-n signals → 0.8.
  const ds = makePanel({ seed: 5, A: 8, T: 120, nNoise: 2, nMkt: 1 });
  const rep2 = E.reportCard(ds, { target: "ret", minN: 5000 });
  assert.ok(Object.values(E.signalMask(rep2)).every((v) => v === 0.8));
});

test("timing IC is free of the in-sample-centring bias that flags momentum on random walks", () => {
  // Pure random walks (common factor + drift): a trailing-return signal has NO predictive power.
  // Ranking signal and target over each asset's full sample ("tsfull") is biased negative by
  // ≈ −√(k·ahead)/T; the point-in-time timing IC ("ts", the default) is not.
  const DAY = 86400000, t0 = Date.UTC(2021, 0, 4), ahead = 5, k = 250, T = 600, A = 30;
  const legacy = [], pit = [];
  for (const seed of [3, 5, 7, 9]) {
    const r = prng(seed);
    const W = T + 260 + ahead;
    const m = Array.from({ length: W }, () => gauss(r));
    const rows = [];
    for (let a = 0; a < A; a++) {
      const cum = [0];
      for (let i = 0; i < W; i++) cum.push(cum[i] + 0.0004 + 0.015 * (0.5 * m[i] + 0.866 * gauss(r)));
      for (let i = 260; i < 260 + T; i++) {
        const y = cum[i + 1 + ahead] - cum[i + 1];
        rows.push({ assetId: `STOCK:S${a}`, assetClass: "stock", t: t0 + (i - 260) * DAY, atrPct: 0.02, regime: { label: "x" },
          sig: { mom: [Math.tanh((cum[i + 1] - cum[i + 1 - k]) / (0.015 * Math.sqrt(k))), 1] }, fam: {}, pRaw: 0.5,
          lab: { ret: y, exRet: y, tbLongRet: y, tEnd: t0 + (i - 260 + ahead) * DAY } });
      }
    }
    rows.sort((p, q) => p.t - q.t || (p.assetId < q.assetId ? -1 : 1));
    const ds = { ahead, tf: 86400, benchmarks: {}, signalIds: ["mom"], rows };
    const rep = E.reportCard(ds, { target: "ret", byRegime: false, legacyTs: true });
    legacy.push(rep.signals.mom.tsFull.ic);
    pit.push(rep.signals.mom.ts.ic);
    assert.equal(rep.signals.mom.ic, rep.signals.mom.ts.ic);          // the default headline is the timing IC
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(mean(legacy) < -0.05, `legacy full-sample IC ${mean(legacy)}`);
  assert.ok(Math.abs(mean(pit)) < 0.02, `point-in-time IC ${mean(pit)}`);
});
