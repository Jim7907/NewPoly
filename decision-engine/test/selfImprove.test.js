"use strict";
// Self-improvement loop tests. Everything runs on STUB research modules (dependency injection):
// this file doubles as the `depsModule` loaded inside the cycle worker, so the stubs are defined
// first and the tests only register on the main thread.
const { isMainThread } = require("worker_threads");

// ───────────────────────────── stubs (also used inside the worker) ─────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const DAY = 86400000;
const sigm = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
const burn = (ms) => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Synthetic panel: P(up) = σ(skill·x) with x = score of "s.alpha"; pRaw uninformative. */
function makeDataset(o = {}) {
  const { nAssets = 8, nDates = 300, seed = 1, skill = 1.5, ahead = 5, t0 = Date.UTC(2024, 0, 1) } = o;
  const r = rng(seed), rows = [];
  for (let d = 0; d < nDates; d++) for (let a = 0; a < nAssets; a++) {
    const x = 2 * r() - 1, noise = 2 * r() - 1;
    const y = r() < sigm(skill * x) ? 1 : 0;
    const ret = (y ? 1 : -1) * (0.005 + 0.02 * r());
    const t = t0 + d * DAY;
    rows.push({
      assetId: `CRYPTO:S${a}`, symbol: `S${a}`, assetClass: "crypto", t, i: d, price: 100, atrPct: 0.03, annVol: 0.5,
      regime: { trend: "range", vol: "normal", label: "range/normal-vol" }, sig: { "s.alpha": [x, 1], "s.noise": [noise, 1] }, fam: { stub: x },
      pRaw: 0.5 + 0.02 * (r() - 0.5),
      lab: d < nDates - ahead ? { ret, exRet: ret * 0.5, y, yEx: y, tbLong: y ? 1 : -1, tbShort: y ? -1 : 1, tbLongRet: ret - 0.002, tbShortRet: -ret - 0.002, tEnd: t + ahead * DAY } : null,
    });
  }
  return { version: 2, horizon: o.horizon || "swing", tf: 86400, ahead, built: new Date(t0).toISOString(), universe: Array.from({ length: nAssets }, (_, a) => `CRYPTO:S${a}`),
    benchmarks: { stock: "STOCK:SPY", crypto: "CRYPTO:S0" }, signalIds: ["s.alpha", "s.noise"], rows, meta: { stub: o } };
}

function labelOf(row, target) {
  const lab = row && row.lab;
  if (!lab) return null;
  return target === "yEx" ? lab.yEx : target === "tbLong" ? (lab.tbLongRet > 0 ? 1 : 0) : lab.y;
}

/** 1-D logistic regression by Newton. */
function fitLogit(xs, ys) {
  let a = 0, b = 0;
  for (let it = 0; it < 25; it++) {
    let ga = 0, gb = 0, haa = 1e-6, hab = 0, hbb = 1e-6;
    for (let i = 0; i < xs.length; i++) { const p = sigm(a + b * xs[i]), w = p * (1 - p), e = p - ys[i]; ga += e; gb += e * xs[i]; haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i]; }
    const det = haa * hbb - hab * hab;
    a -= (hbb * ga - hab * gb) / det; b -= (haa * gb - hab * ga) / det;
  }
  return { a, b };
}

class StubModel {
  constructor(o) { Object.assign(this, { a: 0, b: 0, feature: "s.alpha", target: "y", baseRate: 0.5 }, o); }
  predict(row) { const v = row.sig && row.sig[this.feature]; return sigm(this.a + this.b * (v ? v[0] * v[1] : 0)); }
  toJSON() { return { type: "stub", a: this.a, b: this.b, feature: this.feature, target: this.target, baseRate: this.baseRate }; }
  static fromJSON(j) { if (!j || j.type !== "stub") throw new Error("not a stub model"); return new StubModel(j); }
}
class StubMeta {
  constructor(o) { Object.assign(this, { c: 0, d: 0, primaryBaseRate: 0.5, minEdge: 0.02, threshold: 0.55, baseRate: 0.5 }, o); }
  predict(row, side, p) { const v = row.sig["s.alpha"]; return sigm(this.c + this.d * side * (v ? v[0] : 0)); }
  toJSON() { return { type: "stubmeta", c: this.c, d: this.d, primaryBaseRate: this.primaryBaseRate, minEdge: this.minEdge, threshold: this.threshold, baseRate: this.baseRate }; }
  static fromJSON(j) { if (!j || j.type !== "stubmeta") throw new Error("not a stub meta"); return new StubMeta(j); }
}

const concurrency = { active: 0, max: 0 };
const stubDeps = {
  buildDataset: async (opts = {}) => {
    if (opts.crash === "exit") process.exit(7);
    if (opts.crash === "throw-async") { setTimeout(() => { throw new Error("async boom inside the dataset builder"); }, 5); return new Promise(() => {}); }
    if (opts.crash === "hang") { setInterval(() => {}, 1000); return new Promise(() => {}); }   // stuck, holding a handle (like a stalled socket)
    return makeDataset(opts);
  },
  updateDataset: async (ds) => ds,
  loadDataset: () => null,
  saveDataset: () => null,
  reportCard: (ds) => ({
    target: "ret", fdr: { q: 0.1, nSignificant: 1 },
    signals: {
      "s.alpha": { id: "s.alpha", family: "stub", n: ds.rows.length, ic: 0.2, icT: 8, verdict: "keep" },
      "s.noise": { id: "s.noise", family: "stub", n: ds.rows.length, ic: -0.01, icT: -0.4, verdict: "drop" },
    },
  }),
  signalMask: () => ({ "s.alpha": 1.2, "s.noise": 0 }),
  trainStacker: async (ds, opts = {}) => {
    const st = (ds.meta && ds.meta.stub) || {};
    concurrency.active++; concurrency.max = Math.max(concurrency.max, concurrency.active);
    try {
      if (st.sleepMs) await sleep(st.sleepMs);
      if (st.burnMs) burn(st.burnMs);
      const rows = ds.rows.filter((r) => labelOf(r, opts.target) != null);
      const ys = rows.map((r) => labelOf(r, opts.target));
      const base = ys.reduce((s, v) => s + v, 0) / ys.length;
      const fit = st.noiseModel ? { a: logit(0.62), b: 0 } : fitLogit(rows.map((r) => r.sig["s.alpha"][0]), ys);
      const model = new StubModel({ ...fit, target: opts.target, baseRate: base });
      const last = rows[rows.length - 1];
      return {
        model, target: opts.target,
        oos: rows.map((r, i) => { const p = model.predict(r); return { t: r.t, assetId: r.assetId, p, pCal: p, y: ys[i] }; }),
        metrics: { n: rows.length, auc: null, logloss: null, loglossBaseline: null },
        trainedThrough: last.t, labelsThrough: last.lab.tEnd,
      };
    } finally { concurrency.active--; }
  },
  loadStacker: (j) => StubModel.fromJSON(j),
  trainMetaLabeler: async (ds, opts = {}) => {
    const st = (ds.meta && ds.meta.stub) || {};
    if (!st.meta) return { model: null, oos: [], metrics: { reason: "stub meta disabled" } };
    const prim = opts.stacker;
    const base = prim ? prim.model.baseRate : 0.5;
    const byKey = new Map(ds.rows.map((r) => [`${r.t}|${r.assetId}`, r]));
    const M = [];
    for (const o of prim ? prim.oos : []) {
      const r = byKey.get(`${o.t}|${o.assetId}`);
      const edge = o.pCal - base;
      if (!r || Math.abs(edge) < (opts.minEdge || 0.02)) continue;
      const side = edge > 0 ? 1 : -1;
      const ret = side > 0 ? r.lab.tbLongRet : r.lab.tbShortRet;
      M.push({ r, side, edge, p: o.pCal, y: ret > 0 ? 1 : 0, ret });
    }
    const fit = fitLogit(M.map((m) => m.side * m.r.sig["s.alpha"][0]), M.map((m) => m.y));
    const model = new StubMeta({ c: fit.a, d: fit.b, primaryBaseRate: base, minEdge: opts.minEdge || 0.02 });
    return {
      model, threshold: 0.55, trainedThrough: M.length ? M[M.length - 1].r.t : null, metrics: { n: M.length },
      oos: M.map((m) => ({ t: m.r.t, assetId: m.r.assetId, side: m.side, edge: m.edge, p: m.p, pMeta: model.predict(m.r, m.side, m.p), y: m.y, ret: m.ret })),
    };
  },
  loadMeta: (j) => StubMeta.fromJSON(j),
  labelOf,
};

module.exports = { deps: stubDeps, makeDataset };

// ───────────────────────────── tests (main thread only) ─────────────────────────────
if (isMainThread) {
  const test = require("node:test");
  const assert = require("node:assert");
  const si = require("../server/learning/selfImprove");
  const R = require("../server/learning/registry");

  const fresh = () => {
    si.stop();
    const store = R.createMemoryStore();
    const registry = R.createRegistry({ store });
    si.configure({ store, registry, horizon: "swing" });
    return { store, registry };
  };
  // The scheduler's timers are unref()'d (they must not keep the server alive); keep the test alive.
  const keepAlive = () => { const iv = setInterval(() => {}, 50); return () => clearInterval(iv); };
  const inline = (cycleOpts = {}, extra = {}) => ({ horizon: "swing", reason: "test", inline: true, deps: stubDeps, cycleOpts: { datasetOpts: {}, ...cycleOpts }, ...extra });

  test("promotionDecision: every rule, with reasons", () => {
    const m = (ll) => ({ n: 500, logloss: ll, brier: 0.24, auc: 0.6 });
    const ev = (o = {}) => ({ n: 500, nDates: 60, lag: 5, challenger: m(0.680), baseline: m(0.690), champion: m(0.685),
      dmBaseline: { stat: 2.5, p: 0.012, lag: 5, nDates: 60 }, dmChampion: { stat: 1.9, p: 0.057, lag: 5, nDates: 60 }, ...o });
    let d = si.promotionDecision(ev(), { hasChampion: true });
    assert.strictEqual(d.promote, true, d.reason);
    assert.match(d.reason, /^promoted: .*Diebold–Mariano vs champion/);
    d = si.promotionDecision(ev({ dmChampion: { stat: 1.5, p: 0.13, lag: 5, nDates: 60 } }), { hasChampion: true });
    assert.strictEqual(d.promote, false);
    assert.match(d.reason, /\(b\) Diebold–Mariano vs champion p < 0.1 failed/);
    d = si.promotionDecision(ev({ champion: m(0.679) }), { hasChampion: true });
    assert.strictEqual(d.promote, false);
    assert.match(d.reason, /\(a\) log-loss < champion failed/);
    d = si.promotionDecision(ev({ baseline: m(0.679) }), { hasChampion: true });
    assert.match(d.reason, /\(a\) log-loss < calibrated-v1 baseline failed/);
    d = si.promotionDecision(ev({ dmBaseline: { stat: -2.5, p: 0.01, lag: 5, nDates: 60 } }), { hasChampion: false });
    assert.strictEqual(d.promote, false, "a significant DM in the WRONG direction must not promote");
    d = si.promotionDecision(ev(), { hasChampion: false });
    assert.strictEqual(d.promote, true);
    assert.match(d.reason, /vs baseline/);
    d = si.promotionDecision(ev({ n: 150 }), { hasChampion: false });
    assert.match(d.reason, /holdout size failed/);
    d = si.promotionDecision(ev({ champion: null, championError: "load failed" }), { hasChampion: true });
    assert.match(d.reason, /champion evaluable failed — load failed/);
    assert.strictEqual(si.promotionDecision(null).promote, false);
    assert.strictEqual(si.RULES.dmAlpha, 0.10);
    assert.strictEqual(si.RULES.holdoutFrac, 0.20);
    assert.strictEqual(si.RULES.pboMax, 0.5);
    assert.strictEqual(si.RULES.dsrMin, 0.5);
  });

  test("splitHoldout: holdout = most recent 20% of labelled dates; no training label reaches into it", () => {
    const ds = makeDataset({ nDates: 200 });
    const s = si.splitHoldout(ds.rows, { ahead: 5, tf: 86400 });
    const dates = [...new Set(ds.rows.filter((r) => r.lab).map((r) => r.t))];
    assert.strictEqual(s.holdoutStart, dates[Math.floor(dates.length * 0.8)]);
    assert.ok(s.holdout.every((r) => r.t >= s.holdoutStart && r.lab));
    assert.ok(s.train.every((r) => r.lab.tEnd < s.holdoutStart), "purged: every training label ends before the holdout");
    assert.ok(s.train.length > 0 && s.trainLabelsThrough < s.holdoutStart);
    assert.strictEqual(new Set(s.holdout.map((r) => r.t)).size, s.nHoldoutDates);
  });

  test("cycle: a skilled challenger is promoted over the calibrated baseline; report, report card and registry are written", async () => {
    const { store, registry } = fresh();
    const rep = await si.runCycle(inline({ datasetOpts: { skill: 1.5, meta: true } }));
    assert.strictEqual(rep.ok, true, rep.error);
    const y = rep.challengers.find((c) => c.kind === "stacker" && c.target === "y");
    assert.strictEqual(y.promoted, true, y.reason);
    assert.match(y.reason, /Diebold–Mariano vs baseline/);
    assert.ok(y.metrics.holdout.challenger.logloss < y.metrics.holdout.baseline.logloss);
    assert.ok(y.metrics.holdout.dmBaseline.p < 0.1);
    const mask = rep.challengers.find((c) => c.kind === "mask");
    assert.strictEqual(mask.promoted, true, "mask bundled with the promoted y-stacker");
    const meta = rep.challengers.find((c) => c.kind === "meta");
    assert.ok(meta.reason.length > 0);
    assert.ok(rep.thresholds && typeof rep.thresholds.reason === "string");
    // registry
    const champ = registry.champion("swing", "stacker", "y");
    assert.strictEqual(champ.version, y.version);
    assert.ok(Number.isFinite(champ.baseRate));
    assert.match(champ.dataHash, /^[0-9a-f]{64}$/);
    assert.ok(champ.labelsThrough < Date.parse(rep.dataset.holdoutStart), "the deployed champion never saw the holdout");
    assert.deepStrictEqual(registry.champion("swing", "mask").model, { "s.alpha": 1.2, "s.noise": 0 });
    assert.ok(registry.version() >= 2);
    assert.strictEqual(rep.registryVersion, registry.version());
    // persistence
    const cycles = store.loadModel("cycles:swing");
    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(cycles[0].challengers.length, rep.challengers.length);
    assert.ok(store.loadModel("reportcard:swing").signals["s.alpha"]);
    assert.ok(rep.reportCardSummary.verdicts.keep === 1 && rep.reportCardSummary.mask.dropped === 1);
    assert.ok(rep.datasetRows > 0 && rep.wallMs >= 0);
    console.log(`# cycle 1: promoted ${JSON.stringify(rep.promoted)}; y holdout log-loss ${y.metrics.holdout.challenger.logloss} vs baseline ${y.metrics.holdout.baseline.logloss}, DM p ${y.metrics.holdout.dmBaseline.p}; thresholds: ${rep.thresholds.reason.slice(0, 160)}`);

    // Cycle 2 on identical data: the identical challenger does not strictly beat the champion.
    const v = registry.version();
    const rep2 = await si.runCycle(inline({ datasetOpts: { skill: 1.5, meta: true } }));
    const y2 = rep2.challengers.find((c) => c.kind === "stacker" && c.target === "y");
    assert.strictEqual(y2.promoted, false);
    assert.match(y2.reason, /\(a\) log-loss < champion failed/);
    assert.strictEqual(y2.metrics.holdout.restricted, false);
    assert.ok(!rep2.promoted.some((k) => k.startsWith("stacker")), JSON.stringify(rep2.promoted));
    assert.strictEqual(store.loadModel("cycles:swing").length, 2);
    // every decision (promotions and rejections) is logged with its reason
    const log = registry.decisions("swing", { limit: 100 });
    assert.ok(log.some((d) => d.action === "reject" && /log-loss < champion/.test(d.reason)));
    assert.ok(log.some((d) => d.action === "promote" && /Diebold–Mariano/.test(d.reason)));
    if (rep2.thresholds && !rep2.thresholds.promoted) assert.ok(rep2.thresholds.reason.startsWith("rejected:"));
    assert.ok(registry.version() - v <= 1, "only a changed threshold set could be promoted on unchanged data");
  });

  test("cycle: a worse challenger is rejected against the baseline, with the reason recorded", async () => {
    const { registry } = fresh();
    const rep = await si.runCycle(inline({ datasetOpts: { skill: 1.5, noiseModel: true } }));
    const y = rep.challengers.find((c) => c.kind === "stacker" && c.target === "y");
    assert.strictEqual(y.promoted, false);
    assert.match(y.reason, /^rejected: .*\(a\) log-loss < calibrated-v1 baseline failed/);
    assert.strictEqual(registry.champion("swing", "stacker", "y"), null);
    assert.strictEqual(rep.challengers.find((c) => c.kind === "mask").promoted, false);
    assert.match(rep.thresholds.reason, /no learned y-stacker will be live/);
    const hist = registry.history("swing", { kind: "stacker" });
    assert.ok(hist.length >= 1 && hist.every((e) => e.status === "retired" && !e.hasModel && /^rejected/.test(e.reason)));
    assert.strictEqual(registry.version(), 0);
  });

  test("cycle: a champion whose labels overlap the holdout is compared only on the holdout rows after them", async () => {
    const { registry } = fresh();
    const ds = makeDataset({ skill: 1.5 });
    const s = si.splitHoldout(ds.rows, { ahead: 5, tf: 86400 });
    const e = registry.propose({ horizon: "swing", kind: "stacker", target: "y", model: new StubModel({ a: 0, b: 0.5 }).toJSON(), baseRate: 0.5, labelsThrough: s.holdoutStart + 10 * DAY });
    registry.promote(e.version, "seed champion");
    const rep = await si.runCycle(inline({ datasetOpts: { skill: 1.5 } }));
    const y = rep.challengers.find((c) => c.kind === "stacker" && c.target === "y");
    assert.strictEqual(y.metrics.holdout.restricted, true);
    assert.strictEqual(y.metrics.holdout.championVersion, e.version);
    const full = s.holdout.length, after = s.holdout.filter((r) => r.t > s.holdoutStart + 10 * DAY).length;
    assert.strictEqual(y.metrics.holdout.n, after);
    assert.ok(after < full);
    assert.strictEqual(y.promoted, true, y.reason);   // b = 0.5 vs the fitted ≈1.5: significantly worse champion
    assert.match(y.reason, /vs champion/);
  });

  test("cycles run one at a time; a queued request for the same horizon is reused", async () => {
    fresh();
    concurrency.active = 0; concurrency.max = 0;
    const o = { datasetOpts: { sleepMs: 15, nDates: 120 } };
    const ps = [
      si.runCycle(inline(o, { horizon: "swing" })),
      si.runCycle(inline(o, { horizon: "position" })),
      si.runCycle(inline(o, { horizon: "intraday" })),
    ];
    const dup = si.runCycle(inline(o, { horizon: "position", reason: "manual" }));
    assert.strictEqual(dup, ps[1], "same promise for the still-queued horizon");
    const st = si.status("swing");
    assert.strictEqual(st.running || st.queue.length > 0, true);
    const reps = await Promise.all(ps);
    assert.strictEqual(concurrency.max, 1, "never two trainings at once");
    assert.deepStrictEqual(reps.map((r) => r.horizon), ["swing", "position", "intraday"]);
    assert.match(reps[1].reason, /test\+manual/);
    assert.strictEqual(si.status().running, false);
  });

  test("worker thread: the event loop stays responsive during a CPU-heavy cycle (measured), inline would block", async () => {
    fresh();
    const measure = async (run) => {
      let maxLag = 0, last = Date.now();
      const iv = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 5); last = n; }, 5);
      const t0 = Date.now();
      const rep = await run();
      clearInterval(iv);
      maxLag = Math.max(maxLag, Date.now() - last - 5);   // an inline cycle may never yield to timers at all
      return { rep, maxLag, wall: Date.now() - t0 };
    };
    const cycleOpts = { datasetOpts: { burnMs: 400, nDates: 200 } };   // 3 stackers × 400 ms of pure CPU
    const w = await measure(() => si.runCycle({ horizon: "swing", reason: "lag-test", depsModule: __filename, cycleOpts }));
    assert.strictEqual(w.rep.ok, true, w.rep.error);
    assert.ok(w.wall >= 1200, `cycle wall ${w.wall} ms`);
    const inl = await measure(() => si.runCycle(inline(cycleOpts)));
    console.log(`# event-loop lag: worker max ${w.maxLag} ms over a ${w.wall} ms cycle; inline max ${inl.maxLag} ms over ${inl.wall} ms`);
    // Uncontended this machine measures 6–22 ms for the worker vs ~1,400 ms inline. The bounds are
    // loose because `npm test` runs files in parallel and other jobs may share the 4 cores: OS
    // scheduling delay is not event-loop blocking, so the worker lag is also judged against the
    // inline control measured under the same load.
    assert.ok(inl.maxLag >= 350, `inline control should block (${inl.maxLag} ms) — otherwise this test measures nothing`);
    assert.ok(w.maxLag < 500 && w.maxLag * 4 < inl.maxLag, `worker cycle blocked the event loop for ${w.maxLag} ms (inline ${inl.maxLag} ms)`);
  });

  test("worker crashes, uncaught errors and timeouts become failed reports; the queue keeps going", async () => {
    const { store } = fresh();
    const w = (datasetOpts, extra = {}) => si.runCycle({ horizon: "swing", reason: "crash-test", depsModule: __filename, cycleOpts: { datasetOpts }, ...extra });
    const [a, b, c, d] = await Promise.all([
      w({ crash: "exit" }),
      w({ crash: "throw-async" }, { horizon: "position" }),
      w({ crash: "hang" }, { horizon: "intraday", timeoutMs: 400 }),
    ].concat([new Promise((res) => setTimeout(() => res(w({ nDates: 150 })), 50))]));
    assert.strictEqual(a.ok, false); assert.strictEqual(a.crashed, true); assert.match(a.error, /exited with code 7/);
    assert.strictEqual(b.ok, false); assert.match(b.error, /async boom/);
    assert.strictEqual(c.ok, false); assert.match(c.error, /timed out/);
    assert.strictEqual(d.ok, true, d.error);
    const cycles = store.loadModel("cycles:swing");
    assert.ok(cycles.some((r) => r.ok === false && /exited/.test(r.error)), "failed cycles are logged too");
    assert.strictEqual(si.status().running, false);
    // function deps cannot cross the worker boundary
    const bad = await si.runCycle({ horizon: "swing", deps: stubDeps, cycleOpts: {} });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /worker boundary/);
  });

  test("schedule: first cycle ~firstDelay after start without a champion, onReport on every cycle, then every interval", async () => {
    fresh();
    const release = keepAlive();
    const reports = [];
    let resolveFirst;
    const first = new Promise((r) => { resolveFirst = r; });
    const t0 = Date.now();
    const s = si.schedule({ everyMs: 3600e3, horizons: ["swing"], firstDelayMs: 60, inline: true, deps: stubDeps,
      cycleOpts: { datasetOpts: { skill: 1.5, nDates: 200 } }, onReport: (r) => { reports.push(r); resolveFirst(r); } });
    assert.deepStrictEqual(s.horizons, ["swing"]);
    const nr = Date.parse(si.status().nextRunAt);
    assert.ok(nr - t0 >= 40 && nr - t0 <= 500, `first run in ${nr - t0} ms`);
    const rep = await first;
    assert.ok(Date.now() - t0 >= 60);
    assert.strictEqual(rep.reason, "scheduled");
    assert.strictEqual(rep.ok, true, rep.error);
    await new Promise((r) => setImmediate(r));
    const st = si.status();
    assert.strictEqual(st.scheduled, true);
    assert.ok(Math.abs(Date.parse(st.nextRunAt) - (Date.now() + 3600e3)) < 5000, "re-armed at the interval");
    assert.strictEqual(st.lastReport.ts, rep.ts);
    assert.ok(st.drift && ["ok", "warn", "drift"].includes(st.drift.level));
    assert.strictEqual(st.derisk, null);
    // With a champion (promoted by that cycle), a re-schedule waits for the next interval after the last cycle.
    si.schedule({ everyMs: 3600e3, horizons: ["swing"], firstDelayMs: 60, inline: true, deps: stubDeps, cycleOpts: {} });
    const wait = Date.parse(si.status().nextRunAt) - Date.now();
    assert.ok(wait > 3500e3, `should wait for the next interval, got ${wait} ms`);
    si.stop();
    assert.strictEqual(si.status().scheduled, false);
    assert.strictEqual(si.status().nextRunAt, null);
    assert.strictEqual(reports.length, 1);
    release();
  });

  test("onResolved: drift sets de-risk {until, +0.05, ×0.5} and triggers an early cycle; a promotion clears it; live vs expectation", async () => {
    const { store, registry } = fresh();
    const release = keepAlive();
    const reports = [];
    let gotDriftCycle;
    const driftCycle = new Promise((r) => { gotDriftCycle = r; });
    si.schedule({ everyMs: 3600e3, horizons: ["swing"], firstDelayMs: 3600e3, inline: true, deps: stubDeps,
      cycleOpts: { datasetOpts: { skill: 1.5, nDates: 200 } }, onReport: (r) => { reports.push(r); if (/drift/.test(r.reason)) gotDriftCycle(r); } });
    const r = rng(5);
    let res = null, n = 0;
    for (; n < 3000; n++) {
      const p = 0.35 + 0.35 * r();
      const y = n < 300 ? (r() < p ? 1 : 0) : (r() < 1 - p ? 1 : 0);    // the model's calls turn wrong after 300
      res = si.onResolved({ horizon: "swing", p, y, decision: { ts: new Date().toISOString(), assetId: "CRYPTO:BTC", assetClass: "crypto" } });
      if (res.drift) break;
    }
    assert.ok(res && res.drift, "drift detected");
    assert.ok(n > 300, `no alarm before the change (alarm at ${n})`);
    assert.strictEqual(res.earlyCycle, true);
    const st = si.status();
    assert.strictEqual(st.drift.level, "drift");
    assert.strictEqual(st.derisk.minConfidenceBump, 0.05);
    assert.strictEqual(st.derisk.sizeMult, 0.5);
    const until = Date.parse(st.derisk.until) - Date.now();
    assert.ok(Math.abs(until - 2 * 7 * DAY) < 60e3, `until = now + 2 × horizon (5 trading days = 7 calendar days), got ${until / DAY} d`);
    console.log(`# onResolved: drift after ${n - 300} post-change decisions (${n + 1} total); derisk until ${st.derisk.until}`);
    // a second alarm soon after does not queue another early cycle (≤ 1 per hour)
    const rep = await driftCycle;
    assert.match(rep.reason, /drift/);
    assert.ok(rep.promoted.includes("stacker:y"), JSON.stringify(rep.promoted));
    assert.strictEqual(rep.deriskCleared, true);
    assert.strictEqual(si.status().derisk, null, "the promotion clears de-risk");
    // live records after the promotion are compared with the champion's holdout expectation
    const champ = registry.champion("swing", "stacker", "y");
    await new Promise((res2) => setTimeout(res2, 5));
    for (let i = 0; i < 60; i++) { const p = 0.35 + 0.35 * r(); si.onResolved({ horizon: "swing", p, y: r() < p ? 1 : 0, decision: { ts: new Date().toISOString() } }); }
    const live = si.liveSummary("swing");
    assert.strictEqual(live.source, `stacker v${champ.version}`);
    assert.strictEqual(live.n, 60);
    assert.strictEqual(live.expected, champ.metrics.holdout.challenger.logloss);
    assert.ok(Number.isFinite(live.gap) && Number.isFinite(live.z));
    si.flushState();
    assert.ok(store.loadModel("live:swing").records.length >= 60);
    assert.ok(store.loadModel("drift:swing").monitor);
    assert.strictEqual(si.onResolved({ p: NaN, y: 1 }), null);
    si.stop();
    release();
  });
}
