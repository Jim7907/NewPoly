// Historical track record of the engine's DIRECTIONAL FORECAST (UP / DOWN = the signals' consensus),
// measured on the point-in-time research panel (server/research/dataset.js).
//
// For every labeled row the current ensemble is re-run on that row's point-in-time signals (no
// calibrator, nothing fitted to the outcomes), giving the forecast direction and its alignment
// (share of weighted evidence pointing that way). Outcomes are then tallied per
// asset class × direction × alignment bucket (and × strength):
//   hit = (UP and the price rose over the horizon) or (DOWN and it fell)
// next to the base rate (how often that direction happens anyway in that class), so a reader can see
// whether a "78% aligned UP" call beats simply assuming the usual drift.
//
// Caveat printed with the table: the panel only has the families with point-in-time history
// (technical base-tf, regime, relative, macro, crypto fear&greed); news, fundamentals, derivatives,
// order flow, ML and LLM signals are live-only. Rows overlap (horizon > 1 bar), so n overstates the
// number of independent outcomes by ≈ ahead×; Wilson CIs use n_eff = n / ahead.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const BUCKETS = [[0.5, 0.6, "50-60%"], [0.6, 0.7, "60-70%"], [0.7, 0.8, "70-80%"], [0.8, 0.9, "80-90%"], [0.9, 1.0001, "90-100%"]];
const bucketOf = (a) => (BUCKETS.find(([lo, hi]) => a >= lo && a < hi) || BUCKETS[0])[2];

function wilson(h, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = h / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

/** Pure: rows → table. `decide` is ensemble.decide (injectable for tests). */
function directionTable(ds, { decide, maxRows = Infinity } = {}) {
  if (!decide) decide = require("../decision/ensemble").decide;
  const fam = ds.signalFamily || {};
  const famOf = (id) => fam[id] || (id.startsWith("tech.") ? "technical" : id.startsWith("regime.") ? "regime" : id.startsWith("rel.") ? "relative" : id.startsWith("macro.") ? "macro" : id.startsWith("sent.") ? "sentiment" : "other");
  const ahead = ds.ahead || 5;
  const T = {};           // cls -> dir -> key -> {n, hits}
  const base = {};        // cls -> {n, ups}
  const strengthT = {};   // cls -> dir -> strength -> {n, hits}
  const add = (obj, k, hit) => { const o = (obj[k] ||= { n: 0, hits: 0 }); o.n++; o.hits += hit; };
  let used = 0;
  for (const r of ds.rows) {
    if (used >= maxRows) break;
    if (!r.lab || (r.lab.y !== 0 && r.lab.y !== 1) || !r.sig) continue;
    const signals = Object.entries(r.sig).map(([id, v]) => ({ id, family: famOf(id), score: v[0], confidence: v[1] }));
    if (!signals.length) continue;
    const d = decide({ asset: { id: r.assetId, symbol: r.symbol, assetClass: r.assetClass }, signals, regime: r.regime, horizon: ds.horizon, price: r.price, atr: r.atrPct ? r.atrPct * r.price : null });
    const f = d.forecast;
    if (!f) continue;
    const cls = r.assetClass || "other";
    const y = r.lab.y;
    const hit = (f.direction === "UP" && y === 1) || (f.direction === "DOWN" && y === 0) ? 1 : 0;
    (base[cls] ||= { n: 0, ups: 0 }); base[cls].n++; base[cls].ups += y;
    ((T[cls] ||= {})[f.direction] ||= {});
    add(T[cls][f.direction], bucketOf(f.alignment), hit);
    add(T[cls][f.direction], "all", hit);
    add(((strengthT[cls] ||= {})[f.direction] ||= {}), f.strength, hit);
    used++;
  }
  const finish = (cls, dir, o) => {
    const b = base[cls] ? base[cls].ups / base[cls].n : 0.5;
    const baseRate = dir === "UP" ? b : 1 - b;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const hr = v.n ? v.hits / v.n : null;
      out[k] = { n: v.n, hits: v.hits, hitRate: r4(hr), baseRate: r4(baseRate), lift: r4(hr - baseRate), ci95: wilson(v.hits / ahead, v.n / ahead)?.map(r4) || null };
    }
    return out;
  };
  const table = {}, byStrength = {};
  for (const cls of Object.keys(T)) {
    table[cls] = {}; byStrength[cls] = {};
    for (const dir of Object.keys(T[cls])) {
      table[cls][dir] = finish(cls, dir, T[cls][dir]);
      byStrength[cls][dir] = finish(cls, dir, strengthT[cls][dir] || {});
    }
  }
  return {
    horizon: ds.horizon, ahead, rows: used, built: new Date().toISOString(), datasetBuilt: ds.built || null,
    basis: "technical+regime+relative+macro(+fear&greed) point-in-time signals, current ensemble, no fitting to outcomes",
    baseRates: Object.fromEntries(Object.entries(base).map(([c, v]) => [c, r4(v.ups / v.n)])),
    table, byStrength, buckets: BUCKETS.map(b => b[2]),
  };
}

/** Look up the track record for a live forecast. */
function lookup(stats, assetClass, forecast) {
  if (!stats || !forecast) return null;
  const t = stats.table?.[assetClass]?.[forecast.direction];
  if (!t) return null;
  const bucket = bucketOf(forecast.alignment);
  const cell = t[bucket] && t[bucket].n >= 30 ? t[bucket] : null;
  const st = stats.byStrength?.[assetClass]?.[forecast.direction]?.[forecast.strength];
  return {
    bucket, hitRate: cell ? cell.hitRate : null, n: cell ? cell.n : (t[bucket]?.n || 0), baseRate: t.all?.baseRate ?? null,
    lift: cell ? cell.lift : null, ci95: cell ? cell.ci95 : null,
    strengthHitRate: st && st.n >= 30 ? st.hitRate : null, strengthN: st ? st.n : 0,
    horizon: stats.horizon, assetClass, basis: stats.basis,
  };
}

// ── Worker entry (keeps the ~85k re-decisions off the event loop) ──
function computeInWorker(horizon) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { __directionStats: true, horizon } });
    w.once("message", (m) => (m && m.error ? reject(new Error(m.error)) : resolve(m)));
    w.once("error", reject);
    w.once("exit", (c) => { if (c !== 0) reject(new Error(`directionStats worker exited ${c}`)); });
  });
}

if (!isMainThread && workerData && workerData.__directionStats) {
  (async () => {
    try {
      const { loadDataset } = require("./dataset");
      const ds = await loadDataset(`${workerData.horizon}.json.gz`);
      if (!ds || !Array.isArray(ds.rows)) throw new Error(`no research dataset for ${workerData.horizon}`);
      parentPort.postMessage(directionTable(ds));
    } catch (e) { parentPort.postMessage({ error: e.message }); }
  })();
}

module.exports = { directionTable, lookup, computeInWorker, bucketOf, wilson, BUCKETS };
