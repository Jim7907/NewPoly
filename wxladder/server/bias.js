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
// `targetLead` selects which forecast horizon the sigma should describe. The BIAS is fit on
// every lead pooled (see db.biasPairsAllLeads for why that is valid); the SIGMA prefers pairs
// at the target lead and, when there are too few, falls back to the pooled residual scaled by
// `sigmaGrowth^(targetLead-1)`. Measured sigma growth from lead 1 to lead 2 was 0.98 over 42
// pairs — at these horizons the error is dominated by station representativeness rather than
// forecast decay — so the default growth is a slight margin above 1, not a large penalty.
function fitBias(pairs, { asOf, windowDays = 30, halfLifeDays = 10, clampTo = 4,
                          targetLead = null, sigmaGrowth = 1.05, minLeadPairs = 10 } = {}) {
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

  // Sigma for the requested lead: measured from that lead's own pairs when there are enough,
  // otherwise the pooled residual inflated toward it. Never quietly reuse a shorter lead's
  // sigma unscaled — that is what would make the bot overconfident exactly where it is least
  // informed.
  let sdUsed = sd, sigmaSource = "pooled", leadN = n;
  if (targetLead != null) {
    const atLead = usable.filter(p => p.leadDays === targetLead);
    leadN = atLead.length;
    if (leadN >= minLeadPairs) {
      const lw = atLead.map(p => Math.pow(0.5, p.age / Math.max(halfLifeDays, 0.5)));
      const lwSum = lw.reduce((s, x) => s + x, 0);
      const lBias = atLead.reduce((s, p, i) => s + lw[i] * p.err, 0) / lwSum;
      sdUsed = Math.sqrt(atLead.reduce((s, p, i) => s + lw[i] * (p.err - lBias) ** 2, 0) / lwSum);
      sigmaSource = "measured-at-lead";
    } else {
      sdUsed = sd * Math.pow(sigmaGrowth, Math.max(0, targetLead - 1));
      sigmaSource = targetLead > 1 ? "inflated-from-pooled" : "pooled";
    }
  }

  return {
    n,
    weightedN: +wSum.toFixed(2),
    bias: +clamp(bias, -clampTo, clampTo).toFixed(3),
    biasUnclamped: +bias.toFixed(3),
    sd: +sdUsed.toFixed(3),
    sdPooled: +sd.toFixed(3),
    rmse: +sdUsed.toFixed(3),                   // sigma anchor = residual spread post-correction
    rmseUncorrected: +rmseUncorrected.toFixed(3),
    targetLead, leadN, sigmaSource,
    ready: true,
  };
}

// Spread history for this station+kind+lead — the denominator of the underdispersion ratio.
// Kept separate from the bias fit because it survives days we have no observation for.
//
// Two tracks, deliberately NOT pooled: ensemble spread (120+ members) and multi-model spread
// (4 deterministic runs) live on different scales, so a median mixing them would be
// meaningless. The filter prefers the ensemble track and falls back to the multi-model one,
// which is the only track that can be seeded from history.
function spreadTracks(rows, { asOf, windowDays = 60 } = {}) {
  const inWindow = (rows || []).filter(r =>
    r && (!asOf || (daysBetween(r.date, asOf) >= 0 && daysBetween(r.date, asOf) <= windowDays)));
  const pick = (key) => inWindow
    .filter(r => r[key] != null && isFinite(r[key]) && r[key] > 0)
    .map(r => r[key]);
  return { ens: pick("ensSd"), det: pick("detSd") };
}

// Back-compatible accessor: just the ensemble track.
const spreadHistory = (rows, opts) => spreadTracks(rows, opts).ens;

module.exports = { fitBias, spreadTracks, spreadHistory, daysBetween };
