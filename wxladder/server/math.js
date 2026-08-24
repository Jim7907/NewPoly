// Pure, deterministic math for the decision layer. No I/O — fully unit-testable.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}

function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * clamp(q, 0, 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);

// Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// ── Bucket probabilities ────────────────────────────────────────
// How a bucket label maps onto the latent continuous temperature. This is NOT cosmetic:
// the two rules sit half a degree apart, which on a sigma near 1 C is a large, silent
// probability error in every rung.
//
//   "round" — the source reports WHOLE degrees (METAR), so bucket "31C" is round(T)==31,
//             i.e. T in [30.5, 31.5). Used by all 31 NOAA-resolved cities.
//   "floor" — the source reports finer than the buckets (HK Observatory, 0.1 C) and the
//             market resolves to "the range that contains" it, so "31C" is T in [31.0, 32.0).
//             Verified against 31 resolved Hong Kong markets: floor matched 31/31.
const BUCKET_OFFSETS = { round: [-0.5, 0.5], floor: [0, 1] };

// A bucket is {lo, hi} in whole degrees: interior lo===hi===k; "k or below" is
// {lo:-Infinity, hi:k}; "k or higher" is {lo:k, hi:Infinity}.
function bucketProb(bucket, mu, sd, rule = "round") {
  if (!(sd > 0)) return null;
  const [loOff, hiOff] = BUCKET_OFFSETS[rule] || BUCKET_OFFSETS.round;
  const below = bucket.hi === Infinity ? 1 : normCdf((bucket.hi + hiOff - mu) / sd);
  const above = bucket.lo === -Infinity ? 0 : normCdf((bucket.lo + loOff - mu) / sd);
  return clamp(below - above, 0, 1);
}

// Probabilities across a full bucket ladder, renormalized so they sum to 1 (the buckets
// are mutually exclusive and exhaustive by construction, so this only fixes erf error).
function bucketProbs(buckets, mu, sd, rule = "round") {
  const raw = buckets.map(b => bucketProb(b, mu, sd, rule) ?? 0);
  const t = sum(raw);
  return t > 0 ? raw.map(p => p / t) : raw;
}

// Which bucket a settled reading falls in, under the same rule. METAR hands us an integer
// and floor/round agree; HKO hands us 31.6 and only the rule decides.
function bucketOf(bucket, value, rule = "round") {
  const v = rule === "floor" ? Math.floor(value) : Math.round(value);
  if (bucket.lo === -Infinity) return v <= bucket.hi;
  if (bucket.hi === Infinity) return v >= bucket.lo;
  return v >= bucket.lo && v <= bucket.hi;
}

// Empirical bucket probabilities from ensemble member outcomes (already bias-shifted),
// with add-one (Laplace) smoothing so a bucket no member visited is not called impossible.
function empiricalBucketProbs(buckets, members, alpha = 1, rule = "round") {
  const counts = buckets.map(() => alpha);
  for (const v of members) {
    const k = rule === "floor" ? Math.floor(v) : Math.round(v);
    let idx = buckets.findIndex(b => k >= b.lo && k <= b.hi);
    if (idx < 0) idx = k < buckets[0].hi ? 0 : buckets.length - 1;
    counts[idx] += 1;
  }
  const t = sum(counts);
  return counts.map(c => c / t);
}

const blendProbs = (a, b, w) => {
  const mixed = a.map((x, i) => (1 - w) * x + w * b[i]);
  const t = sum(mixed);
  return t > 0 ? mixed.map(x => x / t) : mixed;
};

// Market-implied bucket probabilities, de-vigged. These ladders carry a real overround
// (the sum of Yes prices runs ~1.02-1.10), so the raw prices are not probabilities;
// normalizing removes the vig and makes model-vs-market comparable.
function impliedProbs(prices) {
  const clean = prices.map(p => (p != null && isFinite(p) && p > 0 ? p : 0));
  const t = sum(clean);
  return t > 0 ? clean.map(p => p / t) : clean.map(() => 0);
}

// Total-variation distance between two distributions: 0 = identical, 1 = disjoint.
const tvd = (a, b) => 0.5 * sum(a.map((x, i) => Math.abs(x - (b[i] ?? 0))));

// ── Spread / dispersion ─────────────────────────────────────────
// Today's ensemble spread relative to this station+lead's own historical median spread.
// < 1 => the ensemble is huddled tighter than usual (underdispersion; press).
// > 1 => the models disagree more than usual (widen the ladder or sit out).
function dispersionRatio(sdToday, sdHistory, minSamples = 10) {
  if (!(sdToday > 0) || sdHistory.length < minSamples) return null;
  const m = median(sdHistory);
  return m > 0 ? sdToday / m : null;
}

// Predictive sigma via a spread-skill relationship: the station's realized forecast RMSE
// is the anchor, scaled by how tight today's ensemble is relative to its own norm.
// gamma=0 trusts only climatology, gamma=1 trusts today's ensemble spread fully.
function predictiveSigma({ rmse, dispRatio, gamma = 0.5, floor = 0.6, fallback = 1.6, mult = 1 }) {
  const base = rmse > 0 ? rmse : fallback;
  const scale = dispRatio != null && dispRatio > 0 ? Math.pow(dispRatio, clamp(gamma, 0, 1)) : 1;
  return Math.max(floor, base * scale * mult);
}

// Regime label used for budget scaling + ladder width.
function dispersionRegime(dispRatio, lo = 0.85, hi = 1.25) {
  if (dispRatio == null) return "unknown";
  if (dispRatio <= lo) return "tight";
  if (dispRatio >= hi) return "wide";
  return "normal";
}

// ── Costs ───────────────────────────────────────────────────────
// Polymarket weather markets return feeSchedule {exponent:1, rate:0.05, takerOnly:true}:
// fee per share = rate * min(q, 1-q)^exponent. For any q <= 0.5 that is a flat `rate`
// fraction of the capital deployed — so the cheap wings of a ladder are NOT cheap in
// relative terms, they pay the same ~5% haircut as everything else.
const feePerShare = (q, rate = 0.05, exp = 1) => rate * Math.pow(Math.min(q, 1 - q), exp);

// All-in cost per share: price + taker fee + slippage crossing the book.
const effCost = (q, rate = 0.05, exp = 1, slip = 0) => q + feePerShare(q, rate, exp) + slip;

// EV per $1 of capital deployed on one leg bought at all-in cost qEff with true prob p.
const legEv = (p, qEff) => (qEff > 0 ? p / qEff - 1 : 0);

// ── Basket metrics ──────────────────────────────────────────────
// legs: [{prob, price, qEff, shares}]. `shares` optional — omit for the equal-share
// (1 share per rung) reading of the basket, which is the article's "47c pays 100c" frame.
function basketMetrics(legs) {
  const coverProb = sum(legs.map(l => l.prob));
  const costEqual = sum(legs.map(l => l.qEff));
  const grossEqual = sum(legs.map(l => l.price));
  const shares = legs.map(l => (l.shares != null ? l.shares : 1));
  const outlay = sum(legs.map((l, i) => l.qEff * shares[i]));
  // Expected payout: leg i pays `shares[i]` dollars with probability prob[i].
  const expPayout = sum(legs.map((l, i) => l.prob * shares[i]));
  return {
    coverProb: +coverProb.toFixed(4),
    grossCost: +grossEqual.toFixed(4),          // sum of raw asks (the "47c" number)
    basketCost: +costEqual.toFixed(4),          // same, all-in with fees + slip
    outlay: +outlay.toFixed(4),
    expPayout: +expPayout.toFixed(4),
    // EV per $1 actually deployed. Equal-share basket reduces to coverProb/basketCost - 1.
    ev: outlay > 0 ? +(expPayout / outlay - 1).toFixed(4) : 0,
    // Worst case is always -100% of outlay; best case is the fattest rung paying out.
    maxPayout: +Math.max(0, ...legs.map((l, i) => shares[i])).toFixed(4),
  };
}

// ── Sizing ──────────────────────────────────────────────────────
// Multi-outcome (horse-race) Kelly, Smoczynski & Tomkins: the buckets are mutually
// exclusive, so the optimal allocation is solved in closed form rather than leg-by-leg.
// Returns bankroll fractions aligned to `legs`; unbet buckets simply get 0.
// legs: [{prob, qEff}].  Cash is held back automatically — that is the "sit out" answer.
function kellyAllocate(legs, kFrac = 1) {
  const idx = legs.map((l, i) => i).filter(i => legs[i].qEff > 0 && legs[i].qEff < 1);
  idx.sort((a, b) => legs[b].prob / legs[b].qEff - legs[a].prob / legs[a].qEff);

  let P = 0, S = 0, bStar = null, tStar = -1;
  for (let t = 0; t < idx.length; t++) {
    const i = idx[t];
    const Pn = P + legs[i].prob, Sn = S + legs[i].qEff;
    // b = expected-return threshold of the "not bet" reserve. Complete book => bet beliefs.
    const b = Sn >= 1 ? 0 : (1 - Pn) / (1 - Sn);
    if (legs[i].prob / legs[i].qEff > b) { P = Pn; S = Sn; bStar = b; tStar = t; }
    else break;
  }
  const f = legs.map(() => 0);
  if (tStar < 0) return f;                       // nothing beats holding cash
  for (let t = 0; t <= tStar; t++) {
    const i = idx[t];
    f[i] = Math.max(0, legs[i].prob - legs[i].qEff * bStar) * kFrac;
  }
  return f;
}

// The article's §7 scheme: dollars proportional to model probability across the rungs.
function probWeights(legs) {
  const t = sum(legs.map(l => l.prob));
  return t > 0 ? legs.map(l => l.prob / t) : legs.map(() => 1 / legs.length);
}

// Equal SHARES across rungs — the true "one winner pays the whole basket" structure:
// whichever rung hits returns the same dollar amount.
function equalShareWeights(legs) {
  const t = sum(legs.map(l => l.qEff));
  return t > 0 ? legs.map(l => l.qEff / t) : legs.map(() => 1 / legs.length);
}

module.exports = {
  clamp, sum, mean, stdev, quantile, median, erf, normCdf,
  bucketProb, bucketProbs, bucketOf, BUCKET_OFFSETS, empiricalBucketProbs, blendProbs, impliedProbs, tvd,
  dispersionRatio, predictiveSigma, dispersionRegime,
  feePerShare, effCost, legEv, basketMetrics,
  kellyAllocate, probWeights, equalShareWeights,
};
