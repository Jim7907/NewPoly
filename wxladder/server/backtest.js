// Offline backtest — walk-forward, leak-free, over archived forecasts and the station
// readings the markets actually resolve on.
//
// WHAT THIS CAN AND CANNOT MEASURE, stated up front:
//
//   Historical Polymarket CLOB prices are not freely replayable, so this does NOT claim a
//   realized P&L. What it measures is the thing the whole strategy rests on — whether the
//   bias-corrected station distribution is CALIBRATED, and how often a 3- or 4-rung cluster
//   centered on it actually contains the observed value. From that cover rate it reports the
//   BREAK-EVEN basket cost: the most you could pay for such a cluster and still profit.
//   Compare that to what the ladders currently quote (their live overround is on the LIVE
//   tab) and you know whether the trade is affordable, without pretending to price history.
//
//   Ensemble SPREAD is also unavailable for past dates from Open-Meteo, so the
//   underdispersion ratio cannot be fit offline; SPREAD_GAMMA is left alone here and the
//   filter proves itself forward on live data. What IS fit offline: SIGMA_MULT (the
//   predictive-spread calibration) and the bias window/half-life, scored by log-loss —
//   a proper scoring rule, so it cannot be gamed by over-confident distributions.
const cfg = require("./config");
const M = require("./math");
const bias = require("./bias");
const history = require("./history");

const DAY_MS = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// An 11-bucket integer ladder like Polymarket's, centered on our own forecast (never on the
// outcome — that would leak) : a bottom tail, nine single-degree buckets, a top tail.
function makeBuckets(centerDeg, n = 11) {
  const half = Math.floor(n / 2);
  const lo = Math.round(centerDeg) - half;
  const out = [{ lo: -Infinity, hi: lo, deg: lo, type: "tail-low" }];
  for (let k = lo + 1; k < lo + n - 1; k++) out.push({ lo: k, hi: k, deg: k, type: "exact" });
  out.push({ lo: lo + n - 1, hi: Infinity, deg: lo + n - 1, type: "tail-high" });
  return out;
}

const bucketIndexOf = (buckets, v) => {
  const i = buckets.findIndex(b => v >= b.lo && v <= b.hi);
  return i >= 0 ? i : (v < buckets[0].hi ? 0 : buckets.length - 1);
};

// Replay one station+kind walk-forward: at each date, fit the bias on STRICTLY EARLIER days
// only, then score the resulting distribution against what the station reported.
function replay(pairs, params) {
  const rows = [];
  const sorted = [...pairs].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const past = sorted.slice(0, i);                       // no lookahead, ever
    const fit = bias.fitBias(past, {
      asOf: p.date, windowDays: params.BIAS_WINDOW_DAYS,
      halfLifeDays: params.BIAS_HALFLIFE_DAYS, clampTo: params.BIAS_CLAMP,
    });
    if (!fit.ready || fit.n < params.MIN_BIAS_SAMPLES) continue;

    const center = p.rawCenter + fit.bias;
    const sigma = M.predictiveSigma({
      rmse: fit.rmse, dispRatio: null, gamma: params.SPREAD_GAMMA,
      floor: params.SD_FLOOR, fallback: params.SD_FALLBACK, mult: params.SIGMA_MULT,
    });
    const buckets = makeBuckets(center);
    const probs = M.bucketProbs(buckets, center, sigma);
    const winIdx = bucketIndexOf(buckets, Math.round(p.obs));

    let centerIdx = 0;
    for (let k = 1; k < probs.length; k++) if (probs[k] > probs[centerIdx]) centerIdx = k;

    rows.push({
      date: p.date, obs: p.obs, rawCenter: p.rawCenter, bias: fit.bias, center, sigma,
      probs, winIdx, centerIdx, pWin: probs[winIdx],
      err: p.obs - center, rawErr: p.obs - p.rawCenter,
    });
  }
  return rows;
}

// Cover rate for a cluster of width w centered on the model's modal bucket — plus, for the
// same rows, the cluster's own claimed probability. Gap between the two IS the miscalibration.
function coverStats(rows, w) {
  if (!rows.length) return { w, n: 0, coverRate: null, claimed: null, breakEvenCost: null };
  let hits = 0, claimed = 0;
  for (const r of rows) {
    const n = r.probs.length;
    // Best contiguous window of width w containing the modal bucket, by model probability.
    let bestSum = -1, bestStart = 0;
    for (let s = Math.max(0, r.centerIdx - w + 1); s <= Math.min(r.centerIdx, n - w); s++) {
      const sum = r.probs.slice(s, s + w).reduce((a, b) => a + b, 0);
      if (sum > bestSum) { bestSum = sum; bestStart = s; }
    }
    claimed += bestSum;
    if (r.winIdx >= bestStart && r.winIdx < bestStart + w) hits++;
  }
  const coverRate = hits / rows.length;
  const claimedAvg = claimed / rows.length;
  // Equal-share basket: pay `cost` for a cluster that returns $1 when it covers. Break-even
  // when coverRate = cost + fee(cost). With the flat weather fee (rate*min(q,1-q)) applied
  // per rung, a conservative single-rung-equivalent haircut is rate*cost for cost <= 0.5.
  const feeAdj = 1 + cfg.FEE_RATE;
  return {
    w, n: rows.length,
    coverRate: +(coverRate * 100).toFixed(1),
    claimed: +(claimedAvg * 100).toFixed(1),
    calibrationGap: +((coverRate - claimedAvg) * 100).toFixed(1),
    breakEvenCost: +(coverRate / feeAdj).toFixed(3),
  };
}

function score(rows) {
  if (!rows.length) return { n: 0, logloss: null, brier: null, hitCenter: null };
  const eps = 1e-6;
  const logloss = -rows.reduce((s, r) => s + Math.log(Math.max(r.pWin, eps)), 0) / rows.length;
  // Multi-class Brier across the ladder.
  const brier = rows.reduce((s, r) => {
    let acc = 0;
    for (let i = 0; i < r.probs.length; i++) acc += (r.probs[i] - (i === r.winIdx ? 1 : 0)) ** 2;
    return s + acc;
  }, 0) / rows.length;
  const errs = rows.map(r => r.err);
  const rawErrs = rows.map(r => r.rawErr);
  return {
    n: rows.length,
    logloss: +logloss.toFixed(4),
    brier: +brier.toFixed(4),
    hitCenter: +(rows.filter(r => r.winIdx === r.centerIdx).length / rows.length * 100).toFixed(1),
    meanErr: +M.mean(errs).toFixed(3),
    maeCorrected: +M.mean(errs.map(Math.abs)).toFixed(3),
    maeRaw: +M.mean(rawErrs.map(Math.abs)).toFixed(3),
    within1: +(errs.filter(e => Math.abs(e) <= 1).length / errs.length * 100).toFixed(1),
  };
}

// ── Runner ──────────────────────────────────────────────────────
async function run(opts = {}) {
  const days = opts.days ?? cfg.BACKTEST_DAYS;
  const kinds = opts.kinds ?? cfg.KINDS;
  const stations = (opts.cities && opts.cities.length
    ? opts.cities.map(c => cfg.UNIVERSE[c]).filter(Boolean)
    : cfg.STATIONS).filter(s => !s.unsupported);

  const end = addDays(iso(Date.now()), -1);
  const start = addDays(end, -days);

  // Pull once; every parameter combination replays the same pairs.
  const datasets = [];
  for (const station of stations) {
    for (const kind of kinds) {
      try {
        const pairs = await history.gather(station, kind, start, end);
        if (pairs.length >= cfg.MIN_BIAS_SAMPLES + 5) datasets.push({ station, kind, pairs });
      } catch (e) { console.error(`[backtest] ${station.icao}/${kind}: ${e.message}`); }
      await sleep(80);
    }
  }
  if (!datasets.length) return { error: "no historical data gathered", start, end, days };

  const grid = [];
  for (const SIGMA_MULT of [0.9, 1.0, 1.15, 1.3, 1.5]) {
    for (const BIAS_HALFLIFE_DAYS of [5, 10, 20]) {
      for (const BIAS_WINDOW_DAYS of [20, 30, 45]) {
        const params = { ...cfg, SIGMA_MULT, BIAS_HALFLIFE_DAYS, BIAS_WINDOW_DAYS };
        const rows = datasets.flatMap(d => replay(d.pairs, params));
        if (rows.length < cfg.BACKTEST_MIN_BASKETS) continue;
        const s = score(rows);
        grid.push({
          SIGMA_MULT, BIAS_HALFLIFE_DAYS, BIAS_WINDOW_DAYS,
          ...s, cover3: coverStats(rows, 3), cover4: coverStats(rows, 4),
        });
      }
    }
  }
  if (!grid.length) return { error: "not enough walk-forward samples", start, end, days, datasets: datasets.length };

  // Log-loss is a proper scoring rule: an over-confident distribution cannot win by cheating.
  const sorted = [...grid].sort((a, b) => a.logloss - b.logloss);
  const best = sorted[0];

  const perStation = [];
  for (const d of datasets) {
    const rows = replay(d.pairs, { ...cfg, SIGMA_MULT: best.SIGMA_MULT, BIAS_HALFLIFE_DAYS: best.BIAS_HALFLIFE_DAYS, BIAS_WINDOW_DAYS: best.BIAS_WINDOW_DAYS });
    if (!rows.length) continue;
    const s = score(rows);
    perStation.push({
      city: d.station.city, station: d.station.icao, kind: d.kind, n: s.n,
      meanBias: +M.mean(d.pairs.map(p => p.obs - p.rawCenter)).toFixed(2),
      maeRaw: s.maeRaw, maeCorrected: s.maeCorrected, logloss: s.logloss,
      cover3: coverStats(rows, 3).coverRate, cover4: coverStats(rows, 4).coverRate,
    });
  }
  perStation.sort((a, b) => (b.cover3 ?? 0) - (a.cover3 ?? 0));

  return {
    days, start, end,
    cities: stations.map(s => s.city),
    datasets: datasets.length,
    best,
    // A cover rate the model claims but does not achieve is the one number that would sink
    // this strategy, so the recommendation is the REALIZED rate less a safety margin.
    recommended: {
      sigmaMult: best.SIGMA_MULT,
      minCoverProb: best.cover3 && best.cover3.coverRate != null
        ? +Math.max(0.4, Math.min(0.9, best.cover3.coverRate / 100 - 0.10)).toFixed(2)
        : null,
      maxBasketCost3: best.cover3 ? best.cover3.breakEvenCost : null,
      maxBasketCost4: best.cover4 ? best.cover4.breakEvenCost : null,
    },
    frontier: sorted.slice(0, 12),
    perStation,
    note: "Walk-forward: the bias at each date is fit only on strictly earlier days. Scores " +
          "the CALIBRATION of the bias-corrected station distribution and the realized cover " +
          "rate of 3- and 4-rung clusters, then converts that cover rate into the break-even " +
          "basket cost. It is not a P&L claim: historical CLOB prices are not freely " +
          "replayable, so W_MODEL and MIN_BASKET_EV are proven forward on the CALIBRATION tab.",
  };
}

module.exports = { run, replay, score, coverStats, makeBuckets, bucketIndexOf };

// CLI: `npm run backtest`
if (require.main === module) {
  run({ days: Number(process.argv[2]) || undefined })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error("backtest failed:", e.message); process.exit(1); });
}
