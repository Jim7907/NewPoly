// Point-in-time research panel (docs/CONTRACT-v2.md §1).
//
// One row = one asset at one bar i, holding every signal the engine can reproduce historically,
// the v1 pooled probability, and forward labels. The contract that matters:
//
//   * NO LOOKAHEAD. Everything in a row except `lab` is computed from candles[0..i] of that asset,
//     from peer / benchmark bars with time ≤ t, from macro observations dated ≤ t − 1 day
//     (publication lag) and from Fear & Greed readings stamped ≤ t. test/dataset.test.js perturbs
//     the future and asserts rows ≤ i do not move.
//     relative.js gets the ≤ i window of the asset itself and, by default, the full peer/benchmark
//     histories plus the cut-off t (the module reads only bars ≤ t and caches prepared series —
//     its author's fast path); relativeInput "slice" hands over only peer bars ≤ t. Both give
//     identical rows (tested), and both pass the perturb-the-future test.
//   * Families: technical (base tf), regime, relative (lazy, optional), macro, fear-greed (crypto).
//     News / fundamentals / derivatives / microstructure / ML have no point-in-time history here
//     and are excluded.
//   * Labels (lab, null while the window is still open):
//       ret      log(close[i+ahead] / close[i])
//       exRet    ret − benchmark log return over the same bars (SPY for stocks, BTC for crypto;
//                the benchmark's own exRet is 0 — signalEval excludes it from relative targets)
//       y, yEx   ret > 0, exRet > 0
//       tbLong/tbShort   triple barrier with ensemble.BRACKETS[horizon] stop/target in ATR(14) at
//                bar i; entry close[i]; bars i+1..i+ahead scanned on high/low; both barriers in
//                one bar → stop (pessimistic); a gap through a barrier fills at the open;
//                +1 target first, −1 stop first, 0 vertical barrier (exit close[i+ahead]).
//       tbLongRet/tbShortRet  bracket return net of round-trip costs 2·(FEE_BPS_<class> + SLIPPAGE_BPS).
//       tEnd     time of bar i+ahead (label window end — for purging overlapping labels).
//   * Speed: technical signals use a trailing `lookback` window; the regime (incl. its HMM fit) is
//     re-detected on bars whose absolute index is a multiple of `regimeEvery` and carried forward
//     (point-in-time: a row never uses a regime fitted after its own bar). Assets are spread over
//     worker threads (opts.workers). Results do not depend on the number of workers.
//   * updateDataset is incremental: only bars after each asset's last row are computed, and
//     labels are filled for rows whose window has matured since. ds.meta.codeHash fingerprints the
//     analyzer/ensemble sources; an update run on different code sets lastUpdate.codeChanged.
//
// Row / Dataset shapes: see the contract. Extras: lab.tEnd, ds.signalFamily {id: family},
// ds.meta {stride, lookback, warmup, regimeEvery, costsBps, families, timing, notes}.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const baseCfg = require("../config");
const ensemble = require("../decision/ensemble");
const I = require("../analysis/indicators");
const technical = require("../analysis/technical");
const regimeMod = require("../analysis/regime");
const macroMod = require("../analysis/macro");
const sentiment = require("../analysis/sentiment");

const VERSION = 2;
const DAY = 86400000;
const DATA_DIR = path.join(__dirname, "..", "..", "data", "research");
const BENCHMARKS = Object.freeze({ stock: "STOCK:SPY", crypto: "CRYPTO:BTC" });
const ETFS = new Set(["SPY", "QQQ", "IWM", "DIA"]);
const MACRO_KEYS = ["vix", "dgs10", "t10y2y", "dxy", "hyOas"];
const MACRO_KEEP = 300;            // observations handed to macro.signals (it looks back ≤ 250)
const FNG_KEEP = 30;

// Liquid US large caps across sectors + index ETFs, and the major coins (contract §1). The
// research universe is the de-duplicated union of these and the live watchlist (cfg.ASSETS).
const EXTRA_STOCKS = ["JPM", "XOM", "UNH", "JNJ", "PG", "KO", "WMT", "HD", "V", "MA", "LLY", "AVGO", "COST", "PEP",
  "ORCL", "CRM", "AMD", "NFLX", "ADBE", "CSCO", "CVX", "BAC", "MRK", "ABBV", "TMO", "DIS", "INTC", "QCOM", "CAT", "GE",
  "IWM", "DIA"];
const EXTRA_CRYPTO = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK"];

// ───────────────────────────── small helpers ─────────────────────────────
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r4 = (v) => (isNum(v) ? Math.round(v * 1e4) / 1e4 : null);
const r6 = (v) => (isNum(v) ? Math.round(v * 1e6) / 1e6 : null);
const sig8 = (v) => (isNum(v) ? Number(v.toPrecision(8)) : null);
const uniq = (xs) => [...new Set(xs)];

/** Index of the last element of ascending `times` that is ≤ t, or −1. */
function upperBound(times, t) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Ascending, one candle per t, finite positive OHLC, h/l widened to contain o/c. */
function cleanCandles(cs) {
  if (!Array.isArray(cs)) return [];
  const m = new Map();
  for (const k of cs) {
    if (!k || ![k.t, k.o, k.h, k.l, k.c].every(isNum) || !(k.c > 0) || !(k.o > 0) || !(k.l > 0)) continue;
    m.set(k.t, { t: k.t, o: k.o, h: Math.max(k.h, k.o, k.c), l: Math.min(k.l, k.o, k.c), c: k.c, v: isNum(k.v) ? k.v : 0 });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

// ───────────────────────────── universe ─────────────────────────────
function stockAsset(sym) {
  const s = String(sym).trim().toUpperCase();
  const live = (baseCfg.STOCKS || []).find((a) => a.symbol === s);
  return live ? { ...live } : { symbol: s, name: s, assetClass: "stock", id: `STOCK:${s}`, etf: ETFS.has(s) };
}
function cryptoAsset(sym) {
  const s = String(sym).trim().toUpperCase();
  const u = (baseCfg.CRYPTO_UNIVERSE || {})[s];
  return u ? { ...u, assetClass: "crypto", id: `CRYPTO:${s}` }
    : { symbol: s, name: s, assetClass: "crypto", id: `CRYPTO:${s}`, coinbase: `${s}-USD`, kraken: `${s}USD` };
}
/** Asset object | "STOCK:XYZ" | "CRYPTO:XYZ" | bare symbol → asset object. */
function toAsset(x) {
  if (!x) return null;
  if (typeof x === "object") {
    if (x.id && x.assetClass) return x;
    if (x.symbol) return x.assetClass === "crypto" ? cryptoAsset(x.symbol) : stockAsset(x.symbol);
    return null;
  }
  const s = String(x).trim().toUpperCase();
  if (s.startsWith("CRYPTO:")) return cryptoAsset(s.slice(7));
  if (s.startsWith("STOCK:")) return stockAsset(s.slice(6));
  return (baseCfg.CRYPTO_UNIVERSE || {})[s] ? cryptoAsset(s) : stockAsset(s);
}

/** Default research universe; env RESEARCH_STOCKS / RESEARCH_CRYPTO (comma lists) override. */
function researchUniverse(env = process.env) {
  const envList = (k) => (env[k] != null && String(env[k]).trim() !== ""
    ? String(env[k]).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null);
  const stocks = envList("RESEARCH_STOCKS") || uniq([...(baseCfg.STOCKS || []).map((a) => a.symbol), ...EXTRA_STOCKS]);
  const crypto = envList("RESEARCH_CRYPTO") || uniq([...(baseCfg.CRYPTO || []).map((a) => a.symbol), ...EXTRA_CRYPTO]);
  if (!stocks.includes("SPY")) stocks.push("SPY");         // benchmarks are always present
  if (!crypto.includes("BTC")) crypto.unshift("BTC");
  return [...uniq(stocks).map(stockAsset), ...uniq(crypto).map(cryptoAsset)];
}
const RESEARCH_UNIVERSE = Object.freeze(researchUniverse());

// ───────────────────────────── macro / fear & greed ─────────────────────────────
function prepSeries(s) {
  const pts = (Array.isArray(s) ? s : [])
    .map((p) => (p ? { t: typeof p.t === "number" ? p.t : Date.parse(p.t), v: Number(p.v ?? p.value) } : null))
    .filter((p) => p && isNum(p.t) && isNum(p.v)).sort((a, b) => a.t - b.t);
  return { pts, times: pts.map((p) => p.t) };
}
function prepMacro(macro) {
  const out = {};
  if (!macro || typeof macro !== "object") return out;
  for (const k of MACRO_KEYS) { const s = prepSeries(macro[k]); if (s.pts.length) out[k] = s; }
  return out;
}
function prepFng(fg) {
  const hist = Array.isArray(fg) ? fg : fg && Array.isArray(fg.history) ? fg.history : [];
  return prepSeries(hist);
}
const hasMacro = (pm) => Object.keys(pm).length > 0;

// Macro observations dated ≤ t − 1 day (FRED series publish with a lag). Memoised by the tuple of
// cut indices + asset kind: all stocks on one date share the same slice.
function macroSignalsAt(ctx, asset, t) {
  const pm = ctx.macro;
  if (!hasMacro(pm)) return [];
  const cut = t - DAY;
  const idx = MACRO_KEYS.map((k) => (pm[k] ? upperBound(pm[k].times, cut) : -1));
  if (idx.every((j) => j < 0)) return [];
  const key = `${asset.assetClass}|${asset.etf ? 1 : 0}|${idx.join(",")}`;
  const memo = ctx.memo.macro;
  let sigs = memo.get(key);
  if (!sigs) {
    const slice = {};
    MACRO_KEYS.forEach((k, n) => { if (idx[n] >= 0) slice[k] = pm[k].pts.slice(Math.max(0, idx[n] + 1 - MACRO_KEEP), idx[n] + 1); });
    try { sigs = macroMod.signals(slice, asset) || []; } catch { sigs = []; }
    if (memo.size > 20000) memo.clear();
    memo.set(key, sigs);
  }
  return sigs;
}

// Fear & Greed reading stamped ≤ t (crypto only), with its trailing history (oldest first).
function fngSignalsAt(ctx, t) {
  const fg = ctx.fng;
  if (!fg || !fg.pts.length) return [];
  const j = upperBound(fg.times, t);
  if (j < 0 || t - fg.times[j] > 3 * DAY) return [];        // no fresh reading → no signal
  let sigs = ctx.memo.fng.get(j);
  if (!sigs) {
    const hist = fg.pts.slice(Math.max(0, j + 1 - FNG_KEEP), j + 1);
    try { sigs = [sentiment.fearGreedSignal({ value: fg.pts[j].v, history: hist })].filter(Boolean); } catch { sigs = []; }
    ctx.memo.fng.set(j, sigs);
  }
  return sigs;
}

// ───────────────────────────── code fingerprint ─────────────────────────────
// Rows are only comparable if they were computed by the same analyzer / ensemble code. The hash of
// those sources is stored in ds.meta.codeHash; updateDataset flags a change (full rebuild advised).
const CODE_FILES = ["../analysis/technical.js", "../analysis/indicators.js", "../analysis/regime.js", "../analysis/macro.js",
  "../analysis/sentiment.js", "../analysis/relative.js", "../decision/ensemble.js", "./dataset.js"];
function codeHash() {
  const h = require("crypto").createHash("sha1");
  for (const f of CODE_FILES) {
    try { h.update(f); h.update(fs.readFileSync(path.join(__dirname, f))); } catch { h.update(`${f}:missing`); }
  }
  return h.digest("hex").slice(0, 16);
}
// The code THIS thread runs: hashed right after the analyzers were required (worker threads hash
// their own copy at start-up, since a worker loads the files as they are on disk at that moment).
const LOADED_HASH = codeHash();

// ───────────────────────────── relative family (optional) ─────────────────────────────
function loadRelative(override) {
  if (override === null || override === false) return null;
  if (override && typeof override.signals === "function") return override;
  try {
    const m = require("../analysis/relative");
    return m && typeof m.signals === "function" ? m : null;
  } catch { return null; }
}

// ───────────────────────────── labels ─────────────────────────────
/**
 * tripleBarrier(candles, i, ahead, atr, { stop, target }, costRT)
 *   → { tbLong, tbShort, tbLongRet, tbShortRet, exitLong, exitShort } | null
 * Entry close[i]; barriers stop·ATR / target·ATR away; bars i+1..i+ahead scanned on high/low.
 * Gap through a barrier fills at that bar's open; stop and target inside one bar → stop.
 */
function tripleBarrier(candles, i, ahead, atr, bracket, costRT = 0) {
  const n = candles.length;
  if (!(atr > 0) || i < 0 || i + ahead > n - 1) return null;
  const entry = candles[i].c;
  const S = bracket.stop * atr, T = bracket.target * atr;
  const run = (dir) => {
    const stop = entry - dir * S, tgt = entry + dir * T;
    for (let j = i + 1; j <= i + ahead; j++) {
      const b = candles[j];
      const gapStop = dir > 0 ? b.o <= stop : b.o >= stop;
      const gapTgt = dir > 0 ? b.o >= tgt : b.o <= tgt;
      if (gapStop) return { out: -1, px: b.o, j };
      if (gapTgt) return { out: 1, px: b.o, j };
      const hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
      const hitTgt = dir > 0 ? b.h >= tgt : b.l <= tgt;
      if (hitStop) return { out: -1, px: stop, j };            // both in one bar → stop (pessimistic)
      if (hitTgt) return { out: 1, px: tgt, j };
    }
    return { out: 0, px: candles[i + ahead].c, j: i + ahead };
  };
  const L = run(1), Sh = run(-1);
  return {
    tbLong: L.out, tbShort: Sh.out,
    tbLongRet: L.px / entry - 1 - costRT,
    tbShortRet: 1 - Sh.px / entry - costRT,
    exitLong: L.j, exitShort: Sh.j,
  };
}

function roundTripCost(cfg, assetClass) {
  const fee = assetClass === "crypto" ? cfg.FEE_BPS_CRYPTO : cfg.FEE_BPS_STOCK;
  return 2 * ((isNum(fee) ? fee : assetClass === "crypto" ? 10 : 1) + (isNum(cfg.SLIPPAGE_BPS) ? cfg.SLIPPAGE_BPS : 5)) / 1e4;
}

// Benchmark close for the window endpoints: exact bar, else last bar ≤ x if the benchmark's data
// covers x and that bar is not stale.
function benchClose(bench, x, staleMs) {
  if (!bench || !bench.times.length || bench.times[bench.times.length - 1] < x) return null;
  const j = upperBound(bench.times, x);
  if (j < 0 || x - bench.times[j] > staleMs) return null;
  return bench.candles[j].c;
}

function labelAt(job, k, atr) {
  const cs = job.candles, H = job.ahead;
  if (k + H > cs.length - 1) return null;
  const c0 = cs[k].c, c1 = cs[k + H].c, t0 = cs[k].t, tEnd = cs[k + H].t;
  const ret = Math.log(c1 / c0);
  let exRet = null;
  if (job.isBenchmark) exRet = 0;
  else if (job.bench) {
    const b0 = benchClose(job.bench, t0, job.staleMs), b1 = benchClose(job.bench, tEnd, job.staleMs);
    if (b0 > 0 && b1 > 0) exRet = ret - Math.log(b1 / b0);
  }
  const tb = tripleBarrier(cs, k, H, atr, job.bracket, job.costRT);
  return {
    ret: r6(ret), exRet: r6(exRet), y: ret > 0 ? 1 : 0, yEx: exRet == null ? null : exRet > 0 ? 1 : 0,
    tbLong: tb ? tb.tbLong : null, tbShort: tb ? tb.tbShort : null,
    tbLongRet: tb ? r6(tb.tbLongRet) : null, tbShortRet: tb ? r6(tb.tbShortRet) : null,
    tEnd,
  };
}

// ───────────────────────────── per-asset computation (pure given a job) ─────────────────────────────
// A job holds settings and ids only; candles live once per thread in `env.series`
// ({ id → { asset, candles, times } }) so peers are not copied into every job.
// job = { assetId, peerIds, benchId, isBenchmark, horizon, tf, ahead, bracket, costRT, lookback,
//         warmup, stride, regimeEvery, staleMs, ppy, iOffset, kFrom, kTo, relative,
//         expectedFamilies }
// env = { series, macro, fng, memo: { macro, fng }, relCache }
function makeEnv(shared) {
  const series = new Map();
  for (const [id, v] of Object.entries(shared.series || {})) series.set(id, { asset: v.asset, candles: v.candles, times: v.candles.map((c) => c.t) });
  return { series, macro: shared.macro, fng: shared.fng, memo: { macro: new Map(), fng: new Map() }, relCache: new Map() };
}
function resolveJob(job, env) {
  const own = env.series.get(job.assetId);
  const bench = !job.isBenchmark && job.benchId ? env.series.get(job.benchId) : null;
  return {
    ...job, asset: own.asset, candles: own.candles, times: own.times,
    peers: (job.peerIds || []).map((id) => env.series.get(id)).filter((p) => p && p.candles.length).map((p) => ({ symbol: p.asset.symbol, candles: p.candles, times: p.times })),
    bench: bench && bench.candles.length ? { candles: bench.candles, times: bench.times } : null,
  };
}

function computeAssetRows(jobIn, env, relMod, onRow) {
  const job = resolveJob(jobIn, env);
  const cs = job.candles;
  const n = cs.length;
  const asset = job.asset;
  const cls = asset.assetClass;
  const techCls = asset.etf ? "etf" : cls;
  const closes = cs.map((c) => c.c);
  const atrA = I.atr(cs, 14);
  const rv = I.realizedVol(closes, 20);
  const ctx = { macro: env.macro, fng: env.fng, memo: env.memo };
  const E = Math.max(1, job.regimeEvery | 0);
  const rows = [];
  const signalFamily = {};
  const errors = {};
  const st = { regimeAt: null, regime: null };
  const safe = (name, fn) => { try { return fn(); } catch (e) { errors[name] = (errors[name] || 0) + 1; return null; } };
  const windowAt = (k) => cs.slice(Math.max(0, k + 1 - job.lookback), k + 1);
  const useRel = !!(relMod && job.relative);
  const relCache = useRel && env.relCache ? env.relCache : null;
  const relFull = job.relativeInput !== "slice";
  const peersFull = {};
  for (const p of job.peers) peersFull[p.symbol] = p.candles;
  if (useRel && relCache && n > 1 && job.kFrom <= job.kTo) {
    // Prime relative.js's series cache with the full histories: every later call passes windows /
    // arrays that are contiguous sub-ranges of these, which the module reuses (its views stop at the
    // `t` cut-off, so this changes speed, not results — see the point-in-time tests).
    safe("relativePrime", () => relMod.signals(cs, { peers: peersFull, benchmark: job.isBenchmark ? cs : job.bench ? job.bench.candles : cs,
      assetClass: cls, horizon: job.horizon, symbol: asset.symbol, etf: !!asset.etf, t: cs[n - 1].t, cache: relCache }));
  }

  for (let k = job.kFrom; k <= job.kTo && k < n; k += job.stride) {
    const bar = cs[k];
    const t = bar.t;
    const iAbs = k + job.iOffset;
    const window = windowAt(k);

    // Regime: re-detected at the last bar ≤ i whose absolute index is a multiple of E.
    let kA = k - (((iAbs % E) + E) % E);
    if (kA < 0) kA = k;
    if (st.regimeAt !== kA) {
      st.regime = safe("regime", () => regimeMod.detect(kA === k ? window : windowAt(kA))) || null;
      st.regimeAt = kA;
    }
    const regime = st.regime;

    const sigs = [];
    const push = (xs) => { if (Array.isArray(xs)) for (const s of xs) if (s && s.id && isNum(Number(s.score))) sigs.push(s); };
    // now = this bar's close: the bar is complete (no forming-bar volume projection), and the result
    // cannot depend on the wall clock.
    push(safe("technical", () => technical.analyze(window, { horizon: job.horizon, assetClass: techCls, now: t + job.tf * 1000 })));
    if (regime) push(safe("regimeSignals", () => regimeMod.signals(regime)));
    push(safe("macro", () => macroSignalsAt(ctx, asset, t)));
    if (cls === "crypto") push(safe("fearGreed", () => fngSignalsAt(ctx, t)));
    if (useRel) {
      push(safe("relative", () => {
        // Own candles: the ≤ i window, always. Peers / benchmark: by default the full histories plus
        // the cut-off `t` (relative.js reads only bars ≤ t — its author's recommended fast path,
        // ~3× cheaper for 50 stock peers); relativeInput "slice" hands over only bars ≤ t instead.
        let peers = peersFull, benchmark = null;
        if (job.isBenchmark) benchmark = window;
        else if (job.bench) benchmark = job.bench.candles;
        if (!relFull) {
          peers = {};
          for (const p of job.peers) {
            const j = upperBound(p.times, t);                    // peer bars with time ≤ t only
            if (j < 0 || t - p.times[j] > job.staleMs) continue;
            peers[p.symbol] = p.candles.slice(0, j + 1);
          }
          if (!job.isBenchmark && job.bench) {
            const j = upperBound(job.bench.times, t);
            benchmark = j >= 0 && t - job.bench.times[j] <= job.staleMs ? job.bench.candles.slice(0, j + 1) : null;
          }
        }
        if (!benchmark) return [];
        return relMod.signals(window, { peers, benchmark, assetClass: cls, horizon: job.horizon, symbol: asset.symbol, etf: !!asset.etf, t, cache: relCache });
      }));
    }

    // id → [score, confidence]; duplicate ids keep the stronger opinion.
    const sig = {};
    const famSum = {}, famN = {};
    const kept = new Map();
    for (const s of sigs) {
      const sc = Math.max(-1, Math.min(1, Number(s.score)));
      const cf = Math.max(0, Math.min(1, isNum(Number(s.confidence)) ? Number(s.confidence) : 0));
      const prev = kept.get(s.id);
      if (prev && Math.abs(prev[0] * prev[1]) >= Math.abs(sc * cf)) continue;
      kept.set(s.id, [sc, cf, s.family || "other"]);
    }
    for (const [id, [sc, cf, fam]] of kept) {
      sig[id] = [r4(sc), r4(cf)];
      if (!signalFamily[id]) signalFamily[id] = fam;
      famSum[fam] = (famSum[fam] || 0) + sc * cf;
      famN[fam] = (famN[fam] || 0) + 1;
    }
    const fam = {};
    for (const f of Object.keys(famSum)) fam[f] = r4(famSum[f] / famN[f]);

    const atr0 = isNum(atrA[k]) && atrA[k] > 0 ? atrA[k] : null;
    // Stored ATR% (8 significant digits) is also what the barriers use, so labels matured later by
    // updateDataset (which only has the row) are bit-identical to labels computed at build time.
    const atrPct = atr0 ? sig8(atr0 / bar.c) : null;
    const atr = atrPct ? atrPct * bar.c : null;
    let pRaw = 0.5;
    const d = safe("decide", () => ensemble.decide({
      asset, signals: sigs, regime, horizon: job.horizon, price: bar.c, atr, candles: window, now: t,
      expectedFamilies: job.expectedFamilies, equity: 100000, openPositions: [],
    }));
    if (d && isNum(d.pRaw)) pRaw = d.pRaw;

    const row = {
      assetId: asset.id, symbol: asset.symbol, assetClass: cls, t, i: iAbs,
      price: bar.c, atrPct, annVol: isNum(rv[k]) ? r4(rv[k] * Math.sqrt(job.ppy)) : null,
      regime: regime ? { trend: regime.trend || null, vol: regime.vol || null, label: regime.label || null,
        hmmState: regime.hmm && regime.hmm.state != null ? regime.hmm.state : null } : null,
      sig, fam, pRaw: r4(pRaw),
      lab: labelAt(job, k, atr),                                 // null while the window is open
    };
    rows.push(row);
    if (onRow) onRow(row);
  }
  return { rows, signalFamily, errors };
}

// ───────────────────────────── job construction ─────────────────────────────
function horizonSpec(horizon, cfg) {
  const hz = (cfg.HORIZONS && cfg.HORIZONS[horizon]) || null;
  if (!hz) throw new Error(`unknown horizon "${horizon}"`);
  return hz;
}
function periodsPerYear(tf, cls) {
  if (cls === "crypto") return (365 * 86400) / tf;
  return tf >= 86400 ? (252 * 86400) / tf : (252 * 6.5 * 3600) / tf;
}

function makeSettings(opts, cfg) {
  const horizon = opts.horizon || cfg.HORIZON || "swing";
  const hz = horizonSpec(horizon, cfg);
  const tf = hz.tf, ahead = Math.max(1, hz.ahead | 0);
  const daily = tf >= 86400;
  const lookback = Math.max(80, Math.floor(isNum(opts.lookback) ? opts.lookback : daily ? 520 : 600));
  return {
    horizon, tf, ahead, lookback,
    warmup: Math.max(60, Math.floor(isNum(opts.warmup) ? opts.warmup : 260)),
    stride: Math.max(1, Math.floor(isNum(opts.stride) ? opts.stride : 1)),
    regimeEvery: Math.max(1, Math.floor(isNum(opts.regimeEvery) ? opts.regimeEvery : daily ? 5 : 4)),
    bracket: ensemble.BRACKETS[horizon] || ensemble.BRACKETS.swing,
    staleMs: Math.max(4 * tf * 1000, 4 * DAY),
    relativeInput: opts.relativeInput === "slice" ? "slice" : "full",
  };
}

function prepAssetData(assets, candlesByAsset) {
  const data = new Map();
  for (const a of assets) {
    const cs = cleanCandles(candlesByAsset[a.id] || candlesByAsset[a.symbol] || []);
    data.set(a.id, { asset: a, candles: cs, times: cs.map((c) => c.t) });
  }
  return data;
}
const sharedSeries = (data) => Object.fromEntries([...data].map(([id, d]) => [id, { asset: d.asset, candles: d.candles }]));

function buildJob(S, cfg, a, data, extra) {
  const d = data.get(a.id);
  const cls = a.assetClass;
  const benchId = BENCHMARKS[cls];
  const isBenchmark = a.id === benchId;
  const peerIds = [];
  for (const [id, p] of data) if (id !== a.id && p.asset.assetClass === cls && p.candles.length) peerIds.push(id);
  return {
    assetId: a.id, peerIds, benchId: data.has(benchId) ? benchId : null, isBenchmark,
    horizon: S.horizon, tf: S.tf, ahead: S.ahead, bracket: S.bracket, costRT: roundTripCost(cfg, cls),
    lookback: S.lookback, warmup: S.warmup, stride: S.stride, regimeEvery: S.regimeEvery,
    staleMs: S.staleMs, ppy: periodsPerYear(S.tf, cls),
    expectedFamilies: extra.expectedFamilies[cls], relative: extra.relative, relativeInput: S.relativeInput,
    iOffset: 0, kFrom: S.warmup, kTo: d.candles.length - 1,
  };
}

// ───────────────────────────── execution (in-process or worker threads) ─────────────────────────────
// shared = { series: { id → { asset, candles } }, macro, fng } — sent once per worker.
function runJobsInWorkers(jobs, shared, nWorkers, onRowCount, hashes) {
  // Balance by number of rows to compute (greedy longest-first).
  const buckets = Array.from({ length: nWorkers }, () => ({ load: 0, idx: [] }));
  const order = jobs.map((j, idx) => ({ idx, load: Math.max(0, Math.ceil((j.kTo - j.kFrom + 1) / j.stride)) })).sort((a, b) => b.load - a.load);
  for (const o of order) { buckets.sort((a, b) => a.load - b.load); buckets[0].load += o.load; buckets[0].idx.push(o.idx); }
  const results = new Array(jobs.length);
  const tasks = buckets.filter((b) => b.idx.length).map((b) => new Promise((resolve) => {
    let settled = false, got = 0;
    const fallback = (why) => {
      if (settled) return; settled = true;
      // Recompute whatever this worker did not deliver, in-process (same results, just slower).
      const missing = b.idx.filter((k) => !results[k]);
      const env = makeEnv(shared);
      const rel = loadRelative();
      if (missing.length) hashes.add(LOADED_HASH);
      for (const k of missing) {
        results[k] = computeAssetRows(jobs[k], env, rel, () => onRowCount(1));
        results[k].errors = { ...(results[k].errors || {}), worker: why };
      }
      resolve();
    };
    let w;
    try { w = new Worker(__filename, { workerData: { __researchDatasetWorker: true, jobs: b.idx.map((k) => jobs[k]), shared } }); }
    catch (e) { fallback(String((e && e.message) || e)); return; }
    w.on("message", (m) => {
      if (!m) return;
      if (m.type === "progress") onRowCount(m.n);
      else if (m.type === "hash") hashes.add(m.h);
      else if (m.type === "result") { results[b.idx[m.j]] = m.result; got++; }
      else if (m.type === "done") { settled = true; resolve(); }
    });
    w.on("error", (e) => fallback(String((e && e.message) || e)));
    w.on("exit", (code) => { if (!settled) { if (got === b.idx.length) { settled = true; resolve(); } else fallback(`worker exit ${code}`); } });
  }));
  return Promise.all(tasks).then(() => results);
}

if (!isMainThread && workerData && workerData.__researchDatasetWorker) {
  const { jobs, shared } = workerData;
  const env = makeEnv(shared);
  const rel = loadRelative();
  parentPort.postMessage({ type: "hash", h: codeHash() });   // relative.js is loaded by now too
  let pending = 0;
  jobs.forEach((job, j) => {
    const result = computeAssetRows(job, env, rel, () => {
      if (++pending >= 25) { parentPort.postMessage({ type: "progress", n: pending }); pending = 0; }
    });
    if (pending) { parentPort.postMessage({ type: "progress", n: pending }); pending = 0; }
    parentPort.postMessage({ type: "result", j, result });
  });
  parentPort.postMessage({ type: "done" });
}

function defaultWorkers(nAssets) {
  const env = Number(process.env.RESEARCH_WORKERS);
  if (isNum(env) && env >= 1) return Math.floor(env);
  if (nAssets < 8) return 1;
  return Math.max(1, Math.min(4, (os.cpus() || []).length - 1));
}

// → { results, workers, hashes: Set of the code hashes that computed the rows }
async function execute(jobs, shared, opts, relMod, progress) {
  const injected = opts.relative && typeof opts.relative.signals === "function";
  const nW = Math.max(1, Math.min(jobs.length, Math.floor(isNum(opts.workers) ? opts.workers : defaultWorkers(jobs.length))));
  const hashes = new Set();
  if (!jobs.length) return { results: [], workers: 0, hashes };
  if (nW <= 1 || injected) {
    hashes.add(LOADED_HASH);
    // In-process (always when an analyzer is injected: functions cannot cross threads). Yields to
    // the event loop between assets so a caller's timers keep running.
    const env = makeEnv(shared);
    const out = [];
    for (const job of jobs) {
      out.push(computeAssetRows(job, env, relMod, () => progress(1)));
      await new Promise((r) => setImmediate(r));
    }
    return { results: out, workers: 1, hashes };
  }
  const results = await runJobsInWorkers(jobs, shared, nW, progress, hashes);
  return { results, workers: nW, hashes };
}

// ───────────────────────────── fetching ─────────────────────────────
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchCandles(assets, tf, limit, onProgress) {
  const data = require("../data");
  const out = {};
  let done = 0;
  await mapLimit(assets, 4, async (a) => {
    let cs = [];
    try { cs = await data.candles(a, tf, limit); } catch { cs = []; }
    out[a.id] = Array.isArray(cs) ? cs : [];
    done++;
    if (onProgress) onProgress({ phase: "fetch", done, total: assets.length, assetId: a.id });
  });
  return out;
}

/** Full FRED history (from `fromT`) for the macro series → { vix, dgs10, t10y2y, dxy, hyOas }. */
async function fetchMacroHistory(fromT = Date.now() - 12 * 365 * DAY) {
  const { get, text, limiters } = require("../data/http");
  const { parseFredCsv, SERIES } = require("../data/macro");
  const cosd = new Date(fromT).toISOString().slice(0, 10);
  const out = {};
  await Promise.all(Object.entries(SERIES).map(async ([k, id]) => {
    try {
      const csv = await get(text, `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`,
        { limiter: limiters.fred, retries: 2, headers: { "User-Agent": "decision-engine/1.0 (+research)" } });
      out[k] = parseFredCsv(csv);
    } catch { out[k] = []; }
  }));
  return out;
}

/** Full Crypto Fear & Greed history (alternative.me, limit=0) → [{t, v}] ascending. */
async function fetchFearGreedHistory() {
  const { get, api, limiters } = require("../data/http");
  const { parseFearGreed } = require("../data/crypto");
  try {
    const j = await get(api, "https://api.alternative.me/fng/?limit=0&format=json", { limiter: limiters.fng, retries: 2, timeout: 20000 });
    const p = parseFearGreed(j);
    return p && Array.isArray(p.history) ? p.history : [];
  } catch { return []; }
}

// ───────────────────────────── build ─────────────────────────────
function dropForming(cs, tf, now) {
  if (!cs.length) return cs;
  const last = cs[cs.length - 1];
  return last.t + tf * 1000 > now ? cs.slice(0, -1) : cs;
}

function familiesPlan(prep, hasRel) {
  const base = ["technical", "regime"];
  if (hasMacro(prep.macro)) base.push("macro");
  if (hasRel) base.push("relative");
  return { stock: base.slice(), crypto: prep.fng.pts.length ? [...base, "sentiment"] : base.slice() };
}

function sortRows(rows) {
  rows.sort((a, b) => a.t - b.t || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  return rows;
}

function collectSignalIds(rows) {
  const s = new Set();
  for (const r of rows) for (const id of Object.keys(r.sig || {})) s.add(id);
  return [...s].sort();
}

async function resolveInputs(opts, S, assets, cfg, progress, limitOverride) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  let candlesByAsset = opts.candlesByAsset;
  const tFetch0 = Date.now();
  if (!candlesByAsset) {
    const hz = horizonSpec(S.horizon, cfg);
    const limit = Math.max(300, Math.floor(limitOverride || (isNum(opts.limit) ? opts.limit : hz.history || 1000)));
    candlesByAsset = await fetchCandles(assets, S.tf, limit, progress);
  }
  const cb = {};
  for (const a of assets) {
    let cs = cleanCandles(candlesByAsset[a.id] || candlesByAsset[a.symbol] || []);
    if (opts.dropForming !== false) cs = dropForming(cs, S.tf, now);
    cb[a.id] = cs;
  }
  const t0 = Math.min(...Object.values(cb).filter((c) => c.length).map((c) => c[0].t), now);
  let macroHistory = opts.macroHistory;
  if (macroHistory === undefined) macroHistory = await fetchMacroHistory(t0 - 400 * DAY);
  let fng = opts.fearGreedHistory;
  if (fng === undefined) fng = assets.some((a) => a.assetClass === "crypto") ? await fetchFearGreedHistory() : [];
  return { candlesByAsset: cb, macro: prepMacro(macroHistory), fng: prepFng(fng), fetchMs: Date.now() - tFetch0 };
}

/**
 * buildDataset({ horizon, assets, candlesByAsset?, macroHistory?, fearGreedHistory?, stride=1,
 *                lookback, warmup=260, regimeEvery, limit, workers, relative, now,
 *                relativeInput="full"|"slice", dropForming=true, onProgress, cfg }) → Promise<Dataset>
 * Missing inputs are fetched (candles via server/data, FRED full history, alternative.me F&G).
 * Pass macroHistory/fearGreedHistory = null to skip those families. `relative`: module override,
 * or null to skip the family. onProgress({ phase, done, total, assetId? }).
 */
async function buildDataset(opts = {}) {
  const cfg = { ...baseCfg, ...(opts.cfg || {}) };
  const S = makeSettings(opts, cfg);
  const tStart = Date.now();
  let assets = (opts.assets && opts.assets.length ? opts.assets : RESEARCH_UNIVERSE).map(toAsset).filter(Boolean);
  if (!opts.assets && S.tf < 86400) assets = assets.filter((a) => a.assetClass === "crypto"); // no intraday stock history
  assets = uniq(assets.map((a) => a.id)).map((id) => assets.find((a) => a.id === id));
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  const inp = await resolveInputs(opts, S, assets, cfg, onProgress);
  const relMod = loadRelative(opts.relative);
  const data = prepAssetData(assets, inp.candlesByAsset);
  const plan = familiesPlan(inp, !!relMod);
  const extra = { expectedFamilies: plan, relative: !!relMod, override: {} };
  const jobs = [];
  for (const a of assets) {
    const d = data.get(a.id);
    if (d.candles.length < S.warmup + 1) continue;
    jobs.push(buildJob(S, cfg, a, data, extra));
  }
  const total = jobs.reduce((s, j) => s + Math.max(0, Math.ceil((j.kTo - j.kFrom + 1) / j.stride)), 0);
  let done = 0, lastEmit = 0;
  const progress = (k) => {
    done += k;
    if (onProgress && (done - lastEmit >= 50 || done >= total)) { lastEmit = done; onProgress({ phase: "compute", done, total }); }
  };
  const tCompute = Date.now();
  const { results, workers, hashes } = await execute(jobs, { series: sharedSeries(data), macro: inp.macro, fng: inp.fng }, opts, relMod, progress);
  const computeMs = Date.now() - tCompute;
  const usedHashes = [...hashes];

  const rows = [];
  const signalFamily = {};
  const errors = {};
  results.forEach((r) => {
    if (!r) return;
    for (const row of r.rows) rows.push(row);
    Object.assign(signalFamily, r.signalFamily);
    for (const [k, v] of Object.entries(r.errors || {})) errors[k] = typeof v === "number" ? (errors[k] || 0) + v : v;
  });
  sortRows(rows);
  const notes = [];
  if (!relMod) notes.push("relative family unavailable (server/analysis/relative.js missing or failed to load) — skipped");
  if (!hasMacro(inp.macro)) notes.push("no macro history — macro family skipped");
  if (assets.some((a) => a.assetClass === "crypto") && !inp.fng.pts.length) notes.push("no Fear & Greed history — sentiment family skipped");
  const short = assets.filter((a) => data.get(a.id).candles.length < S.warmup + 1).map((a) => a.id);
  if (short.length) notes.push(`not enough candles (< warmup+1) for: ${short.join(", ")}`);
  if (Object.keys(errors).length) notes.push(`analyzer errors: ${JSON.stringify(errors)}`);
  if (usedHashes.length > 1) notes.push(`MIXED CODE: analyzer/ensemble sources changed while the build ran (${usedHashes.join(", ")}) — rebuild`);

  return {
    version: VERSION, horizon: S.horizon, tf: S.tf, ahead: S.ahead, built: new Date().toISOString(),
    universe: assets.map((a) => a.id), benchmarks: { ...BENCHMARKS },
    signalIds: collectSignalIds(rows), signalFamily, rows,
    meta: {
      stride: S.stride, lookback: S.lookback, warmup: S.warmup, regimeEvery: S.regimeEvery,
      relativeInput: S.relativeInput,
      bracket: S.bracket, costsBps: { stock: roundTripCost(cfg, "stock") * 1e4, crypto: roundTripCost(cfg, "crypto") * 1e4 },
      families: plan, relative: !!relMod, codeHash: usedHashes.length === 1 ? usedHashes[0] : usedHashes.length ? `mixed:${usedHashes.join("+")}` : LOADED_HASH,
      candles: Object.fromEntries(assets.map((a) => { const c = data.get(a.id).candles; return [a.id, { n: c.length, from: c.length ? c[0].t : null, to: c.length ? c[c.length - 1].t : null }]; })),
      timing: { totalMs: Date.now() - tStart, fetchMs: inp.fetchMs, computeMs, workers, rows: rows.length },
      notes,
    },
  };
}

// ───────────────────────────── incremental update ─────────────────────────────
/**
 * updateDataset(ds, opts) → Promise<ds> (mutated in place and returned).
 * Computes only bars after each asset's last row (continuing its stride and absolute index) and
 * fills labels whose window has matured. Assets in opts.assets that are new to ds get a full
 * build. Inputs as in buildDataset (fetched if not injected; the fetch covers the gap + lookback).
 * ds.meta.lastUpdate = { newRows, maturedLabels, assets, ms }.
 */
async function updateDataset(ds, opts = {}) {
  if (!ds || !Array.isArray(ds.rows)) throw new Error("updateDataset: invalid dataset");
  const cfg = { ...baseCfg, ...(opts.cfg || {}) };
  const m = ds.meta || {};
  // The dataset's own settings win: changing lookback / stride / cadence mid-stream would make
  // new rows inconsistent with old ones.
  const pick = (k) => (m[k] != null ? m[k] : opts[k]);
  const S = makeSettings({ horizon: ds.horizon, lookback: pick("lookback"),
    warmup: pick("warmup"), stride: pick("stride"), regimeEvery: pick("regimeEvery"), relativeInput: pick("relativeInput") }, cfg);
  const tStart = Date.now();
  const assets = uniq([...(ds.universe || []), ...((opts.assets || []).map((a) => toAsset(a) && toAsset(a).id))].filter(Boolean)).map(toAsset);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  // Per-asset state from the existing rows.
  const byAsset = new Map();
  for (const r of ds.rows) {
    let e = byAsset.get(r.assetId);
    if (!e) byAsset.set(r.assetId, (e = { last: r, rows: [] }));
    e.rows.push(r);
    if (r.t > e.last.t) e.last = r;
  }
  const now = isNum(opts.now) ? opts.now : Date.now();
  let limit = null;
  if (!opts.candlesByAsset) {
    let oldest = now;
    for (const e of byAsset.values()) oldest = Math.min(oldest, e.last.t);
    for (const e of byAsset.values()) for (const r of e.rows) if (!r.lab) oldest = Math.min(oldest, r.t);
    const gapBars = Math.ceil((now - oldest) / (S.tf * 1000));
    const hz = horizonSpec(S.horizon, cfg);
    const fresh = assets.some((a) => !byAsset.has(a.id));
    limit = fresh ? Math.max(hz.history || 1000, S.lookback + gapBars + S.ahead + 60) : S.lookback + gapBars + S.ahead + 60;
  }
  const inp = await resolveInputs(opts, S, assets, cfg, onProgress, limit);
  const relMod = loadRelative(opts.relative);
  const data = prepAssetData(assets, inp.candlesByAsset);
  const plan = familiesPlan(inp, !!relMod);
  const extra = { expectedFamilies: plan, relative: !!relMod, override: {} };

  // 1) Mature labels of existing rows.
  let matured = 0;
  const shared = { series: sharedSeries(data), macro: inp.macro, fng: inp.fng };
  const env0 = makeEnv({ series: {}, macro: inp.macro, fng: inp.fng });
  for (const [id, d] of data) env0.series.set(id, d);
  for (const [id, e] of byAsset) {
    const d = data.get(id);
    if (!d || !d.candles.length) continue;
    const a = d.asset;
    const job = resolveJob(buildJob(S, cfg, a, data, extra), env0);
    for (const r of e.rows) {
      const needs = !r.lab || (r.lab.exRet == null && !job.isBenchmark);
      if (!needs) continue;
      const k = upperBound(d.times, r.t);
      if (k < 0 || d.times[k] !== r.t) continue;
      const atr = isNum(r.atrPct) && isNum(r.price) ? r.atrPct * r.price : null;   // ATR at bar i as built
      const lab = labelAt(job, k, atr);
      if (lab) { r.lab = lab; matured++; }
    }
  }

  // 2) New bars.
  const jobs = [];
  for (const a of assets) {
    const d = data.get(a.id);
    if (!d || d.candles.length < 2) continue;
    const e = byAsset.get(a.id);
    const job = buildJob(S, cfg, a, data, extra);
    if (!e) {                                                   // new asset → full history
      if (d.candles.length < S.warmup + 1) continue;
      jobs.push(job);
      continue;
    }
    const k = upperBound(d.times, e.last.t);
    if (k >= 0 && d.times[k] === e.last.t) {
      job.iOffset = e.last.i - k;
      job.kFrom = k + S.stride;
    } else {
      // The last row's bar is not in the fetched history (gap too large): continue after it.
      const k1 = k + 1;
      job.iOffset = e.last.i + S.stride - k1;
      job.kFrom = k1;
    }
    job.kTo = d.candles.length - 1;
    if (job.kFrom <= job.kTo) jobs.push(job);
  }
  const total = jobs.reduce((s, j) => s + Math.max(0, Math.ceil((j.kTo - j.kFrom + 1) / j.stride)), 0);
  let done = 0;
  const progress = (k) => { done += k; if (onProgress) onProgress({ phase: "compute", done, total }); };
  const { results, workers, hashes } = await execute(jobs, shared, opts, relMod, progress);
  let newRows = 0;
  ds.signalFamily = ds.signalFamily || {};
  for (const r of results) {
    if (!r) continue;
    for (const row of r.rows) { ds.rows.push(row); newRows++; }
    for (const [id, f] of Object.entries(r.signalFamily)) if (!ds.signalFamily[id]) ds.signalFamily[id] = f;
  }
  if (newRows) sortRows(ds.rows);
  ds.signalIds = collectSignalIds(ds.rows);
  ds.universe = uniq([...(ds.universe || []), ...assets.map((a) => a.id)]);
  ds.built = new Date().toISOString();
  // Code that computed the new rows (and matured labels, which use no analyzer code).
  const used = [...hashes];
  const hashNow = used.length === 1 ? used[0] : used.length ? `mixed:${used.join("+")}` : LOADED_HASH;
  const codeChanged = !!(m.codeHash && newRows > 0 && m.codeHash !== hashNow);
  const notes = Array.isArray(m.notes) ? m.notes.slice() : [];
  if (codeChanged) notes.push(`${new Date().toISOString()}: analyzer/ensemble code changed since the build (${m.codeHash} → ${hashNow}); rows before and after this update come from different code — a full rebuild is advised`);
  ds.meta = { ...m, families: plan, relative: !!relMod, notes,
    lastUpdate: { newRows, maturedLabels: matured, assets: jobs.length, ms: Date.now() - tStart, fetchMs: inp.fetchMs, workers, codeChanged, codeHash: hashNow } };
  return ds;
}

// ───────────────────────────── persistence ─────────────────────────────
const FORMAT = "research-dataset/compact-1";

function resolveFile(file, horizon) {
  const f = file || `${horizon || "dataset"}.json.gz`;
  return path.isAbsolute(f) || f.includes(path.sep) || f.includes("/") ? path.resolve(f) : path.join(DATA_DIR, f);
}
/** Default path for a horizon: data/research/<horizon>.json.gz */
const defaultFile = (horizon) => path.join(DATA_DIR, `${horizon}.json.gz`);

/**
 * saveDataset(ds, file?) → absolute path. Compact JSON (signals as a flat array aligned with
 * ds.signalIds), gzip when the name ends in .gz. Bare file names go under data/research/.
 */
function saveDataset(ds, file) {
  const out = resolveFile(file, ds.horizon);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ids = ds.signalIds && ds.signalIds.length ? ds.signalIds : collectSignalIds(ds.rows);
  const pos = new Map(ids.map((id, j) => [id, j]));
  const rows = ds.rows.map((r) => {
    const s = new Array(ids.length * 2).fill(null);
    for (const [id, v] of Object.entries(r.sig || {})) { const j = pos.get(id); if (j != null) { s[2 * j] = v[0]; s[2 * j + 1] = v[1]; } }
    const { sig, ...rest } = r;
    return { ...rest, s };
  });
  const body = JSON.stringify({ ...ds, format: FORMAT, signalIds: ids, rows });
  const buf = /\.gz$/i.test(out) ? zlib.gzipSync(body, { level: 6 }) : Buffer.from(body);
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, out);
  return out;
}

/** loadDataset(file) → Dataset (row.sig restored as { id: [score, conf] }). */
function loadDataset(file) {
  const p = resolveFile(file);
  let buf = fs.readFileSync(p);
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const ds = JSON.parse(buf.toString("utf8"));
  if (ds.format === FORMAT) {
    const ids = ds.signalIds || [];
    for (const r of ds.rows) {
      const sig = {};
      const s = r.s || [];
      for (let j = 0; j < ids.length; j++) if (s[2 * j] != null) sig[ids[j]] = [s[2 * j], s[2 * j + 1]];
      r.sig = sig;
      delete r.s;
    }
    delete ds.format;
  }
  return ds;
}

module.exports = {
  buildDataset, updateDataset, saveDataset, loadDataset, RESEARCH_UNIVERSE,
  researchUniverse, toAsset, tripleBarrier, cleanCandles, fetchMacroHistory, fetchFearGreedHistory,
  codeHash, defaultFile, DATA_DIR, BENCHMARKS, VERSION,
};
