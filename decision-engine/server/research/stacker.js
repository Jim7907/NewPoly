// Stacked model over signal scores (contract v2 §4): featurize → purged walk-forward by DATE →
// logistic (L2 tuned by an inner purged CV) + shallow GBM (early-stopped) → honest out-of-sample
// comparison against (a) the training base rate and (b) v1 pooled pRaw calibrated on the training
// folds, with a Diebold–Mariano test whose variance is robust to panel + overlap correlation.
//
// ───────────────────────────── DESIGN NOTES (read before changing) ─────────────────────────────
// Leakage is where a stacker lies, so the splitter is the heart of this file:
//  * PANEL ⇒ SPLIT BY DATE. Every asset shares the calendar, so a test block is a contiguous range
//    of dates [T, E] and contains every asset's rows on those dates. Rows are never split
//    individually (a random row split would put NVDA-Tuesday in test and AMD-Tuesday in train with
//    the same market move in both labels).
//  * PURGE. A row's label window is [t, tEnd] where tEnd is the time of the bar `ahead` bars later
//    FOR THAT ASSET (row.lab.tEnd from the dataset builder, else looked up via row.i + ahead). This matters for stocks: 5
//    daily bars span 7+ calendar days across a weekend/holiday, so the naive t + ahead·tf would
//    under-purge. Rows without an index fall back to a conservative calendar estimate.
//    For a test block starting at date T the model trains ONLY on rows with tEnd < T − embargo.
//  * EMBARGO: default max(1, ceil(1% of dates)) bars (docs/RESEARCH.md §5.1).
//  * EXPANDING WINDOW: the first test block starts at the first date where ≥ minTrain rows are
//    trainable (default 30% of the labelled rows, ≥ 300); the remaining dates are cut into `folds`
//    contiguous blocks with equal date counts.
//  * Everything fitted is fitted per fold on that fold's training rows only: the feature spec
//    (column set, sparse-family flags, winsor bounds), the logistic L2 (inner purged CV), the GBM
//    (early stopping on a purged time-ordered tail), the base rate and the pRaw calibrator.
//  * Rows with a null label are never trained on nor scored. For target yEx the benchmark assets
//    (dataset.benchmarks) are excluded (their exRet is identically 0).
//
// TARGETS
//  y      = lab.y      (5-day log return > 0)
//  yEx    = lab.yEx    (excess return vs benchmark > 0)
//  tbLong = 1 iff lab.tbLongRet > 0, i.e. the LONG BRACKET (ATR stop/target, vertical barrier =
//           ahead) made money NET OF ROUND-TRIP COSTS — target-first, or a time-out that closed
//           above entry + costs. 0 = stop-first or a losing/flat time-out.
//           Chosen over "target-first vs rest" because (i) it is the quantity P&L depends on,
//           (ii) it is the exact success definition the meta-labeler uses for a long, and (iii)
//           it does not throw away profitable time-outs. Fallback when tbLongRet is missing:
//           tbLong = +1 → 1, −1 → 0, 0 (time-out) → null (unknown sign → skipped).
//
// FEATURES — featurize(row, spec), in this fixed order (names in spec.names):
//  1. sig:<id>        score·conf·mask[id] for each spec.signalIds (fixed order); missing → 0.
//                     score clamped to [−1,1], conf to [0,1]. Ids with mask 0 are dropped from the
//                     spec. Unknown ids in the row (e.g. live-only families) are ignored.
//  2. fam:<family>    mean of (1) over the family's spec signals PRESENT in the row (0 if none).
//                     Recomputed from `sig` (never read from row.fam) so the masked aggregate is
//                     identical in training and live, and live-only signals (news, derivatives…)
//                     cannot leak into a family aggregate.
//  3. present:<fam>   1 if any of the family's spec signals is present — only for SPARSE families
//                     (present in < 98% of training rows: macro before its history starts,
//                     fear-greed for crypto only, …), so "missing" and "neutral 0" are separable.
//  4. regime:…        one-hots: trend:{up,down,range}, vol:{low,normal,high,extreme},
//                     hmm:<class>:<state> (HMM states are sorted by mean, k differs by class).
//  5. class:<c>       asset-class one-hot ("etf" → "stock").
//  6. atrPct, annVol  winsorized to the training 1st/99th percentiles; missing → training median.
//  7. logitPRaw       logit(clamp(pRaw, 0.01, 0.99)); missing → 0.
//  Mask: when a signalEval mask is given it is stored in the spec and applied in featurize. The
//  dataset stores RAW confidences; if a live row's confidences were ALREADY multiplied by the mask
//  set row.masked = true so the mask is not applied twice.
//
// MODELS (reusing server/analysis/ml.js — nothing is re-implemented here)
//  logistic : LogisticModel (Newton, standardized features). Penalty λ = c·n on the summed NLL,
//             i.e. c per sample; c chosen from l2Grid (default 0.03…10, strong) by an inner purged
//             walk-forward (3 folds, date-strided downsample to ≤ innerMax rows). Among grid points
//             within innerTol of the best inner log-loss the STRONGEST penalty wins.
//  gbm      : GBMClassifier depth 2, lr 0.05, ≤ 200 trees, subsample 0.5, λ_leaf 10,
//             minLeaf = max(100, 1% of n), early stopping on the last 20% of dates with a purge
//             gap computed from label ends (so the validation tail is itself leak-free).
//  ensemble : mean of the two probabilities (default).
//
// EVALUATION (all on the SAME OOS rows)
//  auc / brier / logloss for the stacker, logistic, gbm, base rate and calibrated pRaw.
//  dm = Diebold–Mariano on the per-row log-loss differential (stacker − calibrated pRaw) with a
//       Driscoll–Kraay variance: per-row differentials are SUMMED BY DATE, then a Newey–West
//       (Bartlett) long-run variance is taken over the date series with lag = ahead (in dates).
//       Cross-sectional correlation (all assets fall together) is therefore absorbed inside a
//       date, and label overlap across dates by the HAC lag. Harvey–Leybourne–Newbold small-sample
//       factor, Student-t(T−1) p-values. stat < 0 ⇔ the stacker has LOWER log-loss.
//  aucCI = moving-block bootstrap over dates (blocks of 2·ahead dates) for the stacker, the
//       baseline and their difference.
//  calibrated = the stacker's probability after the OOS calibrator, evaluated SEQUENTIALLY: fold
//       k is calibrated only on OOS predictions of folds < k whose labels ended before fold k.
//
// FINAL MODEL: refit on all labelled rows; a Calibrator (server/learning/calibrator.js) is fitted
// on the walk-forward OOS predictions and stored, so Stacker.predict(row) returns a CALIBRATED
// probability. Calibrator sample size uses n_eff = nDates / ahead (dates, not rows, are the
// independent unit of a panel), which keeps it on Platt scaling until there is a lot of history.
// Deterministic: fixed seeds, no Math.random.
"use strict";

const { LogisticModel, GBMClassifier, auc, mulberry32 } = require("../analysis/ml");
const { Calibrator } = require("../learning/calibrator");

const DAY_MS = 86400000;
const TARGETS = ["y", "yEx", "tbLong"];
const MODELS = ["logistic", "gbm", "ensemble"];
const FAMILY_PREFIX = Object.freeze({
  tech: "technical", regime: "regime", rel: "relative", macro: "macro", sent: "sentiment",
  fund: "fundamental", deriv: "derivatives", micro: "microstructure", ml: "ml", llm: "llm",
});
const FAMILY_ORDER = ["technical", "regime", "relative", "macro", "sentiment", "fundamental", "derivatives", "microstructure", "ml", "llm"];
const TREND_LEVELS = ["up", "down", "range"];
const VOL_LEVELS = ["low", "normal", "high", "extreme"];

const DEFAULTS = Object.freeze({
  folds: 5,
  minTrainFrac: 0.3,
  minTrainAbs: 300,
  l2Grid: [0.03, 0.1, 0.3, 1, 3, 10],
  innerFolds: 3,
  innerMax: 6000,
  innerTol: 2e-4,
  sparseThreshold: 0.98,
  gbm: { nTrees: 200, depth: 2, lr: 0.05, subsample: 0.5, maxBins: 32, lambda: 10, minLeafFrac: 0.01, minLeafMin: 100, valFrac: 0.2, patience: 25 },
  bootstrapReps: 200,
  seed: 1337,
});

// ─── small helpers ───────────────────────────────────────────────────────────────────────────
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isNum = v => typeof v === "number" && Number.isFinite(v);
const logit = p => { const q = clamp(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)); };
const clipP = p => clamp(Number.isFinite(p) ? p : 0.5, 1e-6, 1 - 1e-6);
const logloss1 = (p, y) => { const q = clipP(p); return y ? -Math.log(q) : -Math.log(1 - q); };
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const r6 = x => (Number.isFinite(x) ? +x.toFixed(6) : null);
const toNum = v => (v === null || v === undefined || v === "" || typeof v === "boolean" ? NaN : Number(v)); // Number(null) is 0!

function familyOf(id) {
  const p = String(id).split(".")[0];
  return FAMILY_PREFIX[p] || p;
}
function normClass(c) {
  const s = String(c || "").toLowerCase();
  return s === "etf" ? "stock" : s || "unknown";
}
function uniqSorted(xs) {
  return Array.from(new Set(xs)).sort((a, b) => a - b);
}
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function cmpRows(a, b) {
  return a.t - b.t || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}
function sortRows(rows) {
  const r = (rows || []).filter(x => x && isNum(x.t));
  for (let k = 1; k < r.length; k++) if (cmpRows(r[k - 1], r[k]) > 0) return r.slice().sort(cmpRows);
  return r;
}

/**
 * [score, conf] from a dataset pair [s, c], a Signal-like {score, confidence} or a bare number.
 * conf is clamped to [0, cMax]: 1 for raw confidences, 2 for rows already multiplied by a mask
 * (keep-verdict multipliers go up to 1.5).
 */
function sigPair(v, cMax = 1) {
  let s, c;
  if (Array.isArray(v)) { s = toNum(v[0]); c = v.length > 1 ? toNum(v[1]) : 1; }
  else if (v && typeof v === "object") { s = toNum(v.score); c = v.confidence != null ? toNum(v.confidence) : v.conf != null ? toNum(v.conf) : 1; }
  else if (typeof v === "number") { s = v; c = 1; }
  else return null;
  if (!Number.isFinite(s)) return null;
  return [clamp(s, -1, 1), Number.isFinite(c) ? clamp(c, 0, cMax) : 0];
}

// ─── labels ──────────────────────────────────────────────────────────────────────────────────
const bin01 = v => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null);

/** Binary training label for `target`, or null (unknown → skipped). See header for tbLong. */
function labelOf(row, target) {
  const lab = row && row.lab;
  if (!lab || typeof lab !== "object") return null;
  if (target === "y") {
    const y = bin01(lab.y);
    return y !== null ? y : isNum(lab.ret) ? (lab.ret > 0 ? 1 : 0) : null;
  }
  if (target === "yEx") {
    if (lab.exRet === null) return null;
    const y = bin01(lab.yEx);
    return y !== null ? y : isNum(lab.exRet) ? (lab.exRet > 0 ? 1 : 0) : null;
  }
  if (target === "tbLong") {
    if (isNum(lab.tbLongRet)) return lab.tbLongRet > 0 ? 1 : 0;
    return lab.tbLong === 1 ? 1 : lab.tbLong === -1 ? 0 : null;
  }
  throw new Error(`unknown target "${target}" (expected ${TARGETS.join("|")})`);
}

// ─── label windows ───────────────────────────────────────────────────────────────────────────
/**
 * Label end time (ms) for every row. With useLabEnd (default) a finite row.lab.tEnd written by
 * the dataset builder (time of bar i + ahead) is used as is. Otherwise: the time of the same
 * asset's bar `ahead` bars later (row.i + ahead), looked up in `rows` — exact when that bar is a
 * row, otherwise the first later
 * row of the asset (an upper bound, i.e. conservative for purging, e.g. with stride > 1). Rows at
 * the end of an asset's history or without `i` use a conservative calendar estimate: crypto
 * t + ahead·tf; stocks daily t + ceil(ahead·7/5) days + 2 days (weekends + holidays); stocks
 * intraday t + ahead·tf + 3 days. Pass the FULL dataset rows (unlabelled tail included).
 */
function computeLabelEnds(rows, { ahead = 5, tf = 86400, useLabEnd = true } = {}) {
  const n = rows.length, tfMs = tf * 1000;
  const ends = new Float64Array(n);
  const labEnd = r => (useLabEnd && r.lab && isNum(r.lab.tEnd) && r.lab.tEnd >= r.t ? r.lab.tEnd : null);
  const fallback = r => {
    const stock = normClass(r.assetClass) === "stock";
    if (!stock) return r.t + ahead * tfMs;
    if (tfMs >= DAY_MS) return r.t + Math.ceil((ahead * tfMs * 7) / 5 / DAY_MS) * DAY_MS + 2 * DAY_MS;
    return r.t + ahead * tfMs + 3 * DAY_MS;
  };
  const byAsset = new Map();
  for (let k = 0; k < n; k++) {
    const r = rows[k];
    if (!Number.isInteger(r.i)) { ends[k] = fallback(r); continue; }
    let g = byAsset.get(r.assetId);
    if (!g) byAsset.set(r.assetId, (g = []));
    g.push(k);
  }
  for (const g of byAsset.values()) {
    g.sort((a, b) => rows[a].i - rows[b].i);
    const is = g.map(k => rows[k].i);
    for (let q = 0; q < g.length; q++) {
      const target = is[q] + ahead;
      let lo = q + 1, hi = g.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (is[m] >= target) hi = m; else lo = m + 1; }
      const r = rows[g[q]];
      ends[g[q]] = lo < g.length ? Math.max(rows[g[lo]].t, r.t + 1) : fallback(r);
    }
  }
  for (let k = 0; k < n; k++) { const e = labEnd(rows[k]); if (e !== null) ends[k] = e; }
  return ends;
}

// ─── purged walk-forward splitter (by date) ─────────────────────────────────────────────────
/**
 * Generic expanding-window, purged + embargoed walk-forward over a PANEL, split by date.
 *   rows       objects with a time (dateOf(row), default row.t, ms)
 *   labelEnds  array aligned with rows (ms) or labelEnd(row, idx) function; default t + purge·tf
 *   embargo    bars (× tf) or embargoMs; default max(1, ceil(1% of dates)) bars
 *   folds      number of contiguous test blocks (equal date counts), default 5
 *   minTrain   rows required before the first test block (default max(minTrainAbs, minTrainFrac·n))
 * Test block k covers dates [testStart, testEnd]; its training rows are exactly the rows whose
 * label window ends before testStart − embargo (so no training label overlaps the block).
 * Returns [{ k, testStart, testEnd, cutoff, train: idx[], test: idx[] }] (indices into rows,
 * ascending); folds whose training set is smaller than minTrain are dropped.
 */
function purgedWalkForward(rows, opts = {}) {
  const n = rows ? rows.length : 0;
  if (!n) return [];
  const tf = opts.tf || 86400, tfMs = tf * 1000;
  const ahead = opts.ahead || 1;
  const purge = opts.purge != null ? opts.purge : ahead;
  const dateOf = opts.dateOf || (r => r.t);
  const ts = new Float64Array(n);
  for (let k = 0; k < n; k++) ts[k] = dateOf(rows[k]);
  const ends = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const e = Array.isArray(opts.labelEnds) || ArrayBuffer.isView(opts.labelEnds) ? opts.labelEnds[k]
      : typeof opts.labelEnd === "function" ? opts.labelEnd(rows[k], k) : ts[k] + purge * tfMs;
    ends[k] = Number.isFinite(e) ? Math.max(e, ts[k]) : Infinity; // unknown end → never trainable
  }
  const dates = uniqSorted(Array.from(ts));
  const embargoMs = opts.embargoMs != null ? opts.embargoMs
    : (opts.embargo != null ? opts.embargo : Math.max(1, Math.ceil(0.01 * dates.length))) * tfMs;
  const nFolds = Math.max(1, Math.floor(opts.folds || 5));
  const minTrain = opts.minTrain != null ? opts.minTrain
    : Math.max(opts.minTrainAbs != null ? opts.minTrainAbs : DEFAULTS.minTrainAbs, Math.ceil((opts.minTrainFrac != null ? opts.minTrainFrac : DEFAULTS.minTrainFrac) * n));
  const sortedEnds = Float64Array.from(ends).sort();
  const trainableBefore = cut => { // # rows with end < cut
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sortedEnds[m] < cut) lo = m + 1; else hi = m; }
    return lo;
  };
  let k0 = -1;
  for (let d = 0; d < dates.length; d++) if (trainableBefore(dates[d] - embargoMs) >= minTrain) { k0 = d; break; }
  if (k0 < 0) return [];
  const testDates = dates.slice(k0);
  const nb = Math.min(nFolds, testDates.length);
  const out = [];
  for (let b = 0; b < nb; b++) {
    const from = Math.floor((b * testDates.length) / nb), to = Math.floor(((b + 1) * testDates.length) / nb) - 1;
    if (to < from) continue;
    const T = testDates[from], E = testDates[to], cutoff = T - embargoMs;
    const train = [], test = [];
    for (let k = 0; k < n; k++) {
      if (ends[k] < cutoff) train.push(k);
      else if (ts[k] >= T && ts[k] <= E) test.push(k);
    }
    if (train.length < minTrain || !test.length) continue;
    out.push({ k: out.length, testStart: T, testEnd: E, cutoff, train, test });
  }
  return out;
}

// ─── feature spec + featurize ───────────────────────────────────────────────────────────────
function regimeKeys(row) {
  const r = row ? row.regime : null;
  let trend = null, vol = null, hmm = null, label = null;
  if (r && typeof r === "object") {
    trend = r.trend || null; vol = r.vol || null; label = r.label || null;
    hmm = r.hmmState != null ? r.hmmState : r.hmm && typeof r.hmm === "object" ? r.hmm.state : null;
  } else if (typeof r === "string") label = r;
  if (label && (!trend || !vol)) {
    const s = String(label).toLowerCase();
    if (!trend) trend = /up/.test(s) ? "up" : /down/.test(s) ? "down" : /rang/.test(s) ? "range" : null;
    if (!vol) { const m = s.match(/(low|normal|high|extreme)-?vol/); vol = m ? m[1] : null; }
  }
  const keys = [];
  if (trend) keys.push(`trend:${trend}`);
  if (vol) keys.push(`vol:${vol}`);
  if (Number.isInteger(hmm)) keys.push(`hmm:${normClass(row.assetClass)}:${hmm}`);
  return keys;
}

/**
 * Stable feature spec from training rows (a Dataset or a row array). opts:
 *   mask       { [id]: multiplier } from signalEval.signalMask (0 ⇒ the id is dropped)
 *   signalIds  canonical id order (default dataset.signalIds, then any other ids seen, sorted)
 *   minCount   an id needs ≥ minCount rows with score·conf ≠ 0 (default min(30, max(5, 0.2% n)))
 */
function makeSpec(data, opts = {}) {
  const rows = Array.isArray(data) ? data : (data && data.rows) || [];
  const n = rows.length;
  const mask = opts.mask && typeof opts.mask === "object" ? opts.mask : null;
  const declared = opts.signalIds || (!Array.isArray(data) && data && data.signalIds) || [];
  const minCount = opts.minCount != null ? opts.minCount : Math.min(30, Math.max(5, Math.floor(0.002 * n)));
  const nz = new Map();
  for (const r of rows) {
    const sig = r && r.sig;
    if (!sig || typeof sig !== "object") continue;
    for (const id in sig) {
      const pr = sigPair(sig[id]);
      if (!pr) continue;
      if (!nz.has(id)) nz.set(id, 0);
      if (pr[0] * pr[1] !== 0) nz.set(id, nz.get(id) + 1);
    }
  }
  const declaredSet = new Set(declared);
  const order = declared.filter(id => nz.has(id)).concat([...nz.keys()].filter(id => !declaredSet.has(id)).sort());
  const signalIds = order.filter(id => nz.get(id) >= minCount && !(mask && mask[id] != null && Number(mask[id]) === 0));
  const famSet = new Set(signalIds.map(familyOf));
  const families = FAMILY_ORDER.filter(f => famSet.has(f)).concat([...famSet].filter(f => !FAMILY_ORDER.includes(f)).sort());
  const famIndex = signalIds.map(id => families.indexOf(familyOf(id)));

  // sparse families: present (any spec signal) in < sparseThreshold of the rows
  const presentCnt = new Array(families.length).fill(0);
  const levelCnt = new Map(), clsCnt = new Map();
  const atr = [], vol = [];
  for (const r of rows) {
    const seen = new Array(families.length).fill(false);
    const sig = (r && r.sig) || {};
    for (let j = 0; j < signalIds.length; j++) if (sig[signalIds[j]] != null && sigPair(sig[signalIds[j]])) seen[famIndex[j]] = true;
    seen.forEach((s, f) => { if (s) presentCnt[f]++; });
    for (const key of regimeKeys(r)) levelCnt.set(key, (levelCnt.get(key) || 0) + 1);
    const c = normClass(r.assetClass);
    clsCnt.set(c, (clsCnt.get(c) || 0) + 1);
    if (isNum(r.atrPct)) atr.push(r.atrPct);
    if (isNum(r.annVol)) vol.push(r.annVol);
  }
  const thr = opts.sparseThreshold != null ? opts.sparseThreshold : DEFAULTS.sparseThreshold;
  const sparse = families.filter((f, k) => n > 0 && presentCnt[k] / n < thr);
  const minLevel = Math.max(1, Math.floor(0.002 * n));
  const keepLevel = key => (levelCnt.get(key) || 0) >= minLevel;
  const hmmKeys = [...levelCnt.keys()].filter(k => k.startsWith("hmm:")).sort();
  const regimes = [
    ...TREND_LEVELS.map(v => `trend:${v}`).filter(keepLevel),
    ...VOL_LEVELS.map(v => `vol:${v}`).filter(keepLevel),
    ...hmmKeys.filter(keepLevel),
  ];
  const classes = [...clsCnt.keys()].filter(c => c !== "unknown").sort();
  const wz = xs => {
    const s = Float64Array.from(xs).sort();
    return s.length ? [r6(quantile(s, 0.01)), r6(quantile(s, 0.99)), r6(quantile(s, 0.5))] : [0, 0, 0];
  };
  const names = [
    ...signalIds.map(id => `sig:${id}`), ...families.map(f => `fam:${f}`), ...sparse.map(f => `present:${f}`),
    ...regimes.map(k => `regime:${k}`), ...classes.map(c => `class:${c}`), "atrPct", "annVol", "logitPRaw",
  ];
  const specMask = mask ? Object.fromEntries(signalIds.map(id => [id, mask[id] != null && Number.isFinite(Number(mask[id])) ? Number(mask[id]) : 1])) : null;
  return { v: 1, signalIds, families, sparse, regimes, classes, winsor: { atrPct: wz(atr), annVol: wz(vol) }, mask: specMask, names };
}

// Derived lookup tables (not serialized).
const SPEC_CACHE = new WeakMap();
function specAux(spec) {
  let a = SPEC_CACHE.get(spec);
  if (!a) {
    const famIndex = spec.signalIds.map(id => spec.families.indexOf(familyOf(id)));
    const sparseIndex = spec.sparse.map(f => spec.families.indexOf(f));
    const regimeIndex = new Map(spec.regimes.map((k, j) => [k, j]));
    a = { famIndex, sparseIndex, regimeIndex };
    SPEC_CACHE.set(spec, a);
  }
  return a;
}

/** Feature vector (plain number[] of length spec.names.length) for a dataset row or a live row. */
function featurize(row, spec) {
  const d = spec.names.length;
  const x = new Array(d).fill(0);
  if (!row || typeof row !== "object") return x;
  const aux = specAux(spec);
  const sig = row.sig && typeof row.sig === "object" ? row.sig : {};
  const mask = row.masked ? null : spec.mask;
  const cMax = row.masked ? 2 : 1;
  const ids = spec.signalIds, nf = spec.families.length;
  const fSum = new Float64Array(nf), fCnt = new Int32Array(nf);
  for (let j = 0; j < ids.length; j++) {
    const raw = sig[ids[j]];
    if (raw == null) continue;
    const pr = sigPair(raw, cMax);
    if (!pr) continue;
    let m = 1;
    if (mask) { const mv = mask[ids[j]]; if (mv != null && Number.isFinite(mv)) m = mv; }
    const v = pr[0] * pr[1] * m;
    x[j] = v;
    fSum[aux.famIndex[j]] += v; fCnt[aux.famIndex[j]]++;
  }
  let o = ids.length;
  for (let f = 0; f < nf; f++) x[o + f] = fCnt[f] ? fSum[f] / fCnt[f] : 0;
  o += nf;
  for (let s = 0; s < aux.sparseIndex.length; s++) x[o + s] = fCnt[aux.sparseIndex[s]] > 0 ? 1 : 0;
  o += aux.sparseIndex.length;
  for (const key of regimeKeys(row)) { const j = aux.regimeIndex.get(key); if (j !== undefined) x[o + j] = 1; }
  o += spec.regimes.length;
  const cls = normClass(row.assetClass);
  for (let c = 0; c < spec.classes.length; c++) x[o + c] = spec.classes[c] === cls ? 1 : 0;
  o += spec.classes.length;
  const wz = (v, w) => (isNum(v) ? clamp(v, w[0], w[1]) : w[2]);
  x[o++] = wz(toNum(row.atrPct), spec.winsor.atrPct);
  x[o++] = wz(toNum(row.annVol), spec.winsor.annVol);
  const pr = toNum(row.pRaw);
  x[o++] = Number.isFinite(pr) ? logit(clamp(pr, 0.01, 0.99)) : 0;
  return x;
}

// ─── model fitting (reuses ml.js) ────────────────────────────────────────────────────────────
function resolveModelOpts(opts = {}) {
  const g = { ...DEFAULTS.gbm, ...(opts.gbm || {}) };
  return {
    kind: opts.model || opts.kind || "ensemble",
    l2: opts.l2 != null ? opts.l2 : null,
    l2Grid: Array.isArray(opts.l2Grid) && opts.l2Grid.length ? opts.l2Grid.slice() : DEFAULTS.l2Grid.slice(),
    innerFolds: opts.innerFolds || DEFAULTS.innerFolds,
    innerMax: opts.innerMax || DEFAULTS.innerMax,
    innerTol: opts.innerTol != null ? opts.innerTol : DEFAULTS.innerTol,
    embargoMs: opts.embargoMs || 0,
    seed: opts.seed != null ? opts.seed : DEFAULTS.seed,
    gbm: g,
  };
}

/** Rows of the GBM validation tail's purge gap: fit rows must have label end < T_val − embargo. */
function gbmGap(ts, ends, valFrac, embargoMs) {
  const n = ts.length, nVal = Math.floor(n * valFrac), vs = n - nVal;
  if (nVal <= 0 || vs <= 0) return 0;
  const cutoff = ts[vs] - embargoMs;
  let j = 0;
  while (j < vs && ends[j] < cutoff) j++;
  return vs - j;
}

/**
 * Pick the logistic per-sample L2 by an inner purged walk-forward on (a date-strided subsample
 * of) the training rows. Returns { c, losses: [{c, logloss}] }.
 */
function tuneL2(X, y, ts, ends, mo) {
  const grid = mo.l2Grid;
  if (grid.length === 1) return { c: grid[0], losses: null };
  const n = X.length;
  let sub = Array.from({ length: n }, (_, i) => i);
  if (n > mo.innerMax) {
    const dates = uniqSorted(ts);
    const stride = Math.ceil(n / mo.innerMax);
    const keep = new Set(dates.filter((_, k) => k % stride === 0));
    sub = sub.filter(i => keep.has(ts[i]));
  }
  const folds = purgedWalkForward(sub.map(i => ({ t: ts[i] })), {
    labelEnds: sub.map(i => ends[i]), folds: mo.innerFolds, embargoMs: mo.embargoMs, minTrainFrac: 0.4, minTrainAbs: 100,
  });
  const fallback = grid[Math.floor(grid.length / 2)];
  if (!folds.length) return { c: fallback, losses: null };
  const tot = new Array(grid.length).fill(0);
  let cnt = 0;
  for (const f of folds) {
    const Xtr = f.train.map(k => X[sub[k]]), ytr = f.train.map(k => y[sub[k]]);
    const Xte = f.test.map(k => X[sub[k]]), yte = f.test.map(k => y[sub[k]]);
    grid.forEach((c, g) => {
      const m = new LogisticModel().fit(Xtr, ytr, { l2: c * Xtr.length, epochs: 12, tol: 1e-5 });
      for (let i = 0; i < Xte.length; i++) tot[g] += logloss1(m.predictProba(Xte[i]), yte[i]);
    });
    cnt += Xte.length;
  }
  const losses = grid.map((c, g) => ({ c, logloss: tot[g] / cnt }));
  const best = Math.min(...losses.map(l => l.logloss));
  // strongest penalty among the near-best grid points (one-standard-error-style tie break)
  const c = Math.max(...losses.filter(l => l.logloss <= best + mo.innerTol).map(l => l.c));
  return { c, losses: losses.map(l => ({ c: l.c, logloss: r6(l.logloss) })) };
}

/**
 * Fit the requested model(s) on time-ordered rows. ts / ends: row times and label ends (ms).
 * Returns { kind, logistic, gbm, l2c, cv, gbmTrees, baseRate, n }.
 */
function fitModel(X, y, ts, ends, modelOpts = {}) {
  const mo = modelOpts.l2Grid ? modelOpts : resolveModelOpts(modelOpts);
  const n = X.length;
  const out = { kind: mo.kind, logistic: null, gbm: null, l2c: null, cv: null, gbmTrees: 0, baseRate: n ? mean(y) : 0.5, n };
  if (!MODELS.includes(mo.kind)) throw new Error(`unknown model "${mo.kind}" (expected ${MODELS.join("|")})`);
  if (!n) return out;
  if (mo.kind !== "gbm") {
    const tune = mo.l2 != null ? { c: mo.l2, losses: null } : tuneL2(X, y, ts, ends, mo);
    out.l2c = tune.c; out.cv = tune.losses;
    out.logistic = new LogisticModel().fit(X, y, { l2: tune.c * n, epochs: 30, tol: 1e-6 });
  }
  if (mo.kind !== "logistic") {
    const g = mo.gbm;
    const minLeaf = Math.max(g.minLeafMin, Math.ceil(g.minLeafFrac * n));
    const gap = gbmGap(ts, ends, g.valFrac, mo.embargoMs);
    out.gbm = new GBMClassifier({
      nTrees: g.nTrees, depth: g.depth, lr: g.lr, subsample: g.subsample, maxBins: g.maxBins, lambda: g.lambda,
      minLeaf, valFrac: g.valFrac, patience: g.patience, gap, seed: mo.seed,
    }).fit(X, y);
    out.gbmTrees = out.gbm.bestIter;
  }
  return out;
}

/** { p, pLog, pGbm } for a fitted model bundle ({kind, logistic, gbm}). */
function predictModel(m, x) {
  const pLog = m.logistic ? m.logistic.predictProba(x) : null;
  const pGbm = m.gbm ? m.gbm.predictProba(x) : null;
  const p = m.kind === "logistic" ? pLog : m.kind === "gbm" ? pGbm : (pLog + pGbm) / 2;
  return { p: clipP(p), pLog, pGbm };
}

// ─── statistics ──────────────────────────────────────────────────────────────────────────────
function lgamma(x) { // Lanczos (g = 7, n = 9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a, b, x) { // continued fraction for I_x(a, b) (modified Lentz)
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function normCdf(z) { // W. J. Cody-grade via erfc (Numerical Recipes erfcc, |rel err| < 1.2e-7)
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.5 * x);
  const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? 1 - r / 2 : r / 2;
}
/** Student-t CDF with nu degrees of freedom (normal for nu > 1e6). */
function tCdf(t, nu) {
  if (Number.isNaN(t)) return NaN;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (!(nu > 0) || nu > 1e6) return normCdf(t);
  const tail = 0.5 * ibeta(nu / (nu + t * t), nu / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/**
 * Driscoll–Kraay test of H0: E[v] = 0 for per-row values v with a date for each row.
 * Rows are summed by date (absorbs cross-sectional correlation), then a Newey–West (Bartlett)
 * long-run variance over the date series with `lag` handles serial correlation / label overlap.
 * Without dates every row is its own date (= classic Newey–West). HLN small-sample factor with
 * h = lag and Student-t(T − 1) p-values.
 * Returns { mean, se, stat, p (two-sided), pLess (H1: mean < 0), pGreater, nDates, nRows, lag }.
 */
function hacMeanTest(values, { dates = null, lag = 1, hln = true } = {}) {
  const v = [], dt = [];
  for (let i = 0; i < (values || []).length; i++) {
    if (!Number.isFinite(values[i])) continue;
    v.push(values[i]); dt.push(dates ? dates[i] : i);
  }
  const N = v.length;
  const empty = { mean: N ? mean(v) : null, se: null, stat: 0, p: 1, pLess: 1, pGreater: 1, nDates: 0, nRows: N, lag };
  if (N < 3) return empty;
  const m = mean(v);
  const byDate = new Map();
  for (let i = 0; i < N; i++) byDate.set(dt[i], (byDate.get(dt[i]) || 0) + (v[i] - m));
  const keys = [...byDate.keys()].sort((a, b) => a - b);
  const S = keys.map(k => byDate.get(k));
  const T = S.length;
  if (T < 3) return { ...empty, nDates: T };
  const L = Math.max(0, Math.min(Math.floor(lag), T - 2));
  let lrv = 0;
  for (let t = 0; t < T; t++) lrv += S[t] * S[t];
  const g0 = lrv;
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let t = l; t < T; t++) g += S[t] * S[t - l];
    lrv += 2 * (1 - l / (L + 1)) * g;
  }
  if (!(lrv > 0)) lrv = g0;
  const se = Math.sqrt(lrv) / N;
  if (!(se > 0)) return { ...empty, mean: m, nDates: T };
  let stat = m / se;
  if (hln) {
    const h = Math.max(1, L);
    const f = (T + 1 - 2 * h + (h * (h - 1)) / T) / T;
    if (f > 0) stat *= Math.sqrt(f);
  }
  const cdf = tCdf(stat, T - 1);
  return { mean: m, se, stat, p: Math.min(1, 2 * Math.min(cdf, 1 - cdf)), pLess: cdf, pGreater: 1 - cdf, nDates: T, nRows: N, lag: L };
}

/**
 * Diebold–Mariano test of equal predictive accuracy from per-row losses (model A vs model B).
 * d = lossA − lossB; stat < 0 ⇔ A has lower loss. `dates` (one per row) turns on the
 * Driscoll–Kraay date aggregation; `lag` = Newey–West lag in dates (use `ahead`).
 * Returns { stat, p (two-sided), pOneSided (H1: A better), meanDiff, se, nDates, nRows, lag }.
 */
function dieboldMariano(lossA, lossB, { dates = null, lag = 1, hln = true } = {}) {
  const n = Math.min(lossA.length, lossB.length);
  const d = new Array(n);
  for (let i = 0; i < n; i++) d[i] = lossA[i] - lossB[i];
  const r = hacMeanTest(d, { dates, lag, hln });
  return { stat: r.stat, p: r.p, pOneSided: r.pLess, meanDiff: r.mean, se: r.se, nDates: r.nDates, nRows: r.nRows, lag: r.lag };
}

/** { n, auc, brier, logloss } of preds[key] vs preds.y. */
function probMetrics(preds, key = "p") {
  const n = preds.length;
  if (!n) return { n: 0, auc: null, brier: null, logloss: null };
  let br = 0, ll = 0;
  const ps = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = clipP(preds[i][key]), y = preds[i].y;
    br += (p - y) ** 2; ll += logloss1(p, y); ps[i] = { p, y };
  }
  return { n, auc: r6(auc(ps)), brier: r6(br / n), logloss: r6(ll / n) };
}

/** Weighted Mann–Whitney AUC over rows pre-sorted by score (order), weights w (bootstrap counts). */
function weightedAuc(order, score, y, w) {
  let P = 0, N = 0, num = 0, negBelow = 0;
  for (let i = 0; i < order.length;) {
    let j = i, gp = 0, gn = 0;
    while (j < order.length && score[order[j]] === score[order[i]]) {
      const k = order[j];
      if (w[k]) { if (y[k]) gp += w[k]; else gn += w[k]; }
      j++;
    }
    num += gp * negBelow + 0.5 * gp * gn;
    negBelow += gn; P += gp; N += gn;
    i = j;
  }
  return P > 0 && N > 0 ? num / (P * N) : 0.5;
}

/**
 * Moving-block bootstrap over DATES (circular blocks of `block` consecutive dates) of the AUC of
 * each key and of the difference keys[0] − keys[1]. Returns { [key]: [lo, hi], diff: [lo, hi], reps }.
 */
function aucBlockBootstrap(preds, keys, { reps = DEFAULTS.bootstrapReps, block = 10, seed = DEFAULTS.seed, alpha = 0.05 } = {}) {
  const n = preds.length;
  if (n < 20 || reps < 10) return null;
  const dates = uniqSorted(preds.map(q => q.t));
  const T = dates.length, di = new Map(dates.map((d, k) => [d, k]));
  const rowDate = preds.map(q => di.get(q.t));
  const byDate = Array.from({ length: T }, () => []);
  rowDate.forEach((d, i) => byDate[d].push(i));
  const y = preds.map(q => q.y);
  const sc = keys.map(k => preds.map(q => clipP(q[k])));
  const orders = sc.map(s => Array.from({ length: n }, (_, i) => i).sort((a, b) => s[a] - s[b]));
  const rnd = mulberry32(seed);
  const L = Math.max(1, Math.min(block, T));
  const nBlocks = Math.ceil(T / L);
  const res = keys.map(() => []), diff = [];
  const w = new Float64Array(n);
  for (let r = 0; r < reps; r++) {
    w.fill(0);
    for (let b = 0; b < nBlocks; b++) {
      const s = Math.floor(rnd() * T);
      for (let q = 0; q < L; q++) for (const i of byDate[(s + q) % T]) w[i] += 1;
    }
    const a = keys.map((_, k) => weightedAuc(orders[k], sc[k], y, w));
    a.forEach((v, k) => res[k].push(v));
    if (keys.length > 1) diff.push(a[0] - a[1]);
  }
  const ci = xs => { const s = xs.slice().sort((u, v) => u - v); return [r6(quantile(s, alpha / 2)), r6(quantile(s, 1 - alpha / 2))]; };
  const out = { reps, block: L };
  keys.forEach((k, j) => { out[k] = ci(res[j]); });
  if (diff.length) out.diff = ci(diff);
  return out;
}

/** NW lag in DATES for an `ahead`-bar label: ceil(ahead·tf / median date spacing). */
function lagInDates(ts, ahead, tf) {
  const d = uniqSorted(ts);
  if (d.length < 2) return ahead;
  const gaps = [];
  for (let k = 1; k < d.length; k++) gaps.push(d[k] - d[k - 1]);
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  return Math.max(1, Math.ceil((ahead * tf * 1000) / Math.max(med, 1)));
}

/**
 * Calibrator on panel pairs [{p, y, t}] with n_eff = nDates / ahead (passed to Calibrator as an
 * effective `ahead` = ahead · rows-per-date). Dates, not rows, are the independent unit.
 */
function fitPanelCalibrator(pairs, ahead) {
  const nDates = new Set(pairs.map(q => q.t)).size || 1;
  const effAhead = Math.max(ahead, (ahead * pairs.length) / nDates);
  return new Calibrator().fit(pairs.map(q => ({ p: q.p, y: q.y })), { ahead: effAhead });
}

// ─── the Stacker ─────────────────────────────────────────────────────────────────────────────
class Stacker {
  constructor(o = {}) {
    this.spec = o.spec || null;
    this.target = o.target || "y";
    this.kind = o.kind || "ensemble";
    this.logistic = o.logistic || null;
    this.gbm = o.gbm || null;
    this.baseRate = Number.isFinite(o.baseRate) ? o.baseRate : 0.5;
    this.calibrator = o.calibrator || null;
    this.l2c = o.l2c != null ? o.l2c : null;
    this.nTrain = o.nTrain || 0;
    this.trainedThrough = o.trainedThrough != null ? o.trainedThrough : null;
    this.horizon = o.horizon || null;
    this.ahead = o.ahead || null;
    this.tf = o.tf || null;
    this.summary = o.summary || null;
  }

  featurize(row) { return featurize(row, this.spec); }

  /** { p: calibrated, pModel: uncalibrated ensemble, pLog, pGbm }. */
  predictDetail(row) {
    if (!this.spec) return { p: this.baseRate, pModel: this.baseRate, pLog: null, pGbm: null };
    const x = featurize(row, this.spec);
    const pr = predictModel(this, x);
    const p = this.calibrator ? this.calibrator.apply(pr.p) : pr.p;
    return { p, pModel: pr.p, pLog: pr.pLog, pGbm: pr.pGbm };
  }

  /** Uncalibrated model probability (the quantity evaluated in metrics.auc/brier/logloss). */
  predictRaw(row) { return this.predictDetail(row).pModel; }

  /** Calibrated P(target = 1) for a dataset row or a live row (same keys). */
  predict(row) { return this.predictDetail(row).p; }

  toJSON() {
    return {
      v: 1, type: "stacker", target: this.target, kind: this.kind, spec: this.spec,
      logistic: this.logistic ? this.logistic.toJSON() : null, gbm: this.gbm ? this.gbm.toJSON() : null,
      baseRate: this.baseRate, calibrator: this.calibrator ? this.calibrator.toJSON() : null, l2c: this.l2c,
      nTrain: this.nTrain, trainedThrough: this.trainedThrough, horizon: this.horizon, ahead: this.ahead, tf: this.tf,
      summary: this.summary,
    };
  }

  static fromJSON(o) {
    if (typeof o === "string") o = JSON.parse(o);
    if (!o || typeof o !== "object") return new Stacker();
    return new Stacker({
      ...o,
      logistic: o.logistic ? LogisticModel.fromJSON(o.logistic) : null,
      gbm: o.gbm ? GBMClassifier.fromJSON(o.gbm) : null,
      calibrator: o.calibrator ? Calibrator.fromJSON(o.calibrator) : null,
    });
  }
}

// ─── training ────────────────────────────────────────────────────────────────────────────────
/**
 * Eligible rows for a target: labelled, and (yEx) not a benchmark. Returns
 * { rows, y, ends } sorted by (t, assetId), ends = label end ms computed on the full dataset.
 */
function prepareRows(dataset, target, { ahead, tf }) {
  const all = sortRows(dataset.rows);
  const endsAll = computeLabelEnds(all, { ahead, tf, useLabEnd: !dataset.ahead || ahead === dataset.ahead });
  const bench = new Set(Object.values(dataset.benchmarks || {}));
  const rows = [], y = [], ends = [];
  for (let k = 0; k < all.length; k++) {
    const r = all[k];
    const lab = labelOf(r, target);
    if (lab === null) continue;
    if (target === "yEx" && bench.has(r.assetId)) continue;
    rows.push(r); y.push(lab); ends.push(endsAll[k]);
  }
  return { rows, y, ends, all, endsAll };
}

/**
 * Train + honestly evaluate a stacker. opts: { target="y", mask, model="ensemble", purge=ahead,
 * embargo (bars), folds=5, minTrain, minTrainFrac=0.3, l2, l2Grid, innerFolds, innerMax, gbm,
 * seed, bootstrapReps, horizon }. See the header for the method. Returns
 * { model: Stacker|null, spec, oos: [...], metrics, trainedThrough, params, timing }.
 */
function trainStacker(dataset, opts = {}) {
  const started = Date.now();
  if (!dataset || !Array.isArray(dataset.rows)) throw new TypeError("trainStacker: dataset.rows is required");
  const target = opts.target || "y";
  if (!TARGETS.includes(target)) throw new Error(`unknown target "${target}"`);
  const kind = opts.model || "ensemble";
  if (!MODELS.includes(kind)) throw new Error(`unknown model "${kind}"`);
  const tf = Number(dataset.tf) || 86400, tfMs = tf * 1000;
  const ahead = Math.max(1, Math.floor(opts.ahead || dataset.ahead || 5));
  const purge = opts.purge != null ? opts.purge : ahead;
  const mask = opts.mask || null;
  const { rows, y: Y, ends } = prepareRows(dataset, target, { ahead: purge, tf });
  const nDates = new Set(rows.map(r => r.t)).size;
  const embargo = opts.embargo != null ? opts.embargo : Math.max(1, Math.ceil(0.01 * nDates));
  const embargoMs = embargo * tfMs;
  const mo = resolveModelOpts({ ...opts, model: kind, embargoMs });
  const params = {
    target, model: kind, ahead, purge, embargo, tf, folds: opts.folds || DEFAULTS.folds, horizon: opts.horizon || dataset.horizon || null,
    minTrainFrac: opts.minTrainFrac != null ? opts.minTrainFrac : DEFAULTS.minTrainFrac, l2Grid: mo.l2Grid, gbm: mo.gbm, seed: mo.seed,
    tbLongLabel: "1 iff lab.tbLongRet > 0 (long bracket profitable net of costs)",
  };
  const folds = purgedWalkForward(rows, {
    labelEnds: ends, folds: params.folds, embargoMs, minTrain: opts.minTrain, minTrainFrac: params.minTrainFrac,
  });
  const empty = reason => ({ model: null, spec: null, oos: [], metrics: { n: 0, reason }, trainedThrough: null, params, timing: { ms: Date.now() - started } });
  if (!folds.length) return empty(`not enough labelled rows (${rows.length}) for a purged walk-forward`);

  const oos = [], perFold = [];
  const pRawOf = r => (isNum(r.pRaw) ? r.pRaw : 0.5);
  for (const f of folds) {
    const tFold = Date.now();
    const trR = f.train.map(k => rows[k]), ytr = f.train.map(k => Y[k]);
    const spec = makeSpec(trR, { mask, signalIds: dataset.signalIds });
    const Xtr = trR.map(r => featurize(r, spec));
    const m = fitModel(Xtr, ytr, trR.map(r => r.t), f.train.map(k => ends[k]), mo);
    const base = m.baseRate;
    const cal = fitPanelCalibrator(trR.map((r, j) => ({ p: pRawOf(r), y: ytr[j], t: r.t })), ahead);
    const foldPreds = [];
    for (const k of f.test) {
      const r = rows[k];
      const pr = predictModel(m, featurize(r, spec));
      const o = {
        t: r.t, assetId: r.assetId, p: pr.p, y: Y[k], pBaseline: cal.apply(pRawOf(r)), pBase: base,
        pLog: pr.pLog, pGbm: pr.pGbm, pRaw: isNum(r.pRaw) ? r.pRaw : null, fold: f.k, tEnd: ends[k], pCal: null,
      };
      oos.push(o); foldPreds.push(o);
    }
    const fm = probMetrics(foldPreds, "p"), fb = probMetrics(foldPreds, "pBaseline");
    perFold.push({
      k: f.k, testStart: f.testStart, testEnd: f.testEnd, nTrain: f.train.length, nTest: f.test.length, nFeatures: spec.names.length,
      l2c: m.l2c, cv: m.cv, gbmTrees: m.gbmTrees, baseRate: r6(base), auc: fm.auc, logloss: fm.logloss,
      aucBaseline: fb.auc, loglossBaseline: fb.logloss, ms: Date.now() - tFold,
    });
  }

  // Sequential (honest) calibration of the stacker output: fold k uses OOS preds of folds < k
  // whose labels ended before fold k's cutoff.
  for (let b = 1; b < folds.length; b++) {
    const pairs = oos.filter(o => o.fold < b && o.tEnd < folds[b].cutoff);
    if (pairs.length < 100) continue;
    const cal = fitPanelCalibrator(pairs, ahead);
    for (const o of oos) if (o.fold === b) o.pCal = cal.apply(o.p);
  }

  // ── metrics on the SAME OOS rows ──
  const lag = lagInDates(oos.map(o => o.t), ahead, tf);
  const dates = oos.map(o => o.t);
  const ll = key => oos.map(o => logloss1(o[key], o.y));
  const mS = probMetrics(oos, "p"), mB = probMetrics(oos, "pBaseline"), mR = probMetrics(oos, "pBase");
  const dm = dieboldMariano(ll("p"), ll("pBaseline"), { dates, lag });
  const dmBase = dieboldMariano(ll("p"), ll("pBase"), { dates, lag });
  const cr = oos.filter(o => o.pCal !== null);
  const calibrated = cr.length ? (() => {
    const a = probMetrics(cr, "pCal"), b = probMetrics(cr, "pBaseline"), raw = probMetrics(cr, "p");
    const dmc = dieboldMariano(cr.map(o => logloss1(o.pCal, o.y)), cr.map(o => logloss1(o.pBaseline, o.y)), { dates: cr.map(o => o.t), lag });
    return { n: a.n, auc: a.auc, brier: a.brier, logloss: a.logloss, loglossUncalibrated: raw.logloss, brierBaseline: b.brier, loglossBaseline: b.logloss, dm: roundDm(dmc) };
  })() : null;
  const withRaw = oos.filter(o => o.pRaw !== null);
  const boot = aucBlockBootstrap(oos, ["p", "pBaseline"], { reps: opts.bootstrapReps != null ? opts.bootstrapReps : DEFAULTS.bootstrapReps, block: 2 * lag, seed: mo.seed });
  const metrics = {
    target, model: kind, n: oos.length, nDates: new Set(dates).size, folds: folds.length,
    auc: mS.auc, brier: mS.brier, logloss: mS.logloss,
    aucBaseline: mB.auc, brierBaseline: mB.brier, loglossBaseline: mB.logloss,
    baseRate: { auc: mR.auc, brier: mR.brier, logloss: mR.logloss },
    brierSkill: mB.brier ? r6(1 - mS.brier / mB.brier) : null,
    brierSkillVsBase: mR.brier ? r6(1 - mS.brier / mR.brier) : null,
    dm: roundDm(dm), dmVsBase: roundDm(dmBase),
    aucCI: boot ? boot.p : null, aucBaselineCI: boot ? boot.pBaseline : null, aucDiffCI: boot ? boot.diff : null,
    logistic: kind !== "gbm" ? probMetrics(oos, "pLog") : null,
    gbm: kind !== "logistic" ? probMetrics(oos, "pGbm") : null,
    pRawAuc: withRaw.length ? probMetrics(withRaw, "pRaw").auc : null,
    oosBaseRate: r6(mean(oos.map(o => o.y))),
    calibrated,
    perFold,
    lag,
  };

  // ── final model on every labelled row + OOS calibrator ──
  const tFinal = Date.now();
  const spec = makeSpec(rows, { mask, signalIds: dataset.signalIds });
  const X = rows.map(r => featurize(r, spec));
  const fm = fitModel(X, Y, rows.map(r => r.t), ends, mo);
  const calibrator = fitPanelCalibrator(oos.map(o => ({ p: o.p, y: o.y, t: o.t })), ahead);
  const trainedThrough = rows.length ? rows[rows.length - 1].t : null;
  const model = new Stacker({
    spec, target, kind, logistic: fm.logistic, gbm: fm.gbm, baseRate: fm.baseRate, calibrator, l2c: fm.l2c, nTrain: rows.length,
    trainedThrough, horizon: params.horizon, ahead, tf,
    summary: { auc: metrics.auc, logloss: metrics.logloss, loglossBaseline: metrics.loglossBaseline, dmP: metrics.dm.p, n: metrics.n },
  });
  return {
    model, spec, target,
    oos: oos.map(o => ({
      t: o.t, assetId: o.assetId, p: o.p, y: o.y, pBaseline: o.pBaseline, pBase: o.pBase, pCal: o.pCal,
      pLog: o.pLog, pGbm: o.pGbm, pRaw: o.pRaw, fold: o.fold, tEnd: o.tEnd,
    })),
    metrics, trainedThrough, labelsThrough: ends.reduce((a, v) => (v > a ? v : a), -Infinity), params,
    timing: { ms: Date.now() - started, finalMs: Date.now() - tFinal, foldsMs: perFold.map(f => f.ms) },
  };
}

function roundDm(d) {
  return { stat: r6(d.stat), p: r6(d.p), pOneSided: r6(d.pOneSided), meanDiff: r6(d.meanDiff), se: r6(d.se), nDates: d.nDates, nRows: d.nRows, lag: d.lag };
}

// ─── deterministic synthetic panel (tests / benchmarks) ─────────────────────────────────────
const SYNTH_IDS = [
  "tech.trend.ema_stack", "tech.trend.supertrend", "tech.trend.kalman", "tech.momentum.rsi", "tech.momentum.macd",
  "tech.momentum.tsmom", "tech.meanrev.bollinger", "tech.meanrev.zscore", "tech.volume.breakout", "tech.structure.donchian",
  "regime.trend.state", "regime.vol.level", "macro.risk.vix", "macro.rates.momentum", "macro.fx.dollar",
  "rel.rs.1m", "rel.rs.3m", "rel.xs.mom_rank", "rel.xs.reversal_1w", "rel.beta", "sent.feargreed.contrarian",
];

/**
 * Deterministic contract-shaped synthetic panel dataset (§1 row format) for tests/benchmarks.
 * opts: { nAssets=20, nDates=600, seed=1, ahead=5, cryptoFrac=0.25, extraSignals=0,
 *         plant: { id, beta } | null   — 5-day return drift = beta·σ5·(score·conf of id)
 *         pRawSkill = 0                 — how much the planted signal leaks into pRaw
 *         meta: { id, kappa } | null    — primary (pRaw) direction is right only when id is high:
 *                                         drift = kappa·σ5·side(pRaw)·2·max(0, score·conf of id)
 *         phi = 0.9 (signal persistence), rho = 0.5 (market-factor share of return variance) }
 * Returns overlapping 5-day labels built from daily shocks (so labels overlap across dates and
 * are cross-sectionally correlated). The last `ahead` dates have lab = null.
 */
function synthDataset(opts = {}) {
  const { nAssets = 20, nDates = 600, seed = 1, ahead = 5, cryptoFrac = 0.25, plant = null, pRawSkill = 0,
    meta = null, phi = 0.9, rho = 0.5, extraSignals = 0 } = opts;
  const rnd = mulberry32(seed);
  const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const ids = SYNTH_IDS.concat(Array.from({ length: extraSignals }, (_, k) => `tech.extra.s${k}`));
  const nCrypto = Math.max(1, Math.round(nAssets * cryptoFrac));
  const assets = Array.from({ length: nAssets }, (_, a) => {
    const crypto = a >= nAssets - nCrypto;
    const sym = crypto ? (a === nAssets - nCrypto ? "BTC" : `C${a}`) : a === 0 ? "SPY" : `S${a}`;
    return { id: `${crypto ? "CRYPTO" : "STOCK"}:${sym}`, cls: crypto ? "crypto" : "stock", bench: sym === "SPY" || sym === "BTC", sigma: (crypto ? 0.035 : 0.015) * (0.7 + 0.6 * rnd()) };
  });
  const T = nDates + ahead + 1;
  const t0 = Date.UTC(2021, 0, 4);
  const mkt = Array.from({ length: T }, () => gauss());
  const cmkt = Array.from({ length: T }, () => gauss());
  // latent AR(1) states per asset × signal, fear-greed per date, macro per date
  const lat = assets.map(() => ids.map(() => gauss()));
  const conf = assets.map(() => ids.map(() => 0.3 + 0.7 * rnd()));
  const rows = [];
  const macroStart = Math.floor(0.2 * nDates);
  const daily = assets.map(() => new Float64Array(T));
  const pend = [];
  const sqrtA = Math.sqrt(ahead);
  for (let d = 0; d < T; d++) {
    for (let a = 0; a < nAssets; a++) {
      const A = assets[a];
      for (let s = 0; s < ids.length; s++) {
        lat[a][s] = phi * lat[a][s] + Math.sqrt(1 - phi * phi) * gauss();
        if (rnd() < 0.05) conf[a][s] = 0.3 + 0.7 * rnd();
      }
      const f = A.cls === "crypto" ? cmkt[d] : mkt[d];
      // benchmarks (SPY, BTC) ARE their market factor; other assets load rho on it
      daily[a][d] = A.bench ? A.sigma * f : A.sigma * (Math.sqrt(rho) * f + Math.sqrt(1 - rho) * gauss());
      if (d >= nDates) continue;
      const sig = {};
      ids.forEach((id, s) => {
        if (id.startsWith("macro.") && d < macroStart) return;
        if (id === "sent.feargreed.contrarian" && A.cls !== "crypto") return;
        sig[id] = [+Math.tanh(0.8 * lat[a][s]).toFixed(4), +conf[a][s].toFixed(3)];
      });
      const sc = id => (sig[id] ? sig[id][0] * sig[id][1] : 0);
      const techMean = ids.filter(id => id.startsWith("tech.")).reduce((acc, id) => acc + sc(id), 0) / 10;
      const plantX = plant ? sc(plant.id) : 0;
      const pRaw = 1 / (1 + Math.exp(-(0.25 * techMean + pRawSkill * plantX + 0.1 * gauss())));
      const trendL = lat[a][0], volL = lat[a][11];
      const regime = {
        trend: trendL > 0.5 ? "up" : trendL < -0.5 ? "down" : "range",
        vol: volL > 1.3 ? "extreme" : volL > 0.5 ? "high" : volL < -0.7 ? "low" : "normal",
        hmmState: A.cls === "crypto" ? (lat[a][12] > 0.4 ? 2 : lat[a][12] < -0.4 ? 0 : 1) : (lat[a][12] > 0 ? 1 : 0),
      };
      regime.label = `${regime.trend === "range" ? "ranging" : "trending-" + regime.trend}/${regime.vol}-vol`;
      const annVol = A.sigma * Math.sqrt(A.cls === "crypto" ? 365 : 252) * (1 + 0.2 * volL);
      pend.push({ a, d, sig, pRaw, plantX, metaX: meta ? sc(meta.id) : 0, regime, annVol });
    }
  }
  const benchIdx = { stock: assets.findIndex(A => A.id === "STOCK:SPY"), crypto: assets.findIndex(A => A.id === "CRYPTO:BTC") };
  const fwd = (a, d) => { let s = 0; for (let j = 1; j <= ahead; j++) s += daily[a][d + j]; return s; };
  const drift = pend.map(q => {
    const A = assets[q.a], s5 = A.sigma * sqrtA;
    let mu = plant ? plant.beta * s5 * q.plantX : 0;
    if (meta) mu += meta.kappa * s5 * (q.pRaw >= 0.5 ? 1 : -1) * 2 * Math.max(0, q.metaX);
    return mu;
  });
  const retOf = new Map();
  pend.forEach((q, k) => { if (q.d + ahead < T) retOf.set(`${q.a}|${q.d}`, fwd(q.a, q.d) + drift[k]); });
  const fee = { stock: 0.0012, crypto: 0.003 };
  pend.forEach(q => {
    const A = assets[q.a];
    const atrPct = 1.2 * A.sigma * (1 + 0.2 * (q.annVol / (A.sigma * Math.sqrt(A.cls === "crypto" ? 365 : 252)) - 1));
    let lab = null;
    if (q.d < nDates - ahead) {
      const ret = retOf.get(`${q.a}|${q.d}`);
      const b = benchIdx[A.cls];
      const exRet = q.a === b ? 0 : ret - retOf.get(`${b}|${q.d}`);
      const stop = 2 * atrPct, tgt = 3 * atrPct;
      const tb = r => (r >= tgt ? 1 : r <= -stop ? -1 : 0);
      const tbRet = r => clamp(r, -stop, tgt) - fee[A.cls];
      lab = {
        ret: +ret.toFixed(6), exRet: +exRet.toFixed(6), y: ret > 0 ? 1 : 0, yEx: exRet > 0 ? 1 : 0,
        tbLong: tb(ret), tbShort: tb(-ret), tbLongRet: +tbRet(ret).toFixed(6), tbShortRet: +tbRet(-ret).toFixed(6),
        tEnd: t0 + (q.d + ahead) * DAY_MS,
      };
    }
    const fam = {};
    for (const [id, pr] of Object.entries(q.sig)) {
      const f = familyOf(id);
      (fam[f] = fam[f] || []).push(pr[0] * pr[1]);
    }
    for (const f of Object.keys(fam)) fam[f] = +mean(fam[f]).toFixed(4);
    rows.push({
      assetId: A.id, symbol: A.id.split(":")[1], assetClass: A.cls, t: t0 + q.d * DAY_MS, i: q.d + 300,
      price: 100, atrPct: +atrPct.toFixed(5), annVol: +q.annVol.toFixed(4), regime: q.regime, sig: q.sig, fam,
      pRaw: +q.pRaw.toFixed(4), lab,
    });
  });
  rows.sort(cmpRows);
  return {
    version: 2, horizon: "swing", tf: 86400, ahead, built: new Date(t0).toISOString(), universe: assets.map(A => A.id),
    benchmarks: { stock: "STOCK:SPY", crypto: "CRYPTO:BTC" }, signalIds: ids, rows, synthetic: true,
  };
}

module.exports = {
  featurize, makeSpec, trainStacker, Stacker, dieboldMariano, purgedWalkForward,
  // building blocks reused by metaLabel.js / tests / the self-improvement loop
  computeLabelEnds, labelOf, prepareRows, fitModel, predictModel, resolveModelOpts, probMetrics, hacMeanTest,
  aucBlockBootstrap, lagInDates, fitPanelCalibrator, familyOf, sigPair, sortRows, tCdf, normCdf, synthDataset,
  TARGETS, MODELS, DEFAULTS, FAMILY_PREFIX,
};
