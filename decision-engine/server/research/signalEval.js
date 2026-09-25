// Signal report card (docs/CONTRACT-v2.md §2): does each point-in-time signal actually rank
// future outcomes, robustly enough to survive multiple testing?
//
// x = score · confidence (the signal's effective vote), y = the target:
//   "ret"    lab.ret        absolute log return (direction)
//   "exRet"  lab.exRet      return in excess of the class benchmark (relative); benchmark rows excluded
//   "tbLong" lab.tbLongRet  realized long-bracket return net of costs (orders stop < timeout < target;
//                           finer than the {-1,0,1} outcome, same ordering)
//
// Two Information Coefficients are computed for every signal; `mode` picks the headline one
// (default "auto": exRet → "xs", ret / tbLong → "ts"):
//   xs  Fama–MacBeth cross-sectional rank IC. Per date — and within asset class, so a signal
//       that only differs between stocks and crypto is not mistaken for stock-picking skill —
//       Spearman(x, y) across assets (≥ minXS names); per-date ICs averaged over dates.
//       t-stat: Newey–West (Bartlett) on the per-date IC series.
//   ts  Pooled time-series rank IC: x and y rank-standardised within each asset (so it measures
//       "does this asset do better when its own signal is higher", not level differences between
//       assets), pooled; SE by Driscoll–Kraay — per-date sums of the centred products, Newey–West
//       across dates — which is robust to the cross-sectional correlation of same-day returns
//       and to overlapping labels. Market-wide signals (macro, fear-greed) only have a ts IC.
// NW lag = max(ahead, label span in date-grid steps): exactly `ahead` for a single-class regular
// panel, larger (conservative) when a 5-trading-day stock label spans 7 calendar-day grid steps.
//
// nEff = min(n, 1/SE²): the number of independent observations that would give a correlation
// the same standard error (≈ n/ahead for overlapping labels, smaller with cross-correlation).
// FDR: Benjamini–Hochberg at q over every signal with enough data (families separately).
// Verdicts (contract §2), evaluated in this order:
//   n < minN / no IC / a half-sample without data   → null ("unknown/low-n")
//   IC sign differs between first and second half    → "drop" (unstable)
//   BH-significant, IC > 0                           → "keep"
//   BH-significant, IC < 0                           → "invert-candidate" (reported, never applied)
//   IC ≤ 0 with p < 0.2                              → "drop"
//   otherwise                                        → "weak" (positive but not significant, or an
//                                                        IC indistinguishable from 0)
// signalMask: keep 1→1.5 (t = 2 → 1, t ≥ 5 → 1.5), weak 0.6, drop 0, invert-candidate 0 (using it
// with its current sign is harmful; flipping it would be data snooping), unknown/low-n 0.8.

"use strict";

const MASK_DEFAULT = 0.8;
const EPS = 1e-12;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r4 = (v) => (isNum(v) ? Math.round(v * 1e4) / 1e4 : null);
const r6 = (v) => (isNum(v) ? Math.round(v * 1e6) / 1e6 : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ───────────────────────────── statistics helpers ─────────────────────────────
/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
function normCdf(z) {
  if (!isNum(z)) return NaN;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
const twoSidedP = (t) => (isNum(t) ? clamp(2 * (1 - normCdf(Math.abs(t))), 0, 1) : null);

/** Average ranks (1-based) with ties sharing the mean rank. */
function rankAvg(vals) {
  const n = vals.length;
  const idx = new Array(n);
  for (let k = 0; k < n; k++) idx[k] = k;
  idx.sort((a, b) => vals[a] - vals[b]);
  const r = new Float64Array(n);
  for (let k = 0; k < n;) {
    let j = k;
    while (j + 1 < n && vals[idx[j + 1]] === vals[idx[k]]) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) r[idx[m]] = avg;
    k = j + 1;
  }
  return r;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += x[k]; my += y[k]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { const a = x[k] - mx, b = y[k] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (!(sxx > EPS) || !(syy > EPS)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation (average ranks for ties); null with < 3 points or no variation. */
function spearman(x, y) {
  const n = Math.min(x.length, y.length);
  const xs = [], ys = [];
  for (let k = 0; k < n; k++) if (isNum(x[k]) && isNum(y[k])) { xs.push(x[k]); ys.push(y[k]); }
  if (xs.length < 3) return null;
  return pearson(rankAvg(xs), rankAvg(ys));
}

/** Newey–West long-run variance sum Σ_d S_d² + 2 Σ_{l≤L} (1 − l/(L+1)) Σ_d S_d S_{d−l} (no demeaning). */
function nwSum(S, lag) {
  const n = S.length;
  let v = 0;
  for (let d = 0; d < n; d++) v += S[d] * S[d];
  const L = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= L; l++) {
    let c = 0;
    for (let d = l; d < n; d++) c += S[d] * S[d - l];
    v += 2 * (1 - l / (L + 1)) * c;
  }
  return v;
}

/**
 * neweyWestT(x, lag) → { mean, se, t, n, lag, lrv } — t-stat of the mean of a (possibly
 * autocorrelated) series with a Newey–West (Bartlett kernel) HAC standard error:
 *   γ_l = (1/n) Σ_{t=l}^{n−1} (x_t − x̄)(x_{t−l} − x̄),  lrv = γ_0 + 2 Σ_{l=1}^{L} (1 − l/(L+1)) γ_l,
 *   se = √(lrv / n),  t = x̄ / se,  L = min(lag, n − 1).
 */
function neweyWestT(xIn, lag = 0) {
  const x = (xIn || []).filter(isNum);
  const n = x.length;
  if (n < 2) return { mean: n ? x[0] : null, se: null, t: null, n, lag, lrv: null };
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const c = x.map((v) => v - mean);
  const L = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  const lrv = nwSum(c, L) / n;
  const se = lrv > 0 ? Math.sqrt(lrv / n) : 0;
  return { mean, se, t: se > 0 ? mean / se : null, n, lag: L, lrv };
}

/**
 * benjaminiHochberg(pvals, q=0.10) → { rejected: bool[], qValues: (number|null)[], threshold, nSignificant, m }
 * Non-finite p-values are ignored (not rejected, not counted in m). threshold = the largest p rejected.
 */
function benjaminiHochberg(pvals, q = 0.10) {
  const items = [];
  (pvals || []).forEach((p, k) => { if (isNum(p)) items.push({ p: clamp(p, 0, 1), k }); });
  const m = items.length;
  const rejected = new Array((pvals || []).length).fill(false);
  const qValues = new Array((pvals || []).length).fill(null);
  if (!m) return { rejected, qValues, threshold: null, nSignificant: 0, m: 0 };
  items.sort((a, b) => a.p - b.p);
  let kMax = -1;
  for (let j = 0; j < m; j++) if (items[j].p <= ((j + 1) / m) * q) kMax = j;
  let minQ = 1;
  for (let j = m - 1; j >= 0; j--) { minQ = Math.min(minQ, (items[j].p * m) / (j + 1)); qValues[items[j].k] = minQ; }
  for (let j = 0; j <= kMax; j++) rejected[items[j].k] = true;
  return { rejected, qValues, threshold: kMax >= 0 ? items[kMax].p : null, nSignificant: kMax + 1, m };
}

/** Wilson score interval for hits/n (n may be fractional, e.g. an effective sample size). */
function wilsonCI(hits, n, z = 1.96) {
  if (!(n > 0) || !isNum(hits)) return [null, null];
  const p = clamp(hits / n, 0, 1), z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const w = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [clamp(c - w, 0, 1), clamp(c + w, 0, 1)];
}

function median(xs) {
  const a = xs.filter(isNum).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ───────────────────────────── panel context ─────────────────────────────
const TARGETS = {
  ret: (lab) => lab.ret,
  exRet: (lab) => lab.exRet,
  tbLong: (lab) => lab.tbLongRet,
};

function familyOf(ds, id) {
  if (ds.signalFamily && ds.signalFamily[id]) return ds.signalFamily[id];
  const p = String(id).split(".")[0];
  return { tech: "technical", regime: "regime", macro: "macro", sent: "sentiment", rel: "relative", ml: "ml" }[p] || p;
}

function buildPanel(ds, opts) {
  const target = opts.target;
  const tv = TARGETS[target];
  if (!tv) throw new Error(`unknown target "${target}" (ret | exRet | tbLong)`);
  const benches = new Set(Object.values(ds.benchmarks || {}));
  const cls = opts.assetClass || null;
  const rows = [];
  for (const r of ds.rows || []) {
    if (!r || !r.lab || !isNum(tv(r.lab))) continue;
    if (target === "exRet" && benches.has(r.assetId)) continue;
    if (cls && r.assetClass !== cls) continue;
    if (isNum(opts.from) && r.t < opts.from) continue;
    if (isNum(opts.to) && r.t > opts.to) continue;
    rows.push(r);
  }
  rows.sort((a, b) => a.t - b.t || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const N = rows.length;
  const dateList = [];
  const dateIdx = new Int32Array(N), assetIdx = new Int32Array(N), classIdx = new Int32Array(N), regIdx = new Int32Array(N);
  const y = new Float64Array(N);
  const assets = new Map(), classes = new Map(), regimes = new Map();
  const spans = [];
  for (let k = 0; k < N; k++) {
    const r = rows[k];
    if (!dateList.length || dateList[dateList.length - 1] !== r.t) dateList.push(r.t);
    dateIdx[k] = dateList.length - 1;
    if (!assets.has(r.assetId)) assets.set(r.assetId, assets.size);
    assetIdx[k] = assets.get(r.assetId);
    const c = r.assetClass || "?";
    if (!classes.has(c)) classes.set(c, classes.size);
    classIdx[k] = classes.get(c);
    const lbl = (r.regime && r.regime.label) || "unknown";
    if (!regimes.has(lbl)) regimes.set(lbl, regimes.size);
    regIdx[k] = regimes.get(lbl);
    y[k] = tv(r.lab);
    if (k % 7 === 0 && isNum(r.lab.tEnd)) spans.push(r.lab.tEnd - r.t);
  }
  const T = dateList.length;
  const ahead = Math.max(1, (ds.ahead | 0) || 1);
  const gaps = [];
  for (let d = 1; d < T; d++) gaps.push(dateList[d] - dateList[d - 1]);
  const step = median(gaps) || (ds.tf || 86400) * 1000;
  const span = median(spans) || ahead * (ds.tf || 86400) * 1000;
  const mult = isNum(opts.lagMult) && opts.lagMult > 0 ? opts.lagMult : 1;
  const lag = isNum(opts.lag) ? Math.max(0, Math.floor(opts.lag)) : Math.ceil(mult * Math.max(ahead, Math.ceil(span / step - 1e-9)));
  return {
    rows, N, T, dateList, dateIdx, assetIdx, classIdx, regIdx, y, lag,
    nAssets: assets.size, classNames: [...classes.keys()], regimeNames: [...regimes.keys()],
    half: Math.floor(T / 2),
  };
}

// Pooled time-series rank IC with Driscoll–Kraay SE. idx: row indices (x finite).
function tsIC(P, x, idx) {
  const byAsset = new Map();
  for (const k of idx) { const a = P.assetIdx[k]; let g = byAsset.get(a); if (!g) byAsset.set(a, (g = [])); g.push(k); }
  const prods = [], pd = [];
  for (const g of byAsset.values()) {
    if (g.length < 10) continue;
    const xs = g.map((k) => x[k]), ys = g.map((k) => P.y[k]);
    const rx = rankAvg(xs), ry = rankAvg(ys);
    const m = (g.length + 1) / 2;
    let sx = 0, sy = 0;
    for (let j = 0; j < g.length; j++) { sx += (rx[j] - m) ** 2; sy += (ry[j] - m) ** 2; }
    sx = Math.sqrt(sx / g.length); sy = Math.sqrt(sy / g.length);
    if (!(sx > EPS) || !(sy > EPS)) continue;
    for (let j = 0; j < g.length; j++) { prods.push(((rx[j] - m) / sx) * ((ry[j] - m) / sy)); pd.push(P.dateIdx[g[j]]); }
  }
  const N = prods.length;
  if (N < 20) return null;
  let ic = 0;
  for (const p of prods) ic += p;
  ic /= N;
  const S = new Float64Array(P.T);
  const seen = new Uint8Array(P.T);
  for (let j = 0; j < N; j++) { S[pd[j]] += prods[j] - ic; seen[pd[j]] = 1; }
  const V = nwSum(S, P.lag) / (N * N);
  const se = V > 0 ? Math.sqrt(V) : null;
  let nDates = 0;
  for (let d = 0; d < P.T; d++) nDates += seen[d];
  return { ic, se, t: se ? ic / se : null, n: N, nEff: se ? Math.min(N, 1 / V) : null, nDates };
}

// Fama–MacBeth cross-sectional rank IC (per date, within class; weighted by group size).
function xsIC(P, x, idx, minXS) {
  const series = [];
  let N = 0;
  let k0 = 0;
  // idx is in row order (sorted by t) → walk date by date.
  while (k0 < idx.length) {
    const d = P.dateIdx[idx[k0]];
    let k1 = k0;
    while (k1 < idx.length && P.dateIdx[idx[k1]] === d) k1++;
    const groups = new Map();
    for (let j = k0; j < k1; j++) { const k = idx[j]; const c = P.classIdx[k]; let g = groups.get(c); if (!g) groups.set(c, (g = [])); g.push(k); }
    let wsum = 0, icsum = 0, n = 0;
    for (const g of groups.values()) {
      if (g.length < minXS) continue;
      const rho = pearson(rankAvg(g.map((k) => x[k])), rankAvg(g.map((k) => P.y[k])));
      if (!isNum(rho)) continue;
      icsum += g.length * rho; wsum += g.length; n += g.length;
    }
    if (wsum > 0) { series.push(icsum / wsum); N += n; }
    k0 = k1;
  }
  if (series.length < 10) return null;
  const nw = neweyWestT(series, P.lag);
  const V = nw.se ? nw.se * nw.se : null;
  return { ic: nw.mean, se: nw.se, t: nw.t, n: N, nEff: V ? Math.min(N, 1 / V) : null, nDates: series.length };
}

function icOf(P, x, idx, mode, minXS) { return mode === "xs" ? xsIC(P, x, idx, minXS) : tsIC(P, x, idx); }
const brief = (s) => (s ? { n: s.n, ic: r4(s.ic), icT: r4(s.t) } : null);

function evalVector(P, x, id, family, o) {
  const idx = [];
  for (let k = 0; k < P.N; k++) if (isNum(x[k])) idx.push(k);
  const n = idx.length;
  const ts = n >= 20 ? tsIC(P, x, idx) : null;
  const xs = n >= 20 ? xsIC(P, x, idx, o.minXS) : null;
  const prim = o.mode === "xs" ? xs : ts;

  // Hit rate and conditional means (all targets: "does y share the sign of x?").
  let nL = 0, nS = 0, sumL = 0, sumS = 0, hits = 0, upL = 0, dnS = 0;
  for (const k of idx) {
    const v = x[k], yy = P.y[k];
    if (v > EPS) { nL++; sumL += yy; if (yy > 0) { hits++; upL++; } }
    else if (v < -EPS) { nS++; sumS += yy; if (yy < 0) { hits++; dnS++; } }
  }
  const nHit = nL + nS;
  let pUp = 0, cnt = 0;
  for (const k of idx) { cnt++; if (P.y[k] > 0) pUp++; }
  pUp = cnt ? pUp / cnt : null;
  const hitRate = nHit ? hits / nHit : null;
  const hitBase = nHit && pUp != null ? (nL * pUp + nS * (1 - pUp)) / nHit : null;
  const effFrac = prim && isNum(prim.nEff) && prim.n > 0 ? Math.min(1, prim.nEff / prim.n) : 1;
  const hitCI = nHit ? wilsonCI(hits * effFrac, nHit * effFrac) : [null, null];

  // Breakdowns on the headline IC.
  const byClass = {};
  for (let c = 0; c < P.classNames.length; c++) {
    const sub = idx.filter((k) => P.classIdx[k] === c);
    if (sub.length >= 20) byClass[P.classNames[c]] = brief(icOf(P, x, sub, o.mode, o.minXS)) || { n: sub.length, ic: null, icT: null };
  }
  const byRegime = {};
  if (o.byRegime) {
    for (let g = 0; g < P.regimeNames.length; g++) {
      const sub = idx.filter((k) => P.regIdx[k] === g);
      if (sub.length >= Math.max(50, o.minN / 4)) byRegime[P.regimeNames[g]] = brief(icOf(P, x, sub, o.mode, o.minXS)) || { n: sub.length, ic: null, icT: null };
    }
  }
  const h1idx = idx.filter((k) => P.dateIdx[k] < P.half), h2idx = idx.filter((k) => P.dateIdx[k] >= P.half);
  const minHalf = Math.max(20, Math.floor(o.minN / 4));
  const h1 = h1idx.length >= minHalf ? icOf(P, x, h1idx, o.mode, o.minXS) : null;
  const h2 = h2idx.length >= minHalf ? icOf(P, x, h2idx, o.mode, o.minXS) : null;
  const stable = h1 && h2 && isNum(h1.ic) && isNum(h2.ic) ? Math.sign(h1.ic) !== 0 && Math.sign(h1.ic) === Math.sign(h2.ic) : null;

  return {
    id, family, n, nEff: prim && isNum(prim.nEff) ? Math.round(prim.nEff) : null,
    ic: prim ? r4(prim.ic) : null, icT: prim ? r4(prim.t) : null, icP: prim ? r6(twoSidedP(prim.t)) : null,
    hitRate: r4(hitRate), hitRateCI: hitCI.map(r4), hitBase: r4(hitBase),
    meanRetWhenLong: nL ? r6(sumL / nL) : null, meanRetWhenShort: nS ? r6(sumS / nS) : null,
    nLong: nL, nShort: nS,
    byRegime, byClass,
    decay: { ic_h1: h1 ? r4(h1.ic) : null, ic_h2: h2 ? r4(h2.ic) : null },
    stable,
    mode: o.mode,
    xs: xs ? { ic: r4(xs.ic), icT: r4(xs.t), nDates: xs.nDates, n: xs.n } : null,
    ts: ts ? { ic: r4(ts.ic), icT: r4(ts.t), nDates: ts.nDates, n: ts.n } : null,
    coverage: P.N ? r4(n / P.N) : 0,
    verdict: null, reason: null, qValue: null, significant: false,
  };
}

function assignVerdicts(stats, q, minN) {
  const tested = stats.filter((s) => s.n >= minN && isNum(s.icP) && isNum(s.ic) && s.stable !== null);
  const bh = benjaminiHochberg(tested.map((s) => s.icP), q);
  tested.forEach((s, j) => { s.qValue = r6(bh.qValues[j]); s.significant = bh.rejected[j]; });
  for (const s of stats) {
    if (!tested.includes(s)) {
      s.verdict = null;
      s.reason = s.n < minN ? `n ${s.n} < minN ${minN}` : !isNum(s.ic) ? `no ${s.mode} IC (no dispersion within dates/assets)` : "not enough data in one half-sample to judge stability";
      continue;
    }
    if (!s.stable) { s.verdict = "drop"; s.reason = `IC sign flips between halves (${s.decay.ic_h1} → ${s.decay.ic_h2})`; }
    else if (s.significant && s.ic > 0) { s.verdict = "keep"; s.reason = `IC ${s.ic} (t ${s.icT}) significant after BH-FDR, stable`; }
    else if (s.significant && s.ic < 0) { s.verdict = "invert-candidate"; s.reason = `IC ${s.ic} (t ${s.icT}) significantly NEGATIVE after BH-FDR, stable — report only, never auto-inverted`; }
    else if (s.ic <= 0 && s.icP < 0.2) { s.verdict = "drop"; s.reason = `IC ${s.ic} ≤ 0 (p ${s.icP})`; }
    else { s.verdict = "weak"; s.reason = `IC ${s.ic} not significant (p ${s.icP}, q ${s.qValue})`; }
  }
  return { q, m: bh.m, nSignificant: bh.nSignificant, pThreshold: r6(bh.threshold) };
}

/**
 * reportCard(ds, { target="ret", byRegime=true, minN=200, q=0.10, mode="auto", minXS=5,
 *                  assetClass?, from?, to?, lag?, lagMult=1 })
 *   lagMult scales the NW lag (robustness check: Bartlett weights under-correct persistent,
 *   market-wide predictors on overlapping labels; lagMult=2 is the conservative variant).
 *   → { target, mode, horizon, ahead, lag, nRows, nDates, nAssets, baseRate, signals: {id: SignalStat},
 *       families: {name: SignalStat (+ "pooled" = pRaw − 0.5)}, fdr, familyFdr, summary, built }
 */
function reportCard(ds, opts = {}) {
  const target = opts.target || "ret";
  const o = {
    target,
    mode: opts.mode && opts.mode !== "auto" ? opts.mode : target === "exRet" ? "xs" : "ts",
    minN: isNum(opts.minN) ? opts.minN : 200,
    q: isNum(opts.q) ? opts.q : 0.10,
    byRegime: opts.byRegime !== false,
    minXS: isNum(opts.minXS) ? Math.max(3, opts.minXS) : 5,
  };
  const P = buildPanel(ds, { ...opts, target });
  const ids = ds.signalIds && ds.signalIds.length ? ds.signalIds
    : [...new Set(P.rows.flatMap((r) => Object.keys(r.sig || {})))].sort();

  const signals = {};
  const statList = [];
  for (const id of ids) {
    const x = new Float64Array(P.N).fill(NaN);
    for (let k = 0; k < P.N; k++) { const v = P.rows[k].sig && P.rows[k].sig[id]; if (v && isNum(v[0]) && isNum(v[1])) x[k] = v[0] * v[1]; }
    const s = evalVector(P, x, id, familyOf(ds, id), o);
    signals[id] = s; statList.push(s);
  }
  const fdr = assignVerdicts(statList, o.q, o.minN);

  const famNames = [...new Set(P.rows.flatMap((r) => Object.keys(r.fam || {})))].sort();
  const families = {};
  const famList = [];
  for (const f of famNames) {
    const x = new Float64Array(P.N).fill(NaN);
    for (let k = 0; k < P.N; k++) { const v = P.rows[k].fam && P.rows[k].fam[f]; if (isNum(v)) x[k] = v; }
    const s = evalVector(P, x, `fam.${f}`, f, o);
    families[f] = s; famList.push(s);
  }
  {
    const x = new Float64Array(P.N).fill(NaN);
    for (let k = 0; k < P.N; k++) { const v = P.rows[k].pRaw; if (isNum(v)) x[k] = v - 0.5; }
    const s = evalVector(P, x, "pooled.pRaw", "pooled", o);
    families.pooled = s; famList.push(s);
  }
  const familyFdr = assignVerdicts(famList, o.q, o.minN);

  let up = 0;
  for (let k = 0; k < P.N; k++) if (P.y[k] > 0) up++;
  const by = (v) => statList.filter((s) => s.verdict === v).map((s) => s.id);
  return {
    target, mode: o.mode, horizon: ds.horizon || null, ahead: ds.ahead || null, lag: P.lag,
    nRows: P.N, nDates: P.T, nAssets: P.nAssets, baseRate: P.N ? r4(up / P.N) : null,
    from: P.T ? new Date(P.dateList[0]).toISOString() : null, to: P.T ? new Date(P.dateList[P.T - 1]).toISOString() : null,
    signals, families,
    fdr: { ...fdr, nSignificant: fdr.nSignificant },
    familyFdr,
    summary: { keep: by("keep"), weak: by("weak"), drop: by("drop"), invertCandidate: by("invert-candidate"), unknown: statList.filter((s) => s.verdict == null).map((s) => s.id) },
    minN: o.minN, built: new Date().toISOString(),
  };
}

/** Confidence multiplier for one SignalStat (see header). */
function maskValue(s) {
  if (!s || s.verdict == null) return MASK_DEFAULT;
  switch (s.verdict) {
    case "keep": return r4(clamp(1 + (0.5 * ((isNum(s.icT) ? Math.abs(s.icT) : 2) - 2)) / 3, 1, 1.5));
    case "weak": return 0.6;
    case "drop": return 0;
    case "invert-candidate": return 0;
    default: return MASK_DEFAULT;
  }
}

/** signalMask(report) → { [signalId]: confidence multiplier }. Ids not in the map → MASK_DEFAULT. */
function signalMask(report) {
  const out = {};
  for (const [id, s] of Object.entries((report && report.signals) || {})) out[id] = maskValue(s);
  return out;
}

/** Signals sorted by |icT| (for UIs / logs): [{ id, family, ic, icT, q, verdict, n }]. */
function rankSignals(report) {
  return Object.values((report && report.signals) || {})
    .map((s) => ({ id: s.id, family: s.family, n: s.n, ic: s.ic, icT: s.icT, qValue: s.qValue, verdict: s.verdict, stable: s.stable }))
    .sort((a, b) => Math.abs(b.icT || 0) - Math.abs(a.icT || 0));
}

module.exports = {
  reportCard, signalMask, maskValue, rankSignals, MASK_DEFAULT,
  spearman, neweyWestT, benjaminiHochberg, wilsonCI, normCdf, rankAvg, pearson,
};
