// Threshold tuner + backtest-overfitting statistics (docs/CONTRACT-v2.md §5, tuner.js).
//
// tuneThresholds(oosRows, opts) chooses the live gating thresholds (MIN_PROB_EDGE and, when a
// meta-labeler is live, its P(success) threshold `metaThreshold`) that maximise the mean NET
// bracket return per acted decision, subject to activity ≥ 15% and precision ≥ 55%.
//
//  * Inputs are OUT-OF-SAMPLE predictions only: [{ t, assetId, p, metaP?, base?, tbLongRet, tbShortRet }]
//    (p = primary P(up), metaP = meta-labeler P(trade succeeds), base = the primary's base rate,
//    tb*Ret = realised triple-barrier bracket return already net of fees + slippage, dataset §1).
//  * Decision rule = the engine's (server/decision/ensemble.js): side = sign(p − 0.5);
//    edge = max(0, min(|p − 0.5|, side·(p − base))); act iff edge ≥ MIN_PROB_EDGE and
//    (no meta) or metaP ≥ metaThreshold. MIN_CONFIDENCE (the v1 confidence composite) cannot be
//    reproduced from dataset rows and is therefore never tuned here.
//  * Nested walk-forward by date: the dates are cut into outerFolds+1 contiguous chunks; for each
//    outer fold k ≥ 1 the thresholds are selected on the dates before it (minus a purge of
//    `ahead` dates, because bracket labels overlap) using an INNER walk-forward (mean objective
//    over innerFolds contiguous validation chunks, constraints on the pooled inner window), then
//    scored on fold k. The concatenated outer-fold results are an honest OOS estimate of the
//    tuning procedure. The deployed thresholds are selected on all dates by the same inner rule.
//  * Overfitting diagnostics:
//      - Deflated Sharpe ratio (Bailey & López de Prado 2014) of the selected configuration's
//        per-date return series, deflated for N = number of grid points tried, the cross-sectional
//        variance of the grid's Sharpe ratios, and the series' skewness / kurtosis. T is the
//        EFFECTIVE sample size nDates / ahead (overlapping `ahead`-bar labels, docs/RESEARCH.md §5).
//      - PBO by combinatorially symmetric cross-validation (Bailey, Borwein, López de Prado & Zhu
//        2017) on the T×N matrix of per-date returns of every grid configuration.
//  * Gate (RULES): best exists, PBO ≤ 0.5, DSR ≥ 0.5, nested-OOS mean net return > 0 over
//    ≥ minActed acted decisions. Nothing is ever promoted on the in-sample optimum alone.
"use strict";

const { normCdf, normInv } = require("../decision/risk");

const EULER_GAMMA = 0.5772156649015329;

const RULES = Object.freeze({
  minActivity: 0.15,   // share of opportunities acted on (contract §5)
  minPrecision: 0.55,  // share of acted decisions with net bracket return > 0 (contract §5)
  pboMax: 0.5,         // refuse when PBO > 0.5 (contract §5)
  dsrMin: 0.5,         // refuse when deflated Sharpe < 0.5 (contract §5)
  minActed: 30,        // min acted decisions for a configuration to count as feasible / nested OOS to count
});

// Default grid. Edges start above 0 so an edge-0 row (p between 0.5 and the base rate, where the
// engine's side and the meta side can disagree) never acts. Meta thresholds span the ensemble's
// clamp range [0.5, 0.9] where it matters.
const DEFAULT_GRID = Object.freeze({
  edges: Object.freeze([0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]),
  metaThresholds: Object.freeze([0.50, 0.52, 0.54, 0.55, 0.56, 0.58, 0.60, 0.62, 0.65]),
});

const fin = (v) => typeof v === "number" && Number.isFinite(v);

// ───────────────────────────── basic statistics ─────────────────────────────

/** Sample moments: sd uses n−1; skew / kurt are the standardized 3rd / 4th moments (kurt = 3 for a normal). */
function moments(x) {
  const a = (Array.isArray(x) ? x : []).filter(fin);
  const n = a.length;
  if (!n) return { n: 0, mean: 0, sd: 0, skew: 0, kurt: 3 };
  let s = 0;
  for (const v of a) s += v;
  const mean = s / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of a) { const d = v - mean, d2 = d * d; m2 += d2; m3 += d2 * d; m4 += d2 * d2; }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = n > 1 ? Math.sqrt((m2 * n) / (n - 1)) : 0;
  const ok = m2 > 1e-300;
  return { n, mean, sd, skew: ok ? m3 / Math.pow(m2, 1.5) : 0, kurt: ok ? m4 / (m2 * m2) : 3 };
}

const sharpe = (x) => { const m = moments(x); return m.sd > 0 ? m.mean / m.sd : 0; };

function sampleVariance(x) {
  const m = moments(x);
  return m.n > 1 ? m.sd * m.sd : NaN;
}

/**
 * Newey–West (Bartlett kernel) long-run variance of x: γ0 + 2·Σ_{k=1..L} (1 − k/(L+1))·γk,
 * γk = (1/n)·Σ e_t·e_{t−k} on the demeaned series. Always ≥ 0.
 */
function neweyWestVariance(x, lag = 0) {
  const a = (Array.isArray(x) ? x : []).filter(fin);
  const n = a.length;
  if (n < 2) return 0;
  let m = 0;
  for (const v of a) m += v;
  m /= n;
  const e = a.map((v) => v - m);
  const L = Math.max(0, Math.min(Math.floor(lag) || 0, n - 1));
  let g0 = 0;
  for (const v of e) g0 += v * v;
  let s = g0 / n;
  for (let k = 1; k <= L; k++) {
    let g = 0;
    for (let t = k; t < n; t++) g += e[t] * e[t - k];
    s += 2 * (1 - k / (L + 1)) * (g / n);
  }
  return Math.max(0, s);
}

/**
 * Diebold–Mariano (1995) test on a loss-differential series d_t = L_reference,t − L_model,t
 * (positive mean ⇒ the model forecasts better). Variance: Newey–West HAC with `lag`; small-sample
 * correction of Harvey, Leybourne & Newbold (1997) with forecast horizon h (default lag, min 1).
 * Returns { stat, p (two-sided), pGreater (H1: E[d] > 0), n, meanDiff, se, lag }.
 */
function dieboldMariano(d, { lag = 0, h, hln = true } = {}) {
  const a = (Array.isArray(d) ? d : []).filter(fin);
  const n = a.length;
  let m = 0;
  for (const v of a) m += v;
  m = n ? m / n : 0;
  if (n < 3) return { stat: 0, p: 1, pGreater: 0.5, n, meanDiff: m, se: null, lag };
  const lrv = neweyWestVariance(a, lag);
  const se = Math.sqrt(lrv / n);
  let stat;
  if (!(se > 1e-15)) stat = m > 0 ? Infinity : m < 0 ? -Infinity : 0;
  else stat = m / se;
  if (hln && Number.isFinite(stat)) {
    const hh = Math.max(1, Math.floor(h ?? lag) || 1);
    stat *= Math.sqrt(Math.max(0, (n + 1 - 2 * hh + (hh * (hh - 1)) / n) / n));
  }
  const p = stat === 0 ? 1 : Number.isFinite(stat) ? 2 * (1 - normCdf(Math.abs(stat))) : 0;
  const pGreater = Number.isFinite(stat) ? 1 - normCdf(stat) : stat > 0 ? 0 : 1;
  return { stat, p: Math.min(1, Math.max(0, p)), pGreater, n, meanDiff: m, se, lag };
}

// ───────────────────────────── Sharpe-ratio inference ─────────────────────────────

function sharpeInputs(input, tEff) {
  if (Array.isArray(input)) {
    const m = moments(input);
    return { sr: m.sd > 0 ? m.mean / m.sd : 0, T: fin(tEff) ? tEff : m.n, skew: m.skew, kurt: m.kurt, n: m.n };
  }
  const o = input || {};
  return { sr: Number(o.sr) || 0, T: fin(tEff) ? tEff : Number(o.T) || 0, skew: fin(o.skew) ? o.skew : 0, kurt: fin(o.kurt) ? o.kurt : 3, n: Number(o.T) || 0 };
}

/**
 * Probabilistic Sharpe ratio (Bailey & López de Prado 2012):
 *   PSR(SR*) = Φ( (SR − SR*)·√(T − 1) / √(1 − γ3·SR + (γ4 − 1)/4·SR²) )
 * SR is per observation (not annualised), γ3 = skewness, γ4 = kurtosis (3 for a normal).
 * input: returns array, or { sr, T, skew, kurt }. opts.tEff overrides T (effective sample size).
 */
function probabilisticSharpe(input, { srBenchmark = 0, tEff } = {}) {
  const s = sharpeInputs(input, tEff);
  if (!(s.T > 1)) return { psr: null, z: null, ...s, srBenchmark };
  const den2 = 1 - s.skew * s.sr + ((s.kurt - 1) / 4) * s.sr * s.sr;
  const z = ((s.sr - srBenchmark) * Math.sqrt(s.T - 1)) / Math.sqrt(Math.max(den2, 1e-12));
  return { psr: normCdf(z), z, sr: s.sr, T: s.T, skew: s.skew, kurt: s.kurt, srBenchmark };
}

/**
 * Expected maximum Sharpe ratio of N independent unskilled trials whose SR estimates have
 * variance V (Bailey & López de Prado 2014, eq. for SR0):
 *   SR0 = √V · ((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))),  γ = Euler–Mascheroni.
 */
function expectedMaxSharpe(nTrials, variance) {
  const N = Math.floor(Number(nTrials) || 1);
  if (N <= 1 || !(variance > 0)) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / N) + EULER_GAMMA * normInv(1 - 1 / (N * Math.E)));
}

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014): DSR = PSR(SR0) with SR0 the expected
 * max SR of nTrials unskilled trials. Variance of the trials' SRs: opts.srVariance, else the
 * sample variance of opts.trialSRs, else Lo's (2002) null variance of the SR estimator 1/(T−1).
 * Returns { dsr, sr0, psr (vs 0), sr, T, skew, kurt, nTrials, srVariance }.
 */
function deflatedSharpe(input, { nTrials = 1, srVariance, trialSRs, tEff } = {}) {
  const s = sharpeInputs(input, tEff);
  let V = Number(srVariance);
  if (!(V >= 0) && Array.isArray(trialSRs) && trialSRs.filter(fin).length > 1) V = sampleVariance(trialSRs);
  if (!(V >= 0)) V = s.T > 1 ? 1 / (s.T - 1) : NaN;
  const N = Math.max(1, Math.floor(Number(nTrials) || 1));
  const sr0 = expectedMaxSharpe(N, V);
  const d = probabilisticSharpe(s, { srBenchmark: sr0 });
  const p0 = probabilisticSharpe(s, { srBenchmark: 0 });
  return { dsr: d.psr, sr0, psr: p0.psr, sr: s.sr, T: s.T, skew: s.skew, kurt: s.kurt, nTrials: N, srVariance: V };
}

// ───────────────────────────── PBO via CSCV ─────────────────────────────

function perfOf(metric, sum, sq, n) {
  if (!(n > 0)) return 0;
  const mean = sum / n;
  if (metric === "mean") return mean;
  if (metric === "sum") return sum;
  // "sharpe": mean / sample sd
  if (n < 2) return 0;
  const v = Math.max(0, (sq - n * mean * mean) / (n - 1));
  const sd = Math.sqrt(v);
  if (!(sd > 1e-12)) return Math.abs(mean) < 1e-15 ? 0 : Math.sign(mean) * 1e6;
  return mean / sd;
}

function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }

/**
 * Probability of backtest overfitting by combinatorially symmetric cross-validation
 * (Bailey, Borwein, López de Prado & Zhu 2017).
 *   M: T×N matrix (array of T rows, each N numbers) — performance of N configurations per period.
 *   1. Drop the oldest T mod S rows and cut the rest into S contiguous, equal blocks (S even).
 *   2. For every one of the C(S, S/2) ways to pick S/2 blocks as the in-sample set J (J̄ = rest):
 *      n* = argmax_n metric_IS(n) (first index on ties); ω = rank of metric_OOS(n*) among the N
 *      OOS values, ascending, ties averaged, divided by (N + 1); λ = ln(ω / (1 − ω)).
 *   3. PBO = share of combinations with λ ≤ 0 (the in-sample winner is at or below the OOS median).
 * metric: "sharpe" (default, mean / sample sd), "mean" or "sum" over the rows of the blocks.
 * Returns { pbo, nCombos, S, N, T, blockSize, logits, logitMean, probOosLoss, degradation }.
 */
function pbo(M, { S = 16, metric = "sharpe", keepLogits = true } = {}) {
  const rows = Array.isArray(M) ? M : [];
  const T0 = rows.length, N = T0 ? (rows[0] || []).length : 0;
  if (N < 2 || T0 < 4) return { pbo: null, reason: "need ≥ 2 configurations and ≥ 4 periods", nCombos: 0, S: 0, N, T: T0 };
  let s = Math.max(2, Math.min(Math.floor(S) || 16, 20, T0));
  if (s % 2) s -= 1;
  const bs = Math.floor(T0 / s), start = T0 - bs * s;
  const sum = [], sq = [];
  const totSum = new Float64Array(N), totSq = new Float64Array(N);
  for (let b = 0; b < s; b++) {
    const bsum = new Float64Array(N), bsq = new Float64Array(N);
    for (let r = start + b * bs; r < start + (b + 1) * bs; r++) {
      const row = rows[r];
      for (let j = 0; j < N; j++) { const v = fin(row[j]) ? row[j] : 0; bsum[j] += v; bsq[j] += v * v; }
    }
    for (let j = 0; j < N; j++) { totSum[j] += bsum[j]; totSq[j] += bsq[j]; }
    sum.push(bsum); sq.push(bsq);
  }
  const half = s / 2, nIS = half * bs, nOOS = (s - half) * bs;
  const isSum = new Float64Array(N), isSq = new Float64Array(N), oos = new Float64Array(N);
  const logits = [];
  let nOver = 0, nLoss = 0, nCombos = 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let mask = 0; mask < 1 << s; mask++) {
    if (popcount(mask) !== half) continue;
    isSum.fill(0); isSq.fill(0);
    for (let b = 0; b < s; b++) if (mask & (1 << b)) {
      const bsum = sum[b], bsq = sq[b];
      for (let j = 0; j < N; j++) { isSum[j] += bsum[j]; isSq[j] += bsq[j]; }
    }
    let best = 0, bestV = -Infinity;
    for (let j = 0; j < N; j++) {
      const v = perfOf(metric, isSum[j], isSq[j], nIS);
      if (v > bestV) { bestV = v; best = j; }
      oos[j] = perfOf(metric, totSum[j] - isSum[j], totSq[j] - isSq[j], nOOS);
    }
    const v = oos[best];
    let below = 0, ties = 0;
    for (let j = 0; j < N; j++) { if (j === best) continue; if (oos[j] < v) below++; else if (oos[j] === v) ties++; }
    const rank = 1 + below + 0.5 * ties;
    const w = rank / (N + 1);
    const lam = Math.log(w / (1 - w));
    if (lam <= 0) nOver++;
    if (v < 0) nLoss++;
    if (keepLogits) logits.push(lam);
    sx += bestV; sy += v; sxx += bestV * bestV; sxy += bestV * v; syy += v * v;
    nCombos++;
  }
  const lmean = keepLogits && logits.length ? logits.reduce((a, b) => a + b, 0) / logits.length : null;
  const vx = sxx - (sx * sx) / nCombos, cxy = sxy - (sx * sy) / nCombos, vy = syy - (sy * sy) / nCombos;
  const slope = vx > 1e-18 ? cxy / vx : 0;
  return {
    pbo: nOver / nCombos, nCombos, S: s, N, T: bs * s, blockSize: bs, metric,
    logits: keepLogits ? logits : undefined, logitMean: lmean,
    probOosLoss: nLoss / nCombos,
    degradation: { slope, intercept: (sy - slope * sx) / nCombos, r: vx > 1e-18 && vy > 1e-18 ? cxy / Math.sqrt(vx * vy) : 0 },
  };
}

// ───────────────────────────── threshold tuning ─────────────────────────────

/** The engine's informational edge (ensemble.js): side from p vs 0.5, capped by the distance from the base rate. */
function engineEdge(p, base) {
  const side = p > 0.5 ? 1 : p < 0.5 ? -1 : 0;
  if (!side) return { side: 0, edge: 0 };
  const b = fin(base) ? Math.min(0.7, Math.max(0.3, base)) : 0.5;
  const vsBase = side > 0 ? p - b : b - p;
  return { side, edge: Math.max(0, Math.min(Math.abs(p - 0.5), vsBase)) };
}

function prepRows(oosRows, { costs = 0, base = 0.5 } = {}) {
  const out = [];
  for (const r of oosRows || []) {
    if (!r || !fin(r.t) || !fin(r.p)) continue;
    const { side, edge } = engineEdge(r.p, fin(r.base) ? r.base : base);
    if (!side) { out.push({ t: r.t, side: 0, edge: 0, metaP: fin(r.metaP) ? r.metaP : null, ret: 0, valid: true }); continue; }
    const raw = side > 0 ? r.tbLongRet : r.tbShortRet;
    if (!fin(raw)) continue;
    out.push({ t: r.t, side, edge, metaP: fin(r.metaP) ? r.metaP : null, ret: raw - (Number(costs) || 0), valid: true });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const acts = (r, c) => r.side !== 0 && r.edge >= c.MIN_PROB_EDGE && (c.metaThreshold == null || (r.metaP != null && r.metaP >= c.metaThreshold));

function summarize(nOpp, nActed, sumRet, wins) {
  return {
    nOpp, nActed,
    meanRet: nActed ? sumRet / nActed : null,
    expRetPerOpp: nOpp ? sumRet / nOpp : null,
    activity: nOpp ? nActed / nOpp : 0,
    precision: nActed ? wins / nActed : null,
  };
}

/** Evaluate one threshold configuration on OOS rows (hand-checkable helper). */
function evaluateThresholds(oosRows, thresholds, opts = {}) {
  const rows = prepRows(oosRows, opts);
  let nActed = 0, sumRet = 0, wins = 0;
  const c = { MIN_PROB_EDGE: Number(thresholds.MIN_PROB_EDGE) || 0, metaThreshold: thresholds.metaThreshold ?? null };
  for (const r of rows) if (acts(r, c)) { nActed++; sumRet += r.ret; if (r.ret > 0) wins++; }
  return summarize(rows.length, nActed, sumRet, wins);
}

function buildGrid(grid, hasMeta) {
  const g = grid || {};
  const edges = (Array.isArray(g.edges) && g.edges.length ? g.edges : DEFAULT_GRID.edges).filter(fin);
  const metas = hasMeta ? (Array.isArray(g.metaThresholds) && g.metaThresholds.length ? g.metaThresholds : DEFAULT_GRID.metaThresholds).filter(fin) : [null];
  const configs = [];
  for (const m of metas) for (const e of edges) configs.push({ MIN_PROB_EDGE: e, metaThreshold: m });
  return { configs, edges, metaThresholds: hasMeta ? metas : null };
}

/**
 * tuneThresholds(oosRows, { costs=0, grid, ahead=5, outerFolds=4, innerFolds=3, minActivity,
 *                           minPrecision, minActed, pboS=16, base=0.5 })
 * Returns { thresholds, best, nested, dsr, dsrNested, pbo, grid, nRows, nDates, rules, gate:{pass, reasons} }.
 * `costs` = extra per-trade cost (fraction) on top of what the labels already net out.
 */
function tuneThresholds(oosRows, opts = {}) {
  const rules = {
    minActivity: fin(opts.minActivity) ? opts.minActivity : RULES.minActivity,
    minPrecision: fin(opts.minPrecision) ? opts.minPrecision : RULES.minPrecision,
    minActed: fin(opts.minActed) ? opts.minActed : RULES.minActed,
    pboMax: fin(opts.pboMax) ? opts.pboMax : RULES.pboMax,
    dsrMin: fin(opts.dsrMin) ? opts.dsrMin : RULES.dsrMin,
  };
  const ahead = Math.max(1, Math.floor(opts.ahead || 5));
  const rows = prepRows(oosRows, opts);
  const hasMeta = opts.useMeta !== false && rows.some((r) => r.metaP != null);
  const { configs, edges, metaThresholds } = buildGrid(opts.grid, hasMeta);
  const G = configs.length;

  // Date index.
  const dates = [];
  const dIdx = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (!dates.length || dates[dates.length - 1] !== rows[i].t) dates.push(rows[i].t);
    dIdx[i] = dates.length - 1;
  }
  const D = dates.length;
  const empty = (why) => ({
    thresholds: null, best: null, nested: null, dsr: null, dsrNested: null, pbo: null,
    grid: { size: G, edges, metaThresholds }, nRows: rows.length, nDates: D, rules,
    gate: { pass: false, reasons: [why] },
  });
  if (D < 20 || rows.length < 100) return empty(`not enough OOS rows to tune (${rows.length} rows / ${D} dates; need ≥ 100 / 20)`);

  // Per-date, per-config additive stats: opportunities, acted, sum of returns, wins.
  const opp = new Float64Array(D);
  const nA = new Float64Array(G * D), sR = new Float64Array(G * D), nW = new Float64Array(G * D);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], d = dIdx[i];
    opp[d]++;
    if (!r.side) continue;
    for (let g = 0; g < G; g++) {
      if (!acts(r, configs[g])) continue;
      const k = g * D + d;
      nA[k]++; sR[k] += r.ret; if (r.ret > 0) nW[k]++;
    }
  }
  const statsOver = (g, d0, d1) => {
    let o = 0, a = 0, s = 0, w = 0;
    for (let d = d0; d < d1; d++) { o += opp[d]; const k = g * D + d; a += nA[k]; s += sR[k]; w += nW[k]; }
    return summarize(o, a, s, w);
  };
  const feasible = (st) => st.nActed >= rules.minActed && st.activity >= rules.minActivity && st.precision >= rules.minPrecision;

  // Inner walk-forward selection on dates [d0, d1): feasibility on the pooled window, objective =
  // mean over innerFolds contiguous chunks of the chunk's mean net return per acted decision.
  const select = (d0, d1) => {
    const len = d1 - d0;
    if (len < 10) return null;
    const k = Math.max(1, Math.min(opts.innerFolds || 3, Math.floor(len / 5)));
    let best = null;
    for (let g = 0; g < G; g++) {
      const pooled = statsOver(g, d0, d1);
      if (!feasible(pooled)) continue;
      let sc = 0, nc = 0;
      for (let c = 0; c < k; c++) {
        const a = d0 + Math.floor((c * len) / k), b = d0 + Math.floor(((c + 1) * len) / k);
        const st = statsOver(g, a, b);
        if (st.nActed > 0) { sc += st.meanRet; nc++; }
      }
      const score = nc ? sc / nc : -Infinity;
      if (!best || score > best.score + 1e-15 || (Math.abs(score - best.score) <= 1e-15 && pooled.activity > best.stats.activity)) best = { g, score, stats: pooled };
    }
    return best;
  };

  // Outer walk-forward.
  const K = Math.max(1, Math.min(opts.outerFolds || 4, Math.floor(D / 10) - 1));
  const bounds = Array.from({ length: K + 2 }, (_, i) => Math.floor((i * D) / (K + 1)));
  const folds = [];
  let oO = 0, oA = 0, oS = 0, oW = 0;
  const nestedSeries = [];
  for (let k = 1; k <= K; k++) {
    const t0 = bounds[k], t1 = bounds[k + 1];
    const trEnd = Math.max(0, t0 - ahead);
    const sel = select(0, trEnd);
    const fold = { test: [dates[t0], dates[t1 - 1]], nTestDates: t1 - t0, chosen: sel ? { ...configs[sel.g] } : null };
    if (sel) {
      const st = statsOver(sel.g, t0, t1);
      Object.assign(fold, st);
      oO += st.nOpp; oA += st.nActed; oS += (st.meanRet || 0) * st.nActed; oW += (st.precision || 0) * st.nActed;
      for (let d = t0; d < t1; d++) { const kk = sel.g * D + d; nestedSeries.push(nA[kk] ? sR[kk] / nA[kk] : 0); }
    } else {
      fold.note = "no feasible configuration on the inner window";
      let o = 0; for (let d = t0; d < t1; d++) { o += opp[d]; nestedSeries.push(0); }
      oO += o;
    }
    folds.push(fold);
  }
  const nested = { folds, ...summarize(oO, oA, oS, Math.round(oW)), foldsWithChoice: folds.filter((f) => f.chosen).length };

  // Deployed choice: same inner rule on all dates.
  const bestSel = select(0, D);

  // Per-date return series per configuration (0 when flat that date) → trial SRs, DSR, PBO.
  const series = (g) => { const s = new Array(D); for (let d = 0; d < D; d++) { const k = g * D + d; s[d] = nA[k] ? sR[k] / nA[k] : 0; } return s; };
  const trialSRs = [];
  for (let g = 0; g < G; g++) trialSRs.push(sharpe(series(g)));
  const tEff = D / ahead;
  let dsr = null, dsrNested = null;
  if (bestSel) {
    const bs = series(bestSel.g);
    dsr = deflatedSharpe(bs, { nTrials: G, trialSRs, tEff });
    dsrNested = deflatedSharpe(nestedSeries, { nTrials: G, trialSRs, tEff: nestedSeries.length / ahead });
  }
  const M = [];
  for (let d = 0; d < D; d++) { const row = new Array(G); for (let g = 0; g < G; g++) { const k = g * D + d; row[g] = nA[k] ? sR[k] / nA[k] : 0; } M.push(row); }
  const pb = G >= 2 ? pbo(M, { S: opts.pboS || 16, keepLogits: false }) : { pbo: null, reason: "grid has < 2 configurations" };

  const reasons = [];
  if (!bestSel) reasons.push(`no configuration satisfies activity ≥ ${rules.minActivity}, precision ≥ ${rules.minPrecision}, ≥ ${rules.minActed} acted`);
  if (!(pb.pbo != null && pb.pbo <= rules.pboMax)) reasons.push(`PBO ${pb.pbo == null ? "n/a" : pb.pbo.toFixed(3)} > ${rules.pboMax}`);
  if (!(dsr && dsr.dsr != null && dsr.dsr >= rules.dsrMin)) reasons.push(`deflated Sharpe ${dsr && dsr.dsr != null ? dsr.dsr.toFixed(3) : "n/a"} < ${rules.dsrMin}`);
  if (!(nested.nActed >= rules.minActed && nested.meanRet > 0)) reasons.push(`nested walk-forward OOS mean net return ${nested.meanRet == null ? "n/a" : nested.meanRet.toFixed(5)} over ${nested.nActed} acted (need > 0 over ≥ ${rules.minActed})`);

  const thresholds = bestSel ? (hasMeta
    ? { MIN_PROB_EDGE: configs[bestSel.g].MIN_PROB_EDGE, metaThreshold: configs[bestSel.g].metaThreshold }
    : { MIN_PROB_EDGE: configs[bestSel.g].MIN_PROB_EDGE }) : null;
  return {
    thresholds,
    best: bestSel ? { ...configs[bestSel.g], innerScore: bestSel.score, ...bestSel.stats } : null,
    nested, dsr, dsrNested, pbo: pb,
    grid: { size: G, edges, metaThresholds }, nRows: rows.length, nDates: D, tEff, rules, costs: Number(opts.costs) || 0,
    gate: { pass: reasons.length === 0, reasons },
  };
}

module.exports = {
  tuneThresholds, evaluateThresholds, engineEdge,
  deflatedSharpe, probabilisticSharpe, expectedMaxSharpe, pbo,
  dieboldMariano, neweyWestVariance, moments, sharpe,
  RULES, DEFAULT_GRID, EULER_GAMMA,
};
