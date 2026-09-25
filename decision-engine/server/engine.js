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

// ── Learned state ──
const calibrators = {};               // horizon -> Calibrator
let learner = new WeightLearner();
const MAX_PAIRS = 6000;

function loadState() {
  const w = db.loadModel("weights");
  if (w) learner = WeightLearner.fromJSON(w);
  for (const h of Object.keys(cfg.HORIZONS)) {
    const c = db.loadModel(`calib:${h}`);
    calibrators[h] = c ? Calibrator.fromJSON(c) : null;
  }
}

function refitCalibrator(horizon, newPairs = []) {
  const key = `pairs:${horizon}`;
  const pairs = (db.loadModel(key) || []).concat(newPairs).slice(-MAX_PAIRS);
  db.saveModel(key, pairs);
  if (pairs.length < 30) return null;
  const c = new Calibrator();
  c.fit(pairs, { ahead: H(horizon).ahead });
  calibrators[horizon] = c;
  db.saveModel(`calib:${horizon}`, c.toJSON());
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

  const decision = ensemble.decide({
    asset, signals, regime, horizon, price, atr, candles,
    weights: learner, calibrator: calibrators[horizon] || null, now: Date.now(),
    thresholds: thresholds(), dataQuality: g.dataQuality,
    equity: portfolio.equity(), openPositions: db.openPositions(),
  });
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
  const last = db.lastDecisionTs(decision.assetId, decision.horizon);
  const due = !last || Date.now() - new Date(last.ts).getTime() >= (SAMPLE_MS[decision.horizon] || 3600e3) || last.action !== decision.action;
  if (!due || !(decision.price > 0)) return null;
  const hc = H(decision.horizon);
  return db.logDecision(decision, Date.now() + hc.ahead * hc.tf * 1000);
}

async function resolveDue(nowMs = Date.now()) {
  const due = db.dueDecisions(nowMs);
  if (!due.length) return 0;
  const byHorizon = {};
  for (const d of due) {
    const asset = cfg.ASSETS.find(a => a.id === d.assetId) || { id: d.assetId, symbol: d.symbol, assetClass: d.assetClass };
    let px = portfolio.lastPrice.get(d.assetId);
    if (!px) { try { px = (await data.quote(asset))?.price; } catch { /* ignore */ } }
    if (!(px > 0) || !(d.price > 0)) continue;
    const r = Math.log(px / d.price);
    const y = r > 0 ? 1 : 0;
    db.resolveDecision(d.id, px, r, y);
    learner.update(d.votes || [], y, { scale: 1 / H(d.horizon).ahead });
    (byHorizon[d.horizon] ||= []).push({ p: d.pRaw, y });
  }
  db.saveModel("weights", learner.toJSON());
  for (const [h, pairs] of Object.entries(byHorizon)) refitCalibrator(h, pairs);
  return due.length;
}

// ── Warm start from walk-forward backtests ──
async function warmStart({ horizon = currentHorizon(), log = console.log } = {}) {
  const { runInWorker } = require("./learning/worker");
  const pairs = [];
  for (const asset of cfg.ASSETS) {
    try {
      // Technical + regime only (ML has its own purged walk-forward inside ml.signals); regime
      // re-detected every 5 bars to keep this to seconds per asset. Runs in a worker thread.
      const res = await runInWorker({ asset, horizon, opts: { useML: false, regimeEvery: 5 } });
      db.saveBacktest(asset.id, horizon, { ...res, assetId: asset.id, horizon, warm: true, ts: new Date().toISOString() });
      pairs.push(...(res.calibrationPairs || []));
      learner.seed(res.signalStats || {});
      log(`[warm] ${asset.symbol} ${horizon}: ${res.metrics?.nTrades ?? 0} trades, hit ${(100 * (res.metrics?.hitRate || 0)).toFixed(1)}%, pairs ${res.calibrationPairs?.length || 0}`);
    } catch (e) { log(`[warm] ${asset.symbol}: ${e.message}`); }
  }
  db.saveModel("weights", learner.toJSON());
  const c = refitCalibrator(horizon, pairs);
  db.setSetting(`warm_${horizon}`, new Date().toISOString());
  return { pairs: pairs.length, reliability: c?.reliability?.() || null };
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
    calibrator: calibrators[h]?.reliability?.() || null,
    weights: learner.report(), byAction, byFamily,
  };
};

module.exports = { evaluate, buildSignals, maybeLog, resolveDue, warmStart, loadState, perfReport, thresholds, currentHorizon,
  get learner() { return learner; }, calibrators };
