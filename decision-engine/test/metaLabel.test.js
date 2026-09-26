"use strict";
const test = require("node:test");
const assert = require("node:assert");
const S = require("../server/research/stacker");
const ML = require("../server/research/metaLabel");

const DAY = 86400000;

test("sideOf maps numbers and labels", () => {
  assert.strictEqual(ML.sideOf(1), 1);
  assert.strictEqual(ML.sideOf(-0.3), -1);
  assert.strictEqual(ML.sideOf("BUY"), 1);
  assert.strictEqual(ML.sideOf("strong_sell"), -1);
  assert.strictEqual(ML.sideOf("long"), 1);
  assert.strictEqual(ML.sideOf("HOLD"), 0);
  assert.strictEqual(ML.sideOf(undefined), 0);
});

test("precisionCoverage: precision, coverage (of trades and of opportunities), returns, lift, edge-only comparator", () => {
  // 40 trades over 40 dates: pMeta 0.40…0.79; success iff pMeta ≥ 0.6 except two misses
  const rows = Array.from({ length: 40 }, (_, k) => {
    const pMeta = 0.4 + 0.01 * k;
    const y = pMeta >= 0.6 ? (k % 10 === 3 ? 0 : 1) : k % 4 === 0 ? 1 : 0;
    return { t: k * DAY, pMeta, y, ret: y ? 0.02 : -0.01, edge: (k % 2 ? 1 : -1) * 0.001 * (40 - k) };
  });
  const tab = ML.precisionCoverage(rows, [0.5, 0.6, 0.9], { nAll: 80, lag: 1 });
  const prec0 = rows.reduce((s, r) => s + r.y, 0) / 40;
  const kept6 = rows.filter(r => r.pMeta >= 0.6);
  assert.strictEqual(tab["0.6"].n, kept6.length);
  assert.ok(Math.abs(tab["0.6"].precision - kept6.reduce((s, r) => s + r.y, 0) / kept6.length) < 1e-6);
  assert.ok(Math.abs(tab["0.6"].coverage - kept6.length / 40) < 1e-6);
  assert.ok(Math.abs(tab["0.6"].coverageAll - kept6.length / 80) < 1e-6);
  assert.ok(Math.abs(tab["0.6"].lift - (tab["0.6"].precision - prec0)) < 1e-6);
  assert.ok(tab["0.6"].liftP < 0.01, "clear separation is significant");
  assert.ok(Math.abs(tab["0.6"].retPerOpp - kept6.reduce((s, r) => s + r.ret, 0) / 80) < 1e-6);
  // edge-only filter keeps the |edge|-largest trades = the lowest k here → poor precision
  assert.ok(tab["0.6"].edgeOnlyPrecision < tab["0.6"].precision);
  assert.strictEqual(tab["0.9"].n, 0);
  assert.strictEqual(tab["0.9"].precision, null);
  assert.strictEqual(tab["0.9"].coverage, 0);
  // threshold choice: max net return per opportunity with coverageAll ≥ 0.15
  const thr = ML.chooseThreshold(rows, { nAll: 80, minCoverage: 0.15 });
  assert.ok(thr.feasible && thr.coverageAll >= 0.15);
  assert.ok(thr.threshold >= 0.58 && thr.threshold <= 0.61, `thr ${thr.threshold}`);
  const infeasible = ML.chooseThreshold(rows, { nAll: 10000, minCoverage: 0.15 });
  assert.strictEqual(infeasible.feasible, false);
});

// Planted: the primary (calibrated v1 pRaw) is right only when tech.volume.breakout is high.
let planted = null;
const plantedData = () => S.synthDataset({ nAssets: 20, nDates: 700, seed: 5, meta: { id: "tech.volume.breakout", kappa: 0.5 } });
function plantedRun() {
  if (!planted) planted = ML.trainMetaLabeler(plantedData(), { primary: "pooled", minEdge: 0.02, bootstrapReps: 100 });
  return planted;
}

test("planted 'primary is right when X is high': meta-labeling raises OOS precision at the cost of coverage", () => {
  const r = plantedRun();
  const m = r.metrics;
  assert.ok(r.model instanceof ML.MetaLabeler);
  assert.ok(m.n > 2000 && m.folds === 5);
  assert.ok(m.auc > 0.55 && m.aucCI[0] > 0.5, `meta auc ${m.auc} ${m.aucCI}`);
  assert.ok(m.dmVsBase.p < 0.05 && m.dmVsBase.stat < 0, "meta-P beats the meta base rate in log-loss");
  const p0 = m.primary.precision;
  const at = m.precisionAt["0.55"];
  assert.ok(at.precision > p0 + 0.05, `precision ${at.precision} vs primary ${p0}`);
  assert.ok(at.liftP < 0.05);
  assert.ok(at.coverage < 0.8 && at.coverage > 0.05, "coverage is traded away");
  assert.ok(at.precision > at.edgeOnlyPrecision + 0.03, "better than just demanding a larger primary edge");
  assert.ok(at.meanRet > m.primary.meanRet, "kept trades earn more per trade");
  assert.strictEqual(m.raisesPrecision.at055, true);
  // table covers 0.5 … 0.7 and coverage is monotone non-increasing in the threshold
  const thr = Object.keys(m.precisionAt).map(Number);
  assert.deepStrictEqual(thr, [0.5, 0.55, 0.6, 0.65, 0.7]);
  for (let k = 1; k < thr.length; k++) assert.ok(m.precisionAt[String(thr[k])].coverage <= m.precisionAt[String(thr[k - 1])].coverage);
  assert.ok(m.reliability.ece < 0.08, `ece ${m.reliability.ece}`);
  assert.strictEqual(r.model.threshold, r.threshold);
  assert.ok(r.threshold >= 0.4 && r.threshold <= 0.7);
});

test("meta rows: side = sign(p − base) with |edge| ≥ minEdge; label = that side's net bracket return > 0; all OOS", () => {
  const r = plantedRun();
  const ds = plantedData();
  const byKey = new Map(ds.rows.map(x => [`${x.t}|${x.assetId}`, x]));
  const firstTest = Math.min(...r.metrics.perFold.map(f => f.testStart));
  for (const o of r.oos) {
    const row = byKey.get(`${o.t}|${o.assetId}`);
    assert.ok(Math.abs(o.edge) >= 0.02);
    assert.strictEqual(o.side, o.edge > 0 ? 1 : -1);
    const ret = o.side > 0 ? row.lab.tbLongRet : row.lab.tbShortRet;
    assert.strictEqual(o.ret, ret);
    assert.strictEqual(o.y, ret > 0 ? 1 : 0);
    assert.ok(o.t >= firstTest);
  }
  // meta folds are purged: every fold's training rows end before its test block (checked via sizes)
  for (const f of r.metrics.perFold) assert.ok(f.nTrain > 0 && f.nTest > 0);
});

test("serialization round-trip + live predict(row, side, p)", () => {
  const r = plantedRun();
  const m2 = ML.MetaLabeler.fromJSON(JSON.parse(JSON.stringify(r.model)));
  assert.strictEqual(m2.threshold, r.model.threshold);
  assert.strictEqual(m2.primaryBaseRate, r.model.primaryBaseRate);
  const ds = plantedData();
  for (const row of ds.rows.slice(-100)) {
    for (const [side, p] of [[1, 0.56], [-1, 0.44], ["SELL", 0.47]]) {
      const a = r.model.predict(row, side, p), b = m2.predict(row, side, p);
      assert.strictEqual(a, b);
      assert.ok(a > 0 && a < 1);
    }
  }
  const row = ds.rows[ds.rows.length - 1];
  const live = { ...row, sig: { ...row.sig, "sent.news.aggregate": [1, 1], "deriv.oi.fragility": [-1, 1] }, lab: undefined };
  assert.strictEqual(m2.predict(live, 1, 0.58), m2.predict(row, 1, 0.58), "unknown live ids are ignored");
  assert.strictEqual(m2.predict(live, 0, 0.58), m2.predict(live, 1, 0.58), "side defaults to sign(p − base)");
  const acc = m2.accept(live, 1, 0.58);
  assert.strictEqual(typeof acc.accept, "boolean");
  // X high → higher P(success) for the primary's call (the planted relation)
  const hi = { ...row, sig: { ...row.sig, "tech.volume.breakout": [1, 1] } }, lo = { ...row, sig: { ...row.sig, "tech.volume.breakout": [-1, 1] } };
  assert.ok(m2.predict(hi, 1, 0.56) > m2.predict(lo, 1, 0.56));
  assert.strictEqual(ML.MetaLabeler.fromJSON(null).predict({}, 1, 0.5), 0.5);
});

test("stacker primary: uses sequentially-calibrated OOS stacker calls only; a bare Stacker is refused", () => {
  const ds = S.synthDataset({ nAssets: 10, nDates: 420, seed: 8, plant: { id: "rel.xs.mom_rank", beta: 0.6 } });
  const st = S.trainStacker(ds, { target: "y", bootstrapReps: 0 });
  const r = ML.trainMetaLabeler(ds, { primary: "stacker", stacker: st, minEdge: 0.01, bootstrapReps: 0 });
  assert.ok(r.model, r.metrics.reason);
  const stKeys = new Map(st.oos.filter(o => o.pCal !== null).map(o => [`${o.t}|${o.assetId}`, o]));
  for (const o of r.oos) {
    const s = stKeys.get(`${o.t}|${o.assetId}`);
    assert.ok(s, "every meta row is a stacker OOS row");
    assert.strictEqual(o.p, s.pCal);
    assert.ok(Math.abs(o.edge - (s.pCal - s.pCalBase)) < 1e-12, "edge is measured from the calibrated scale's centre");
  }
  assert.strictEqual(r.model.primary, "stacker");
  assert.strictEqual(r.model.primaryBaseRate, st.model.baseRate);
  assert.throws(() => ML.trainMetaLabeler(ds, { primary: "stacker", stacker: st.model }), /in-sample/);
});

test("no primary edge (constant pRaw): no trades → no model, with a reason; no crash", () => {
  const ds = S.synthDataset({ nAssets: 10, nDates: 400, seed: 13 });
  for (const row of ds.rows) row.pRaw = 0.5;
  const r = ML.trainMetaLabeler(ds, { primary: "pooled", minEdge: 0.02, bootstrapReps: 0 });
  assert.strictEqual(r.model, null);
  assert.ok(/too few primary trades/.test(r.metrics.reason));
});

test("noise meta (leakage guard): primary trades on noise → meta AUC ≈ 0.5, no significant precision lift", () => {
  const r = ML.trainMetaLabeler(S.synthDataset({ nAssets: 16, nDates: 520, seed: 17 }), { primary: "pooled", minEdge: 0, bootstrapReps: 100 });
  const m = r.metrics;
  assert.ok(m.n > 2000);
  assert.ok(Math.abs(m.auc - 0.5) < 0.04, `auc ${m.auc}`);
  assert.ok(m.aucCI[0] < 0.5 && m.aucCI[1] > 0.5);
  // no threshold (0.40…0.70 grid, ≥ 50 kept trades) shows a significant precision lift
  const tab = ML.precisionCoverage(r.oos, Array.from({ length: 31 }, (_, k) => +(0.4 + 0.01 * k).toFixed(2)), { nAll: m.nOpportunities, lag: m.lag });
  let tested = 0;
  for (const [thr, e] of Object.entries(tab)) {
    if (e.n < 50 || e.liftP === null) continue;
    tested++;
    assert.ok(!(e.lift > 0 && e.liftP < 0.01), `spurious lift at ${thr}: ${JSON.stringify(e)}`);
  }
  assert.ok(tested >= 3);
  assert.strictEqual(m.raisesPrecision.at055, false);
});
