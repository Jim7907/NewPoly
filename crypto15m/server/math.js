// Pure, deterministic math for the decision layer. No I/O — fully unit-testable.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

// Standard normal CDF.
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// EWMA variance update (RiskMetrics style). Returns new variance.
const ewmaVar = (prevVar, ret, lambda = 0.94) => lambda * prevVar + (1 - lambda) * ret * ret;

// Lead z-score: z = (L + mu*tau) / (sigma*sqrt(tau)).
// L = ln(S/S_open); sigmaPerSec = per-second return stdev; tauSec = seconds to close.
function leadZ(L, sigmaPerSec, tauSec, muPerSec = 0) {
  const denom = sigmaPerSec * Math.sqrt(Math.max(tauSec, 1e-9));
  if (!(denom > 0) || !isFinite(denom)) return 0;
  return (L + muPerSec * tauSec) / denom;
}

// Model probability the window resolves "Up" (close >= open), clamped.
function pUp(z, clampLo = 0.05, clampHi = 0.95) {
  return clamp(normCdf(z), clampLo, clampHi);
}

// Shrink model probability toward the market price. Trust the model more as the
// window nears close: w grows from ~0.55 (open) to ~0.95 (close).
function shrinkWeight(tauSec, windowSec, wMin = 0.55, wSpan = 0.40) {
  const frac = clamp(1 - tauSec / windowSec, 0, 1);
  return wMin + wSpan * frac;
}
const blend = (pModel, pMarket, w) => clamp(w * pModel + (1 - w) * pMarket, 0.01, 0.99);

// Effective taker fee as a fraction of capital deployed at entry price q.
// fee/share = feeK * q * (1-q); capital/share = q  =>  fee_frac = feeK * (1-q).
const takerFeeFrac = (q, feeK = 0.036) => feeK * (1 - q);

// Net edge after fees + slippage when buying at effective price q with model prob p.
const netEdge = (p, q, feeK, slip = 0) => (p - q) - takerFeeFrac(q, feeK) - slip;

// EV per $1 staked buying a $1-payout share at price q with true prob p (fee-aware).
const evPerDollar = (p, q, feeK, slip = 0) => (p / q - 1) - takerFeeFrac(q, feeK) - slip / q;

// Fractional-Kelly stake fraction for a binary bet (model p, entry q), capped.
function kellyFraction(p, q, k = 0.15, fMax = 0.04) {
  if (!(q > 0) || !(q < 1)) return 0;
  const fStar = (p - q) / (1 - q);
  if (!(fStar > 0)) return 0;
  return clamp(k * fStar, 0, fMax);
}

// Order-book imbalance from arrays of {price,size} (already top-N / band-filtered).
function bookImbalance(bids, asks) {
  const sum = (arr) => arr.reduce((s, l) => s + (Number(l.size) || 0), 0);
  const b = sum(bids), a = sum(asks);
  const t = b + a;
  return t > 0 ? (b - a) / t : 0;
}

// Trade-flow imbalance from signed trades [{side:'buy'|'sell', size}].
function tradeFlowImbalance(trades) {
  let buy = 0, sell = 0;
  for (const t of trades) {
    const sz = Number(t.size) || 0;
    if (t.side === "buy") buy += sz; else if (t.side === "sell") sell += sz;
  }
  const tot = buy + sell;
  return tot > 0 ? (buy - sell) / tot : 0;
}

module.exports = {
  clamp, erf, normCdf, ewmaVar, leadZ, pUp, shrinkWeight, blend,
  takerFeeFrac, netEdge, evPerDollar, kellyFraction, bookImbalance, tradeFlowImbalance,
};
