// Learned model (contract §2.9): hand-written logistic regression + gradient-boosted trees,
// trained walk-forward with purging, ensembled, and turned into "ml" family signals.
//
// Design notes (read before changing anything — this module is where leakage would hide):
//  * Features at bar i are computed ONLY from candles[0..i]. All rolling quantities are causal
//    recursions / trailing windows. `featureMatrix(candles)` computes every row in one O(n) pass;
//    `buildFeatures(candles, i)` runs the same code on candles.slice(0, i+1), so the two agree by
//    construction and a test asserts that mutating candles after i leaves row i unchanged.
//  * Label for bar k: y = 1 if log(c[k+ahead]/c[k]) > 0. The label "ends" at bar k+ahead.
//  * Purging (López de Prado): a model used to predict bar j may only be trained on samples k
//    with k + ahead <= j, i.e. whose labels were fully observed at j. Walk-forward retrains at
//    bar r every `step` bars on k <= r - ahead and predicts bars r..r+step-1 (so k <= j - ahead).
//    GBM early stopping uses a time-ordered validation tail with an `ahead`-bar purge gap too.
//  * Dead zone: TRAINING samples with |ret| < 0.1·σ_ahead (σ of the training forward returns)
//    are dropped (they are label noise). OOS evaluation keeps every bar.
//  * Everything is deterministic (seeded PRNG for GBM row subsampling).
"use strict";

const { projectFormingVolume } = require("./indicators");

// ─── small numeric helpers ───────────────────────────────────────────────────────────────────
const EPS = 1e-12;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const fin = (x, d = 0) => (Number.isFinite(x) ? x : d);
const sigmoid = z => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const clipP = p => clamp(fin(p, 0.5), 1e-6, 1 - 1e-6);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── features ────────────────────────────────────────────────────────────────────────────────
const FEATURE_NAMES = [
  // trailing log returns over k bars, vol-scaled: log(c_i/c_{i−k}) / (σ20·√k), clamped to ±6
  "ret_1", "ret_3", "ret_5", "ret_10", "ret_20", "ret_60",
  "rsi_14",            // (RSI14 − 50)/50, Wilder smoothing
  "macd_hist_px",      // MACD(12,26,9) histogram / close
  "bb_pctb_20",        // Bollinger %B (20, 2σ), clamped to [-1, 2]
  "atr_px_14",         // ATR14 / close
  "adx_14",            // ADX14 / 100
  "vol_z_20",          // z-score of log(1+volume) over trailing 20 bars
  "dist_ema20", "dist_ema50", "dist_ema200", // log(close / EMA_n)
  "rvol_ratio_5_20",   // log(realized vol 5 / realized vol 20)
  "eff_ratio_10",      // Kaufman efficiency ratio, signed by direction, [-1, 1]
  "hurst_lite_60",     // variance-ratio Hurst proxy: 0.5 + 0.5·log(VR4)/log(4) over 60 bars
  "autocorr_20",       // lag-1 autocorrelation of 1-bar log returns over trailing 20 bars
  "dd_60",             // log(close / max close of trailing 60 bars) ≤ 0
  "range_pos_20",      // (close − low20) / (high20 − low20) − 0.5, Donchian position
  "dist_high_252",     // log(close / max close of trailing min(252, i+1) bars) — 52w-high proximity
  "vol_pct_250",       // percentile rank (0..1) of σ20 among its trailing ≤250 values
  // Calendar features (day-of-week / hour) are deliberately excluded: no robust evidence and a
  // classic data-snooping trap (docs/RESEARCH.md §5.1).
];
const N_FEATURES = FEATURE_NAMES.length;
const WARMUP = 60; // first index with a full feature vector (needs 60-bar return)

function rollingStd(arr, end, n) { // population std of arr[end-n+1..end]
  if (end - n + 1 < 0) return null;
  let s = 0, s2 = 0;
  for (let k = end - n + 1; k <= end; k++) { s += arr[k]; s2 += arr[k] * arr[k]; }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/**
 * Compute feature rows for every bar in one causal pass. Row i is null for i < WARMUP or when
 * the inputs are unusable. Every quantity at i depends only on candles[0..i].
 */
function featureMatrix(candles) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const rows = new Array(n).fill(null);
  if (n === 0) return rows;
  const c = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n);
  const lv = new Float64Array(n), r = new Float64Array(n);
  let ok = true;
  for (let i = 0; i < n; i++) {
    const k = candles[i] || {};
    const close = Number(k.c);
    if (!(close > 0)) { ok = false; }
    c[i] = close > 0 ? close : (i ? c[i - 1] : 1);
    const hi = Number(k.h), lo = Number(k.l);
    h[i] = hi > 0 ? Math.max(hi, c[i]) : c[i];
    l[i] = lo > 0 ? Math.min(lo, c[i]) : c[i];
    lv[i] = Math.log1p(Math.max(0, fin(Number(k.v), 0)));
    r[i] = i ? Math.log(c[i] / c[i - 1]) : 0;
  }
  if (!ok && n < 2) return rows;

  // Recursive state (all causal).
  const ema = (prev, x, span) => prev + (2 / (span + 1)) * (x - prev);
  let e12 = c[0], e26 = c[0], sig = 0, e20 = c[0], e50 = c[0], e200 = c[0];
  let avgG = 0, avgL = 0;            // Wilder RSI
  let atr = h[0] - l[0];             // Wilder ATR
  let pDMs = 0, mDMs = 0, trs = 0, adx = 0; // Wilder ADX
  const tr = new Float64Array(n);
  const rv20a = new Float64Array(n).fill(NaN); // σ20 of 1-bar log returns, causal
  for (let i = 0; i < n; i++) {
    if (i >= 20) rv20a[i] = rollingStd(r, i, 20);
    const x = c[i];
    if (i > 0) {
      e12 = ema(e12, x, 12); e26 = ema(e26, x, 26);
      e20 = ema(e20, x, 20); e50 = ema(e50, x, 50); e200 = ema(e200, x, 200);
      const d = x - c[i - 1];
      const a14 = 1 / 14;
      avgG += a14 * (Math.max(d, 0) - avgG);
      avgL += a14 * (Math.max(-d, 0) - avgL);
      tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      atr += a14 * (tr[i] - atr);
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
      pDMs += a14 * (pdm - pDMs); mDMs += a14 * (mdm - mDMs); trs += a14 * (tr[i] - trs);
      const pdi = trs > EPS ? pDMs / trs : 0, mdi = trs > EPS ? mDMs / trs : 0;
      const dx = pdi + mdi > EPS ? Math.abs(pdi - mdi) / (pdi + mdi) : 0;
      adx += a14 * (dx - adx);
    } else tr[i] = h[i] - l[i];
    const macd = e12 - e26;
    sig = i === 0 ? macd : ema(sig, macd, 9);
    if (i < WARMUP) continue;

    const f = new Array(N_FEATURES);
    let j = 0;
    const s20 = rv20a[i];
    for (const lag of [1, 3, 5, 10, 20, 60]) {
      f[j++] = s20 > 1e-12 ? clamp(Math.log(x / c[i - lag]) / (s20 * Math.sqrt(lag)), -6, 6) : 0;
    }
    const rs = avgL > EPS ? avgG / avgL : (avgG > EPS ? 100 : 1);
    f[j++] = (100 - 100 / (1 + rs) - 50) / 50;
    f[j++] = (macd - sig) / x;
    // Bollinger %B
    let s = 0, s2 = 0;
    for (let k = i - 19; k <= i; k++) { s += c[k]; s2 += c[k] * c[k]; }
    const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m));
    f[j++] = sd > EPS * x ? clamp((x - (m - 2 * sd)) / (4 * sd), -1, 2) : 0.5;
    f[j++] = atr / x;
    f[j++] = adx;
    const vsd = rollingStd(lv, i, 20);
    let vm = 0; for (let k = i - 19; k <= i; k++) vm += lv[k]; vm /= 20;
    f[j++] = vsd > 1e-9 ? clamp((lv[i] - vm) / vsd, -5, 5) : 0;
    f[j++] = Math.log(x / e20); f[j++] = Math.log(x / e50); f[j++] = Math.log(x / e200);
    const rv5 = rollingStd(r, i, 5), rv20 = rollingStd(r, i, 20);
    f[j++] = rv5 > 1e-12 && rv20 > 1e-12 ? clamp(Math.log(rv5 / rv20), -3, 3) : 0;
    let path = 0; for (let k = i - 9; k <= i; k++) path += Math.abs(c[k] - c[k - 1]);
    f[j++] = path > EPS ? (x - c[i - 10]) / path : 0;
    // variance-ratio Hurst proxy over trailing 60 one-bar returns (overlapping 4-bar sums)
    let v1 = 0, v4 = 0, m1 = 0;
    for (let k = i - 59; k <= i; k++) m1 += r[k];
    m1 /= 60;
    for (let k = i - 59; k <= i; k++) v1 += (r[k] - m1) ** 2;
    let cnt4 = 0;
    for (let k = i - 56; k <= i; k++) { const q = r[k] + r[k - 1] + r[k - 2] + r[k - 3] - 4 * m1; v4 += q * q; cnt4++; }
    v1 /= 60; v4 /= cnt4;
    f[j++] = v1 > 1e-18 && v4 > 1e-18 ? clamp(0.5 + 0.5 * Math.log(v4 / (4 * v1)) / Math.log(4), 0, 1) : 0.5;
    // lag-1 autocorrelation of returns (20)
    let ma = 0; for (let k = i - 19; k <= i; k++) ma += r[k]; ma /= 20;
    let num = 0, den = 0;
    for (let k = i - 19; k <= i; k++) { den += (r[k] - ma) ** 2; if (k > i - 19) num += (r[k] - ma) * (r[k - 1] - ma); }
    f[j++] = den > 1e-18 ? clamp(num / den, -1, 1) : 0;
    let mx = -Infinity; for (let k = i - 59; k <= i; k++) if (c[k] > mx) mx = c[k];
    f[j++] = Math.log(x / mx);
    let hh = -Infinity, ll = Infinity;
    for (let k = i - 19; k <= i; k++) { if (h[k] > hh) hh = h[k]; if (l[k] < ll) ll = l[k]; }
    f[j++] = hh - ll > EPS ? (x - ll) / (hh - ll) - 0.5 : 0;
    let mx252 = -Infinity;
    for (let k = Math.max(0, i - 251); k <= i; k++) if (c[k] > mx252) mx252 = c[k];
    f[j++] = Math.log(x / mx252);
    let below = 0, tot = 0;
    for (let k = Math.max(20, i - 249); k <= i; k++) { tot++; if (rv20a[k] <= s20) below++; }
    f[j++] = tot ? below / tot : 0.5;
    let good = true;
    for (let k = 0; k < N_FEATURES; k++) if (!Number.isFinite(f[k])) { good = false; break; }
    rows[i] = good ? f : null;
  }
  return rows;
}

/** Feature vector for bar i using only candles[0..i]; null during warm-up / bad input. */
function buildFeatures(candles, i) {
  if (!Array.isArray(candles) || !Number.isInteger(i) || i < WARMUP || i >= candles.length) return null;
  const rows = featureMatrix(candles.slice(0, i + 1));
  return rows[i];
}

// ─── linear algebra ──────────────────────────────────────────────────────────────────────────
function choleskySolve(A, b) { // A symmetric positive definite (d×d, array of arrays)
  const d = b.length, L = A.map(row => row.slice());
  for (let j = 0; j < d; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (!(s > 1e-12)) return null;
    L[j][j] = Math.sqrt(s);
    for (let i = j + 1; i < d; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  const z = new Array(d);
  for (let i = 0; i < d; i++) { let t = b[i]; for (let k = 0; k < i; k++) t -= L[i][k] * z[k]; z[i] = t / L[i][i]; }
  const x = new Array(d);
  for (let i = d - 1; i >= 0; i--) { let t = z[i]; for (let k = i + 1; k < d; k++) t -= L[k][i] * x[k]; x[i] = t / L[i][i]; }
  return x;
}

// ─── logistic regression ─────────────────────────────────────────────────────────────────────
class LogisticModel {
  constructor() { this.mean = null; this.std = null; this.w = null; this.b = 0; this.n = 0; }

  /**
   * L2-regularized logistic regression on standardized features. Default solver is Newton/IRLS
   * (deterministic, converges in ~10 iterations); `{ solver: "gd", lr, epochs }` uses full-batch
   * gradient descent instead. The intercept is not penalized.
   */
  fit(X, y, { l2 = 1.0, epochs = 25, lr = 0.1, solver = "newton", tol = 1e-8 } = {}) {
    const n = X.length, d = n ? X[0].length : 0;
    this.n = n;
    if (!n || !d) { this.mean = []; this.std = []; this.w = []; this.b = 0; return this; }
    const mean = new Array(d).fill(0), std = new Array(d).fill(0);
    for (const x of X) for (let k = 0; k < d; k++) mean[k] += x[k];
    for (let k = 0; k < d; k++) mean[k] /= n;
    for (const x of X) for (let k = 0; k < d; k++) std[k] += (x[k] - mean[k]) ** 2;
    for (let k = 0; k < d; k++) { std[k] = Math.sqrt(std[k] / n); if (!(std[k] > 1e-12)) std[k] = 1; }
    this.mean = mean; this.std = std;
    const Z = X.map(x => x.map((v, k) => clamp((v - mean[k]) / std[k], -8, 8)));
    const ybar = y.reduce((a, v) => a + v, 0) / n;
    let b = Math.log((ybar + 0.5 / n) / (1 - ybar + 0.5 / n));
    let w = new Array(d).fill(0);
    const lam = l2; // penalty: 0.5·lam·|w|² added to total (sum) negative log-likelihood
    if (solver === "gd") {
      for (let ep = 0; ep < epochs; ep++) {
        const gw = new Array(d).fill(0); let gb = 0;
        for (let i = 0; i < n; i++) {
          let z = b; for (let k = 0; k < d; k++) z += w[k] * Z[i][k];
          const e = sigmoid(z) - y[i]; gb += e;
          for (let k = 0; k < d; k++) gw[k] += e * Z[i][k];
        }
        for (let k = 0; k < d; k++) w[k] -= lr * (gw[k] + lam * w[k]) / n;
        b -= lr * gb / n;
      }
    } else {
      const D = d + 1; // parameters: [w..., b]
      for (let it = 0; it < epochs; it++) {
        const H = Array.from({ length: D }, () => new Array(D).fill(0));
        const g = new Array(D).fill(0);
        for (let i = 0; i < n; i++) {
          const zi = Z[i];
          let z = b; for (let k = 0; k < d; k++) z += w[k] * zi[k];
          const p = sigmoid(z), e = p - y[i], s = Math.max(p * (1 - p), 1e-6);
          for (let a = 0; a < d; a++) {
            g[a] += e * zi[a];
            const sa = s * zi[a];
            for (let c2 = 0; c2 <= a; c2++) H[a][c2] += sa * zi[c2];
            H[d][a] += sa;
          }
          g[d] += e; H[d][d] += s;
        }
        for (let a = 0; a < D; a++) for (let c2 = 0; c2 < a; c2++) H[c2][a] = H[a][c2];
        for (let a = 0; a < d; a++) { g[a] += lam * w[a]; H[a][a] += lam; }
        H[d][d] += 1e-6;
        const step = choleskySolve(H, g);
        if (!step) break;
        let maxStep = 0;
        for (let a = 0; a < d; a++) { w[a] -= step[a]; maxStep = Math.max(maxStep, Math.abs(step[a])); }
        b -= step[d]; maxStep = Math.max(maxStep, Math.abs(step[d]));
        if (maxStep < tol) break;
      }
    }
    this.w = w.map(v => fin(v)); this.b = fin(b);
    return this;
  }

  decision(x) {
    if (!this.w || !x) return 0;
    let z = this.b;
    for (let k = 0; k < this.w.length; k++) z += this.w[k] * clamp((fin(x[k]) - this.mean[k]) / this.std[k], -8, 8);
    return z;
  }
  predictProba(x) { return clipP(sigmoid(this.decision(x))); }
  toJSON() { return { type: "logistic", mean: this.mean, std: this.std, w: this.w, b: this.b, n: this.n }; }
  static fromJSON(o) {
    const m = new LogisticModel();
    if (o) { m.mean = o.mean; m.std = o.std; m.w = o.w; m.b = o.b; m.n = o.n || 0; }
    return m;
  }
}

// ─── gradient-boosted trees (logloss) ────────────────────────────────────────────────────────
function quantileEdges(values, maxBins) {
  const s = Float64Array.from(values).sort();
  const edges = [];
  for (let q = 1; q < maxBins; q++) {
    const v = s[Math.min(s.length - 1, Math.floor((q * s.length) / maxBins))];
    if (!edges.length || v > edges[edges.length - 1]) edges.push(v);
  }
  // the top edge equal to the max would make an empty right bin — drop it
  if (edges.length && edges[edges.length - 1] >= s[s.length - 1]) edges.pop();
  return edges;
}
function binOf(edges, v) { // first b with v <= edges[b], else edges.length
  let lo = 0, hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= edges[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

class GBMClassifier {
  constructor(opts = {}) {
    this.opts = {
      // defaults per docs/RESEARCH.md §5.1: shallow, slow, heavily regularized
      nTrees: 200, depth: 2, lr: 0.05, subsample: 0.7, maxBins: 32, lambda: 1.0,
      minLeaf: 50, valFrac: 0.2, patience: 25, gap: 0, seed: 1337, ...opts,
    };
    this.base = 0; this.trees = []; this.bestIter = 0; this.n = 0;
  }

  /**
   * Newton boosting on logloss. Depth-≤3 trees are grown on quantile-binned features (≤32 bins,
   * histogram split search). Early stopping: the last `valFrac` of the (time-ordered) rows is a
   * validation tail, separated from the fit rows by a purge `gap`; the number of trees that
   * minimized validation logloss is then refit on ALL rows (same seed) so recent data is used.
   */
  fit(X, y, opts = {}) {
    const o = { ...this.opts, ...opts };
    this.opts = o;
    const n = X.length;
    this.n = n; this.trees = [];
    if (!n) { this.base = 0; return this; }
    let nIter = o.nTrees;
    const nVal = Math.floor(n * o.valFrac);
    const nFit = n - nVal - o.gap;
    if (nVal >= 30 && nFit >= 60) {
      const val = this._boost(X, y, 0, nFit, o, o.nTrees, { X, y, from: n - nVal, to: n });
      nIter = Math.max(1, val.bestIter);
    }
    this._boost(X, y, 0, n, o, nIter, null);
    this.bestIter = nIter;
    return this;
  }

  _boost(X, y, from, to, o, nTrees, val) {
    const n = to - from, d = X[0].length;
    // binning on the fit rows only
    const edges = [], bins = [];
    for (let k = 0; k < d; k++) {
      const col = new Float64Array(n);
      for (let i = 0; i < n; i++) col[i] = X[from + i][k];
      edges.push(quantileEdges(col, o.maxBins));
      const bk = new Uint8Array(n);
      for (let i = 0; i < n; i++) bk[i] = binOf(edges[k], col[i]);
      bins.push(bk);
    }
    let ybar = 0; for (let i = 0; i < n; i++) ybar += y[from + i];
    ybar /= n;
    const base = Math.log((ybar * n + 0.5) / ((1 - ybar) * n + 0.5));
    const F = new Float64Array(n).fill(base);
    const g = new Float64Array(n), hs = new Float64Array(n);
    const rnd = mulberry32(o.seed);
    const trees = [];
    let valF = null, best = Infinity, bestIter = 0;
    if (val) valF = new Float64Array(val.to - val.from).fill(base);
    for (let t = 0; t < nTrees; t++) {
      for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = p - y[from + i]; hs[i] = Math.max(p * (1 - p), 1e-6); }
      const rows = [];
      for (let i = 0; i < n; i++) if (rnd() < o.subsample) rows.push(i);
      const tree = this._grow(rows, bins, edges, g, hs, o);
      trees.push(tree);
      for (let i = 0; i < n; i++) F[i] += o.lr * treePredictBinned(tree, bins, i);
      if (val) {
        let ll = 0;
        for (let i = val.from; i < val.to; i++) {
          valF[i - val.from] += o.lr * treePredict(tree, val.X[i]);
          const p = clipP(sigmoid(valF[i - val.from]));
          ll -= val.y[i] ? Math.log(p) : Math.log(1 - p);
        }
        ll /= val.to - val.from;
        if (ll < best - 1e-7) { best = ll; bestIter = t + 1; }
        else if (t + 1 - bestIter >= o.patience) break;
      }
    }
    if (!val) { this.base = base; this.trees = trees; }
    return { bestIter, bestLoss: best };
  }

  _grow(rows, bins, edges, g, hs, o) {
    const d = bins.length;
    const node = (idx, depth) => {
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += hs[i]; }
      const leaf = { v: clamp(-G / (H + o.lambda), -4, 4) };
      if (depth >= o.depth || idx.length < 2 * o.minLeaf) return leaf;
      const parentScore = (G * G) / (H + o.lambda);
      let bestGain = 1e-9, bf = -1, bb = -1;
      const gh = new Float64Array(64 * 2), cnt = new Int32Array(64);
      for (let k = 0; k < d; k++) {
        const nb = edges[k].length + 1;
        if (nb < 2) continue;
        gh.fill(0, 0, nb * 2); cnt.fill(0, 0, nb);
        const bk = bins[k];
        for (const i of idx) { const b = bk[i]; gh[2 * b] += g[i]; gh[2 * b + 1] += hs[i]; cnt[b]++; }
        let GL = 0, HL = 0, nL = 0;
        for (let b = 0; b < nb - 1; b++) {
          GL += gh[2 * b]; HL += gh[2 * b + 1]; nL += cnt[b];
          const nR = idx.length - nL;
          if (nL < o.minLeaf) continue;
          if (nR < o.minLeaf) break;
          const GR = G - GL, HR = H - HL;
          const gain = (GL * GL) / (HL + o.lambda) + (GR * GR) / (HR + o.lambda) - parentScore;
          if (gain > bestGain) { bestGain = gain; bf = k; bb = b; }
        }
      }
      if (bf < 0) return leaf;
      const L = [], R = [];
      const bk = bins[bf];
      for (const i of idx) (bk[i] <= bb ? L : R).push(i);
      return { f: bf, b: bb, thr: edges[bf][bb], l: node(L, depth + 1), r: node(R, depth + 1) };
    };
    return node(rows, 0);
  }

  decision(x) {
    let z = this.base;
    for (const t of this.trees) z += this.opts.lr * treePredict(t, x);
    return z;
  }
  predictProba(x) { return x ? clipP(sigmoid(this.decision(x))) : 0.5; }
  toJSON() {
    const strip = t => (t.f === undefined ? { v: t.v } : { f: t.f, thr: t.thr, l: strip(t.l), r: strip(t.r) });
    return { type: "gbm", opts: this.opts, base: this.base, trees: this.trees.map(strip), bestIter: this.bestIter, n: this.n };
  }
  static fromJSON(o) {
    const m = new GBMClassifier(o && o.opts);
    if (o) { m.base = o.base; m.trees = o.trees || []; m.bestIter = o.bestIter || 0; m.n = o.n || 0; }
    return m;
  }
}
function treePredict(t, x) {
  while (t.f !== undefined) t = fin(x[t.f]) <= t.thr ? t.l : t.r;
  return t.v;
}
function treePredictBinned(t, bins, i) {
  while (t.f !== undefined) t = bins[t.f][i] <= t.b ? t.l : t.r;
  return t.v;
}

// ─── metrics ─────────────────────────────────────────────────────────────────────────────────
/** ROC AUC (Mann–Whitney, ties averaged) of [{p, y}]. 0.5 when one class is missing. */
function auc(preds) {
  const a = (preds || []).filter(q => q && Number.isFinite(q.p) && (q.y === 0 || q.y === 1));
  const nPos = a.reduce((s, q) => s + q.y, 0), nNeg = a.length - nPos;
  if (!nPos || !nNeg) return 0.5;
  const s = a.slice().sort((u, v) => u.p - v.p);
  let rankSum = 0;
  for (let i = 0; i < s.length;) {
    let j = i; while (j + 1 < s.length && s[j + 1].p === s[i].p) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (s[k].y === 1) rankSum += r;
    i = j + 1;
  }
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}
function brier(preds) {
  if (!preds.length) return null;
  return preds.reduce((s, q) => s + (q.p - q.y) ** 2, 0) / preds.length;
}
function accuracy(preds) {
  if (!preds.length) return null;
  return preds.reduce((s, q) => s + ((q.p > 0.5 ? 1 : 0) === q.y ? 1 : 0), 0) / preds.length;
}

// ─── walk-forward training ───────────────────────────────────────────────────────────────────
function labelsFor(candles, ahead) {
  const n = candles.length, ret = new Array(n).fill(null);
  for (let k = 0; k + ahead < n; k++) {
    const a = Number(candles[k].c), b = Number(candles[k + ahead].c);
    if (a > 0 && b > 0) ret[k] = Math.log(b / a);
  }
  return ret;
}

/**
 * Training set from rows k with k + ahead <= endIdx (label fully observed by endIdx). Dead zone:
 * drop |ret| < max(deadZone·σ, minAbsRet) where σ is the std of those training forward returns.
 */
function trainingSet(rows, ret, endIdx, ahead, deadZone, minAbsRet = 0) {
  const ks = [];
  for (let k = WARMUP; k + ahead <= endIdx; k++) if (rows[k] && ret[k] !== null) ks.push(k);
  if (!ks.length) return { X: [], y: [], ks, sigma: 0 };
  let m = 0; for (const k of ks) m += ret[k];
  m /= ks.length;
  let v = 0; for (const k of ks) v += (ret[k] - m) ** 2;
  const sigma = Math.sqrt(v / ks.length);
  const X = [], y = [], kept = [];
  for (const k of ks) {
    if (Math.abs(ret[k]) < Math.max(deadZone * sigma, minAbsRet)) continue;
    X.push(rows[k]); y.push(ret[k] > 0 ? 1 : 0); kept.push(k);
  }
  return { X, y, ks: kept, sigma, nAll: ks.length };
}

function fitModels(set, opts) {
  const logistic = new LogisticModel().fit(set.X, set.y, { l2: opts.l2 });
  const gbm = new GBMClassifier({ seed: opts.seed, gap: opts.ahead, nTrees: opts.nTrees }).fit(set.X, set.y);
  const base = set.y.length ? set.y.reduce((a, b) => a + b, 0) / set.y.length : 0.5;
  return { logistic, gbm, baseRate: base, nTrain: set.y.length };
}

function ensembleModel(m) {
  return {
    logistic: m.logistic, gbm: m.gbm, baseRate: m.baseRate, nTrain: m.nTrain,
    predict(x) {
      if (!x) return { p: 0.5, pLog: 0.5, pGbm: 0.5 };
      const pLog = m.logistic.predictProba(x), pGbm = m.gbm.predictProba(x);
      return { p: clipP((pLog + pGbm) / 2), pLog, pGbm };
    },
    toJSON() { return { logistic: m.logistic.toJSON(), gbm: m.gbm.toJSON(), baseRate: m.baseRate, nTrain: m.nTrain }; },
  };
}

function summarize(preds, key) {
  const ps = preds.map(q => ({ p: q[key], y: q.y }));
  return { auc: auc(ps), brier: brier(ps), accuracy: accuracy(ps) };
}

/** AUC of each of up to 4 consecutive OOS chunks (≥ 30 preds each) → stability = share > 0.5. */
function stabilityOf(preds, key = "p") {
  const k = Math.min(4, Math.floor(preds.length / 30));
  if (k < 2) return { chunkAucs: [], stability: 0 };
  const size = Math.floor(preds.length / k), chunkAucs = [];
  for (let c = 0; c < k; c++) {
    const part = preds.slice(c * size, c === k - 1 ? preds.length : (c + 1) * size);
    chunkAucs.push(auc(part.map(q => ({ p: q[key], y: q.y }))));
  }
  return { chunkAucs, stability: chunkAucs.filter(a => a > 0.5).length / k };
}

/** Median bar spacing (ms) → is this daily-or-slower data? */
function isDailyBars(candles) {
  const d = [];
  for (let i = Math.max(1, candles.length - 200); i < candles.length; i++) d.push(candles[i].t - candles[i - 1].t);
  if (!d.length) return true;
  d.sort((a, b) => a - b);
  return d[d.length >> 1] >= 20 * 3600 * 1000;
}

/**
 * Resolved walk-forward options. Defaults follow docs/RESEARCH.md §5.1:
 *   daily bars:    minTrain 500,  step 20, dead zone 0.15·σ_h
 *   sub-daily:     minTrain 3000, step 96, dead zone max(0.2·σ_h, round-trip cost)
 *   embargo:       max(ahead, ceil(1% of the training span)) bars on top of the `ahead` purge
 *   l2 = 100 on the summed NLL (≈ 0.1–0.2 per sample at n≈500–1000): weaker penalties gave
 *   visibly overconfident OOS probabilities on BTC daily data, while planted AR(1) structure is
 *   still recovered at this strength (see test/ml.test.js).
 */
function resolveOpts(candles, opts = {}) {
  const daily = isDailyBars(candles);
  const ahead = Math.max(1, Math.floor(opts.ahead || 5));
  return {
    ahead,
    minTrain: opts.minTrain || (daily ? 500 : 3000),
    step: opts.step || (daily ? 20 : 96),
    deadZone: opts.deadZone != null ? opts.deadZone : (daily ? 0.15 : 0.2),
    minAbsRet: opts.costBps ? (2 * opts.costBps) / 1e4 : 0, // round trip
    embargo: opts.embargo, // null → max(ahead, 1% of span)
    l2: opts.l2 != null ? opts.l2 : 100,
    seed: opts.seed != null ? opts.seed : 1337,
    nTrees: opts.nTrees || 200,
  };
}
const embargoFor = (o, r) => (o.embargo != null ? o.embargo : Math.max(o.ahead, Math.ceil(0.01 * r)));

/**
 * Expanding-window, purged + embargoed walk-forward. At each retrain bar r the models see only
 * samples k with k + ahead + embargo <= r and predict bars r..r+step−1. Returns the final model
 * (trained with the same purge at the last bar) plus honest out-of-sample metrics.
 */
function trainWalkForward(candles, opts = {}) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const o = n ? resolveOpts(candles, opts) : resolveOpts([], opts);
  const { ahead, minTrain, step, deadZone, minAbsRet, l2, seed, nTrees } = o;
  const empty = {
    model: null, oosPredictions: [], oosAuc: 0.5, oosBrier: null, oosAccuracy: null,
    baseline: { accuracy: null, brier: null }, perModel: null, nOos: 0, nTrain: 0,
    stability: 0, chunkAucs: [], featureNames: FEATURE_NAMES, ahead, lastT: n ? candles[n - 1].t : null,
  };
  if (n < WARMUP + 50 + ahead) return empty;
  const rows = featureMatrix(candles);
  const ret = labelsFor(candles, ahead);
  const mo = { l2, seed, ahead, nTrees };

  // first OOS bar r0: enough labelled samples (pre-dead-zone) with label end <= r0
  let r0 = -1, cnt = 0;
  for (let k = WARMUP; k < n; k++) {
    if (rows[k] && ret[k] !== null) cnt++;
    if (cnt >= minTrain) { r0 = k + ahead + embargoFor(o, k); break; }
  }
  const oos = [];
  let lastModel = null;
  if (r0 > 0) {
    for (let r = r0; r < n; r += step) {
      const set = trainingSet(rows, ret, r - embargoFor(o, r), ahead, deadZone, minAbsRet);
      if (set.y.length < 30) continue;
      const m = fitModels(set, mo);
      lastModel = m;
      const em = ensembleModel(m);
      for (let j = r; j < Math.min(n, r + step); j++) {
        if (!rows[j] || ret[j] === null) continue; // label not yet known → cannot score
        const pr = em.predict(rows[j]);
        oos.push({ t: candles[j].t, i: j, p: pr.p, pLog: pr.pLog, pGbm: pr.pGbm, y: ret[j] > 0 ? 1 : 0, ret: ret[j], base: m.baseRate });
      }
    }
  }
  // final model: all samples whose label ended by the last bar
  const finalSet = trainingSet(rows, ret, n - 1 - embargoFor(o, n - 1), ahead, deadZone, minAbsRet);
  const finalM = finalSet.y.length >= 30 ? fitModels(finalSet, mo) : lastModel;
  if (!finalM) return empty;

  const ens = summarize(oos, "p");
  const baseline = {
    // naive, causal: always predict the majority class of the training data at that time
    accuracy: oos.length ? oos.reduce((s, q) => s + ((q.base > 0.5 ? 1 : 0) === q.y ? 1 : 0), 0) / oos.length : null,
    brier: oos.length ? oos.reduce((s, q) => s + (q.base - q.y) ** 2, 0) / oos.length : null,
  };
  const st = stabilityOf(oos, "p");
  return {
    model: ensembleModel(finalM),
    oosPredictions: oos.map(q => ({ t: q.t, p: q.p, y: q.y, pLog: q.pLog, pGbm: q.pGbm })),
    oosAuc: ens.auc, oosBrier: ens.brier, oosAccuracy: ens.accuracy,
    baseline,
    perModel: { logistic: summarize(oos, "pLog"), gbm: summarize(oos, "pGbm") },
    nOos: oos.length, nTrain: finalM.nTrain, stability: st.stability, chunkAucs: st.chunkAucs,
    featureNames: FEATURE_NAMES, ahead, trainedAt: n - 1, lastT: candles[n - 1].t,
  };
}

// ─── model cache ─────────────────────────────────────────────────────────────────────────────
const CACHE = new Map();
const CACHE_MAX = 200;

/**
 * Cached walk-forward result keyed by `key` (the engine passes "<assetId>|<tfSec>"; options are
 * part of the cache identity too). Same last-candle t → pure cache hit. If the new candles
 * extend the cached history (the cached last t is still present — rolling windows are fine) by
 * fewer than `retrainEvery` (default `step`) bars, the cached models are reused; otherwise, or
 * if the history was replaced, we retrain.
 */
function getModel(key, candles, opts = {}) {
  const n = Array.isArray(candles) ? candles.length : 0;
  if (!n) return null;
  const o = resolveOpts(candles, opts);
  const retrainEvery = opts.retrainEvery || o.step;
  const sig = JSON.stringify(o);
  const lastT = candles[n - 1].t;
  const e = CACHE.get(key);
  if (e && e.sig === sig) {
    let idx = -1;
    for (let i = n - 1; i >= 0 && i >= n - 1 - retrainEvery; i--) if (candles[i].t === e.result.lastT) { idx = i; break; }
    if (idx >= 0 && n - 1 - idx < retrainEvery) {
      CACHE.delete(key); CACHE.set(key, e); // LRU touch
      return e.result;
    }
  }
  const result = trainWalkForward(candles, opts);
  CACHE.set(key, { sig, result });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return result;
}
function clearCache() { CACHE.clear(); }

// ─── signals ─────────────────────────────────────────────────────────────────────────────────
const MIN_OOS = 60;

/**
 * Hanley–McNeil standard error of an AUC, inflated by sqrt(ahead) because consecutive
 * `ahead`-bar labels overlap (effective sample size ≈ n / ahead).
 */
function aucStdErr(aucV, nPos, nNeg, ahead = 1) {
  if (!(nPos > 0 && nNeg > 0)) return 0.5;
  const A = clamp(aucV, 1e-6, 1 - 1e-6), q1 = A / (2 - A), q2 = (2 * A * A) / (1 + A);
  const v = (A * (1 - A) + (nPos - 1) * (q1 - A * A) + (nNeg - 1) * (q2 - A * A)) / (nPos * nNeg);
  return Math.sqrt(Math.max(v, 1e-12) * Math.max(1, ahead));
}

const AUC_Z = 1.64; // one-sided 95% lower confidence bound

/** Lower confidence bound of the OOS AUC with overlap-aware (n_eff = n/ahead) Hanley–McNeil SE. */
function aucLowerBound(aucV, preds, ahead = 1) {
  const nPos = preds.reduce((s, q) => s + q.y, 0);
  return aucV - AUC_Z * aucStdErr(aucV, nPos, preds.length - nPos, ahead);
}

/**
 * confidence = clamp((AUC_lcb − 0.50) / 0.06, 0, 1) × stability      (docs/RESEARCH.md §5.1)
 *   AUC_lcb   = OOS AUC − 1.64·SE(n_eff), so small or overlapping OOS samples earn ≈ 0 —
 *               in particular an AUC ≤ 0.52 always gives 0 at any realistic sample size;
 *   stability = share of consecutive OOS chunks whose own AUC > 0.5 (regime robustness);
 * and exactly 0 when fewer than MIN_OOS out-of-sample bars exist.
 */
function confidenceFrom(aucV, chunkShare, preds, ahead = 1) {
  if (!(preds.length >= MIN_OOS)) return 0;
  const lcb = aucLowerBound(aucV, preds, ahead);
  return fin(clamp((lcb - 0.5) / 0.06, 0, 1) * chunkShare, 0);
}

/**
 * ML signals: `ml.ensemble.pup` (primary) plus `ml.logistic.pup` / `ml.gbm.pup` (audit; their
 * confidence is halved so the correlated trio does not triple-count in the ensemble).
 * score = 2·(p − b), b = the model's training base rate (share of up-labels after the dead zone);
 * value.p keeps the raw P(up). AUDIT (2026-09): the score used to be 2p − 1, so a model with no
 * skill (p ≈ b ≈ 0.57 on large-cap stocks) still cast a constant bullish vote — drift the class
 * calibrator already prices in, i.e. counted twice. Every other family scores a view RELATIVE to
 * "nothing special"; for a probability model that reference is its base rate.
 * confidence = clamp((AUC_lcb − 0.50)/0.06, 0, 1) × stability (see confidenceFrom). The reason
 * always states the OOS AUC and whether it beats chance. Inference features use
 * projectFormingVolume (a still-forming last bar's volume is pro-rated to a full bar).
 * opts: { ahead=5, key (cache id, e.g. "<assetId>|<tfSec>"), horizon, minTrain, step, costBps,
 *         noCache } — minTrain/step/dead-zone defaults depend on bar spacing (see resolveOpts).
 */
function signals(candles, opts = {}) {
  const ahead = opts.ahead || 5;
  if (!Array.isArray(candles) || candles.length < WARMUP + 50 + ahead) return [];
  const key = opts.key || `${opts.symbol || "anon"}|${opts.tf || "?"}`;
  let res;
  try { res = opts.noCache ? trainWalkForward(candles, opts) : getModel(key, candles, { ...opts, ahead }); }
  catch (_) { return []; }
  if (!res || !res.model) return [];
  const x = buildFeaturesFast(projectFormingVolume(candles, { now: Number.isFinite(opts.now) ? opts.now : Date.now() }));
  if (!x) return [];
  const pr = res.model.predict(x);
  const base = Number.isFinite(res.model.baseRate) ? clamp(res.model.baseRate, 0.05, 0.95) : 0.5;
  const horizon = opts.horizon || "any";
  const enough = res.nOos >= MIN_OOS;
  const pm = res.perModel || { logistic: { auc: 0.5 }, gbm: { auc: 0.5 } };
  const P = res.oosPredictions;
  const stLog = stabilityOf(res.oosPredictions, "pLog").stability;
  const stGbm = stabilityOf(res.oosPredictions, "pGbm").stability;
  const mk = (id, p, aucV, conf, label) => {
    const score = clamp(2 * (p - base), -1, 1);
    const lcb = aucLowerBound(aucV, P, ahead);
    const verdict = !enough
      ? `not enough out-of-sample history (${res.nOos} OOS bars < ${MIN_OOS}) — no confidence`
      : lcb <= 0.5
        ? `walk-forward OOS AUC ${aucV.toFixed(3)} over ${res.nOos} bars (95% lower bound ${lcb.toFixed(3)}) is not distinguishable from chance — ignore`
        : `walk-forward OOS AUC ${aucV.toFixed(3)} over ${res.nOos} bars (95% lower bound ${lcb.toFixed(3)} > 0.5)`;
    return {
      id, family: "ml", score: fin(score), confidence: clamp(fin(conf), 0, 1), horizon,
      value: { p: +p.toFixed(4), baseRate: +base.toFixed(4), oosAuc: +fin(aucV, 0.5).toFixed(4), aucLcb: +fin(lcb, 0).toFixed(4), n: res.nOos, nTrain: res.nTrain, ahead },
      reason: `${label} P(up ${ahead} bars) = ${(p * 100).toFixed(1)}% vs ${(base * 100).toFixed(1)}% base rate; ${verdict}`,
    };
  };
  const cEns = confidenceFrom(res.oosAuc, res.stability, P, ahead);
  return [
    mk("ml.ensemble.pup", pr.p, res.oosAuc, cEns, "Logistic+GBM ensemble"),
    mk("ml.logistic.pup", pr.pLog, pm.logistic.auc, 0.5 * confidenceFrom(pm.logistic.auc, stLog, P, ahead), "Logistic"),
    mk("ml.gbm.pup", pr.pGbm, pm.gbm.auc, 0.5 * confidenceFrom(pm.gbm.auc, stGbm, P, ahead), "GBM"),
  ];
}

// Latest-bar features: only a trailing window is needed for everything except EMA200/ADX
// recursions, which have (effectively) forgotten their seed after ~600 bars, so we pass the
// whole array when it is short and the last 1000 bars otherwise (cheap, still causal).
function buildFeaturesFast(candles) {
  const w = candles.length > 1000 ? candles.slice(candles.length - 1000) : candles;
  return buildFeatures(w, w.length - 1);
}

module.exports = {
  FEATURE_NAMES, WARMUP, buildFeatures, featureMatrix,
  LogisticModel, GBMClassifier, trainWalkForward, signals, getModel, clearCache,
  auc, aucStdErr, aucLowerBound, confidenceFrom, resolveOpts, brier, accuracy, mulberry32,
};
