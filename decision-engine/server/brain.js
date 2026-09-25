// Live model-serving layer for the self-improving engine (docs/CONTRACT-v2.md §6).
//
// Bridges what the self-improvement loop learns offline to the real-time decision path:
//   • signal mask   — report-card multipliers (keep ↑ / weak ↓ / drop → 0) applied to confidences
//   • relative      — cross-sectional signals from a per-class cache of peer candles
//   • stacker       — promoted learned combiner → calibrated P(up) / P(outperform) / P(target first)
//   • meta-labeler  — promoted P(this trade ends net-profitable) → confidence + sizing
//   • drift/de-risk — live outcome monitoring feeds back into thresholds and position size
// Everything degrades gracefully: with no promoted models the v1 pooled ensemble runs unchanged.
const cfg = require("./config");

const tryRequire = (p) => { try { return require(p); } catch { return null; } };
const mods = () => ({
  registry: tryRequire("./learning/registry"),
  selfImprove: tryRequire("./learning/selfImprove"),
  stacker: tryRequire("./research/stacker"),
  meta: tryRequire("./research/metaLabel"),
  relative: tryRequire("./analysis/relative"),
});

// ── Champion cache (hot-reloaded when the registry version changes) ──
let loadedVersion = -1;
const champs = {};   // horizon -> { mask, thresholds, stacker:{y,yEx,tbLong}, meta }

function reload(force = false) {
  const { registry, stacker, meta } = mods();
  if (!registry) return;
  let v = 0;
  try { v = registry.version ? registry.version() : 0; } catch { return; }
  if (!force && v === loadedVersion) return;
  loadedVersion = v;
  for (const h of Object.keys(cfg.HORIZONS)) {
    const c = { mask: null, thresholds: null, stacker: {}, meta: null };
    const champ = (kind, target) => { try { return registry.champion(h, kind, target); } catch { return null; } };
    const m = champ("mask"); if (m?.model) c.mask = { map: m.model, version: m.version };
    const t = champ("thresholds"); if (t?.model) c.thresholds = { ...t.model, version: t.version };
    for (const target of ["y", "yEx", "tbLong"]) {
      const e = champ("stacker", target);
      if (e?.model && stacker?.Stacker) {
        try { c.stacker[target] = { model: stacker.Stacker.fromJSON(e.model), version: e.version, baseRate: e.baseRate ?? e.model.baseRate }; }
        catch (err) { console.error(`[brain] stacker ${h}/${target}:`, err.message); }
      }
    }
    const me = champ("meta");
    if (me?.model && meta?.MetaLabeler) {
      try { c.meta = { model: meta.MetaLabeler.fromJSON(me.model), version: me.version, threshold: me.model.threshold ?? me.threshold }; }
      catch (err) { console.error(`[brain] meta ${h}:`, err.message); }
    }
    champs[h] = c;
  }
}

// ── Signal mask ──
// Research prior (docs/DIAGNOSTICS.md): signals whose sign was wrong at EVERY horizon in the
// point-in-time study are zero-weighted (never inverted — flipping would be data snooping).
const PRIOR_MASK = { "sent.feargreed.contrarian": 0 };
function applyMask(signals, horizon) {
  reload();
  const mask = { ...PRIOR_MASK, ...(champs[horizon]?.mask?.map || {}) };
  return signals.map(s => {
    const key = pitId(s.id);
    const m = mask[key] ?? mask[s.id];
    if (m == null || !Number.isFinite(m)) return s;
    return { ...s, confidence: Math.max(0, Math.min(1, s.confidence * m)), masked: m };
  });
}

// ── Dataset-compatible ids ──
// Live technical signals come from the multi-timeframe analyzer (tech.<tf>.<sub>.<name>); the
// point-in-time dataset uses the base timeframe only (tech.<sub>.<name>).
const TF_RX = /^tech\.(\d+[mhdw])\./;
const pitId = (id) => String(id).replace(TF_RX, "tech.");
const baseTfName = (tfSec) => (tfSec >= 86400 ? "1d" : tfSec >= 3600 ? `${tfSec / 3600}h` : `${tfSec / 60}m`);
const PIT_FAMILIES = new Set(["technical", "regime", "relative", "macro"]);

// The subset of live signals the offline models were trained on (base tf technical, regime,
// relative, macro, crypto fear&greed), with ids normalized to the dataset's.
function pitSignals(signals, tfSec) {
  const base = baseTfName(tfSec);
  const out = [];
  for (const s of signals) {
    const m = String(s.id).match(TF_RX);
    if (m) { if (m[1] === base) out.push({ ...s, id: pitId(s.id) }); continue; }
    if (s.id === "tech.mtf.alignment") continue;
    if (PIT_FAMILIES.has(s.family) || String(s.id).startsWith("sent.feargreed")) out.push(s);
  }
  return out;
}

function liveRow(asset, signals, { regime, atrPct, annVol, pRaw, tfSec }) {
  const sig = {}, famSum = {}, famN = {};
  for (const s of pitSignals(signals, tfSec)) {
    sig[s.id] = [s.score, s.confidence];
    famSum[s.family] = (famSum[s.family] || 0) + s.score * s.confidence;
    famN[s.family] = (famN[s.family] || 0) + 1;
  }
  const fam = Object.fromEntries(Object.keys(famSum).map(f => [f, famSum[f] / famN[f]]));
  return {
    assetId: asset.id, symbol: asset.symbol, assetClass: asset.assetClass, t: Date.now(),
    regime: regime ? { trend: regime.trend, vol: regime.vol, label: regime.label, hmmState: regime.hmm?.state ?? null } : null,
    sig, fam, atrPct, annVol, pRaw,
  };
}

// ── Predictions from promoted models ──
// opts.pooledP: v1 pooled pRaw (point-in-time subset) passed through the engine's class calibrator —
// the primary a "pooled" meta-labeler was trained on.
function predict(horizon, row, opts = {}) {
  reload();
  const c = champs[horizon];
  if (!c) return {};
  const out = {};
  const run = (k) => {
    const e = c.stacker[k];
    if (!e) return null;
    try { const p = Number(e.model.predict(row)); return Number.isFinite(p) ? { p, version: e.version, baseRate: e.baseRate } : null; }
    catch (err) { console.error(`[brain] predict ${k}:`, err.message); return null; }
  };
  const y = run("y"); if (y) out.probability = { pUp: y.p, baseRate: y.baseRate, source: "stacker", version: y.version };
  const ex = run("yEx"); if (ex) out.relative = { pOutperform: ex.p, baseRate: ex.baseRate, version: ex.version };
  const tb = run("tbLong"); if (tb) out.targetFirst = { p: tb.p, version: tb.version };
  if (c.meta) {
    // Feed the meta-labeler the SAME primary it was trained on; if that primary isn't available
    // live, serve no meta rather than a mismatched one.
    const mm = c.meta.model;
    let p = null, base = null;
    if (mm.primary === "stacker") {
      const prim = run(mm.primaryTarget || "y");
      if (prim) { p = prim.p; base = prim.baseRate ?? mm.primaryBaseRate; }
    } else if (Number.isFinite(opts.pooledP)) { p = opts.pooledP; base = mm.primaryBaseRate ?? 0.5; }
    if (p == null) return out;
    const side = p >= base ? 1 : -1;
    try {
      const ps = Number(c.meta.model.predict(row, side, p));
      if (Number.isFinite(ps)) out.meta = { pSuccess: ps, threshold: c.thresholds?.metaThreshold ?? c.meta.threshold ?? 0.55, version: c.meta.version, side };
    } catch (err) { console.error("[brain] meta:", err.message); }
  }
  return out;
}

function thresholdsOverride(horizon) {
  reload();
  const t = champs[horizon]?.thresholds;
  if (!t) return {};
  const o = {};
  if (Number.isFinite(t.MIN_CONFIDENCE)) o.MIN_CONFIDENCE = t.MIN_CONFIDENCE;
  if (Number.isFinite(t.MIN_PROB_EDGE)) o.MIN_PROB_EDGE = t.MIN_PROB_EDGE;
  return o;
}

// ── De-risk state from drift monitoring ──
function derisk() {
  const si = mods().selfImprove;
  try {
    const d = si?.status?.()?.derisk;
    return d && (!d.until || Date.parse(d.until) > Date.now() || d.until > Date.now()) ? d : null;
  } catch { return null; }
}

function onResolved(ev) {
  const si = mods().selfImprove;
  try { si?.onResolved?.(ev); } catch (e) { console.error("[brain] onResolved:", e.message); }
}

// ── Peer candles for the relative family ──
const peerCache = new Map();   // `${cls}|${tf}` -> Map(symbol -> candles)
function rememberCandles(asset, tfSec, candles) {
  if (!Array.isArray(candles) || candles.length < 30) return;
  const k = `${asset.assetClass}|${tfSec}`;
  if (!peerCache.has(k)) peerCache.set(k, new Map());
  peerCache.get(k).set(asset.symbol, candles);
}
const BENCH = { stock: "SPY", crypto: "BTC" };
const relCache = {};
function relativeSignals(asset, candles, horizon, tfSec) {
  const rel = mods().relative;
  if (!rel?.signals) return [];
  const pool = peerCache.get(`${asset.assetClass}|${tfSec}`);
  if (!pool) return [];
  const peers = {};
  for (const [sym, c] of pool) if (sym !== asset.symbol) peers[sym] = c;
  const benchmark = asset.symbol === BENCH[asset.assetClass] ? candles : pool.get(BENCH[asset.assetClass]);
  if (!benchmark) return [];
  try {
    return rel.signals(candles, { peers, benchmark, assetClass: asset.assetClass, horizon, symbol: asset.symbol,
      t: candles.at(-1)?.t, cache: relCache }) || [];
  } catch (e) { console.error("[brain] relative:", e.message); return []; }
}

function status() {
  reload();
  const out = {};
  for (const [h, c] of Object.entries(champs)) {
    out[h] = {
      mask: c.mask ? { version: c.mask.version, n: Object.keys(c.mask.map).length, dropped: Object.values(c.mask.map).filter(v => v === 0).length } : null,
      thresholds: c.thresholds || null,
      stacker: Object.fromEntries(Object.entries(c.stacker).map(([k, v]) => [k, { version: v.version, baseRate: v.baseRate }])),
      meta: c.meta ? { version: c.meta.version, threshold: c.meta.threshold } : null,
    };
  }
  return { registryVersion: loadedVersion, champions: out, derisk: derisk(), peers: [...peerCache].map(([k, m]) => ({ key: k, n: m.size })) };
}

module.exports = { reload, applyMask, pitSignals, pitId, liveRow, predict, thresholdsOverride, derisk, onResolved,
  rememberCandles, relativeSignals, status, PIT_FAMILIES };
