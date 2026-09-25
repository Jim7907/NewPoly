// Self-improvement loop (docs/CONTRACT-v2.md §5, selfImprove.js).
//
//   runCycle({ horizon, reason }) → Promise<CycleReport>     (never rejects; failures → ok:false)
//   schedule({ everyMs = 6h, horizons = [current], onReport, firstDelayMs = 2 min, depsModule, cycleOpts })
//   status(horizon?) → { running, current, queue, nextRunAt, lastReport, drift:{level, stat}, derisk, … }
//   stop()           → clears timers, terminates a running cycle, flushes state
//   onResolved({ horizon, p, y, decision })  ← engine, once per resolved live decision
//
// A CYCLE (computeCycle, executed in a worker thread — server/learning/cycleWorker.js):
//   1. dataset: load the cached panel (data/research/<horizon>.json.gz) and update it
//      incrementally, or build it (dataset.js); save it back.
//   2. split by date: HOLDOUT = labelled rows on the most recent holdoutFrac (20%) of dates;
//      TRAINING WINDOW = rows whose label window ends (lab.tEnd, exact) before the holdout starts.
//      Nothing in steps 3–5 sees the holdout: the report card, mask, stackers, meta-labeler and
//      the calibrated-v1 baseline are all fitted on the training window.
//   3. report card (target "ret") + mask on the training window.
//   4. challenger stackers for y, yEx, tbLong (purged walk-forward inside trainStacker); each is
//      evaluated on the holdout against the champion (as stored — a champion whose training labels
//      overlap the holdout is only compared on the part of the holdout after its labels end) and
//      against the calibrated-v1 baseline (Calibrator fitted on the training window's pRaw).
//   5. meta-labeler with the stacker primary (or pooled when no y-stacker will be live), evaluated
//      on the holdout the same way; the baseline is v1's calibrated side probability.
//   6. thresholds: tuneThresholds (nested walk-forward, DSR, PBO) on out-of-sample predictions of
//      the models that will be live after this cycle.
//   7. PROMOTION GATE (RULES below), then registry writes and the CycleReport
//      (db "cycles:<horizon>", last 50) + report card (db "reportcard:<horizon>").
//
// PROMOTION RULES (all must hold; every decision is logged with its reason, rejections included):
//  stacker / meta challengers — evaluated ONLY on the holdout (never on in-sample metrics):
//   (0) holdout has ≥ minHoldoutRows (200) rows (meta: ≥ minMetaHoldoutRows 100) on ≥ minHoldoutDates (20) dates;
//   (a) holdout log-loss < calibrated-v1 baseline log-loss AND < champion log-loss (if a champion exists),
//       all on the same rows;
//   (b) Diebold–Mariano test on the per-row log-loss differential (reference − challenger),
//       Driscoll–Kraay variance (differentials summed per date, Newey–West over dates, lag =
//       label span in dates ≥ ahead), Harvey–Leybourne–Newbold correction: two-sided p < 0.10 with
//       the challenger better. Reference = the champion when one exists, else the baseline.
//       (Two-sided p < 0.10 in the challenger's favour ≡ one-sided p < 0.05.)
//  mask — promoted only together with the y-stacker that was trained on it (a mask is not a
//       forecaster and cannot be tested on its own; the gate of that stacker applies).
//  thresholds — (c) PBO ≤ 0.5 and deflated Sharpe ≥ 0.5 (tuner.js), plus nested walk-forward OOS
//       mean net return > 0 over ≥ 30 acted decisions, and a learned y-stacker live after the cycle
//       (MIN_PROB_EDGE / metaThreshold are defined on its calibrated probability).
//
// Deployment: a promoted model is the one trained on the TRAINING WINDOW (it never saw the
// holdout), so next cycle's holdout is again unseen by the champion.
//
// DRIFT: onResolved feeds a DriftMonitor per horizon (drift.js) and appends a live record. On
// drift: status().derisk = { until: now + 2 × horizon, minConfidenceBump: 0.05, sizeMult: 0.5 }
// (cleared by the next promotion for that horizon) and, when the scheduler runs, an early cycle
// (at most one per hour per horizon). The live records give each cycle the champion's live
// log-loss vs its holdout (backtest) expectation.
"use strict";

const path = require("path");
const { DriftMonitor, logLoss: driftLogLoss } = require("./drift");
const tuner = require("./tuner");
const { Calibrator } = require("./calibrator");
const registryMod = require("./registry");

// ───────────────────────────── constants ─────────────────────────────

const RULES = Object.freeze({
  holdoutFrac: 0.20,          // most recent 20% of labelled dates
  minHoldoutRows: 200,        // stacker holdout rows (after any restriction)
  minMetaHoldoutRows: 100,    // meta holdout rows (primary trades with a bracket outcome)
  minHoldoutDates: 20,
  dmAlpha: 0.10,              // two-sided Diebold–Mariano p-value must be below this
  pboMax: tuner.RULES.pboMax, // 0.5
  dsrMin: tuner.RULES.dsrMin, // 0.5
  minActivity: tuner.RULES.minActivity,   // 0.15
  minPrecision: tuner.RULES.minPrecision, // 0.55
  minNestedActed: tuner.RULES.minActed,   // 30
});

const DERISK = Object.freeze({ minConfidenceBump: 0.05, sizeMult: 0.5, horizons: 2 });
const EVERY_MS = 6 * 3600e3;
const FIRST_DELAY_MS = 2 * 60e3;
const EARLY_MIN_GAP_MS = 3600e3;
const MAX_CYCLES_KEPT = 50;
const MAX_LIVE_RECORDS = 5000;
const DEFAULT_TIMEOUT_MS = Number(process.env.SELF_IMPROVE_TIMEOUT_MS) || 40 * 60e3;

const CYCLE_DEFAULTS = Object.freeze({
  holdoutFrac: RULES.holdoutFrac,
  targets: ["y", "yEx", "tbLong"],
  stackerModel: "ensemble",
  folds: 4,
  bootstrapReps: 50,
  reportTarget: "ret",
  minN: 200,
  metaMinEdge: 0.02,
  datasetOpts: {},
  useCache: true,
  saveCache: true,
  tune: {},
});

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r6 = (x) => (fin(x) ? +x.toFixed(6) : x == null ? null : x);
const EPS = 1e-6;
const clipP = (p) => Math.min(1 - EPS, Math.max(EPS, fin(p) ? p : 0.5));
const ll1 = (p, y) => { const q = clipP(p); return y ? -Math.log(q) : -Math.log(1 - q); };
const iso = (ms) => (fin(ms) ? new Date(ms).toISOString() : null);
const keyOf = (t, a) => `${t}|${a}`;

// ───────────────────────────── dependencies ─────────────────────────────

/** Default deps: lazy requires of the research modules (so tests can inject stubs instead). */
function defaultDeps() {
  const ds = () => require("../research/dataset");
  const se = () => require("../research/signalEval");
  const st = () => require("../research/stacker");
  const ml = () => require("../research/metaLabel");
  return {
    buildDataset: (o) => ds().buildDataset(o),
    updateDataset: (d, o) => ds().updateDataset(d, o),
    loadDataset: (f) => ds().loadDataset(f),
    saveDataset: (d, f) => ds().saveDataset(d, f),
    reportCard: (d, o) => se().reportCard(d, o),
    signalMask: (r) => se().signalMask(r),
    trainStacker: (d, o) => st().trainStacker(d, o),
    loadStacker: (j) => st().Stacker.fromJSON(j),
    trainMetaLabeler: (d, o) => ml().trainMetaLabeler(d, o),
    loadMeta: (j) => ml().MetaLabeler.fromJSON(j),
    labelOf: (row, target) => st().labelOf(row, target),
  };
}

function resolveDeps(injected) {
  const d = defaultDeps();
  if (injected && typeof injected === "object") for (const [k, v] of Object.entries(injected)) if (typeof v === "function") d[k] = v;
  return d;
}

/** Fallback label definition (identical to stacker.labelOf). */
function fallbackLabel(row, target) {
  const lab = row && row.lab;
  if (!lab) return null;
  const b = (v) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null);
  if (target === "y") return b(lab.y) ?? (fin(lab.ret) ? (lab.ret > 0 ? 1 : 0) : null);
  if (target === "yEx") return lab.exRet === null ? null : b(lab.yEx) ?? (fin(lab.exRet) ? (lab.exRet > 0 ? 1 : 0) : null);
  if (target === "tbLong") return fin(lab.tbLongRet) ? (lab.tbLongRet > 0 ? 1 : 0) : lab.tbLong === 1 ? 1 : lab.tbLong === -1 ? 0 : null;
  return null;
}

// ───────────────────────────── pure helpers ─────────────────────────────

/** Rank AUC (Mann–Whitney, ties averaged). */
function aucOf(ps, ys) {
  const n = ps.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => ps[a] - ps[b]);
  let nPos = 0, sumRank = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && ps[idx[j + 1]] === ps[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (ys[idx[k]] === 1) { nPos++; sumRank += rank; }
    i = j + 1;
  }
  const nNeg = n - nPos;
  return nPos && nNeg ? (sumRank - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : null;
}

function probMetrics(ps, ys) {
  if (!ps || !ps.length) return null;
  let br = 0, ll = 0;
  for (let i = 0; i < ps.length; i++) { const p = clipP(ps[i]); br += (p - ys[i]) ** 2; ll += ll1(p, ys[i]); }
  return { n: ps.length, logloss: r6(ll / ps.length), brier: r6(br / ps.length), auc: r6(aucOf(ps, ys)) };
}

/** Label-end time of a row: dataset lab.tEnd (exact), else a conservative calendar estimate. */
function labelEnd(row, ahead, tf) {
  if (row && row.lab && fin(row.lab.tEnd)) return row.lab.tEnd;
  const tfMs = (tf || 86400) * 1000, DAY = 86400e3;
  const stock = row && row.assetClass !== "crypto";
  if (!stock) return row.t + ahead * tfMs;
  if (tfMs >= DAY) return row.t + Math.ceil((ahead * 7) / 5) * DAY + 3 * DAY;
  return row.t + ahead * tfMs + 3.5 * DAY;
}

/**
 * Split the panel by date. holdout = labelled rows with t ≥ holdoutStart (the date at quantile
 * 1 − holdoutFrac of the labelled dates); train = rows whose label window ends before holdoutStart.
 */
function splitHoldout(rows, { holdoutFrac = RULES.holdoutFrac, ahead = 5, tf = 86400 } = {}) {
  const labelled = rows.filter((r) => r && r.lab);
  const dates = [...new Set(labelled.map((r) => r.t))].sort((a, b) => a - b);
  if (dates.length < 10) return { train: [], holdout: [], holdoutStart: null, holdoutEnd: null, nDates: dates.length, nHoldoutDates: 0 };
  const cut = Math.min(dates.length - 1, Math.max(1, Math.floor(dates.length * (1 - holdoutFrac))));
  const holdoutStart = dates[cut];
  const train = rows.filter((r) => r && r.lab && r.t < holdoutStart && labelEnd(r, ahead, tf) < holdoutStart);
  const holdout = labelled.filter((r) => r.t >= holdoutStart);
  let trainLabelsThrough = -Infinity;
  for (const r of train) trainLabelsThrough = Math.max(trainLabelsThrough, labelEnd(r, ahead, tf));
  return {
    train, holdout, holdoutStart, holdoutEnd: dates[dates.length - 1], nDates: dates.length, nHoldoutDates: dates.length - cut,
    trainEnd: train.length ? train[train.length - 1].t : null, trainLabelsThrough: fin(trainLabelsThrough) ? trainLabelsThrough : null,
  };
}

/** Newey–West lag in dates for the DM test: label span in date-grid steps, at least `ahead`. */
function dmLag(rows, ahead, tf) {
  const ds = [...new Set(rows.map((r) => r.t))].sort((a, b) => a - b);
  if (ds.length < 3) return ahead;
  const gaps = [];
  for (let i = 1; i < ds.length; i++) gaps.push(ds[i] - ds[i - 1]);
  gaps.sort((a, b) => a - b);
  const g = Math.max(1, gaps[gaps.length >> 1]);
  const spans = rows.slice(0, 2000).map((r) => labelEnd(r, ahead, tf) - r.t).sort((a, b) => a - b);
  const span = spans.length ? spans[spans.length >> 1] : ahead * tf * 1000;
  return Math.max(ahead, Math.ceil(span / g));
}

/** Baseline calibrator on (x, y) pairs with n_eff = dates / ahead (dates are the independent unit). */
function fitCalibrator(pairs, ahead) {
  const nDates = new Set(pairs.map((q) => q.t)).size || 1;
  const effAhead = Math.max(ahead, (ahead * pairs.length) / nDates);
  return new Calibrator().fit(pairs.map((q) => ({ p: q.p, y: q.y })), { ahead: effAhead });
}

/**
 * Holdout comparison on identical rows: challenger vs champion (optional) vs baseline.
 * Returns { n, nDates, lag, challenger, champion, baseline, dmBaseline, dmChampion }.
 * DM differential = reference loss − challenger loss (positive ⇒ challenger better).
 */
function evaluateHoldout({ ys, dates, pChallenger, pChampion = null, pBaseline, lag }) {
  const L = (ps) => ps.map((p, i) => ll1(p, ys[i]));
  const lCh = L(pChallenger), lBl = L(pBaseline), lCp = pChampion ? L(pChampion) : null;
  const dm = (lRef) => {
    const r = tuner.dieboldMariano(lRef.map((v, i) => v - lCh[i]), { dates, lag, h: lag });
    return { stat: r6(r.stat), p: r6(r.p), pOneSided: r6(r.pGreater), meanDiff: r6(r.meanDiff), nDates: r.nDates, lag };
  };
  return {
    n: ys.length, nDates: new Set(dates).size, lag,
    challenger: probMetrics(pChallenger, ys), champion: pChampion ? probMetrics(pChampion, ys) : null, baseline: probMetrics(pBaseline, ys),
    dmBaseline: dm(lBl), dmChampion: lCp ? dm(lCp) : null,
  };
}

/**
 * The statistical promotion gate for a forecaster (stacker / meta). Pure.
 * ev: evaluateHoldout(...) (+ ev.championError when the champion could not be evaluated).
 * Returns { promote, reason, checks: [{ rule, pass, detail }] }.
 */
function promotionDecision(ev, { hasChampion = false, minRows = RULES.minHoldoutRows, minDates = RULES.minHoldoutDates, alpha = RULES.dmAlpha } = {}) {
  const checks = [];
  const add = (rule, pass, detail) => checks.push({ rule, pass: !!pass, detail });
  const f4 = (x) => (fin(x) ? x.toFixed(4) : "n/a");
  if (!ev || !ev.challenger) {
    add("holdout", false, "challenger could not be evaluated on the holdout");
  } else {
    add("(0) holdout size", ev.n >= minRows && ev.nDates >= minDates, `n=${ev.n} rows on ${ev.nDates} dates (need ≥ ${minRows} / ${minDates})`);
    if (hasChampion && !ev.champion) add("(0) champion evaluable", false, ev.championError || "champion could not be evaluated on the same holdout rows");
    const ch = ev.challenger.logloss, bl = ev.baseline && ev.baseline.logloss;
    add("(a) log-loss < calibrated-v1 baseline", fin(ch) && fin(bl) && ch < bl, `holdout log-loss ${f4(ch)} vs baseline ${f4(bl)}`);
    if (hasChampion && ev.champion) add("(a) log-loss < champion", fin(ch) && ch < ev.champion.logloss, `holdout log-loss ${f4(ch)} vs champion ${f4(ev.champion.logloss)}`);
    const ref = hasChampion ? ev.dmChampion : ev.dmBaseline;
    const refName = hasChampion ? "champion" : "baseline";
    if (ref) add(`(b) Diebold–Mariano vs ${refName} p < ${alpha}`, ref.stat > 0 && ref.p < alpha, `DM stat ${f4(ref.stat)} (positive = challenger better), two-sided p ${f4(ref.p)}, lag ${ref.lag}, ${ref.nDates} dates`);
    else add(`(b) Diebold–Mariano vs ${refName}`, false, "not computable");
  }
  const failed = checks.filter((c) => !c.pass);
  const promote = failed.length === 0;
  const reason = promote
    ? `promoted: ${checks.map((c) => `${c.rule}: ${c.detail}`).join("; ")}`
    : `rejected: ${failed.map((c) => `${c.rule} failed — ${c.detail}`).join("; ")}`;
  return { promote, reason, checks };
}

function summarizeReportCard(rc, mask) {
  const sigs = Object.values((rc && rc.signals) || {});
  const count = {};
  for (const s of sigs) { const v = s.verdict || "unknown"; count[v] = (count[v] || 0) + 1; }
  const top = sigs.slice().sort((a, b) => Math.abs(b.icT || 0) - Math.abs(a.icT || 0)).slice(0, 10)
    .map((s) => ({ id: s.id, family: s.family, n: s.n, ic: r6(s.ic), icT: r6(s.icT), verdict: s.verdict ?? null }));
  const mv = Object.values(mask || {});
  return {
    nSignals: sigs.length, verdicts: count, fdr: rc && rc.fdr ? rc.fdr : null, target: rc && rc.target ? rc.target : null,
    top, mask: { n: mv.length, dropped: mv.filter((v) => v === 0).length, boosted: mv.filter((v) => v > 1).length },
  };
}

const toModelJSON = (m) => (m && typeof m.toJSON === "function" ? m.toJSON() : m ?? null);

function predictMany(fn, rows) {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) { const p = Number(fn(rows[i])); out[i] = fin(p) ? p : 0.5; }
  return out;
}

/** Latest time a champion's training labels reach (entry.labelsThrough, else a conservative estimate). */
function championLabelsThrough(entry, ahead, tf) {
  if (!entry) return null;
  if (fin(entry.labelsThrough)) return entry.labelsThrough;
  const m = entry.model || {};
  const t = fin(entry.trainedThrough) ? entry.trainedThrough : fin(m.trainedThrough) ? m.trainedThrough : null;
  return t == null ? null : labelEnd({ t, assetClass: "stock" }, ahead, tf);
}

// ───────────────────────────── the cycle (runs in the worker) ─────────────────────────────

async function acquireDataset(deps, horizon, o, progress, notes) {
  if (o.dataset) return { ds: o.dataset, source: "injected" };
  const file = o.datasetFile || `${horizon}.json.gz`;
  const onProgress = (p) => progress("dataset", p);
  let ds = null, source = "built";
  if (o.useCache !== false && deps.loadDataset) {
    try { ds = await deps.loadDataset(file); } catch { ds = null; }
    if (ds && (ds.horizon !== horizon || !Array.isArray(ds.rows))) { notes.push("cached dataset ignored (horizon mismatch / invalid)"); ds = null; }
  }
  if (ds && deps.updateDataset) {
    ds = await deps.updateDataset(ds, { ...o.datasetOpts, onProgress });
    source = "cache+update";
  } else if (!ds) {
    ds = await deps.buildDataset({ horizon, ...o.datasetOpts, onProgress });
  } else source = "cache";
  if (o.saveCache !== false && deps.saveDataset) {
    try { await deps.saveDataset(ds, file); } catch (e) { notes.push(`dataset cache not saved: ${e.message}`); }
  }
  return { ds, source };
}

/**
 * One full cycle. Pure with respect to the registry / db: champions, live stats and drift state
 * come in `job`, and the result goes back to the caller (main thread) which writes the registry.
 * job: { horizon, reason, champions: { "stacker|y": entry, …, meta, mask, thresholds }, live, drift, opts, deps, onProgress }
 * → { report, proposals: [{ key, entry, promote, reason }], reportCard }
 */
async function computeCycle(job) {
  const T0 = Date.now();
  const cfg = require("../config");
  const horizon = job.horizon || cfg.HORIZON;
  const hc = cfg.HORIZONS[horizon] || cfg.HORIZONS.swing;
  const o = { ...CYCLE_DEFAULTS, ...(job.opts || {}) };
  const deps = resolveDeps(job.deps);
  const labelOf = (row, target) => { try { return deps.labelOf(row, target); } catch { return fallbackLabel(row, target); } };
  const champions = job.champions || {};
  const notes = [];
  const timings = {};
  const progress = (phase, extra) => { try { if (job.onProgress) job.onProgress({ phase, ...(extra && typeof extra === "object" ? extra : {}), elapsedMs: Date.now() - T0 }); } catch { /* ignore */ } };
  const lap = async (k, fn) => { const t = Date.now(); progress(k); try { return await fn(); } finally { timings[k] = Date.now() - t; } };

  // 1. dataset
  const { ds, source } = await lap("dataset", () => acquireDataset(deps, horizon, o, progress, notes));
  const ahead = ds.ahead || hc.ahead, tf = ds.tf || hc.tf;
  const rows = ds.rows || [];

  // 2. split
  const split = splitHoldout(rows, { holdoutFrac: o.holdoutFrac, ahead, tf });
  const trainDs = { ...ds, rows: split.train };
  const bench = new Set(Object.values(ds.benchmarks || {}));
  const dataHash = registryMod.hashRows(split.train);
  const holdoutHash = registryMod.hashRows(split.holdout);
  const lag = dmLag(split.holdout, ahead, tf);
  const report = {
    ts: new Date().toISOString(), horizon, reason: job.reason || "manual", ok: true,
    datasetRows: rows.length, labeledRows: rows.filter((r) => r && r.lab).length,
    dataset: {
      source, built: ds.built || null, universe: (ds.universe || []).length, signals: (ds.signalIds || []).length,
      notes: ds.meta && Array.isArray(ds.meta.notes) ? ds.meta.notes.slice(0, 10) : [],
      trainRows: split.train.length, holdoutRows: split.holdout.length, holdoutStart: iso(split.holdoutStart), holdoutEnd: iso(split.holdoutEnd),
      holdoutDates: split.nHoldoutDates, trainLabelsThrough: iso(split.trainLabelsThrough), dataHash, holdoutHash, dmLag: lag,
    },
    reportCardSummary: null, challengers: [], thresholds: null,
    drift: job.drift || null, live: job.live || null, rules: RULES, notes, timings,
  };
  if (job.live && job.live.degraded) notes.push(`champion live log-loss ${job.live.logloss} exceeds its holdout expectation ${job.live.expected} (z=${job.live.z})`);
  const proposals = [];
  if (!split.train.length || !split.holdout.length) {
    report.ok = false;
    report.error = `not enough labelled history to split (${rows.length} rows, ${split.nDates} labelled dates)`;
    report.wallMs = Date.now() - T0;
    return { report, proposals, reportCard: null };
  }

  // 3. report card + mask on the training window only
  const rc = await lap("reportCard", () => deps.reportCard(trainDs, { target: o.reportTarget, byRegime: true, minN: o.minN }));
  const mask = deps.signalMask(rc) || {};
  report.reportCardSummary = summarizeReportCard(rc, mask);
  const reportCard = rc ? { ...rc, window: { trainRows: split.train.length, to: iso(split.trainLabelsThrough), holdoutStart: iso(split.holdoutStart) }, horizon, cycleTs: report.ts } : null;

  // v1 calibrated baseline per target (fitted on the training window only)
  const baselineFor = (target) => {
    const pairs = [];
    for (const r of split.train) {
      if (target === "yEx" && bench.has(r.assetId)) continue;
      const y = labelOf(r, target);
      if (y === null || y === undefined) continue;
      pairs.push({ p: fin(r.pRaw) ? r.pRaw : 0.5, y, t: r.t });
    }
    const cal = fitCalibrator(pairs, ahead);
    cal.baseRate = pairs.length ? pairs.reduce((s, q) => s + q.y, 0) / pairs.length : 0.5;
    return cal;
  };

  // 4. challenger stackers
  const trained = {};
  const stackerDecisions = {};
  for (const target of o.targets) {
    await lap(`stacker:${target}`, async () => {
      const ch = { kind: "stacker", target, version: null, metrics: null, promoted: false, reason: "" };
      report.challengers.push(ch);
      let tr;
      try {
        tr = await deps.trainStacker(trainDs, { target, mask, model: o.stackerModel, purge: ahead, folds: o.folds, bootstrapReps: o.bootstrapReps, horizon });
      } catch (e) { ch.reason = `rejected: training failed — ${e.message}`; return; }
      if (!tr || !tr.model) { ch.reason = `rejected: trainer returned no model — ${(tr && tr.metrics && tr.metrics.reason) || "unknown"}`; return; }
      trained[target] = tr;
      const champ = champions[`stacker|${target}`] || null;
      const champThrough = championLabelsThrough(champ, ahead, tf);
      let hRows = split.holdout.filter((r) => { const y = labelOf(r, target); return y === 0 || y === 1; });
      if (target === "yEx") hRows = hRows.filter((r) => !bench.has(r.assetId));
      let restricted = false;
      if (champ && champThrough != null && champThrough >= split.holdoutStart) { hRows = hRows.filter((r) => r.t > champThrough); restricted = true; }
      const ys = hRows.map((r) => labelOf(r, target));
      const dates = hRows.map((r) => r.t);
      const cal = baselineFor(target);
      let pCh = null, pCp = null, champErr = null;
      try { pCh = predictMany((r) => tr.model.predict(r), hRows); } catch (e) { ch.reason = `rejected: challenger prediction failed — ${e.message}`; return; }
      if (champ) {
        try { const m = deps.loadStacker(champ.model); pCp = predictMany((r) => m.predict(r), hRows); }
        catch (e) { champErr = `champion v${champ.version} could not be evaluated: ${e.message}`; }
      }
      const pBl = hRows.map((r) => cal.apply(fin(r.pRaw) ? r.pRaw : 0.5));
      const ev = hRows.length ? evaluateHoldout({ ys, dates, pChallenger: pCh, pChampion: pCp, pBaseline: pBl, lag }) : null;
      if (ev && champErr) ev.championError = champErr;
      const dec = promotionDecision(ev, { hasChampion: !!champ });
      stackerDecisions[target] = dec;
      const oosM = tr.metrics || {};
      ch.metrics = {
        holdout: ev ? { ...ev, restricted, championVersion: champ ? champ.version : null } : null,
        oos: { n: oosM.n, nDates: oosM.nDates, auc: oosM.auc, logloss: oosM.logloss, loglossBaseline: oosM.loglossBaseline, aucBaseline: oosM.aucBaseline, dm: oosM.dm || null, calibrated: oosM.calibrated ? { logloss: oosM.calibrated.logloss, loglossBaseline: oosM.calibrated.loglossBaseline, auc: oosM.calibrated.auc } : null },
        checks: dec.checks,
      };
      ch.promoted = dec.promote;
      ch.reason = dec.reason;
      proposals.push({
        key: `stacker|${target}`, promote: dec.promote, reason: dec.reason,
        entry: {
          horizon, kind: "stacker", target, metrics: ch.metrics, trainedThrough: tr.trainedThrough ?? null, labelsThrough: fin(tr.labelsThrough) ? tr.labelsThrough : split.trainLabelsThrough,
          dataHash, holdoutHash, model: toModelJSON(tr.model), baseRate: fin(tr.model.baseRate) ? tr.model.baseRate : cal.baseRate,
          calibration: tr.model.calibrator && typeof tr.model.calibrator.reliability === "function" ? tr.model.calibrator.reliability() : null,
          trainOpts: { target, model: o.stackerModel, purge: ahead, folds: o.folds }, mask, cycleTs: report.ts,
        },
      });
    });
  }

  // Effective y primary after this cycle.
  let effY = null;
  if (stackerDecisions.y && stackerDecisions.y.promote && trained.y) {
    effY = { source: "challenger", model: trained.y.model, baseRate: trained.y.model.baseRate, labelsThrough: split.trainLabelsThrough, trained: trained.y };
  } else if (champions["stacker|y"]) {
    try {
      const c = champions["stacker|y"];
      const m = deps.loadStacker(c.model);
      effY = { source: "champion", version: c.version, model: m, baseRate: fin(c.baseRate) ? c.baseRate : m.baseRate, labelsThrough: championLabelsThrough(c, ahead, tf) };
    } catch (e) { notes.push(`y champion could not be loaded: ${e.message}`); }
  }

  // Mask: bundled with the y-stacker trained on it.
  {
    const yPromoted = !!(stackerDecisions.y && stackerDecisions.y.promote);
    const reason = yPromoted ? "promoted: bundled with the promoted y-stacker trained on this mask"
      : `rejected: a mask is promoted only with a y-stacker trained on it (${trained.y ? "y-stacker not promoted" : "no y-stacker trained"})`;
    report.challengers.push({ kind: "mask", target: null, version: null, metrics: report.reportCardSummary.mask, promoted: yPromoted, reason });
    proposals.push({ key: "mask", promote: yPromoted, reason, entry: { horizon, kind: "mask", metrics: { reportCard: report.reportCardSummary }, trainedThrough: split.trainEnd, labelsThrough: split.trainLabelsThrough, dataHash, model: mask, cycleTs: report.ts } });
  }

  // 5. meta-labeler
  let effMeta = null;
  const primaryTrain = effY && trained.y ? trained.y : null;
  const metaCh = { kind: "meta", target: null, version: null, metrics: null, promoted: false, reason: "" };
  report.challengers.push(metaCh);
  let metaTrained = null;
  await lap("meta", async () => {
    try {
      metaTrained = await deps.trainMetaLabeler(trainDs, primaryTrain
        ? { primary: "stacker", stacker: primaryTrain, minEdge: o.metaMinEdge, mask, folds: o.folds, bootstrapReps: o.bootstrapReps, horizon }
        : { primary: "pooled", minEdge: o.metaMinEdge, mask, folds: o.folds, bootstrapReps: o.bootstrapReps, horizon });
    } catch (e) { metaCh.reason = `rejected: training failed — ${e.message}`; return; }
    if (!metaTrained || !metaTrained.model) { metaCh.reason = `rejected: trainer returned no model — ${(metaTrained && metaTrained.metrics && metaTrained.metrics.reason) || "unknown"}`; return; }
    const mm = metaTrained.model;
    // Primary on the holdout = what will be live: the effective y-stacker, else pooled calibrated pRaw.
    const calY = baselineFor("y");
    const primaryP = effY ? (r) => effY.model.predict(r) : (r) => calY.apply(fin(r.pRaw) ? r.pRaw : 0.5);
    const base = effY ? (fin(effY.baseRate) ? effY.baseRate : 0.5) : fin(mm.primaryBaseRate) ? mm.primaryBaseRate : calY.baseRate;
    const minEdge = fin(mm.minEdge) ? mm.minEdge : o.metaMinEdge;
    const champ = champions.meta || null;
    const champThrough = championLabelsThrough(champ, ahead, tf);
    const restricted = !!(champ && champThrough != null && champThrough >= split.holdoutStart);
    const eligible = [];
    for (const r of split.holdout) {
      if (!r.lab || !fin(r.lab.tbLongRet) || !fin(r.lab.tbShortRet)) continue;
      if (restricted && !(r.t > champThrough)) continue;
      const p = Number(primaryP(r));
      if (!fin(p)) continue;
      const edge = p - base;
      if (!(Math.abs(edge) >= minEdge)) continue;
      const side = edge > 0 ? 1 : -1;
      eligible.push({ r, p, side, y: (side > 0 ? r.lab.tbLongRet : r.lab.tbShortRet) > 0 ? 1 : 0 });
    }
    // v1 baseline for the meta target: calibrated v1 P(side right) re-calibrated to the meta label
    // on the meta-labeler's own OOS rows (training window).
    const rowByKey = new Map(split.train.map((r) => [keyOf(r.t, r.assetId), r]));
    const sideProb = (r, side) => { const q = calY.apply(fin(r.pRaw) ? r.pRaw : 0.5); return side > 0 ? q : 1 - q; };
    const bPairs = [];
    for (const q of metaTrained.oos || []) { const r = rowByKey.get(keyOf(q.t, q.assetId)); if (r && (q.y === 0 || q.y === 1)) bPairs.push({ p: sideProb(r, q.side), y: q.y, t: q.t }); }
    const metaBase = bPairs.length >= 30 ? fitCalibrator(bPairs, ahead) : null;
    let pCh, pCp = null, champErr = null;
    try { pCh = eligible.map((e) => Number(mm.predict(e.r, e.side, e.p))).map((p) => (fin(p) ? p : 0.5)); }
    catch (e) { metaCh.reason = `rejected: meta prediction failed — ${e.message}`; return; }
    if (champ) {
      try { const cm = deps.loadMeta(champ.model); pCp = eligible.map((e) => Number(cm.predict(e.r, e.side, e.p))).map((p) => (fin(p) ? p : 0.5)); }
      catch (e) { champErr = `meta champion v${champ.version} could not be evaluated: ${e.message}`; }
    }
    const trainRate = bPairs.length ? bPairs.reduce((s, q) => s + q.y, 0) / bPairs.length : 0.5;
    const pBl = eligible.map((e) => (metaBase ? metaBase.apply(sideProb(e.r, e.side)) : trainRate));
    const ev = eligible.length ? evaluateHoldout({ ys: eligible.map((e) => e.y), dates: eligible.map((e) => e.r.t), pChallenger: pCh, pChampion: pCp, pBaseline: pBl, lag }) : null;
    if (ev && champErr) ev.championError = champErr;
    const dec = promotionDecision(ev, { hasChampion: !!champ, minRows: RULES.minMetaHoldoutRows });
    const mt = metaTrained.metrics || {};
    metaCh.metrics = {
      holdout: ev ? { ...ev, restricted, championVersion: champ ? champ.version : null, primary: effY ? `stacker (${effY.source})` : "pooled", minEdge } : null,
      oos: { n: mt.n, auc: mt.auc, logloss: mt.logloss, primary: mt.primary || null, threshold: mt.threshold || null, raisesPrecision: mt.raisesPrecision || null },
      checks: dec.checks,
    };
    metaCh.promoted = dec.promote;
    metaCh.reason = dec.reason;
    proposals.push({
      key: "meta", promote: dec.promote, reason: dec.reason,
      entry: {
        horizon, kind: "meta", metrics: metaCh.metrics, trainedThrough: metaTrained.trainedThrough ?? null, labelsThrough: split.trainLabelsThrough,
        dataHash, holdoutHash, model: toModelJSON(mm), threshold: fin(metaTrained.threshold) ? metaTrained.threshold : fin(mm.threshold) ? mm.threshold : 0.55,
        baseRate: fin(mm.baseRate) ? mm.baseRate : null, primary: effY ? "stacker" : "pooled", cycleTs: report.ts,
      },
    });
    if (dec.promote) effMeta = { source: "challenger", model: mm, oos: metaTrained.oos || [] };
  });
  if (!effMeta && champions.meta) {
    try { effMeta = { source: "champion", version: champions.meta.version, model: deps.loadMeta(champions.meta.model), labelsThrough: championLabelsThrough(champions.meta, ahead, tf) }; }
    catch (e) { notes.push(`meta champion could not be loaded: ${e.message}`); }
  }

  // 6. thresholds (nested walk-forward on OOS predictions of the models live after this cycle)
  await lap("tune", async () => {
    const tunePrimary = effY || (trained.y ? { source: "challenger-diagnostic", model: trained.y.model, baseRate: trained.y.model.baseRate, trained: trained.y } : null);
    if (!tunePrimary) { report.thresholds = { promoted: false, reason: "rejected: no y-stacker available to tune thresholds on" }; return; }
    const base = fin(tunePrimary.baseRate) ? tunePrimary.baseRate : 0.5;
    const metaFor = tunePrimary === effY ? effMeta : null;
    const tRows = [];
    // (i) holdout rows — unseen by the live models (rows after a champion's labels only)
    const after = Math.max(fin(tunePrimary.labelsThrough) ? tunePrimary.labelsThrough : -Infinity, metaFor && fin(metaFor.labelsThrough) ? metaFor.labelsThrough : -Infinity);
    for (const r of split.holdout) {
      if (!r.lab || !fin(r.lab.tbLongRet) || !fin(r.lab.tbShortRet) || !(r.t > after || !fin(after))) continue;
      const p = Number(tunePrimary.model.predict(r));
      if (!fin(p)) continue;
      const row = { t: r.t, assetId: r.assetId, p, base, tbLongRet: r.lab.tbLongRet, tbShortRet: r.lab.tbShortRet };
      if (metaFor) { const side = p >= base ? 1 : -1; const mp = Number(metaFor.model.predict(r, side, p)); row.metaP = fin(mp) ? mp : null; }
      tRows.push(row);
    }
    // (ii) training-window OOS rows when the live primary (and meta) are this cycle's challengers
    let fromOos = 0;
    if (tunePrimary.trained && (!metaFor || metaFor.source === "challenger")) {
      const rowByKey = new Map(split.train.map((r) => [keyOf(r.t, r.assetId), r]));
      const metaByKey = metaFor ? new Map((metaFor.oos || []).map((q) => [keyOf(q.t, q.assetId), q])) : null;
      for (const q of tunePrimary.trained.oos || []) {
        const r = rowByKey.get(keyOf(q.t, q.assetId));
        const p = fin(q.pCal) ? q.pCal : q.p;
        if (!r || !r.lab || !fin(r.lab.tbLongRet) || !fin(r.lab.tbShortRet) || !fin(p)) continue;
        const row = { t: q.t, assetId: q.assetId, p, base, tbLongRet: r.lab.tbLongRet, tbShortRet: r.lab.tbShortRet };
        if (metaFor) { const m = metaByKey.get(keyOf(q.t, q.assetId)); row.metaP = m && fin(m.pMeta) ? m.pMeta : null; }
        tRows.push(row); fromOos++;
      }
    }
    const tr = tuner.tuneThresholds(tRows, { ahead, ...(o.tune || {}) });
    const live = tunePrimary === effY;
    const pass = tr.gate.pass && live;
    const reasons = tr.gate.reasons.slice();
    if (!live) reasons.push("no learned y-stacker will be live after this cycle (thresholds are defined on its probability)");
    const reason = pass
      ? `promoted: PBO ${r6(tr.pbo.pbo)} ≤ ${RULES.pboMax}, deflated Sharpe ${r6(tr.dsr.dsr)} ≥ ${RULES.dsrMin}, nested OOS mean net return ${r6(tr.nested.meanRet)} over ${tr.nested.nActed} acted`
      : `rejected: ${reasons.join("; ")}`;
    const summary = {
      thresholds: tr.thresholds, best: tr.best, nested: tr.nested ? { ...tr.nested, folds: tr.nested.folds } : null,
      dsr: tr.dsr, dsrNested: tr.dsrNested, pbo: tr.pbo ? { ...tr.pbo, logits: undefined } : null, grid: tr.grid,
      nRows: tr.nRows, nDates: tr.nDates, fromTrainOos: fromOos, fromHoldout: tRows.length - fromOos, primary: tunePrimary.source, meta: metaFor ? metaFor.source : null,
    };
    report.thresholds = { ...summary, promoted: pass, reason };
    if (tr.thresholds) {
      proposals.push({
        key: "thresholds", promote: pass, reason,
        entry: { horizon, kind: "thresholds", metrics: summary, trainedThrough: split.trainEnd, labelsThrough: split.trainLabelsThrough, dataHash, holdoutHash, model: { ...tr.thresholds }, basedOn: { stackerY: effY ? effY.source : null, meta: metaFor ? metaFor.source : null }, cycleTs: report.ts },
      });
    }
  });

  report.wallMs = Date.now() - T0;
  return { report, proposals, reportCard };
}

// ───────────────────────────── main-thread orchestration ─────────────────────────────

const ctx = { store: null, registry: null, horizon: null };
const state = {
  queue: [], current: null, seq: 0,
  sched: null, timers: new Map(), nextRunAt: new Map(),
  lastReport: new Map(), monitors: new Map(), live: new Map(), derisk: new Map(), lastEarly: new Map(),
  dirty: new Set(), flushTimer: null,
};

const getStore = () => ctx.store || require("../db");
const getRegistry = () => ctx.registry || registryMod;
function defaultHorizon() {
  if (ctx.horizon) return ctx.horizon;
  try { const h = getStore().getSetting && getStore().getSetting("horizon"); if (h) return h; } catch { /* db not ready */ }
  return require("../config").HORIZON;
}
function horizonMs(horizon) {
  const cfg = require("../config");
  const hc = cfg.HORIZONS[horizon] || cfg.HORIZONS.swing;
  return hc.ahead * hc.tf * 1000 * (hc.tf >= 86400 ? 7 / 5 : 1);   // trading days → calendar
}
const safeLoad = (k) => { try { return getStore().loadModel(k); } catch { return null; } };
const safeSave = (k, v) => { try { getStore().saveModel(k, v); return true; } catch (e) { console.error(`[selfImprove] save ${k}: ${e.message}`); return false; } };

/** Dependency injection for tests / tools: { store, registry, horizon }. Resets in-memory state. */
function configure({ store, registry, horizon } = {}) {
  if (store !== undefined) ctx.store = store;
  if (registry !== undefined) ctx.registry = registry;
  if (horizon !== undefined) ctx.horizon = horizon;
  state.lastReport.clear(); state.monitors.clear(); state.live.clear(); state.derisk.clear(); state.lastEarly.clear();
  liveCache.clear();
}

// ── drift + live records ──
function driftBlob(h) {
  if (!state.monitors.has(h)) {
    const raw = safeLoad(`drift:${h}`);
    state.monitors.set(h, raw && raw.monitor ? DriftMonitor.fromJSON(raw.monitor) : new DriftMonitor());
    if (raw && raw.derisk && Date.parse(raw.derisk.until) > Date.now()) state.derisk.set(h, raw.derisk);
    if (raw && fin(raw.lastEarly)) state.lastEarly.set(h, raw.lastEarly);
  }
  return state.monitors.get(h);
}
function liveRecords(h) {
  if (!state.live.has(h)) { const raw = safeLoad(`live:${h}`); state.live.set(h, raw && Array.isArray(raw.records) ? raw.records : []); }
  return state.live.get(h);
}
function markDirty(h) {
  state.dirty.add(h);
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushState, 1000);
  if (state.flushTimer.unref) state.flushTimer.unref();
}
/** Persist drift monitors, de-risk state and live records (debounced by onResolved; call on shutdown). */
function flushState() {
  if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
  for (const h of state.dirty) {
    const m = state.monitors.get(h);
    safeSave(`drift:${h}`, { monitor: m ? m.toJSON() : null, derisk: state.derisk.get(h) || null, lastEarly: state.lastEarly.get(h) || null });
    if (state.live.has(h)) safeSave(`live:${h}`, { v: 1, records: state.live.get(h).slice(-MAX_LIVE_RECORDS) });
  }
  state.dirty.clear();
}

function activeDerisk(h) {
  const d = state.derisk.get(h);
  if (!d) return null;
  if (!(Date.parse(d.until) > Date.now())) { state.derisk.delete(h); markDirty(h); return null; }
  return { ...d };
}

/**
 * Live performance of the current y champion (or v1 when none): decisions made since its
 * promotion, log-loss vs the champion's holdout expectation. z = gap / (sd / √n_eff), n_eff = n / ahead.
 */
function liveSummary(h, champions) {
  const recs = liveRecords(h);
  // champions() strips model JSON (cheap); champion() would deep-copy the whole model.
  const champ = champions ? champions["stacker|y"] : (() => { try { const c = getRegistry().champions(h); return c && c.stacker ? c.stacker.y : null; } catch { return null; } })();
  const since = champ && champ.promotedAt ? Date.parse(champ.promotedAt) : null;
  const sel = since ? recs.filter((r) => (fin(r.dts) ? r.dts : r.rt) >= since) : recs;
  const hol = champ && champ.metrics && champ.metrics.holdout;
  const expected = champ ? (hol && hol.challenger ? hol.challenger.logloss : null) : lastBaselineExpectation(h);
  const out = { source: champ ? `stacker v${champ.version}` : "v1", since: since ? iso(since) : null, n: sel.length, logloss: null, hitRate: null, expected: r6(expected), gap: null, z: null, degraded: false };
  if (!sel.length) return out;
  const L = sel.map((r) => r.loss);
  const m = L.reduce((s, v) => s + v, 0) / L.length;
  const sd = Math.sqrt(L.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, L.length - 1));
  const cfg = require("../config");
  const ahead = (cfg.HORIZONS[h] || cfg.HORIZONS.swing).ahead;
  out.logloss = r6(m);
  out.hitRate = r6(sel.reduce((s, r) => s + r.hit, 0) / sel.length);
  if (fin(expected)) {
    out.gap = r6(m - expected);
    const se = sd / Math.sqrt(Math.max(1, sel.length / ahead));
    out.z = se > 0 ? r6((m - expected) / se) : null;
    out.degraded = sel.length >= 50 && out.z != null && out.z > 2;
  }
  return out;
}
function lastBaselineExpectation(h) {
  const rep = lastReportFor(h);
  const y = rep && Array.isArray(rep.challengers) ? rep.challengers.find((c) => c.kind === "stacker" && c.target === "y") : null;
  return y && y.metrics && y.metrics.holdout && y.metrics.holdout.baseline ? y.metrics.holdout.baseline.logloss : null;
}

/**
 * The engine calls this for every resolved live decision. Feeds the horizon's DriftMonitor and
 * appends a live-performance record. On drift: de-risk + early cycle (if the scheduler runs).
 * Returns { drift, level, stat, derisk, earlyCycle } or null for unusable input.
 */
function onResolved({ horizon, p, y, decision } = {}) {
  const pp = Number(p), yy = y === true ? 1 : y === false ? 0 : Number(y);
  if (!fin(pp) || (yy !== 0 && yy !== 1)) return null;
  const h = horizon || (decision && decision.horizon) || defaultHorizon();
  const mon = driftBlob(h);
  const res = mon.update(pp, yy);
  const recs = liveRecords(h);
  const dts = decision && decision.ts ? Date.parse(decision.ts) : NaN;
  recs.push({ dts: fin(dts) ? dts : null, rt: Date.now(), p: r6(pp), y: yy, loss: r6(driftLogLoss(pp, yy)), hit: (pp >= 0.5 ? 1 : 0) === yy ? 1 : 0,
    assetId: decision && decision.assetId ? decision.assetId : null, cls: decision && decision.assetClass ? decision.assetClass : null });
  if (recs.length > MAX_LIVE_RECORDS + 500) recs.splice(0, recs.length - MAX_LIVE_RECORDS);
  let early = false;
  if (res.drift) {
    const now = Date.now();
    const d = { until: iso(now + DERISK.horizons * horizonMs(h)), minConfidenceBump: DERISK.minConfidenceBump, sizeMult: DERISK.sizeMult, since: iso(now), horizon: h, triggers: res.triggers || [] };
    state.derisk.set(h, d);
    early = requestEarlyCycle(h);
    console.log(`[selfImprove] drift on ${h} (${(res.triggers || []).join(", ")}): de-risk until ${d.until}${early ? "; early cycle queued" : ""}`);
  }
  markDirty(h);
  return { drift: res.drift, level: res.level, stat: res.stat, derisk: activeDerisk(h), earlyCycle: early };
}

function requestEarlyCycle(h) {
  if (!state.sched) return false;
  const now = Date.now();
  if (now - (state.lastEarly.get(h) || 0) < EARLY_MIN_GAP_MS) return false;
  if ((state.current && state.current.horizon === h) || state.queue.some((j) => j.horizon === h)) return false;
  state.lastEarly.set(h, now);
  enqueue({ horizon: h, reason: "drift" });
  return true;
}

// ── cycles ──
function lastReportFor(h) {
  if (state.lastReport.has(h)) return state.lastReport.get(h);
  const arr = safeLoad(`cycles:${h}`);
  const r = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
  if (r) state.lastReport.set(h, r);
  return r;
}

function collectChampions(reg, h) {
  const out = {};
  for (const t of registryMod.STACKER_TARGETS) { const e = reg.champion(h, "stacker", t); if (e) out[`stacker|${t}`] = e; }
  for (const k of ["meta", "mask", "thresholds"]) { const e = reg.champion(h, k); if (e) out[k] = e; }
  return out;
}

/** Write the worker's proposals to the registry, persist report + report card. Main thread. */
function applyOutcome(h, out) {
  const reg = getRegistry();
  const report = out.report;
  const versions = {};
  let promotedAny = false, promotedPrimary = false;
  for (const pr of out.proposals || []) {
    try {
      if (pr.key === "thresholds" && pr.entry) pr.entry.basedOn = { ...pr.entry.basedOn, stackerYVersion: versions["stacker|y"] || null, metaVersion: versions.meta || null };
      const e = reg.propose({ ...pr.entry, reason: "challenger" });
      versions[pr.key] = e.version;
      if (pr.promote) {
        reg.promote(e.version, pr.reason, h);
        promotedAny = true;
        if (pr.key === "stacker|y" || pr.key === "meta") promotedPrimary = true;
      } else reg.reject(e.version, pr.reason, { horizon: h });
      const ch = report.challengers.find((c) => (c.kind === "stacker" ? `stacker|${c.target}` : c.kind) === pr.key);
      if (ch) ch.version = e.version;
      if (pr.key === "thresholds" && report.thresholds) report.thresholds.version = e.version;
    } catch (err) {
      report.notes = report.notes || [];
      report.notes.push(`registry write failed for ${pr.key}: ${err.message}`);
      const ch = report.challengers.find((c) => (c.kind === "stacker" ? `stacker|${c.target}` : c.kind) === pr.key);
      if (ch && pr.promote) { ch.promoted = false; ch.reason = `rejected: registry write failed — ${err.message}`; }
    }
  }
  // Challengers that never reached the registry (training failed …) are still logged with their reason.
  for (const c of report.challengers) {
    if (c.version != null) continue;
    try { reg.logDecision(h, { action: "reject", version: null, kind: c.kind, target: c.target || null, reason: c.reason }); } catch { /* ignore */ }
  }
  if (promotedAny && state.derisk.has(h)) { state.derisk.delete(h); report.deriskCleared = true; markDirty(h); }
  if (promotedPrimary) { driftBlob(h).reset(); markDirty(h); }
  report.promoted = report.challengers.filter((c) => c.promoted).map((c) => `${c.kind}${c.target ? ":" + c.target : ""}`)
    .concat(report.thresholds && report.thresholds.promoted ? ["thresholds"] : []);
  report.registryVersion = (() => { try { return reg.version(); } catch { return null; } })();
  if (out.reportCard) safeSave(`reportcard:${h}`, out.reportCard);
  return report;
}

function saveCycle(h, report) {
  const arr = safeLoad(`cycles:${h}`);
  const list = (Array.isArray(arr) ? arr : []).concat([report]).slice(-MAX_CYCLES_KEPT);
  safeSave(`cycles:${h}`, list);
  state.lastReport.set(h, report);
}

async function executeJob(job) {
  const t0 = Date.now();
  const h = job.horizon;
  let report;
  try {
    const reg = getRegistry();
    const champions = collectChampions(reg, h);
    const input = {
      horizon: h, reason: job.reason, champions, live: liveSummary(h, champions),
      drift: (() => { const m = driftBlob(h); const s = m.stat(); return { level: activeDerisk(h) ? "drift" : m.level, n: s.n, lastDrift: s.lastDrift, derisk: activeDerisk(h) }; })(),
      opts: job.cycleOpts || {},
    };
    const onProgress = (p) => { if (state.current) state.current.progress = p; };
    let out;
    if (job.inline) {
      out = await computeCycle({ ...input, deps: job.deps, onProgress });
    } else {
      if (job.deps) throw new Error("function deps cannot cross the worker boundary: pass depsModule (a module path) or inline:true");
      const { startCycleWorker } = require("./cycleWorker");
      const w = startCycleWorker({ ...input, depsModule: job.depsModule || null }, { timeoutMs: job.timeoutMs || DEFAULT_TIMEOUT_MS, onProgress });
      if (state.current) state.current.terminate = w.terminate;
      out = await w.promise;
    }
    report = applyOutcome(h, out);
  } catch (e) {
    report = { ts: new Date().toISOString(), horizon: h, reason: job.reason, ok: false, error: e && e.message ? e.message : String(e), crashed: !!(e && e.crashed), challengers: [], promoted: [] };
    console.error(`[selfImprove] cycle ${h} failed: ${report.error}`);
  }
  report.wallMs = Date.now() - t0;
  saveCycle(h, report);
  return report;
}

function pump() {
  if (state.current || !state.queue.length) return;
  const job = state.queue.shift();
  state.current = { id: job.id, horizon: job.horizon, reason: job.reason, startedAt: Date.now(), progress: null, terminate: null };
  executeJob(job).catch((e) => ({ ts: new Date().toISOString(), horizon: job.horizon, reason: job.reason, ok: false, error: e.message, challengers: [], promoted: [] })).then((report) => {
    state.current = null;
    job.resolve(report);
    if (state.sched) {
      if (typeof state.sched.onReport === "function") { try { state.sched.onReport(report); } catch (e) { console.error("[selfImprove] onReport:", e.message); } }
      if (state.sched.horizons.includes(job.horizon)) arm(job.horizon, state.sched.everyMs);
    }
    setImmediate(pump);
  });
}

function enqueue(opts) {
  const h = opts.horizon || defaultHorizon();
  const dup = state.queue.find((j) => j.horizon === h);
  if (dup) { if (opts.reason && !dup.reason.includes(opts.reason)) dup.reason += `+${opts.reason}`; return dup.promise; }
  const sched = state.sched || {};
  const job = {
    id: ++state.seq, horizon: h, reason: opts.reason || "manual",
    inline: !!opts.inline, deps: opts.deps || sched.deps || null, depsModule: opts.depsModule || sched.depsModule || null,
    cycleOpts: opts.cycleOpts || sched.cycleOpts || {}, timeoutMs: opts.timeoutMs || sched.timeoutMs || null,
  };
  if (!opts.deps && sched.deps) job.inline = true;
  if (opts.inline === undefined && sched.inline) job.inline = true;
  job.promise = new Promise((res) => { job.resolve = res; });
  state.queue.push(job);
  setImmediate(pump);
  return job.promise;
}

/**
 * Run one cycle (queued behind any running one; a queued cycle for the same horizon is reused).
 * opts: { horizon, reason, depsModule, cycleOpts, timeoutMs, inline, deps } — `deps` (functions)
 * require inline:true (tests only: runs on the calling thread); everything else runs in a worker.
 * Resolves with the CycleReport; never rejects.
 */
function runCycle(opts = {}) { return enqueue(opts); }

function arm(h, delay) {
  if (!state.sched) return;
  clearTimeout(state.timers.get(h));
  const at = Date.now() + Math.max(0, delay);
  state.nextRunAt.set(h, at);
  const t = setTimeout(() => { state.nextRunAt.delete(h); state.timers.delete(h); enqueue({ horizon: h, reason: "scheduled" }); }, Math.max(0, delay));
  if (t.unref) t.unref();
  state.timers.set(h, t);
}

/**
 * Background scheduling. First cycle ~firstDelayMs (2 min) after the call when the horizon has no
 * y-stacker champion; otherwise at the next interval (last cycle + everyMs, clamped to
 * [firstDelayMs, everyMs] from now). After every cycle the horizon is re-armed at everyMs.
 * opts: { everyMs = 6h, horizons = [current], firstDelayMs, onReport(report), depsModule, cycleOpts, timeoutMs }
 */
function schedule(opts = {}) {
  for (const t of state.timers.values()) clearTimeout(t);
  state.timers.clear(); state.nextRunAt.clear();
  const everyMs = fin(opts.everyMs) && opts.everyMs > 0 ? opts.everyMs : EVERY_MS;
  const firstDelayMs = fin(opts.firstDelayMs) ? Math.max(0, opts.firstDelayMs) : FIRST_DELAY_MS;
  const horizons = Array.isArray(opts.horizons) && opts.horizons.length ? opts.horizons.filter(Boolean) : [defaultHorizon()];
  state.sched = { everyMs, firstDelayMs, horizons, onReport: opts.onReport || null, depsModule: opts.depsModule || null, deps: opts.deps || null,
    inline: !!opts.inline, cycleOpts: opts.cycleOpts || null, timeoutMs: opts.timeoutMs || null };
  const now = Date.now();
  for (const h of horizons) {
    let hasChampion = false;
    try { hasChampion = !!getRegistry().champion(h, "stacker", "y"); } catch { /* db not ready */ }
    const last = lastReportFor(h);
    const lastTs = last ? Date.parse(last.ts) : NaN;
    const delay = !hasChampion ? firstDelayMs : Math.min(everyMs, Math.max(firstDelayMs, (fin(lastTs) ? lastTs + everyMs : now + everyMs) - now));
    arm(h, delay);
  }
  return { horizons, everyMs, nextRuns: Object.fromEntries([...state.nextRunAt].map(([h, t]) => [h, iso(t)])) };
}

/** Stop scheduling; terminate a running cycle and drop queued ones (they resolve ok:false). */
function stop({ terminate = true } = {}) {
  for (const t of state.timers.values()) clearTimeout(t);
  state.timers.clear(); state.nextRunAt.clear();
  state.sched = null;
  for (const j of state.queue.splice(0)) j.resolve({ ts: new Date().toISOString(), horizon: j.horizon, reason: j.reason, ok: false, error: "stopped", challengers: [], promoted: [] });
  if (terminate && state.current && typeof state.current.terminate === "function") { try { state.current.terminate("stopped"); } catch { /* ignore */ } }
  flushState();
}

const liveCache = new Map();   // horizon -> { at, v }  (status() is polled by the engine on every evaluation)
function liveSummaryCached(h) {
  const c = liveCache.get(h);
  if (c && Date.now() - c.at < 10e3) return c.v;
  const v = liveSummary(h);
  liveCache.set(h, { at: Date.now(), v });
  return v;
}

/** Running state, schedule, last report, drift and de-risk. Cheap: safe to poll per decision. */
function status(horizon) {
  const h = horizon || (state.current && state.current.horizon) || defaultHorizon();
  const hs = new Set([h, ...(state.sched ? state.sched.horizons : []), ...state.derisk.keys()]);
  const driftOf = (x) => {
    const m = driftBlob(x);
    const s = m.stat();
    return { level: activeDerisk(x) ? "drift" : m.level, stat: s, lastDrift: s.lastDrift };
  };
  const byH = {};
  for (const x of hs) byH[x] = activeDerisk(x);
  let derisk = byH[h] || null;
  if (!derisk) for (const v of Object.values(byH)) if (v && (!derisk || Date.parse(v.until) > Date.parse(derisk.until))) derisk = v;
  const next = [...state.nextRunAt.values()];
  const cur = state.current;
  return {
    horizon: h,
    running: !!cur,
    current: cur ? { horizon: cur.horizon, reason: cur.reason, startedAt: iso(cur.startedAt), elapsedMs: Date.now() - cur.startedAt, progress: cur.progress } : null,
    queue: state.queue.map((j) => ({ horizon: j.horizon, reason: j.reason })),
    scheduled: !!state.sched, everyMs: state.sched ? state.sched.everyMs : null, horizons: state.sched ? state.sched.horizons : [],
    nextRunAt: next.length ? iso(Math.min(...next)) : null,
    nextRuns: Object.fromEntries([...state.nextRunAt].map(([x, t]) => [x, iso(t)])),
    lastReport: lastReportFor(h),
    drift: driftOf(h),
    derisk, deriskByHorizon: byH,
    live: liveSummaryCached(h),
    rules: RULES,
  };
}

module.exports = {
  runCycle, schedule, status, stop, onResolved, flushState, configure,
  computeCycle, promotionDecision, evaluateHoldout, splitHoldout, summarizeReportCard, liveSummary,
  RULES, DERISK, CYCLE_DEFAULTS,
  _state: state,
};
