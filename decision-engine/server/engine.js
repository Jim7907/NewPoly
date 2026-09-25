// The real-time decision loop.
//
//   gather (data layer, parallel, cached) ─► analyzers (technical MTF, regime/HMM, ML, fundamental,
//   sentiment, macro, derivatives, microstructure, optional Claude analyst) ─► ensemble.decide
//   (log-odds pooling + calibration + confidence gating) ─► persist sample ─► paper portfolio ─► push
//
// Learning loop: every logged decision snapshot is resolved once its horizon elapses; the realized
// direction updates (a) the per-signal Hedge weights and (b) the probability calibrator. On boot the
// calibrator and weights are warm-started from walk-forward backtests so confidence is anchored to
// out-of-sample evidence from day one instead of an arbitrary prior.
const cfg = require("./config");
const db = require("./db");
const data = require("./data");
const technical = require("./analysis/technical");
const regimeMod = require("./analysis/regime");
const ml = require("./analysis/ml");
const fundamental = require("./analysis/fundamental");
const sentiment = require("./analysis/sentiment");
const macroMod = require("./analysis/macro");
const derivatives = require("./analysis/derivatives");
const micro = require("./analysis/microstructure");
const ind = require("./analysis/indicators");
const ensemble = require("./decision/ensemble");
const { Calibrator } = require("./learning/calibrator");
const { WeightLearner } = require("./learning/weights");
const analyst = require("./llm/analyst");
const portfolio = require("./portfolio");
const brain = require("./brain");

// ── Learned state ──
const calibrators = {};               // `${horizon}|${assetClass}` -> Calibrator (+ .baseRate)
let learner = new WeightLearner();
const MAX_PAIRS_PER_ASSET = 1500;   // audit: was a global slice(-20000) over asset-ordered pairs
const CLASSES = ["crypto", "stock"];
const ckey = (h, cls) => `${h}|${cls}`;

function loadState() {
  const w = db.loadModel("weights");
  if (w) learner = WeightLearner.fromJSON(w);
  // Refit from the stored (pRaw, y) pairs on every boot — cheap, and it keeps the calibrator in
  // step with the current calibration code; fall back to the saved model if pairs are missing.
  for (const h of Object.keys(cfg.HORIZONS)) for (const cls of CLASSES) {
    if (refitCalibrator(h, cls, [])) continue;
    const c = db.loadModel(`calib:${ckey(h, cls)}`);
    if (c) { calibrators[ckey(h, cls)] = Calibrator.fromJSON(c.model); calibrators[ckey(h, cls)].baseRate = c.baseRate; }
  }
}

// One calibrator per (horizon, asset class): crypto and equities have different base rates and
// score distributions. Pairs are kept per class (most recent MAX_PAIRS).
function refitCalibrator(horizon, cls, newPairs = []) {
  const key = `pairs:${ckey(horizon, cls)}`;
  // Keep the most recent pairs PER ASSET (a global slice(-N) of the asset-ordered warm-start list
  // silently dropped whole assets — with the 50-stock universe, all of tech — once it exceeded N),
  // ordered by (asset, time) so overlapping labels stay adjacent for the calibrator's purged folds.
  const byAsset = new Map();
  for (const p of (db.loadModel(key) || []).concat(newPairs)) {
    const k = (p && p.a) || "?";
    if (!byAsset.has(k)) byAsset.set(k, []);
    byAsset.get(k).push(p);
  }
  const pairs = [];
  for (const k of [...byAsset.keys()].sort()) {
    const arr = byAsset.get(k).sort((u, v) => (u.t || 0) - (v.t || 0));
    pairs.push(...arr.slice(-MAX_PAIRS_PER_ASSET));
  }
  db.saveModel(key, pairs);
  if (pairs.length < 30) return null;
  const c = new Calibrator();
  c.fit(pairs, { ahead: H(horizon).ahead });
  c.baseRate = pairs.reduce((s, p) => s + p.y, 0) / pairs.length;
  calibrators[ckey(horizon, cls)] = c;
  db.saveModel(`calib:${ckey(horizon, cls)}`, { model: c.toJSON(), baseRate: c.baseRate });
  return c;
}

// ── Helpers ──
const safe = (label, fn, sink) => {
  try { const r = fn(); return Array.isArray(r) ? r : r ? [r] : []; }
  catch (e) { sink.push(`${label}: ${e.message}`); return []; }
};
const H = (h) => cfg.HORIZONS[h] || cfg.HORIZONS.swing;
const thresholds = () => ({
  MIN_CONFIDENCE: db.num("min_confidence", cfg.MIN_CONFIDENCE),
  MIN_PROB_EDGE: db.num("min_prob_edge", cfg.MIN_PROB_EDGE),
  MIN_AGREEMENT: db.num("min_agreement", cfg.MIN_AGREEMENT),
  STRONG_CONFIDENCE: cfg.STRONG_CONFIDENCE,
});
const currentHorizon = () => db.getSetting("horizon") || cfg.HORIZON;

// Turn gathered data into the full signal set. Pure w.r.t. its inputs (plus cached ML/LLM state).
function buildSignals(asset, g, horizon, errors) {
  const hc = H(horizon);
  const opts = { horizon, assetClass: asset.assetClass };
  const out = [];
  const tfs = Object.keys(g.candlesByTf || {}).filter(k => (g.candlesByTf[k] || []).length >= 60);

  out.push(...safe("technical", () => tfs.length >= 2
    ? technical.multiTimeframe(g.candlesByTf, opts)
    : technical.analyze(g.candles || [], opts), errors));

  let regime = null;
  try { regime = regimeMod.detect(g.candles || []); } catch (e) { errors.push(`regime: ${e.message}`); }
  if (regime) out.push(...safe("regime", () => regimeMod.signals(regime), errors));

  // Cross-sectional / relative family (v2): peers come from a per-class cache of recent candles.
  brain.rememberCandles(asset, hc.tf, g.candles);
  out.push(...safe("relative", () => brain.relativeSignals(asset, g.candles || [], horizon, hc.tf), errors));

  out.push(...safe("ml", () => ml.signals(g.candles || [], { ahead: hc.ahead, key: `${asset.id}|${hc.tf}` }), errors));

  if (asset.assetClass === "stock") {
    if (g.fundamentals) out.push(...safe("fundamental", () => fundamental.stockSignals(g.fundamentals, { horizon, asset, now: Date.now() }), errors));
  } else if (g.fundamentals) {
    out.push(...safe("fundamental", () => fundamental.cryptoSignals(g.fundamentals, { horizon, btc: asset.symbol === "BTC" ? null : g.btcFundamentals || null }), errors));
  }

  if (g.news?.length) out.push(...safe("news", () => sentiment.newsSignals(g.news, { now: Date.now() }), errors));
  if (g.social) out.push(...safe("social", () => sentiment.socialSignals(g.social), errors));
  if (asset.assetClass === "crypto" && g.fearGreed) out.push(...safe("feargreed", () => sentiment.fearGreedSignal(g.fearGreed), errors));
  if (g.macro) out.push(...safe("macro", () => macroMod.signals(g.macro, asset), errors));
  if (asset.assetClass === "crypto") {
    if (g.derivatives) out.push(...safe("derivatives", () => derivatives.signals(g.derivatives, { candles: g.candlesByTf?.["1h"] || g.candles }), errors));
    if (g.microstructure) out.push(...safe("microstructure", () => micro.signals(g.microstructure, { horizon }), errors));
  }

  const clean = out.filter(s => s && Number.isFinite(s.score) && Number.isFinite(s.confidence));
  return { signals: clean, regime };
}

// The signals the calibrator was trained on: backtest.run (useML:false) = base-timeframe technical
// (ids normalised to tech.<sub>.<name>) + regime, unmasked and unweighted.
function calibrationSignals(signals, tfSec) {
  const base = data.tfName(tfSec), out = [];
  for (const s of signals) {
    if (s.family === "regime") { out.push(s); continue; }
    if (s.family !== "technical" || s.id === "tech.mtf.alignment") continue;
    const m = /^tech\.(\d+[mhdw])\.(.+)$/.exec(s.id);
    if (!m) out.push(s);
    else if (m[1] === base) out.push({ ...s, id: `tech.${m[2]}` });
  }
  return out;
}

// Full decision for one asset. Never throws.
async function evaluate(asset, { horizon = currentHorizon(), withLLM = true, forceLLM = false } = {}) {
  const hc = H(horizon);
  const errors = [];
  const g = await data.gather(asset, hc);
  if (asset.assetClass === "crypto" && asset.symbol !== "BTC") {
    const btc = cfg.CRYPTO_UNIVERSE.BTC;
    g.btcFundamentals = await data.fundamentals({ ...btc, assetClass: "crypto", id: "CRYPTO:BTC" }).catch(() => null);
  }
  const { signals, regime } = buildSignals(asset, g, horizon, errors);

  let llm = null;
  if (withLLM && db.getSetting("llm_enabled") !== "false" && analyst.enabled()) {
    llm = forceLLM ? await analyst.analyze(asset, g, { horizon, force: true }) : analyst.cachedOrRefresh(asset, g, { horizon });
    if (llm?.signal) signals.push(llm.signal);
  }

  const candles = g.candles || [];
  const live = asset.assetClass === "crypto" ? data.live?.(asset) : null;
  const price = live?.price || g.quote?.price || candles.at(-1)?.c || null;
  const atrArr = candles.length > 20 ? ind.atr(candles, 14) : [];
  const atr = atrArr.length ? atrArr.at(-1) : null;

  // v2 model layer: report-card mask → point-in-time row → promoted stacker / meta-labeler.
  const masked = brain.applyMask(signals, horizon);
  const atrPct = price > 0 && atr ? atr / price : null;
  // The offline models see what the dataset saw: UNMASKED point-in-time signals (each stacker
  // stores and applies its own mask) and pRaw pooled from that same subset.
  const pit = brain.pitSignals(signals, hc.tf);
  const pitDecision = ensemble.decide({ asset, signals: pit, regime, horizon, price, atr, candles, now: Date.now() });
  const calDecision = ensemble.decide({ asset, signals: calibrationSignals(signals, hc.tf), regime, horizon, price, atr, candles,
    now: Date.now(), expectedFamilies: ["technical", "regime"] });
  const row = brain.liveRow(asset, signals, { regime, atrPct, annVol: regime?.annVol ?? null, pRaw: pitDecision.pRaw, tfSec: hc.tf });
  const calC = calibrators[ckey(horizon, asset.assetClass)];
  const preds = brain.predict(horizon, row, { pooledP: calC ? calC.apply(pitDecision.pRaw) : undefined });
  const dr = brain.derisk();
  const th = { ...thresholds(), ...brain.thresholdsOverride(horizon) };
  if (dr) { th.MIN_CONFIDENCE += dr.minConfidenceBump ?? 0.05; th.DERISK_BUMP = dr.minConfidenceBump ?? 0.05; }

  const decision = ensemble.decide({
    asset, signals: masked, regime, horizon, price, atr, candles,
    weights: learner, calibrator: calibrators[ckey(horizon, asset.assetClass)] || null,
    baseRate: calibrators[ckey(horizon, asset.assetClass)]?.baseRate, now: Date.now(),
    thresholds: th, dataQuality: g.dataQuality,
    equity: portfolio.equity(), openPositions: db.openPositions(),
    probability: preds.probability, meta: preds.meta, sizeMult: dr ? dr.sizeMult ?? 0.5 : 1,
    calibration: { pRaw: calDecision.pRaw, logOdds: calDecision.logOdds, extraShrink: 0.5 },
  });
  decision.pRawPIT = pitDecision.pRaw;
  decision.pRawCal = calDecision.pRaw;
  if (preds.relative) decision.relative = { ...preds.relative, rank: rankOf(asset, horizon) };
  if (preds.targetFirst) decision.targetFirst = preds.targetFirst;
  if (dr) decision.derisk = dr;
  decision.horizonLabel = decision.horizonLabel || hc.label;
  decision.dataQuality = g.dataQuality;
  if (errors.length) decision.analyzerErrors = errors;
  if (llm) decision.llm = { narrative: llm.narrative, bullCase: llm.bullCase, bearCase: llm.bearCase,
    risks: llm.risks, catalysts: llm.catalysts, newsAssessment: llm.newsAssessment, model: llm.model, ts: llm.ts };
  decision.headlines = (g.news || []).slice(0, 8);
  return decision;
}

// ── Sampling for learning ──
// Snapshots are logged at most once per sampling interval per asset (or on an action change) so the
// learner isn't flooded with near-duplicate, heavily-overlapping samples.
// One sample per base bar: labels of consecutive samples still overlap (ahead bars), so the learner
// scales each update by 1/ahead (docs/RESEARCH.md §5.2 #4).
const SAMPLE_MS = { intraday: 15 * 60e3, swing: 24 * 3600e3, position: 24 * 3600e3 };
function maybeLog(decision) {
  // Audit: learning samples at a FIXED cadence only — logging on every action change added
  // near-duplicate, fully overlapping samples exactly at the decision boundary (selection bias) — and
  // for stocks only in regular hours (weekend/overnight rows all resolve on the same close).
  if (decision.assetClass === "stock" && !data.marketOpen(Date.now())) return null;
  const last = db.lastDecisionTs(decision.assetId, decision.horizon);
  const due = !last || Date.now() - new Date(last.ts).getTime() >= (SAMPLE_MS[decision.horizon] || 3600e3);
  if (!due || !(decision.price > 0)) return null;
  const hc = H(decision.horizon);
  // Label horizon in the asset's trading time: 5 daily stock bars = 5 sessions, not 5 calendar days.
  return db.logDecision(decision, data.horizonEnd(decision.assetId, Date.now(), hc.ahead, hc.tf));
}

// Price at a past time (late resolution): close of the latest 15m/1h bar that started at or before t.
const LATE_MS = 10 * 60e3;
async function priceAt(asset, tMs) {
  for (const tf of [900, 3600]) {
    const cs = await data.candles(asset, tf, 300).catch(() => []);
    if (!cs.length || cs[0].t > tMs) continue;
    let bar = null;
    for (const c of cs) { if (c.t <= tMs) bar = c; else break; }
    if (bar && tMs - bar.t < 2 * tf * 1000) return bar.c;
  }
  return null;
}

async function resolveDue(nowMs = Date.now()) {
  const due = db.dueDecisions(nowMs);
  if (!due.length) return 0;
  const byHorizon = {};
  for (const d of due) {
    const asset = cfg.ASSETS.find(a => a.id === d.assetId) || { id: d.assetId, symbol: d.symbol, assetClass: d.assetClass };
    let px = null;
    if (nowMs - d.resolveAt > LATE_MS) {
      // Audit: resolved late (server down / loop stalled) → use the price AT resolveAt, not the
      // current one (labels were silently stretched to the outage length). Give up after 14 days.
      px = await priceAt(asset, d.resolveAt);
      if (!(px > 0)) { if (nowMs - d.resolveAt > 14 * 86400e3) db.resolveDecision(d.id, null, null, null); continue; }
    } else {
      px = portfolio.lastPrice.get(d.assetId);
      if (!px) { try { px = (await data.quote(asset))?.price; } catch { /* ignore */ } }
    }
    if (!(px > 0) || !(d.price > 0)) continue;
    const r = Math.log(px / d.price);
    const y = r > 0 ? 1 : 0;
    db.resolveDecision(d.id, px, r, y);
    brain.onResolved({ horizon: d.horizon, p: d.pUp, y, decision: d });
    // Audit: reward skill, not drift (a no-skill always-bullish stock signal drifted to w≈1.9).
    learner.update(d.votes || [], y, { scale: 1 / H(d.horizon).ahead, baseRate: calibrators[ckey(d.horizon, d.assetClass)]?.baseRate ?? 0.5 });
    (byHorizon[ckey(d.horizon, d.assetClass)] ||= []).push({ p: d.pRaw, y, t: Date.parse(d.ts) || nowMs, a: d.assetId });
  }
  db.saveModel("weights", learner.toJSON());
  for (const [k, pairs] of Object.entries(byHorizon)) { const [h, cls] = k.split("|"); refitCalibrator(h, cls, pairs); }
  return due.length;
}

// ── Warm start from walk-forward backtests ──
async function warmStart({ horizon = currentHorizon(), log = console.log } = {}) {
  const { runInWorker } = require("./learning/worker");
  const pairs = { crypto: [], stock: [] };
  learner.clearPriors?.();          // audit: seed() now pools across assets; start from clean priors
  for (const asset of cfg.ASSETS) {
    try {
      // Technical + regime only (ML has its own purged walk-forward inside ml.signals); regime
      // re-detected every 5 bars to keep this to seconds per asset. Runs in a worker thread.
      const res = await runInWorker({ asset, horizon, opts: { useML: false, regimeEvery: 5 } });
      db.saveBacktest(asset.id, horizon, { ...res, assetId: asset.id, horizon, warm: true, ts: new Date().toISOString() });
      pairs[asset.assetClass].push(...(res.calibrationPairs || []).map(p => ({ ...p, a: asset.id })));
      learner.seed(res.signalStats || {});
      log(`[warm] ${asset.symbol} ${horizon}: ${res.metrics?.nTrades ?? 0} trades, hit ${(100 * (res.metrics?.hitRate || 0)).toFixed(1)}%, pairs ${res.calibrationPairs?.length || 0}`);
    } catch (e) { log(`[warm] ${asset.symbol}: ${e.message}`); }
  }
  db.saveModel("weights", learner.toJSON());
  const out = {};
  for (const cls of CLASSES) {
    const c = refitCalibrator(horizon, cls, pairs[cls]);
    out[cls] = { pairs: pairs[cls].length, baseRate: c?.baseRate, reliability: c?.reliability?.() || null };
  }
  db.setSetting(`warm_${horizon}`, new Date().toISOString());
  return out;
}

// ── Cross-sectional rankings (v2) ──
// Ranks every asset of a class in the research universe by predicted probability of beating its
// benchmark (promoted yEx stacker), falling back to the relative family's pooled score. Uses only
// point-in-time families (no per-asset news/fundamental fetches), so it scales to ~50 names.
const rankCache = new Map();   // `${horizon}|${cls}` -> { ts, rankings }
function rankOf(asset, horizon) {
  const r = rankCache.get(`${horizon}|${asset.assetClass}`)?.rankings || [];
  const i = r.findIndex(x => x.assetId === asset.id);
  return i >= 0 ? { rank: i + 1, of: r.length } : null;
}
function researchUniverse(cls) {
  const ds = (() => { try { return require("./research/dataset"); } catch { return null; } })();
  const u = ds?.RESEARCH_UNIVERSE;
  const list = Array.isArray(u) ? u : (u && (u[cls] || u.assets)) || [];
  const assets = list.map(x => (typeof x === "string" ? data.resolveAsset?.(x) : x)).filter(a => a && a.assetClass === cls);
  const seen = new Set(assets.map(a => a.id));
  for (const a of cfg.ASSETS) if (a.assetClass === cls && !seen.has(a.id)) assets.push(a);
  return assets;
}
async function rankings({ horizon = currentHorizon(), cls = "stock", maxAgeMs = 10 * 60e3 } = {}) {
  const key = `${horizon}|${cls}`;
  const hit = rankCache.get(key);
  if (hit && Date.now() - hit.ts < maxAgeMs) return hit;
  const hc = H(horizon);
  const assets = researchUniverse(cls);
  const series = await Promise.all(assets.map(a => data.candles(a, hc.tf, 400).catch(() => null)));
  assets.forEach((a, i) => brain.rememberCandles(a, hc.tf, series[i]));
  const macro = await data.macro().catch(() => null);
  const out = [];
  assets.forEach((asset, i) => {
    const candles = series[i];
    if (!candles || candles.length < 120) return;
    const errors = [];
    const sigs = [];
    sigs.push(...safe("technical", () => technical.analyze(candles, { horizon, assetClass: asset.assetClass }), errors));
    let regime = null; try { regime = regimeMod.detect(candles); } catch { /* ignore */ }
    if (regime) sigs.push(...safe("regime", () => regimeMod.signals(regime), errors));
    sigs.push(...safe("relative", () => brain.relativeSignals(asset, candles, horizon, hc.tf), errors));
    if (macro) sigs.push(...safe("macro", () => macroMod.signals(macro, asset), errors));
    const masked = brain.applyMask(sigs, horizon);
    const price = candles.at(-1).c;
    const atrA = ind.atr(candles, 14); const atr = atrA.at(-1);
    const cal = calibrators[ckey(horizon, asset.assetClass)] || null;
    const pitD = ensemble.decide({ asset, signals: brain.pitSignals(sigs, hc.tf), regime, horizon, price, atr, candles });
    const row0 = brain.liveRow(asset, sigs, { regime, atrPct: atr / price, annVol: regime?.annVol ?? null, pRaw: pitD.pRaw, tfSec: hc.tf });
    const preds0 = brain.predict(horizon, row0, { pooledP: cal ? cal.apply(pitD.pRaw) : undefined });
    // Same gating as the live board (calibrator + base-rate guard + promoted models), so the two views agree.
    const d0 = ensemble.decide({ asset, signals: masked, regime, horizon, price, atr, candles, calibrator: cal, baseRate: cal?.baseRate,
      thresholds: { ...thresholds(), ...brain.thresholdsOverride(horizon) }, probability: preds0.probability, meta: preds0.meta });
    const preds = preds0;
    const relScore = d0.families?.relative?.score ?? 0;
    out.push({
      assetId: asset.id, symbol: asset.symbol, assetClass: asset.assetClass, price,
      pOutperform: preds.relative?.pOutperform ?? null, relScore,
      model: preds.relative ? { kind: "stacker", version: preds.relative.version } : { kind: "relative-family", version: null },
      pUp: preds.probability?.pUp ?? d0.pUp, action: d0.action, regime: regime?.label || null,
      drivers: d0.drivers.slice(0, 2).map(x => x.reason),
    });
  });
  out.sort((a, b) => (b.pOutperform ?? 0.5 + b.relScore / 10) - (a.pOutperform ?? 0.5 + a.relScore / 10));
  out.forEach((x, i) => { x.rank = i + 1; });
  const res = { ts: Date.now(), horizon, cls, rankings: out };
  rankCache.set(key, res);
  return res;
}

const perfReport = () => {
  const res = db.resolvedDecisions(5000);
  const byAction = {};
  for (const d of res) {
    const b = (byAction[d.action] ||= { n: 0, correct: 0, avgRet: 0 });
    const dir = d.action.includes("BUY") ? 1 : d.action.includes("SELL") ? -1 : 0;
    b.n++; b.avgRet += dir ? dir * d.fwdReturn : d.fwdReturn;
    if ((dir === 1 && d.y === 1) || (dir === -1 && d.y === 0)) b.correct++;
  }
  for (const b of Object.values(byAction)) { b.avgRet /= b.n; b.hitRate = b.n ? b.correct / b.n : null; }
  const byFamily = {};
  for (const d of res) for (const [fam, v] of Object.entries(d.families || {})) {
    if (!v || !Number.isFinite(v.score) || v.score === 0) continue;
    const b = (byFamily[fam] ||= { n: 0, hits: 0 });
    b.n++; if ((v.score > 0) === (d.y === 1)) b.hits++;
  }
  for (const b of Object.values(byFamily)) b.hitRate = b.hits / b.n;
  const h = currentHorizon();
  const pairs = res.filter(d => d.horizon === h).map(d => ({ p: d.pUp, y: d.y }));
  let calibration = null;
  try { calibration = pairs.length ? Calibrator.reliabilityOf(pairs) : null; } catch { /* ignore */ }
  return {
    horizon: h, nResolved: res.length, calibration,
    calibrator: calibrators[ckey(h, "crypto")]?.reliability?.() || calibrators[ckey(h, "stock")]?.reliability?.() || null,
    calibrators: Object.fromEntries(CLASSES.map(cls => [cls, calibrators[ckey(h, cls)]
      ? { ...calibrators[ckey(h, cls)].reliability(), baseRate: calibrators[ckey(h, cls)].baseRate } : null])),
    weights: learner.report(), byAction, byFamily,
  };
};

module.exports = { evaluate, buildSignals, maybeLog, resolveDue, warmStart, loadState, perfReport, thresholds, currentHorizon, rankings,
  get learner() { return learner; }, calibrators };
