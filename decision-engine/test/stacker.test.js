"use strict";
const test = require("node:test");
const assert = require("node:assert");
const S = require("../server/research/stacker");
const { mulberry32 } = require("../server/analysis/ml");

const DAY = 86400000;

// Panel with real calendar gaps: stocks trade Mon–Fri (i advances per trading day), crypto daily.
function calendarPanel({ nDays = 260, stocks = 4, crypto = 2, stride = 1, seed = 3 } = {}) {
  const rnd = mulberry32(seed);
  const rows = [];
  const t0 = Date.UTC(2023, 0, 2); // a Monday
  const ids = [...Array.from({ length: stocks }, (_, k) => ["stock", `STOCK:S${k}`]), ...Array.from({ length: crypto }, (_, k) => ["crypto", `CRYPTO:C${k}`])];
  for (const [cls, id] of ids) {
    let i = 0;
    for (let d = 0; d < nDays; d++) {
      const t = t0 + d * DAY, wd = new Date(t).getUTCDay();
      if (cls === "stock" && (wd === 0 || wd === 6)) continue;
      if (i % stride === 0) {
        rows.push({ assetId: id, assetClass: cls, t, i, sig: { "tech.trend.ema_stack": [rnd() * 2 - 1, 0.5] }, pRaw: 0.5, lab: { y: rnd() < 0.5 ? 1 : 0, ret: 0 } });
      }
      i++;
    }
  }
  return rows.sort((a, b) => a.t - b.t || (a.assetId < b.assetId ? -1 : 1));
}

// ─── features ────────────────────────────────────────────────────────────────────────────────
function specRows() {
  const base = { assetClass: "stock", atrPct: 0.02, annVol: 0.3, pRaw: 0.55, regime: { trend: "up", vol: "normal", hmmState: 1 } };
  const rows = [];
  for (let k = 0; k < 400; k++) {
    const s = ((k % 7) - 3) / 4;
    const r = { ...base, t: k * DAY, assetId: k % 2 ? "STOCK:A" : "CRYPTO:B", assetClass: k % 2 ? "stock" : "crypto",
      atrPct: k === 5 ? 5 : 0.02 + 0.0001 * (k % 50), annVol: 0.3 + 0.001 * (k % 100),
      regime: { trend: ["up", "down", "range"][k % 3], vol: ["low", "normal", "high"][k % 3], hmmState: k % 2 },
      sig: { "tech.trend.ema_stack": [s, 0.8], "rel.rs.1m": [-s, 0.5], "regime.trend.state": [s / 2, 1] } };
    if (k % 3 === 0) r.sig["macro.risk.vix"] = [0.4, 0.5]; // sparse family (1/3 of rows)
    if (k % 100 === 0) r.sig["tech.rare.thing"] = [1, 1];  // 4 rows < minCount 5 → not in the spec
    rows.push(r);
  }
  return rows;
}

test("makeSpec: fixed order, sparse families, regimes, classes, winsor, mask 0 drops ids", () => {
  const rows = specRows();
  const spec = S.makeSpec(rows, { signalIds: ["rel.rs.1m", "tech.trend.ema_stack", "macro.risk.vix", "regime.trend.state"] });
  assert.deepStrictEqual(spec.signalIds, ["rel.rs.1m", "tech.trend.ema_stack", "macro.risk.vix", "regime.trend.state"]);
  assert.deepStrictEqual(spec.families, ["technical", "regime", "relative", "macro"]);
  assert.deepStrictEqual(spec.sparse, ["macro"]);
  assert.ok(spec.regimes.includes("trend:down") && spec.regimes.includes("vol:high") && spec.regimes.includes("hmm:crypto:0"));
  assert.ok(!spec.regimes.includes("vol:extreme"), "unseen levels are not columns");
  assert.deepStrictEqual(spec.classes, ["crypto", "stock"]);
  assert.ok(spec.winsor.atrPct[1] < 1, "99th percentile winsor excludes the 5.0 outlier");
  assert.strictEqual(spec.names.length, 4 + 4 + 1 + spec.regimes.length + 2 + 3);
  const masked = S.makeSpec(rows, { mask: { "rel.rs.1m": 0, "tech.trend.ema_stack": 1.3 } });
  assert.ok(!masked.signalIds.includes("rel.rs.1m"));
  assert.ok(!masked.families.includes("relative"));
  assert.strictEqual(masked.mask["tech.trend.ema_stack"], 1.3);
});

test("featurize: missing = 0 + presence, family means, one-hots, mask, winsor, logit pRaw, unknown ids ignored", () => {
  const rows = specRows();
  const spec = S.makeSpec(rows, { mask: { "tech.trend.ema_stack": 1.5 } });
  const ix = n => spec.names.indexOf(n);
  const row = { assetClass: "crypto", atrPct: 99, annVol: null, pRaw: 0.6, regime: { trend: "down", vol: "high", hmmState: 0 },
    sig: { "tech.trend.ema_stack": [0.5, 0.8], "regime.trend.state": { score: -0.4, confidence: 0.5 }, "sent.news.aggregate": [1, 1], "tech.1h.trend.ema_stack": [1, 1] } };
  const x = S.featurize(row, spec);
  assert.strictEqual(x.length, spec.names.length);
  assert.ok(x.every(Number.isFinite));
  assert.ok(Math.abs(x[ix("sig:tech.trend.ema_stack")] - 0.5 * 0.8 * 1.5) < 1e-12, "mask multiplier applied");
  assert.strictEqual(x[ix("sig:rel.rs.1m")], 0, "missing signal = 0");
  assert.strictEqual(x[ix("sig:macro.risk.vix")], 0);
  assert.strictEqual(x[ix("present:macro")], 0, "sparse family absent");
  assert.ok(Math.abs(x[ix("fam:technical")] - 0.6) < 1e-12, "family mean over present spec signals");
  assert.ok(Math.abs(x[ix("fam:regime")] + 0.2) < 1e-12, "{score, confidence} objects accepted");
  assert.strictEqual(x[ix("regime:trend:down")], 1);
  assert.strictEqual(x[ix("regime:trend:up")], 0);
  assert.strictEqual(x[ix("regime:vol:high")], 1);
  assert.strictEqual(x[ix("regime:hmm:crypto:0")], 1);
  assert.strictEqual(x[ix("class:crypto")], 1);
  assert.strictEqual(x[ix("class:stock")], 0);
  assert.strictEqual(x[ix("atrPct")], spec.winsor.atrPct[1], "winsorized at the training 99th pct");
  assert.strictEqual(x[ix("annVol")], spec.winsor.annVol[2], "missing → training median");
  assert.ok(Math.abs(x[ix("logitPRaw")] - Math.log(0.6 / 0.4)) < 1e-12);
  // unknown ids (live-only families, other timeframes) change nothing
  const stripped = { ...row, sig: { "tech.trend.ema_stack": [0.5, 0.8], "regime.trend.state": { score: -0.4, confidence: 0.5 } } };
  assert.deepStrictEqual(S.featurize(stripped, spec), x);
  // a live row whose confidences were already masked is not masked twice
  const pre = { ...stripped, masked: true, sig: { ...stripped.sig, "tech.trend.ema_stack": [0.5, 0.8 * 1.5] } };
  assert.ok(Math.abs(S.featurize(pre, spec)[ix("sig:tech.trend.ema_stack")] - 0.6) < 1e-12);
  // string regime labels and empty rows are handled
  const y = S.featurize({ regime: "trending-up/extreme-vol", assetClass: "etf" }, spec);
  assert.strictEqual(y[ix("regime:trend:up")], 1);
  assert.strictEqual(y[ix("class:stock")], 1);
  assert.ok(S.featurize(null, spec).every(v => v === 0));
});

// ─── labels / splitter ───────────────────────────────────────────────────────────────────────
test("labelOf: y / yEx / tbLong (net bracket return > 0) and nulls", () => {
  const r = lab => ({ lab });
  assert.strictEqual(S.labelOf(r({ y: 1, ret: 0.01 }), "y"), 1);
  assert.strictEqual(S.labelOf(r({ ret: -0.01 }), "y"), 0);
  assert.strictEqual(S.labelOf(r({ yEx: 0, exRet: -0.02 }), "yEx"), 0);
  assert.strictEqual(S.labelOf(r({ yEx: 0, exRet: null }), "yEx"), null);
  assert.strictEqual(S.labelOf(r({ tbLong: 0, tbLongRet: 0.004 }), "tbLong"), 1, "profitable time-out counts as success");
  assert.strictEqual(S.labelOf(r({ tbLong: 1, tbLongRet: -0.001 }), "tbLong"), 0, "target hit but net of costs ≤ 0");
  assert.strictEqual(S.labelOf(r({ tbLong: 0 }), "tbLong"), null, "time-out without a return is unknown");
  assert.strictEqual(S.labelOf({ lab: null }, "y"), null);
  assert.throws(() => S.labelOf(r({ y: 1 }), "nope"));
});

test("computeLabelEnds: exact per-asset bar lookup (weekends), conservative with stride and at the end", () => {
  const rows = calendarPanel({ nDays: 60 });
  const ends = S.computeLabelEnds(rows, { ahead: 5, tf: 86400 });
  const byKey = new Map(rows.map(r => [`${r.assetId}|${r.i}`, r.t]));
  let stockWeekendSpans = 0;
  rows.forEach((r, k) => {
    const exact = byKey.get(`${r.assetId}|${r.i + 5}`);
    if (exact !== undefined) assert.strictEqual(ends[k], exact);
    else assert.ok(ends[k] >= r.t + 5 * DAY, "fallback is never shorter than the calendar window");
    if (r.assetClass === "stock" && exact !== undefined && exact > r.t + 5 * DAY) stockWeekendSpans++;
  });
  assert.ok(stockWeekendSpans > 0, "naive t + ahead·tf would under-purge stock rows");
  // stride 2: rows at i, i+2, … → the first row with i' ≥ i+5 (an upper bound)
  const r2 = calendarPanel({ nDays: 60, stride: 2 });
  const e2 = S.computeLabelEnds(r2, { ahead: 5, tf: 86400 });
  const full = calendarPanel({ nDays: 60 });
  const fullT = new Map(full.map(r => [`${r.assetId}|${r.i}`, r.t]));
  r2.forEach((r, k) => { const ex = fullT.get(`${r.assetId}|${r.i + 5}`); if (ex !== undefined && e2[k] < 1e15) assert.ok(e2[k] >= ex); });
  // the dataset builder's exact lab.tEnd wins (unless disabled, e.g. purge ≠ dataset ahead)
  const withEnd = rows.map((r, k) => (k === 3 ? { ...r, lab: { ...r.lab, tEnd: r.t + 9 * DAY } } : r));
  assert.strictEqual(S.computeLabelEnds(withEnd, { ahead: 5 })[3], rows[3].t + 9 * DAY);
  assert.strictEqual(S.computeLabelEnds(withEnd, { ahead: 5, useLabEnd: false })[3], ends[3]);
});

test("purgedWalkForward: split by date, no training label window overlaps the test block, expanding, min size", () => {
  const rows = calendarPanel({ nDays: 400 });
  const ends = S.computeLabelEnds(rows, { ahead: 5, tf: 86400 });
  const embargo = 2;
  const folds = S.purgedWalkForward(rows, { labelEnds: ends, folds: 5, embargo, tf: 86400, minTrain: 500 });
  assert.strictEqual(folds.length, 5);
  let prevTrain = null, prevEnd = -Infinity;
  for (const f of folds) {
    assert.ok(f.train.length >= 500, "minimum training size");
    assert.ok(f.testStart > prevEnd, "test blocks are chronological and disjoint");
    prevEnd = f.testEnd;
    // every row on a test date is in the test block (split by date, not by row)
    const inBlock = rows.map((r, k) => k).filter(k => rows[k].t >= f.testStart && rows[k].t <= f.testEnd);
    assert.deepStrictEqual(f.test, inBlock);
    for (const k of f.train) {
      assert.ok(ends[k] < f.testStart - embargo * DAY, `train row ${k} label ends ${ends[k]} inside purge/embargo of ${f.testStart}`);
      assert.ok(ends[k] < f.testStart && rows[k].t < f.testStart, "label window [t, tEnd] does not overlap [testStart, testEnd]");
    }
    // nothing trainable was left out: every row with tEnd < cutoff is in train
    const expected = rows.map((r, k) => k).filter(k => ends[k] < f.cutoff);
    assert.deepStrictEqual(f.train, expected);
    if (prevTrain) assert.ok(prevTrain.every(k => f.train.includes(k)), "expanding window");
    prevTrain = f.train;
  }
  // with naive label ends (t + 5 days) and no embargo, some stock row WOULD overlap the block
  const naive = S.purgedWalkForward(rows, { folds: 5, embargo: 0, ahead: 5, tf: 86400, minTrain: 500 });
  const leaks = naive.some(f => f.train.some(k => ends[k] >= f.testStart));
  assert.ok(leaks, "sanity: the exact label ends are what prevent the weekend leak");
  assert.deepStrictEqual(S.purgedWalkForward([], {}), []);
  assert.deepStrictEqual(S.purgedWalkForward(rows.slice(0, 50), { minTrain: 1000 }), []);
});

// ─── statistics ──────────────────────────────────────────────────────────────────────────────
test("dieboldMariano: sign, HAC on date-aggregated losses, degenerate inputs", () => {
  const rnd = mulberry32(9);
  const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const T = 400;
  const a = [], b = [], dates = [];
  const aDup = [], bDup = [], dDup = [];
  for (let t = 0; t < T; t++) {
    const e = g();
    a.push(0.69 - 0.02 + 0.1 * e); b.push(0.69); dates.push(t);
    for (let k = 0; k < 20; k++) { aDup.push(0.69 - 0.02 + 0.1 * e); bDup.push(0.69); dDup.push(t); } // 20 perfectly correlated rows/date
  }
  const one = S.dieboldMariano(a, b, { dates, lag: 5 });
  assert.ok(one.stat < 0 && one.p < 0.05 && one.pOneSided < 0.025, "A clearly better");
  const dup = S.dieboldMariano(aDup, bDup, { dates: dDup, lag: 5 });
  assert.ok(Math.abs(dup.stat - one.stat) < 1e-9, "duplicating a date's rows adds no information");
  const naive = S.dieboldMariano(aDup, bDup, { lag: 5 });
  assert.ok(Math.abs(naive.stat) > 1.5 * Math.abs(one.stat), "row-level test would overstate significance");
  const same = S.dieboldMariano(b, b, { dates, lag: 5 });
  assert.strictEqual(same.p, 1);
  assert.strictEqual(S.dieboldMariano([], [], {}).p, 1);
  assert.ok(Math.abs(S.tCdf(0, 10) - 0.5) < 1e-12 && Math.abs(S.tCdf(2.228, 10) - 0.975) < 1e-3 && Math.abs(S.normCdf(1.96) - 0.975) < 1e-4);
});

// ─── training on synthetic panels ────────────────────────────────────────────────────────────
const PLANT = { id: "rel.xs.mom_rank", beta: 0.6 };
let planted = null;
function plantedRun() {
  if (!planted) planted = S.trainStacker(S.synthDataset({ nAssets: 16, nDates: 520, seed: 21, plant: PLANT }), { target: "y", bootstrapReps: 100 });
  return planted;
}

test("planted signal: stacker beats base rate and calibrated pRaw on the same OOS rows, DM p < 0.05", () => {
  const r = plantedRun();
  const m = r.metrics;
  assert.ok(r.model instanceof S.Stacker);
  assert.strictEqual(m.folds, 5);
  assert.ok(m.n > 3000);
  assert.ok(m.auc > 0.56, `auc ${m.auc}`);
  assert.ok(m.aucBaseline < 0.54, "pRaw carries no planted information");
  assert.ok(m.logloss < m.loglossBaseline && m.brier < m.brierBaseline);
  assert.ok(m.logloss < m.baseRate.logloss);
  assert.ok(m.dm.stat < 0 && m.dm.p < 0.05, `dm ${JSON.stringify(m.dm)}`);
  assert.ok(m.dmVsBase.p < 0.05);
  assert.strictEqual(m.dm.lag, 5);
  assert.ok(m.aucCI[0] > 0.5 && m.aucDiffCI[0] > 0, "block-bootstrap CI excludes chance");
  // every OOS row carries both baselines, and the same rows were used
  for (const o of r.oos) assert.ok(Number.isFinite(o.p) && Number.isFinite(o.pBaseline) && Number.isFinite(o.pBase) && (o.y === 0 || o.y === 1));
  // no OOS row was predicted by a model that trained on a label overlapping it
  for (const f of m.perFold) assert.ok(f.nTrain >= 300 && f.l2c > 0);
  assert.ok(m.calibrated && m.calibrated.n > 0 && m.calibrated.logloss < m.calibrated.loglossBaseline);
  // the planted signal dominates the logistic weights of the final model
  const spec = r.spec, w = r.model.logistic.w.map(Math.abs);
  const top = spec.names[w.indexOf(Math.max(...w))];
  assert.ok(/mom_rank|fam:relative/.test(top), `top feature ${top}`);
});

test("pure noise (leakage guard): AUC ≈ 0.5 and no significant DM improvement", () => {
  for (const [seed, target] of [[31, "y"], [32, "yEx"]]) {
    const r = S.trainStacker(S.synthDataset({ nAssets: 16, nDates: 520, seed }), { target, bootstrapReps: 100 });
    const m = r.metrics;
    assert.ok(Math.abs(m.auc - 0.5) < 0.04, `${target} auc ${m.auc}`);
    assert.ok(m.aucCI[0] < 0.5 && m.aucCI[1] > 0.5, `${target} CI ${m.aucCI}`);
    assert.ok(m.dm.p > 0.05, `${target} dm p ${m.dm.p}`);
    assert.ok(m.dm.pOneSided > 0.1, `${target} one-sided ${m.dm.pOneSided}`);
    assert.ok(m.logloss > 0.68, "no spurious confidence on noise");
  }
});

test("targets: yEx excludes the benchmarks, tbLong trains on net bracket returns, null labels are skipped", () => {
  const ds = S.synthDataset({ nAssets: 10, nDates: 300, seed: 4, plant: PLANT });
  const r = S.trainStacker(ds, { target: "yEx", model: "logistic", bootstrapReps: 0 });
  assert.ok(r.oos.every(o => o.assetId !== "STOCK:SPY" && o.assetId !== "CRYPTO:BTC"));
  const rowsByKey = new Map(ds.rows.map(x => [`${x.t}|${x.assetId}`, x]));
  assert.ok(r.oos.every(o => rowsByKey.get(`${o.t}|${o.assetId}`).lab.yEx === o.y));
  const tb = S.trainStacker(ds, { target: "tbLong", model: "gbm", bootstrapReps: 0 });
  assert.ok(tb.oos.every(o => o.y === (rowsByKey.get(`${o.t}|${o.assetId}`).lab.tbLongRet > 0 ? 1 : 0)));
  assert.ok(tb.oos.every(o => rowsByKey.get(`${o.t}|${o.assetId}`).lab !== null));
  assert.strictEqual(tb.metrics.logistic, null);
  assert.ok(tb.model.gbm && !tb.model.logistic);
  const lastLabelled = Math.max(...ds.rows.filter(x => x.lab).map(x => x.t));
  assert.strictEqual(tb.trainedThrough, lastLabelled);
  assert.throws(() => S.trainStacker(ds, { target: "ret" }));
  const tiny = S.trainStacker(S.synthDataset({ nAssets: 2, nDates: 40, seed: 1 }), {});
  assert.strictEqual(tiny.model, null);
  assert.ok(/not enough/.test(tiny.metrics.reason));
});

test("mask as a function is evaluated per fold on purged training rows only (no look-ahead selection)", () => {
  const ds = S.synthDataset({ nAssets: 8, nDates: 300, seed: 6, plant: PLANT });
  const calls = [];
  const maskFn = train => { calls.push(Math.max(...train.rows.map(r => r.lab.tEnd))); return { "tech.trend.ema_stack": 0, "rel.xs.mom_rank": 1.5 }; };
  const r = S.trainStacker(ds, { target: "y", mask: maskFn, model: "logistic", bootstrapReps: 0 });
  assert.strictEqual(calls.length, r.metrics.folds + 1, "once per fold + once for the final model");
  r.metrics.perFold.forEach((f, k) => assert.ok(calls[k] < f.testStart, "mask saw only labels that ended before the test block"));
  assert.ok(!r.spec.signalIds.includes("tech.trend.ema_stack"));
  assert.strictEqual(r.spec.mask["rel.xs.mom_rank"], 1.5);
});

test("serialization round-trip: identical calibrated predictions, baseRate and target exposed", () => {
  const r = plantedRun();
  const json = JSON.parse(JSON.stringify(r.model));
  const m2 = S.Stacker.fromJSON(json);
  const m3 = S.Stacker.fromJSON(JSON.stringify(r.model));
  assert.strictEqual(m2.target, "y");
  assert.ok(Math.abs(m2.baseRate - r.model.baseRate) < 1e-15 && m2.baseRate > 0.3 && m2.baseRate < 0.7);
  assert.ok(m2.calibrator, "calibrator stored");
  const ds = S.synthDataset({ nAssets: 16, nDates: 520, seed: 21, plant: PLANT });
  for (const row of ds.rows.slice(-200)) {
    const a = r.model.predictDetail(row), b = m2.predictDetail(row);
    assert.strictEqual(a.p, b.p);
    assert.strictEqual(a.pModel, b.pModel);
    assert.strictEqual(m3.predict(row), a.p);
    assert.strictEqual(r.model.predict(row), r.model.calibrator.apply(a.pModel), "predict() is the calibrated probability");
  }
  assert.ok(Math.abs(S.Stacker.fromJSON(null).predict({}) - 0.5) < 1e-12);
});

test("live row: engine-shaped row with extra families/timeframes predicts the same as the dataset row", () => {
  const r = plantedRun();
  const ds = S.synthDataset({ nAssets: 16, nDates: 520, seed: 21, plant: PLANT });
  const row = ds.rows[ds.rows.length - 3];
  const live = {
    assetClass: row.assetClass, atrPct: row.atrPct, annVol: row.annVol, pRaw: row.pRaw,
    regime: { label: row.regime.label, trend: row.regime.trend, vol: row.regime.vol, hmm: { state: row.regime.hmmState } },
    sig: { ...row.sig, "sent.news.aggregate": [0.9, 0.9], "deriv.funding.crowding": [-1, 1], "ml.ensemble.pup": [0.3, 0.2], "tech.1h.trend.ema_stack": [1, 1], "fund.value.fcf_yield": [0.5, 0.5] },
    fam: { ...row.fam, sentiment: 0.8, derivatives: -1, fundamental: 0.25, ml: 0.06 },
  };
  const p = r.model.predict(live);
  assert.ok(p > 0 && p < 1);
  assert.strictEqual(p, r.model.predict(row));
  // nulls mean "missing", not 0 (Number(null) === 0 would turn pRaw into logit(0.01))
  const pm = x => r.model.predictDetail(x).pModel;
  assert.strictEqual(pm({ ...row, pRaw: null }), pm({ ...row, pRaw: undefined }));
  assert.notStrictEqual(pm({ ...row, pRaw: null }), pm({ ...row, pRaw: 0 }));
  const bare = r.model.predict({ sig: {}, assetClass: "stock" });
  assert.ok(Number.isFinite(bare) && bare > 0 && bare < 1);
});

test("deterministic: same data + seed → identical OOS predictions and model", () => {
  const ds = S.synthDataset({ nAssets: 8, nDates: 300, seed: 5, plant: PLANT });
  const a = S.trainStacker(ds, { target: "y", bootstrapReps: 50 });
  const b = S.trainStacker(S.synthDataset({ nAssets: 8, nDates: 300, seed: 5, plant: PLANT }), { target: "y", bootstrapReps: 50 });
  assert.deepStrictEqual(a.oos.map(o => o.p), b.oos.map(o => o.p));
  const noTiming = m => JSON.stringify({ ...m, perFold: m.perFold.map(({ ms, ...f }) => f) });
  assert.strictEqual(noTiming(a.metrics), noTiming(b.metrics));
  assert.deepStrictEqual(JSON.stringify(a.model), JSON.stringify(b.model));
});

test("performance: ~50k rows × ~80 features, all folds + final model < 60 s", { skip: !process.env.STACKER_PERF && "set STACKER_PERF=1 (≈25 s)" }, () => {
  const ds = S.synthDataset({ nAssets: 50, nDates: 1005, seed: 11, extraSignals: 35, plant: { id: "rel.xs.mom_rank", beta: 0.3 } });
  const t = Date.now();
  const r = S.trainStacker(ds, { target: "y" });
  const ms = Date.now() - t;
  assert.ok(ds.rows.length >= 50000 && r.spec.names.length >= 80);
  assert.ok(ms < 60000, `took ${ms} ms`);
});
