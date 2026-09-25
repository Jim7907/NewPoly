// Meta-labeling (contract v2 §4; López de Prado 2018, AFML ch. 3; Joubert 2022).
//
// A PRIMARY model picks the side; a secondary (meta) model predicts whether taking that side will
// succeed, so the engine can skip (or down-size) the calls that are likely wrong. The whole point
// is to raise precision at the cost of coverage — this module measures whether it does.
//
// ───────────────────────────── METHOD ─────────────────────────────
//  Primary probability p per row, ALWAYS out of sample:
//    "pooled"  : v1 pRaw calibrated (server/learning/calibrator.js) on the purged training rows of
//                each walk-forward fold; base = that fold's training base rate of primaryTarget.
//                A fold whose calibrator is not reliable (n_eff < 30) gives p = base (no call).
//    "stacker" : the stacker's walk-forward OOS predictions, SEQUENTIALLY calibrated (oos.pCal —
//                the same calibrated scale Stacker.predict returns live); base = the fold's
//                training base rate. Pass a trainStacker() result as opts.stacker, or let this
//                module train one. A bare Stacker is refused: its predictions on history would be
//                in-sample, and a meta model trained on in-sample primary calls learns nothing true.
//  Primary side  = sign(p − base) when |p − base| ≥ minEdge, otherwise no trade (not a meta row,
//                  but still an "opportunity" in the coverage denominator).
//  Meta label    = 1 iff that side's triple-barrier return NET OF COSTS is > 0
//                  (lab.tbLongRet for a long, lab.tbShortRet for a short).
//  Meta features = stacker features (featurize) + |edge| + side, plus side-signed family
//                  aggregates and side·logit(pRaw) (a linear model cannot otherwise express "the
//                  long works when the trend family is positive and the short when it is negative";
//                  the GBM could, the logistic could not).
//  Model         = stacker.fitModel (logistic with inner-CV L2 + depth-2 early-stopped GBM,
//                  ensemble by default), trained with a purged walk-forward BY DATE over the meta
//                  rows (label end = the same asset's bar `ahead` later), so every meta-P in the
//                  report is out of sample, and the primary behind it was out of sample too.
//
// REPORT (all OOS)
//  precisionAt[thr] for thr ∈ 0.50…0.70: precision (hit rate of kept trades), coverage (kept /
//  primary trades), coverageAll (kept / all decision opportunities in the OOS period), meanRet
//  (mean net bracket return per kept trade), retPerOpp (net return per opportunity), lift vs the
//  primary's own precision with a Driscoll–Kraay p-value (kept-vs-rejected difference, rows
//  clustered by date, Newey–West lag = ahead), and the precision of an EDGE-ONLY filter at the
//  same coverage (keep the largest |p − base|) — the meta-labeler must beat simply demanding a
//  bigger primary edge to be worth anything.
//  threshold: maximizes net return per opportunity subject to coverageAll ≥ minCoverage (0.15),
//  grid 0.40…0.70. NOTE: chosen on the same OOS rows it is reported on (one parameter on a
//  31-point grid — small selection bias; the self-improvement tuner re-validates thresholds with
//  a nested walk-forward).
//  MetaLabeler.predict(row, side, p) returns the model's probability (the quantity evaluated
//  here, same units as the threshold); metrics.reliability reports its OOS calibration (ECE).
"use strict";

const S = require("./stacker");
const { LogisticModel, GBMClassifier } = require("../analysis/ml");
const { reliabilityOf } = require("../learning/calibrator");

const REPORT_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7];
const SEARCH_THRESHOLDS = Array.from({ length: 31 }, (_, k) => +(0.4 + 0.01 * k).toFixed(2));
const isNum = v => typeof v === "number" && Number.isFinite(v);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const r6 = x => (Number.isFinite(x) ? +x.toFixed(6) : null);

/** +1 / −1 / 0 from a number or a label ("long", "BUY", "short", "SELL", …). */
function sideOf(s) {
  if (typeof s === "number") return s > 0 ? 1 : s < 0 ? -1 : 0;
  const v = String(s || "").toLowerCase();
  if (/^(long|buy|strong_buy|up|\+1|1)$/.test(v)) return 1;
  if (/^(short|sell|strong_sell|down|-1)$/.test(v)) return -1;
  return 0;
}

function metaFeatureNames(spec) {
  return [...spec.names, "absEdge", "side", ...spec.families.map(f => `side*fam:${f}`), "side*logitPRaw"];
}

/** Meta feature vector: featurize(row) ++ [|edge|, side, side·fam_f…, side·logitPRaw]. */
function metaFeatures(row, side, absEdge, spec) {
  const x = S.featurize(row, spec);
  const nIds = spec.signalIds.length, nf = spec.families.length;
  const lp = x[x.length - 1];
  const fam = x.slice(nIds, nIds + nf);
  x.push(isNum(absEdge) ? absEdge : 0, side);
  for (const v of fam) x.push(side * v);
  x.push(side * lp);
  return x;
}

// ─── primary OOS predictions ────────────────────────────────────────────────────────────────
/** v1 pooled pRaw calibrated per purged walk-forward fold → [{t, assetId, p, pBase, fold}]. */
function pooledPrimary(dataset, { target, ahead, tf, embargoMs, folds, minTrain, minTrainFrac }) {
  const { rows, y, ends } = S.prepareRows(dataset, target, { ahead, tf });
  const splits = S.purgedWalkForward(rows, { labelEnds: ends, folds, embargoMs, minTrain, minTrainFrac });
  const pr = r => (isNum(r.pRaw) ? r.pRaw : 0.5);
  const out = [];
  for (const f of splits) {
    const base = mean(f.train.map(k => y[k]));
    const cal = S.fitPanelCalibrator(f.train.map(k => ({ p: pr(rows[k]), y: y[k], t: rows[k].t })), ahead);
    // an unreliable calibrator (n_eff < 30) has no opinion: p = base → edge 0 → no trade
    for (const k of f.test) out.push({ t: rows[k].t, assetId: rows[k].assetId, p: S.calibratedOr(cal, pr(rows[k]), base), pBase: base, fold: f.k });
  }
  return { preds: out, baseRate: y.length ? mean(y) : 0.5 };
}

function stackerPrimary(dataset, st) {
  if (!st || !Array.isArray(st.oos)) {
    throw new Error("primary \"stacker\" needs a trainStacker() result with walk-forward OOS predictions (a bare Stacker's predictions on history are in-sample)");
  }
  const preds = st.oos.filter(o => isNum(o.pCal)).map(o => ({ t: o.t, assetId: o.assetId, p: o.pCal, pBase: o.pBase, fold: o.fold }));
  const baseRate = st.model && isNum(st.model.baseRate) ? st.model.baseRate : mean(st.oos.map(o => o.y));
  return { preds, baseRate };
}

// ─── precision / coverage ───────────────────────────────────────────────────────────────────
/**
 * Precision/coverage table for OOS meta rows [{pMeta, y, ret, t, edge}] (one row per primary
 * trade). opts: { key="pMeta", thresholds=[0.5…0.7], nAll (decision opportunities; default
 * rows.length), lag (NW lag in dates) }. Returns { [thr]: {precision, coverage, coverageAll, n,
 * meanRet, retPerOpp, lift, liftP, edgeOnlyPrecision} } where lift = precision − primary
 * precision and liftP is the two-sided Driscoll–Kraay p-value of kept-vs-rejected precision.
 */
function precisionCoverage(rows, thresholds = REPORT_THRESHOLDS, opts = {}) {
  const key = opts.key || "pMeta";
  const R = (rows || []).filter(r => r && isNum(r[key]) && (r.y === 0 || r.y === 1));
  const N = R.length, nAll = opts.nAll || N;
  const lag = opts.lag || 1;
  const prec0 = N ? mean(R.map(r => r.y)) : null;
  const byEdge = R.some(r => isNum(r.edge)) ? R.slice().sort((a, b) => Math.abs(b.edge || 0) - Math.abs(a.edge || 0)) : null;
  const out = {};
  for (const thr of thresholds) {
    const kept = R.filter(r => r[key] >= thr);
    const n = kept.length;
    const e = { n, precision: n ? r6(mean(kept.map(r => r.y))) : null, coverage: N ? r6(n / N) : 0, coverageAll: nAll ? r6(n / nAll) : 0 };
    const rets = kept.map(r => r.ret).filter(isNum);
    e.meanRet = rets.length ? r6(mean(rets)) : null;
    e.retPerOpp = nAll ? r6(rets.reduce((s, v) => s + v, 0) / nAll) : null;
    e.lift = n && prec0 !== null ? r6(mean(kept.map(r => r.y)) - prec0) : null;
    // kept-vs-rejected precision difference b = Σ(k−k̄)(y−ȳ)/Σ(k−k̄)²; tested as a mean of
    // u_i = (k_i − k̄)(y_i − ȳ)/s_kk with date-clustered HAC variance.
    if (n >= 10 && N - n >= 10) {
      const kbar = n / N, skk = kbar * (1 - kbar);
      const u = R.map(r => (((r[key] >= thr ? 1 : 0) - kbar) * (r.y - prec0)) / skk);
      e.liftP = r6(S.hacMeanTest(u, { dates: R.map(r => r.t), lag }).p);
    } else e.liftP = null;
    if (byEdge && n) e.edgeOnlyPrecision = r6(mean(byEdge.slice(0, n).map(r => r.y)));
    out[String(thr)] = e;
  }
  return out;
}

/** Threshold maximizing net return per opportunity with coverageAll ≥ minCoverage. */
function chooseThreshold(rows, { nAll, minCoverage = 0.15, grid = SEARCH_THRESHOLDS, lag = 1 } = {}) {
  const tab = precisionCoverage(rows, grid, { nAll, lag });
  let best = null, bestAny = null;
  for (const thr of grid) {
    const e = tab[String(thr)];
    if (!e.n || e.retPerOpp === null) continue;
    if (!bestAny || e.retPerOpp > bestAny.e.retPerOpp) bestAny = { thr, e };
    if (e.coverageAll >= minCoverage && (!best || e.retPerOpp > best.e.retPerOpp)) best = { thr, e };
  }
  const pick = best || bestAny;
  if (!pick) return { threshold: 0.5, feasible: false, reason: "no OOS trades" };
  return {
    threshold: pick.thr, feasible: !!best, minCoverage, precision: pick.e.precision, coverage: pick.e.coverage,
    coverageAll: pick.e.coverageAll, retPerOpp: pick.e.retPerOpp, meanRet: pick.e.meanRet,
    reason: best ? `max net return per opportunity with coverage ≥ ${minCoverage}` : `coverage ≥ ${minCoverage} not attainable; max net return per opportunity`,
  };
}

// ─── the MetaLabeler ─────────────────────────────────────────────────────────────────────────
class MetaLabeler {
  constructor(o = {}) {
    this.spec = o.spec || null;
    this.names = o.names || (this.spec ? metaFeatureNames(this.spec) : []);
    this.kind = o.kind || "ensemble";
    this.logistic = o.logistic || null;
    this.gbm = o.gbm || null;
    this.primary = o.primary || "pooled";
    this.primaryTarget = o.primaryTarget || "y";
    this.primaryBaseRate = isNum(o.primaryBaseRate) ? o.primaryBaseRate : 0.5;
    this.minEdge = isNum(o.minEdge) ? o.minEdge : 0;
    this.baseRate = isNum(o.baseRate) ? o.baseRate : 0.5;   // meta-label base rate (training)
    this.threshold = isNum(o.threshold) ? o.threshold : 0.5;
    this.thresholdInfo = o.thresholdInfo || null;
    this.l2c = o.l2c != null ? o.l2c : null;
    this.nTrain = o.nTrain || 0;
    this.trainedThrough = o.trainedThrough != null ? o.trainedThrough : null;
    this.horizon = o.horizon || null;
    this.ahead = o.ahead || null;
    this.summary = o.summary || null;
  }

  /** Meta feature vector for (row, side, p); side defaults to sign(p − primaryBaseRate). */
  features(row, side, p) {
    const edge = isNum(p) ? p - this.primaryBaseRate : 0;
    let sd = sideOf(side);
    if (!sd) sd = edge >= 0 ? 1 : -1;
    return metaFeatures(row, sd, Math.abs(edge), this.spec);
  }

  /** P(the `side` trade on this row succeeds net of costs), given the primary probability p. */
  predict(row, side, p) {
    if (!this.spec) return this.baseRate;
    return S.predictModel(this, this.features(row, side, p)).p;
  }

  /** Should the engine take the trade? predict ≥ threshold (and the primary clears minEdge). */
  accept(row, side, p) {
    const edge = isNum(p) ? Math.abs(p - this.primaryBaseRate) : 0;
    const pm = this.predict(row, side, p);
    return { accept: edge >= this.minEdge && pm >= this.threshold, pMeta: pm, edge };
  }

  toJSON() {
    return {
      v: 1, type: "meta", kind: this.kind, spec: this.spec, names: this.names,
      logistic: this.logistic ? this.logistic.toJSON() : null, gbm: this.gbm ? this.gbm.toJSON() : null,
      primary: this.primary, primaryTarget: this.primaryTarget, primaryBaseRate: this.primaryBaseRate, minEdge: this.minEdge,
      baseRate: this.baseRate, threshold: this.threshold, thresholdInfo: this.thresholdInfo, l2c: this.l2c, nTrain: this.nTrain,
      trainedThrough: this.trainedThrough, horizon: this.horizon, ahead: this.ahead, summary: this.summary,
    };
  }

  static fromJSON(o) {
    if (typeof o === "string") o = JSON.parse(o);
    if (!o || typeof o !== "object") return new MetaLabeler();
    return new MetaLabeler({
      ...o,
      logistic: o.logistic ? LogisticModel.fromJSON(o.logistic) : null,
      gbm: o.gbm ? GBMClassifier.fromJSON(o.gbm) : null,
    });
  }
}

// ─── training ────────────────────────────────────────────────────────────────────────────────
/**
 * trainMetaLabeler(dataset, { primary="pooled"|"stacker", stacker (trainStacker result),
 *   primaryTarget="y", minEdge=0.02, mask, model="ensemble", folds=5, embargo, purge, minTrain,
 *   minTrainFrac=0.3, thresholds=[0.5…0.7], minCoverage=0.15, seed })
 * → { model: MetaLabeler|null, oos: [{t, assetId, side, edge, p, pMeta, y, ret, fold}], metrics, threshold }
 */
function trainMetaLabeler(dataset, opts = {}) {
  const started = Date.now();
  if (!dataset || !Array.isArray(dataset.rows)) throw new TypeError("trainMetaLabeler: dataset.rows is required");
  const primary = opts.primary || (opts.stacker ? "stacker" : "pooled");
  if (!["pooled", "stacker"].includes(primary)) throw new Error(`unknown primary "${primary}"`);
  const primaryTarget = opts.primaryTarget || (opts.stacker && opts.stacker.target) || "y";
  const tf = Number(dataset.tf) || 86400, tfMs = tf * 1000;
  const ahead = Math.max(1, Math.floor(opts.ahead || dataset.ahead || 5));
  const purge = opts.purge != null ? opts.purge : ahead;
  const minEdge = isNum(opts.minEdge) ? opts.minEdge : 0.02;
  const folds = opts.folds || S.DEFAULTS.folds;
  const minTrainFrac = opts.minTrainFrac != null ? opts.minTrainFrac : S.DEFAULTS.minTrainFrac;
  const all = S.sortRows(dataset.rows);
  const endsAll = S.computeLabelEnds(all, { ahead: purge, tf, useLabEnd: purge === (dataset.ahead || purge) });
  const nDates = new Set(all.map(r => r.t)).size;
  const embargo = opts.embargo != null ? opts.embargo : Math.max(1, Math.ceil(0.01 * nDates));
  const embargoMs = embargo * tfMs;
  const mo = S.resolveModelOpts({ ...opts, model: opts.model || "ensemble", embargoMs });
  const params = { primary, primaryTarget, minEdge, ahead, purge, embargo, folds, minTrainFrac, model: mo.kind, seed: mo.seed, minCoverage: opts.minCoverage != null ? opts.minCoverage : 0.15 };

  // 1. primary OOS predictions
  let prim;
  if (primary === "stacker") {
    const st = opts.stacker || S.trainStacker(dataset, {
      target: primaryTarget, mask: opts.mask, folds, embargo, purge, seed: mo.seed, bootstrapReps: 0, model: opts.stackerModel || "ensemble",
    });
    prim = stackerPrimary(dataset, st);
  } else {
    prim = pooledPrimary(dataset, { target: primaryTarget, ahead: purge, tf, embargoMs, folds, minTrain: opts.minTrain, minTrainFrac });
  }

  // 2. meta rows (primary trades with a known bracket outcome) + all decision opportunities
  const byKey = new Map(all.map((r, k) => [`${r.t}|${r.assetId}`, k]));
  const opp = [];
  const M = { rows: [], y: [], ends: [], side: [], edge: [], ret: [], p: [] };
  for (const q of prim.preds) {
    const k = byKey.get(`${q.t}|${q.assetId}`);
    if (k === undefined) continue;
    const r = all[k];
    if (!r.lab || !isNum(r.lab.tbLongRet) || !isNum(r.lab.tbShortRet)) continue;
    opp.push(r.t);
    const edge = q.p - q.pBase;
    if (!(Math.abs(edge) >= minEdge)) continue;
    const side = edge > 0 ? 1 : -1;
    const ret = side > 0 ? r.lab.tbLongRet : r.lab.tbShortRet;
    M.rows.push(r); M.y.push(ret > 0 ? 1 : 0); M.ends.push(endsAll[k]); M.side.push(side); M.edge.push(edge); M.ret.push(ret); M.p.push(q.p);
  }
  const empty = reason => ({ model: null, oos: [], metrics: { n: 0, reason, nPrimaryTrades: M.rows.length, nOpportunities: opp.length }, threshold: null, params, timing: { ms: Date.now() - started } });
  if (M.rows.length < 200) return empty(`too few primary trades with outcomes (${M.rows.length})`);

  // 3. purged walk-forward over the meta rows
  const splits = S.purgedWalkForward(M.rows, { labelEnds: M.ends, folds, embargoMs, minTrain: opts.minTrain, minTrainFrac });
  if (!splits.length) return empty("not enough meta rows for a purged walk-forward");
  const oos = [], perFold = [];
  for (const f of splits) {
    const trR = f.train.map(k => M.rows[k]);
    const spec = S.makeSpec(trR, { mask: S.resolveMask(opts.mask, dataset, all, endsAll, f.cutoff), signalIds: dataset.signalIds });
    const X = f.train.map(k => metaFeatures(M.rows[k], M.side[k], Math.abs(M.edge[k]), spec));
    const ytr = f.train.map(k => M.y[k]);
    const m = S.fitModel(X, ytr, trR.map(r => r.t), f.train.map(k => M.ends[k]), mo);
    const fp = [];
    for (const k of f.test) {
      const r = M.rows[k];
      const pm = S.predictModel(m, metaFeatures(r, M.side[k], Math.abs(M.edge[k]), spec));
      const o = { t: r.t, assetId: r.assetId, side: M.side[k], edge: M.edge[k], p: M.p[k], pMeta: pm.p, pLog: pm.pLog, pGbm: pm.pGbm, y: M.y[k], ret: M.ret[k], fold: f.k, pTrainBase: m.baseRate };
      oos.push(o); fp.push(o);
    }
    const fm = S.probMetrics(fp, "pMeta");
    perFold.push({ k: f.k, testStart: f.testStart, testEnd: f.testEnd, nTrain: f.train.length, nTest: f.test.length, l2c: m.l2c, gbmTrees: m.gbmTrees, baseRate: r6(m.baseRate), auc: fm.auc, logloss: fm.logloss });
  }

  // 4. OOS report
  const t0 = splits[0].testStart, t1 = splits[splits.length - 1].testEnd;
  const nAll = opp.filter(t => t >= t0 && t <= t1).length;
  const lag = S.lagInDates(oos.map(o => o.t), ahead, tf);
  const thresholds = opts.thresholds || REPORT_THRESHOLDS;
  const precisionAt = precisionCoverage(oos, thresholds, { nAll, lag });
  const pm = S.probMetrics(oos, "pMeta"), pb = S.probMetrics(oos, "pTrainBase");
  const dm = S.dieboldMariano(oos.map(o => ll(o.pMeta, o.y)), oos.map(o => ll(o.pTrainBase, o.y)), { dates: oos.map(o => o.t), lag });
  const rets = oos.map(o => o.ret);
  const primaryStats = {
    n: oos.length, precision: r6(mean(oos.map(o => o.y))), coverageAll: nAll ? r6(oos.length / nAll) : null,
    meanRet: r6(mean(rets)), retPerOpp: nAll ? r6(rets.reduce((s, v) => s + v, 0) / nAll) : null,
  };
  const thr = chooseThreshold(oos, { nAll, minCoverage: params.minCoverage, lag });
  const thrRow = precisionCoverage(oos, [thr.threshold], { nAll, lag })[String(thr.threshold)];
  const boot = S.aucBlockBootstrap(oos, ["pMeta", "pTrainBase"], { reps: opts.bootstrapReps != null ? opts.bootstrapReps : S.DEFAULTS.bootstrapReps, block: 2 * lag, seed: mo.seed });
  const at55 = precisionAt["0.55"] || null;
  const raises = row => !!(row && row.n && row.lift > 0 && row.liftP !== null && row.liftP < 0.05);
  const metrics = {
    n: oos.length, nOpportunities: nAll, nDates: new Set(oos.map(o => o.t)).size, folds: splits.length, lag,
    auc: pm.auc, aucCI: boot ? boot.pMeta : null, brier: pm.brier, logloss: pm.logloss,
    baseRate: { brier: pb.brier, logloss: pb.logloss }, dmVsBase: { stat: r6(dm.stat), p: r6(dm.p), pOneSided: r6(dm.pOneSided), meanDiff: r6(dm.meanDiff), nDates: dm.nDates, lag: dm.lag },
    logistic: mo.kind !== "gbm" ? S.probMetrics(oos, "pLog") : null, gbm: mo.kind !== "logistic" ? S.probMetrics(oos, "pGbm") : null,
    primary: primaryStats,
    precisionAt,
    threshold: { ...thr, lift: thrRow ? thrRow.lift : null, liftP: thrRow ? thrRow.liftP : null, edgeOnlyPrecision: thrRow ? thrRow.edgeOnlyPrecision : null },
    raisesPrecision: { at055: raises(at55), atThreshold: raises(thrRow) },
    reliability: reliabilityOf(oos.map(o => ({ p: o.pMeta, y: o.y }))),
    perFold,
  };

  // 5. final model on every meta row
  const spec = S.makeSpec(M.rows, { mask: S.resolveMask(opts.mask, dataset, all, endsAll, Infinity), signalIds: dataset.signalIds });
  const X = M.rows.map((r, k) => metaFeatures(r, M.side[k], Math.abs(M.edge[k]), spec));
  const fm = S.fitModel(X, M.y, M.rows.map(r => r.t), M.ends, mo);
  const model = new MetaLabeler({
    spec, kind: mo.kind, logistic: fm.logistic, gbm: fm.gbm, primary, primaryTarget, primaryBaseRate: prim.baseRate, minEdge,
    baseRate: fm.baseRate, threshold: thr.threshold, thresholdInfo: metrics.threshold, l2c: fm.l2c, nTrain: M.rows.length,
    trainedThrough: M.rows[M.rows.length - 1].t, horizon: opts.horizon || dataset.horizon || null, ahead,
    summary: { auc: metrics.auc, precision: primaryStats.precision, thresholdPrecision: thr.precision, thresholdCoverageAll: thr.coverageAll, n: metrics.n },
  });
  return {
    model, oos: oos.map(o => ({ t: o.t, assetId: o.assetId, side: o.side, edge: o.edge, p: o.p, pMeta: o.pMeta, y: o.y, ret: o.ret, fold: o.fold })),
    metrics, threshold: thr.threshold, trainedThrough: model.trainedThrough, params, timing: { ms: Date.now() - started },
  };
}

function ll(p, y) { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return y ? -Math.log(q) : -Math.log(1 - q); }

module.exports = { trainMetaLabeler, MetaLabeler, precisionCoverage, chooseThreshold, metaFeatures, metaFeatureNames, sideOf, REPORT_THRESHOLDS };
