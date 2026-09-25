// Risk math: bracket expectation, position sizing and portfolio/return statistics.
// Pure, deterministic, dependency-free — every function guards against NaN/short inputs.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ATR_TO_SIGMA = 1.5;   // ATR ≈ 1.5 × per-bar σ
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

// ---------- normal distribution helpers ----------
// Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// Inverse normal CDF (Acklam's rational approximation, rel. err ~1e-9).
function normInv(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- basic stats ----------
const cleanArr = (x) => (Array.isArray(x) ? x.map(Number).filter(Number.isFinite) : []);
const mean = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0);
function sd(x) {
  if (x.length < 2) return 0;
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}
// Linear-interpolated quantile of an array (q in [0,1]).
function quantile(x, q) {
  const a = cleanArr(x).sort((u, v) => u - v);
  if (!a.length) return 0;
  const pos = clamp(q, 0, 1) * (a.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// ---------- bracket (ATR stop/target + time exit) expectation ----------
// Model: log-price is Brownian with per-bar vol σ ≈ atrPct/1.5 (ATR ≈ 1.4–1.6σ_bar, RESEARCH §3.5)
// and drift μ chosen so that P(return over H bars > 0) = pWin, i.e. μ = Φ⁻¹(pWin)·σ/√H.
// By optional stopping (X_t − μt is a martingale), E[return at exit] = μ·E[τ], where
// τ = min(H, first touch of −S or +T). E[τ] is approximated by the harmonic blend of the time
// cap H and the driftless two-barrier exit time S·T/σ²:  E[τ] ≈ 1 / (1/H + σ²/(S·T)).
// This is exactly 0 for pWin = 0.5 regardless of bracket asymmetry (no free lunch from a 3:2
// bracket), which a naive p·T − (1−p)·S does NOT satisfy.
// pEff is the win probability of the equivalent two-outcome bet (+T / −S) with the same mean.
function bracketExpectation({ pWin, atrPct, stopAtr = 2, targetAtr = 3, horizonBars = 5, costFrac = 0 } = {}) {
  const p = clamp(fin(pWin, 0.5), 0.001, 0.999);
  const a = fin(atrPct, 0);
  const H = Math.max(1, fin(horizonBars, 5));
  const c = Math.max(0, fin(costFrac, 0));
  if (!(a > 0)) return { eGross: 0, eNet: -c, pEff: 0.5, expectedBars: 0, winFrac: 0, lossFrac: 0, costFrac: c };
  const sigma = a / ATR_TO_SIGMA;
  const S = Math.max(1e-9, fin(stopAtr, 2) * a), T = Math.max(1e-9, fin(targetAtr, 3) * a);
  const mu = normInv(p) * sigma / Math.sqrt(H);
  const expectedBars = 1 / (1 / H + (sigma * sigma) / (S * T));
  const eGross = mu * expectedBars;
  const pEff = clamp((eGross + S) / (S + T), 0, 1);
  return { eGross, eNet: eGross - c, pEff, expectedBars, winFrac: T - c, lossFrac: S + c, costFrac: c };
}

// ---------- position sizing ----------
// sizeFrac = min(fractional Kelly for the ATR bracket, TARGET_VOL/annVol, MAX_POS_FRAC[class])
//            × correlation haircut (1 − 0.5·max(0,ρ)), then limited by remaining gross capacity.
// `pUp` is the probability the trade's OWN direction is right (callers pass 1−P(up) for shorts).
// Kelly for a two-outcome bet: win W = T − costs, lose L = S + costs, win prob pEff:
//   f* = (pEff·W − (1−pEff)·L) / (W·L) = eNet / (W·L);
//   kellyFrac = KELLY_K · reliability · max(0, f*)   (reliability ∈ [0,1] from the calibrator —
//   Kelly shrinks further when p itself is uncertain; Baker & McHale 2013).
// MAX_POS_FRAC is per class: cfg.MAX_POS_FRAC (stocks, 0.10) / cfg.MAX_POS_FRAC_CRYPTO (0.05).
function positionSize({ pUp, riskReward, atrPct, annVol, equity, cfg = {}, openPositions = [], correlation,
  stopAtr, horizonBars = 5, costFrac = 0, periodsPerYear = 365, drawdown = 0, reliability = 1, assetClass } = {}) {
  const K = fin(cfg.KELLY_K, 0.25) * clamp(fin(reliability, 1), 0, 1);
  const maxPos = assetClass === "crypto" ? fin(cfg.MAX_POS_FRAC_CRYPTO, 0.05) : fin(cfg.MAX_POS_FRAC, 0.10);
  const maxGross = fin(cfg.MAX_GROSS, 1.0);
  const targetVol = fin(cfg.TARGET_VOL, 0.15), maxDD = fin(cfg.MAX_DRAWDOWN, 0.15);
  const sAtr = fin(stopAtr, fin(cfg.STOP_ATR, 2));
  const rr = fin(riskReward, fin(cfg.TARGET_ATR, 3) / sAtr);
  const eq = Math.max(0, fin(equity, fin(cfg.PAPER_BALANCE, 0)));
  const capped = [];
  const out = (sizeFrac, kellyFrac, volTargetFrac, extra = {}) => ({
    sizeFrac: clamp(fin(sizeFrac), 0, 1), sizeUsd: clamp(fin(sizeFrac), 0, 1) * eq,
    kellyFrac: fin(kellyFrac), volTargetFrac: fin(volTargetFrac), capped, ...extra,
  });

  const a = fin(atrPct, 0);
  if (!(a > 0)) { capped.push("no_atr"); return out(0, 0, 0); }
  const br = bracketExpectation({ pWin: pUp, atrPct: a, stopAtr: sAtr, targetAtr: rr * sAtr, horizonBars, costFrac });
  const kellyRaw = br.eNet > 0 ? br.eNet / (br.winFrac * br.lossFrac) : 0;
  const kellyFrac = Math.max(0, K * kellyRaw);
  // annualized vol fallback from ATR (σ_bar ≈ atrPct/1.5).
  const av = fin(annVol, 0) > 0 ? annVol : (a / ATR_TO_SIGMA) * Math.sqrt(Math.max(1, periodsPerYear));
  const volTargetFrac = av > 0 ? targetVol / av : maxPos;

  if (fin(drawdown) >= maxDD) { capped.push("drawdown_halt"); return out(0, kellyFrac, volTargetFrac, { expectation: br }); }
  if (!(br.eNet > 0)) { capped.push("no_edge"); return out(0, 0, volTargetFrac, { expectation: br }); }

  let size = kellyFrac, binding = "kelly";
  if (volTargetFrac < size) { size = volTargetFrac; binding = "vol_target"; }
  if (maxPos < size) { size = maxPos; binding = "max_pos"; }
  capped.push(binding);

  const opens = Array.isArray(openPositions) ? openPositions : [];
  let rho = Number.isFinite(correlation) ? correlation : null;
  if (rho == null) for (const p of opens) if (p && Number.isFinite(p.correlation)) rho = Math.max(rho ?? -1, p.correlation);
  if (rho != null && rho > 0) { size *= 1 - 0.5 * clamp(rho, 0, 1); capped.push("correlation"); }

  const used = opens.reduce((s, p) => {
    if (typeof p === "number") return s + Math.abs(fin(p));
    if (!p) return s;
    if (Number.isFinite(p.sizeFrac)) return s + Math.abs(p.sizeFrac);
    if (Number.isFinite(p.valueUsd) && eq > 0) return s + Math.abs(p.valueUsd) / eq;
    return s;
  }, 0);
  const room = Math.max(0, maxGross - used);
  if (size > room) { size = room; capped.push("gross"); }
  return out(size, kellyFrac, volTargetFrac, { expectation: br });
}

// ---------- return statistics ----------
// 95% one-period VaR as a positive loss, historical (empirical 5% quantile) and parametric
// (Gaussian μ − 1.645σ), scaled by `value` (position value; default 1 = fraction).
function var95(returns, value = 1) {
  const r = cleanArr(returns);
  if (r.length < 2) return { historical: 0, parametric: 0 };
  const hist = Math.max(0, -quantile(r, 0.05));
  const para = Math.max(0, -(mean(r) - 1.6448536 * sd(r)));
  return { historical: hist * fin(value, 1), parametric: para * fin(value, 1) };
}

// Expected shortfall: mean loss in the worst 5% tail (positive number), scaled by value.
function cvar95(returns, value = 1) {
  const r = cleanArr(returns);
  if (r.length < 2) return 0;
  const q = quantile(r, 0.05);
  const tail = r.filter(v => v <= q);
  return Math.max(0, -mean(tail)) * fin(value, 1);
}

// Max peak-to-trough drawdown as a positive fraction. Accepts numbers or {v} points.
function maxDrawdown(curve) {
  const x = (Array.isArray(curve) ? curve : []).map(p => (p && typeof p === "object" ? p.v : p)).map(Number).filter(Number.isFinite);
  let peak = -Infinity, mdd = 0;
  for (const v of x) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

// Annualized Sharpe (rf = 0), sample stdev. 0 when undefined.
function sharpe(returns, periodsPerYear = 252) {
  const r = cleanArr(returns), s = sd(r);
  return r.length >= 2 && s > 0 ? (mean(r) / s) * Math.sqrt(periodsPerYear) : 0;
}

// Annualized Sortino (target 0): mean / sqrt(mean(min(r,0)^2)).
function sortino(returns, periodsPerYear = 252) {
  const r = cleanArr(returns);
  if (r.length < 2) return 0;
  const dd = Math.sqrt(r.reduce((s, v) => s + Math.min(v, 0) ** 2, 0) / r.length);
  return dd > 0 ? (mean(r) / dd) * Math.sqrt(periodsPerYear) : 0;
}

// Pearson correlation of the overlapping tails of a and b. 0 when degenerate.
function correlation(a, b) {
  const x0 = Array.isArray(a) ? a : [], y0 = Array.isArray(b) ? b : [];
  const n = Math.min(x0.length, y0.length);
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    const x = Number(x0[x0.length - n + i]), y = Number(y0[y0.length - n + i]);
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  }
  if (xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? clamp(sxy / Math.sqrt(sxx * syy), -1, 1) : 0;
}

module.exports = {
  positionSize, bracketExpectation, var95, cvar95, maxDrawdown, sharpe, sortino, correlation,
  normCdf, normInv, quantile, mean, sd, clamp, ATR_TO_SIGMA,
};
