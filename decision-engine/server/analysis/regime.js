// Market-regime detection → regime object + Signal[] (family "regime").
//
//  detect(candles)          trend (up/down/range), vol bucket (low/normal/high/extreme), Hurst,
//                           efficiency ratio, ADX, volatility percentile and a Gaussian HMM state.
//  signals(regime)          regime-level directional signals for the ensemble.
//  fitHMM(returns, k=3)     Gaussian HMM via Baum-Welch (scaled forward-backward).
//  hmmFilter(model, rets)   forward filter → state probabilities for the latest bar.
//
// The ensemble also uses the regime object to condition family weights (trend-followers weigh more
// when trending, mean-reversion when ranging, everyone less in "extreme" vol).

const I = require("./indicators");

const { isNum } = I;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sat = (v) => clamp(v, 0, 1);
const r4 = (v) => (isNum(v) ? Math.round(v * 10000) / 10000 : null);
const LOG_2PI = Math.log(2 * Math.PI);

// ---------------------------------------------------------------------------------------------
// Gaussian HMM
// ---------------------------------------------------------------------------------------------

// Log-density matrix → per-t scaled emission probabilities b[t][k] = exp(logpdf − max_k logpdf)
// plus the per-t offsets (so the true likelihood can be reconstructed without underflow).
function emissions(x, means, vars) {
  const T = x.length, K = means.length;
  const b = new Array(T), off = new Float64Array(T);
  const lv = vars.map((v) => Math.log(v));
  for (let t = 0; t < T; t++) {
    const row = new Float64Array(K);
    let mx = -Infinity;
    for (let k = 0; k < K; k++) {
      const d = x[t] - means[k];
      row[k] = -0.5 * (LOG_2PI + lv[k] + (d * d) / vars[k]);
      if (row[k] > mx) mx = row[k];
    }
    for (let k = 0; k < K; k++) row[k] = Math.exp(row[k] - mx);
    b[t] = row; off[t] = mx;
  }
  return { b, off };
}

// Scaled forward pass. alpha[t] is the FILTERED distribution P(s_t | x_1..t). Returns log-lik.
function forward(x, model, b, off) {
  const T = x.length, K = model.k, A = model.A;
  const alpha = new Array(T), c = new Float64Array(T);
  let ll = 0;
  for (let t = 0; t < T; t++) {
    const a = new Float64Array(K);
    let s = 0;
    for (let j = 0; j < K; j++) {
      let p;
      if (t === 0) p = model.pi[j];
      else { p = 0; const prev = alpha[t - 1]; for (let i = 0; i < K; i++) p += prev[i] * A[i][j]; }
      a[j] = p * b[t][j];
      s += a[j];
    }
    if (!(s > 0)) { for (let j = 0; j < K; j++) a[j] = 1 / K; s = 1e-300; }
    else for (let j = 0; j < K; j++) a[j] /= s;
    alpha[t] = a; c[t] = s;
    ll += Math.log(s) + off[t];
  }
  return { alpha, c, ll };
}

function sortModel(m) {
  const order = m.means.map((mu, i) => i).sort((a, b) => m.means[a] - m.means[b]);
  const perm = (arr) => order.map((i) => arr[i]);
  m.means = perm(m.means); m.vars = perm(m.vars); m.pi = perm(m.pi);
  m.A = order.map((i) => order.map((j) => m.A[i][j]));
  m.vols = m.vars.map((v) => Math.sqrt(v));
  return m;
}

/**
 * fitHMM(returns, k=3) -> model | null
 * Gaussian-emission HMM by Baum-Welch EM.
 *  * deterministic init: sort returns, split into k equal-count quantile buckets → bucket mean/var;
 *    sticky transition matrix (0.9 on the diagonal); uniform π.
 *  * scaled forward-backward (Rabiner) with log-sum-of-scales likelihood; emission densities are
 *    normalised per t so extreme outliers can't underflow.
 *  * variance floor = 1% of the sample variance (prevents a state collapsing on a few points),
 *    tiny Dirichlet pseudo-counts on A and π so no transition becomes impossible.
 *  * stops after `maxIter` (50) or when the log-likelihood improves by < tol·(1+|LL|).
 *  * states are finally sorted by mean: 0 = most bearish … k−1 = most bullish.
 * Returns { k, means, vars, vols, pi, A, logLik, iters, converged, n } (per-bar units).
 */
function fitHMM(returnsIn, k = 3, { maxIter = 50, tol = 1e-5 } = {}) {
  const x = (returnsIn || []).filter(isNum);
  const T = x.length;
  k = Math.max(1, Math.min(6, Math.floor(k) || 3));
  if (T < Math.max(30, 10 * k)) return null;
  const mean = x.reduce((a, b) => a + b, 0) / T;
  const varAll = x.reduce((a, b) => a + (b - mean) ** 2, 0) / T;
  if (!(varAll > 1e-18)) return null;                     // (numerically) constant series
  const floor = varAll * 0.01;

  // --- deterministic quantile initialisation -----------------------------------------------
  const sorted = [...x].sort((a, b) => a - b);
  const means = [], vars = [];
  for (let j = 0; j < k; j++) {
    const lo = Math.floor((j * T) / k), hi = Math.floor(((j + 1) * T) / k);
    const seg = sorted.slice(lo, Math.max(hi, lo + 1));
    const m = seg.reduce((a, b) => a + b, 0) / seg.length;
    // Within-bucket variance understates the state's spread; blend with the global variance.
    const v = seg.reduce((a, b) => a + (b - m) ** 2, 0) / seg.length;
    means.push(m); vars.push(Math.max(floor, 0.5 * v + 0.5 * varAll));
  }
  const A = [];
  for (let i = 0; i < k; i++) A.push(Array.from({ length: k }, (_, j) => (k === 1 ? 1 : i === j ? 0.9 : 0.1 / (k - 1))));
  let model = { k, means, vars, pi: new Array(k).fill(1 / k), A };

  let prevLL = -Infinity, ll = -Infinity, iters = 0, converged = false;
  for (iters = 1; iters <= maxIter; iters++) {
    const { b, off } = emissions(x, model.means, model.vars);
    const f = forward(x, model, b, off);
    ll = f.ll;
    // Backward (scaled with the same c[t]).
    const beta = new Array(T);
    beta[T - 1] = new Float64Array(k).fill(1);
    for (let t = T - 2; t >= 0; t--) {
      const bt = new Float64Array(k), nb = beta[t + 1], em = b[t + 1];
      for (let i = 0; i < k; i++) {
        let s = 0;
        for (let j = 0; j < k; j++) s += model.A[i][j] * em[j] * nb[j];
        bt[i] = s / f.c[t + 1];
      }
      beta[t] = bt;
    }
    // E-step accumulators.
    const gSum = new Float64Array(k), gx = new Float64Array(k), gxx = new Float64Array(k);
    const xiSum = Array.from({ length: k }, () => new Float64Array(k));
    const g0 = new Float64Array(k);
    for (let t = 0; t < T; t++) {
      let s = 0;
      const g = new Float64Array(k);
      for (let i = 0; i < k; i++) { g[i] = f.alpha[t][i] * beta[t][i]; s += g[i]; }
      for (let i = 0; i < k; i++) {
        const gi = s > 0 ? g[i] / s : 1 / k;
        gSum[i] += gi; gx[i] += gi * x[t];
        if (t === 0) g0[i] = gi;
      }
      if (t < T - 1) {
        const em = b[t + 1], nb = beta[t + 1], ct = f.c[t + 1];
        for (let i = 0; i < k; i++) {
          const ai = f.alpha[t][i];
          for (let j = 0; j < k; j++) xiSum[i][j] += (ai * model.A[i][j] * em[j] * nb[j]) / ct;
        }
      }
    }
    // M-step.
    const nm = [], nv = [];
    for (let i = 0; i < k; i++) {
      const m = gSum[i] > 1e-12 ? gx[i] / gSum[i] : model.means[i];
      nm.push(m);
    }
    for (let t = 0; t < T; t++) {
      // second pass for variance around the NEW means (numerically safer than E[x²]−m²)
      let s = 0;
      const g = new Float64Array(k);
      for (let i = 0; i < k; i++) { g[i] = f.alpha[t][i] * beta[t][i]; s += g[i]; }
      for (let i = 0; i < k; i++) { const gi = s > 0 ? g[i] / s : 1 / k; gxx[i] += gi * (x[t] - nm[i]) ** 2; }
    }
    for (let i = 0; i < k; i++) nv.push(gSum[i] > 1e-12 ? Math.max(floor, gxx[i] / gSum[i]) : model.vars[i]);
    const nA = [];
    for (let i = 0; i < k; i++) {
      const row = xiSum[i].map((v) => v + 1e-3);
      const s = row.reduce((a, b) => a + b, 0);
      nA.push(row.map((v) => v / s));
    }
    const piRaw = Array.from(g0, (v) => v + 1e-3), ps = piRaw.reduce((a, b) => a + b, 0);
    model = { k, means: nm, vars: nv, pi: piRaw.map((v) => v / ps), A: nA };
    if (!isNum(ll)) break;
    if (Math.abs(ll - prevLL) < tol * (1 + Math.abs(ll))) { converged = true; break; }
    prevLL = ll;
  }
  // Final likelihood under the returned parameters.
  const { b, off } = emissions(x, model.means, model.vars);
  ll = forward(x, model, b, off).ll;
  sortModel(model);
  if (![...model.means, ...model.vars, ll].every(isNum)) return null;
  return { ...model, logLik: ll, iters: Math.min(iters, maxIter), converged, n: T };
}

/**
 * hmmFilter(model, returns) -> { probs, state, logLik, expectedMean, expectedVol, persistence } | null
 * Forward-filters `returns` and reports P(state | returns up to the latest bar).
 */
function hmmFilter(model, returnsIn) {
  if (!model || !Array.isArray(model.means)) return null;
  const x = (returnsIn || []).filter(isNum);
  if (!x.length) return null;
  const { b, off } = emissions(x, model.means, model.vars);
  const f = forward(x, model, b, off);
  const probs = Array.from(f.alpha[x.length - 1]);
  if (!probs.every(isNum)) return null;
  let state = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[state]) state = i;
  // One-step-ahead predictive moments: next-state distribution = probs·A.
  const next = model.means.map((_, j) => probs.reduce((s, p, i) => s + p * model.A[i][j], 0));
  const mu = next.reduce((s, p, j) => s + p * model.means[j], 0);
  const m2 = next.reduce((s, p, j) => s + p * (model.vars[j] + model.means[j] ** 2), 0);
  return {
    probs, state, logLik: f.ll, next,
    expectedMean: mu, expectedVol: Math.sqrt(Math.max(m2 - mu * mu, 0)),
    persistence: model.A[state][state],
  };
}

// ---------------------------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------------------------

const HMM_CACHE = new Map();   // fit is deterministic → memoise per (length, first t, last t, last c)

function neutral() {
  return {
    trend: "range", vol: "normal", hurst: null, efficiency: null, adx: null, volPercentile: null,
    hmm: null, label: "ranging/normal-vol", direction: 0, trendStrength: 0, annVol: null,
  };
}

/**
 * detect(candles) -> { trend, vol, hurst, efficiency, adx, volPercentile, hmm, label,
 *                      direction, trendStrength, annVol }
 *  trend  : "up"/"down" when trendStrength (ADX + efficiency ratio) ≥ 0.35 AND ≥ 2/3 of the
 *           direction votes (price vs EMA50, EMA20 vs EMA50, 50-bar regression slope) agree.
 *  vol    : percentile of 20-bar realized vol within the last ≤252 bars:
 *           <25% low, <75% normal, <95% high, else extreme (also extreme if > 2.5× its median).
 *  hmm    : 3-state (2 if < 250 returns) Gaussian HMM on the last ≤500 log returns; needs ≥ 100.
 *  Extra (non-contract) fields: direction ∈ [−1,1], trendStrength ∈ [0,1], annVol (if daily bars).
 */
function detect(candlesIn) {
  if (!Array.isArray(candlesIn)) return neutral();
  const candles = candlesIn.filter((c) => c && [c.h, c.l, c.c].every(isNum) && c.c > 0);
  const N = candles.length;
  if (N < 30) return neutral();
  const close = candles.map((c) => c.c);
  const c0 = close[N - 1];

  const adxV = I.last(I.adx(candles, 14).adx);
  const er = I.last(I.efficiencyRatio(close, 20));
  const H = N >= 64 ? I.hurst(close.slice(-Math.min(N, 512))) : null;
  const trendStrength = sat(0.5 * sat(((adxV ?? 15) - 18) / 14) + 0.5 * sat(((er ?? 0.2) - 0.2) / 0.3));

  const e20 = I.last(I.ema(close, 20)), e50 = I.last(I.ema(close, Math.min(50, N - 1)));
  const slope = I.last(I.linregSlope(close, Math.min(50, N)));
  const votes = [Math.sign(c0 - (e50 ?? c0)), Math.sign((e20 ?? c0) - (e50 ?? c0)), Math.sign(slope ?? 0)];
  const direction = votes.reduce((a, b) => a + b, 0) / votes.length;
  const trend = trendStrength >= 0.35 && direction >= 2 / 3 ? "up"
    : trendStrength >= 0.35 && direction <= -2 / 3 ? "down" : "range";

  const rv = I.realizedVol(close, 20);
  const win = Math.min(252, rv.filter(isNum).length);
  let volPercentile = null, vol = "normal";
  const rvNow = I.last(rv);
  if (win >= 20 && isNum(rvNow)) {
    volPercentile = I.last(I.percentileRank(rv.slice(-win), win));
    const hist = rv.slice(-win).filter(isNum).sort((a, b) => a - b);
    const med = hist[Math.floor(hist.length / 2)];
    vol = volPercentile < 0.25 ? "low" : volPercentile < 0.75 ? "normal" : volPercentile < 0.95 ? "high" : "extreme";
    if (med > 0 && rvNow > 2.5 * med) vol = "extreme";
  }
  // Annualise only if bars are ~daily (crypto 365, stocks ~252 — use the bar spacing to decide).
  let annVol = null;
  if (isNum(rvNow)) {
    const dt = (candles[N - 1].t - candles[Math.max(0, N - 21)].t) / Math.min(20, N - 1);
    const perYear = dt > 0 ? (365.25 * 86400000) / dt : 252;
    annVol = rvNow * Math.sqrt(Math.min(perYear, 365.25 * 24 * 60));
  }

  // HMM on the last ≤ 500 log returns.
  let hmm = null;
  const rets = I.logReturns(close).filter(isNum).slice(-500);
  if (rets.length >= 100) {
    const k = rets.length >= 250 ? 3 : 2;
    const key = `${rets.length}|${candles[N - rets.length - 1]?.t}|${candles[N - 1].t}|${c0}|${k}`;
    let model = HMM_CACHE.get(key);
    if (!model) {
      model = fitHMM(rets, k);
      if (HMM_CACHE.size > 128) HMM_CACHE.delete(HMM_CACHE.keys().next().value);
      HMM_CACHE.set(key, model);
    }
    const f = model ? hmmFilter(model, rets) : null;
    if (f) {
      hmm = {
        state: f.state, probs: f.probs.map(r4), means: model.means.map((v) => r4(v * 1e4) / 1e4),
        vols: model.vols.map(r4), k: model.k, persistence: r4(f.persistence),
        expectedMean: f.expectedMean, expectedVol: f.expectedVol, converged: model.converged, n: model.n,
      };
    }
  }

  const tl = trend === "up" ? "trending-up" : trend === "down" ? "trending-down" : "ranging";
  return {
    trend, vol, hurst: H, efficiency: er, adx: adxV, volPercentile, hmm,
    label: `${tl}/${vol}-vol`, direction, trendStrength, annVol,
  };
}

// ---------------------------------------------------------------------------------------------
// signals()
// ---------------------------------------------------------------------------------------------

function mk(id, score, confidence, value, reason) {
  return {
    id, family: "regime", score: r4(clamp(isNum(score) ? score : 0, -1, 1)),
    confidence: r4(clamp(isNum(confidence) ? confidence : 0, 0, 1)), horizon: "any", value, reason,
  };
}

/**
 * signals(regime) -> Signal[]
 *  regime.trend.state        direction × trend strength (trend regimes persist). CONTEXT ONLY
 *                            (confidence 0): AUDIT (2026-09) — it is built from the same ADX,
 *                            efficiency ratio, EMA20/EMA50 and 50-bar regression slope as the
 *                            technical trend subfamily, and its score correlated 0.75–0.92 with the
 *                            technical trend view on BTC/ETH/SPY/AAPL/MSFT daily history, so pooling
 *                            it re-counted the trend evidence a second time (a third, counting the
 *                            ensemble's trend ×1.3 regime multiplier). The regime still conditions the
 *                            ensemble through regime.trend / regime.vol; the score is kept for the UI.
 *  regime.hmm.state          HMM one-step-ahead expected return / vol, confidence = state
 *                            certainty × persistence.
 *  regime.vol.level          leverage effect: extreme/high vol regimes skew returns negative,
 *                            calm regimes mildly positive. Low confidence.
 *  regime.hurst.persistence  H > 0.5 → the recent drift tends to continue; H < 0.5 → it tends to
 *                            reverse.
 */
function signals(regime) {
  if (!regime || typeof regime !== "object") return [];
  const out = [];
  const dir = isNum(regime.direction) ? regime.direction : regime.trend === "up" ? 1 : regime.trend === "down" ? -1 : 0;
  const ts = isNum(regime.trendStrength) ? regime.trendStrength : 0;
  {
    const score = regime.trend === "range" ? dir * ts * 0.3 : dir * (0.3 + 0.5 * ts);
    const conf = 0;   // context only — see the header (duplicate of the technical trend evidence)
    out.push(mk("regime.trend.state", score, conf,
      { trend: regime.trend, trendStrength: r4(ts), adx: r4(regime.adx), efficiency: r4(regime.efficiency) },
      `Regime ${regime.label}: ${regime.trend === "range" ? "no persistent trend" : `${regime.trend}trend`} (ADX ${isNum(regime.adx) ? regime.adx.toFixed(0) : "n/a"}, efficiency ${isNum(regime.efficiency) ? regime.efficiency.toFixed(2) : "n/a"}) — context only, the trend evidence itself is counted in the technical family`));
  }
  const h = regime.hmm;
  if (h && Array.isArray(h.probs) && h.probs.length) {
    const mu = isNum(h.expectedMean) ? h.expectedMean : h.probs.reduce((s, p, i) => s + p * h.means[i], 0);
    const sd = isNum(h.expectedVol) && h.expectedVol > 0 ? h.expectedVol
      : Math.sqrt(h.probs.reduce((s, p, i) => s + p * h.vols[i] ** 2, 0)) || 1;
    const sharpe = mu / sd;                               // per-bar Sharpe of the predicted state mix
    const score = Math.tanh(6 * sharpe);
    const pmax = Math.max(...h.probs);
    const persist = isNum(h.persistence) ? h.persistence : 0.9;
    // Confidence = state certainty & persistence, scaled by how statistically distinguishable the
    // predicted drift is from zero (t ≈ Sharpe·√n): regime means are noisy estimates.
    const certainty = clamp((pmax - 1 / h.probs.length) / (1 - 1 / h.probs.length), 0, 1);
    const tStat = Math.abs(sharpe) * Math.sqrt(isNum(h.n) ? h.n : 250);
    const conf = (0.35 * certainty + 0.25 * sat((persist - 0.5) / 0.5) + 0.1) * sat(tStat / 2.5);
    const names = h.probs.length === 3 ? ["bear", "neutral", "bull"] : ["bear", "bull"];
    out.push(mk("regime.hmm.state", score, conf,
      { state: h.state, probs: h.probs, means: h.means, vols: h.vols, persistence: persist },
      `HMM in ${names[h.state] || `state ${h.state}`} state (${(pmax * 100).toFixed(0)}% prob, mean ${(h.means[h.state] * 100).toFixed(2)}%/bar, vol ${(h.vols[h.state] * 100).toFixed(2)}%/bar, stay-prob ${(persist * 100).toFixed(0)}%); next-bar expected drift ${(mu * 100).toFixed(2)}% (t ≈ ${tStat.toFixed(1)})`));
  }
  {
    const v = regime.vol;
    const score = v === "extreme" ? -0.3 : v === "high" ? -0.12 : v === "low" ? 0.1 : 0;
    const conf = v === "extreme" ? 0.3 : v === "normal" ? 0.05 : 0.18;
    out.push(mk("regime.vol.level", score, conf,
      { vol: v, volPercentile: r4(regime.volPercentile), annVol: r4(regime.annVol) },
      `Volatility ${v}${isNum(regime.volPercentile) ? ` (${(regime.volPercentile * 100).toFixed(0)}th percentile of the past year)` : ""}${isNum(regime.annVol) ? `, ~${(regime.annVol * 100).toFixed(0)}% annualised` : ""}`));
  }
  if (isNum(regime.hurst)) {
    const H = regime.hurst;
    const k = clamp((H - 0.5) * 5, -1, 1);          // +1 at H=0.7, −1 at H=0.3
    const score = k * dir * 0.5;
    const conf = 0.1 + 0.25 * Math.abs(k) * Math.abs(dir);
    out.push(mk("regime.hurst.persistence", score, conf, { hurst: r4(H), direction: r4(dir) },
      `Hurst ${H.toFixed(2)} — ${H > 0.55 ? "persistent (trends extend)" : H < 0.45 ? "anti-persistent (moves mean-revert)" : "close to a random walk"}${Math.abs(dir) > 0.3 ? `, recent drift ${dir > 0 ? "up" : "down"}` : ""}`));
  }
  return out;
}

module.exports = { detect, signals, fitHMM, hmmFilter };
