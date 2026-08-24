// Bias correction — the single step the article warns hardest about skipping (§8): center
// the ladder on a raw model forecast and every rung is one bucket off.
//
// The offset is real and structural, not noise: the model grid cell is not the runway.
// Over Aug 10-14 2026 the three-model consensus for Singapore averaged 31.6 C while WSSS
// reported 32.4 C — a persistent ~+0.8 C, most of a whole bucket.
//
// We fit, per station+kind+lead, an exponentially-weighted mean error and the residual
// spread around it. The mean becomes the center shift; the residual spread is the anchor
// for the predictive sigma (see math.predictiveSigma), so sigma is grounded in this
// station's REALIZED error rather than in the ensemble's own optimism about itself.
const { clamp } = require("./math");

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// pairs: [{ date, rawCenter, obs, ensSd? }]  (`date` = the forecast's valid date)
// asOf:  the date the fit is being made for; older pairs are down-weighted by half-life.
function fitBias(pairs, { asOf, windowDays = 30, halfLifeDays = 10, clampTo = 4 } = {}) {
  const usable = (pairs || [])
    .filter(p => p && p.obs != null && p.rawCenter != null && isFinite(p.obs) && isFinite(p.rawCenter))
    .map(p => ({ ...p, err: p.obs - p.rawCenter, age: asOf ? daysBetween(p.date, asOf) : 0 }))
    .filter(p => p.age >= 0 && p.age <= windowDays);

  const n = usable.length;
  if (!n) return { n: 0, bias: 0, rmse: null, sd: null, weightedN: 0, ready: false };

  const w = usable.map(p => Math.pow(0.5, p.age / Math.max(halfLifeDays, 0.5)));
  const wSum = w.reduce((s, x) => s + x, 0);
  const bias = usable.reduce((s, p, i) => s + w[i] * p.err, 0) / wSum;
  // Residual spread about the CORRECTED center — this is the honest predictive sigma.
  const varW = usable.reduce((s, p, i) => s + w[i] * (p.err - bias) ** 2, 0) / wSum;
  const sd = Math.sqrt(varW);
  // Raw RMSE about zero, i.e. what you would suffer by not correcting at all.
  const rmseUncorrected = Math.sqrt(usable.reduce((s, p, i) => s + w[i] * p.err ** 2, 0) / wSum);

  return {
    n,
    weightedN: +wSum.toFixed(2),
    bias: +clamp(bias, -clampTo, clampTo).toFixed(3),
    biasUnclamped: +bias.toFixed(3),
    sd: +sd.toFixed(3),
    rmse: +sd.toFixed(3),                       // sigma anchor = residual spread post-correction
    rmseUncorrected: +rmseUncorrected.toFixed(3),
    ready: true,
  };
}

// Median ensemble spread for this station+kind+lead, used as the denominator of the
// underdispersion ratio. Kept separate from the bias fit because spread history survives
// even on days we have no observation for yet.
function spreadHistory(rows, { asOf, windowDays = 60 } = {}) {
  return (rows || [])
    .filter(r => r && r.ensSd != null && isFinite(r.ensSd) && r.ensSd > 0)
    .filter(r => !asOf || (daysBetween(r.date, asOf) >= 0 && daysBetween(r.date, asOf) <= windowDays))
    .map(r => r.ensSd);
}

module.exports = { fitBias, spreadHistory, daysBetween };
