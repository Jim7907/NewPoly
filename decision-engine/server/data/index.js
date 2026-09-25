// Data-layer facade: one entry point for the engine, backtester and API.
// Every function accepts an asset object, an id ("CRYPTO:BTC" / "STOCK:AAPL") or a bare symbol
// (resolved against config; unknown tickers are treated as US stocks). Nothing here throws —
// failures come back as null / [] and are reported in gather().dataQuality.
//
// Cache TTLs: daily candles 10 min, hourly 60 s, sub-hourly 30 s; quote 15 s;
// fundamentals / news / social / macro / derivatives / fear-greed 15–30 min.
const cfg = require("../config");
const { cached, peek, put, timeout } = require("./http");
const crypto = require("./crypto");
const stocks = require("./stocks");
const newsP = require("./news");
const macroP = require("./macro");

const MIN = 60000;
const TF_NAMES = { 60: "1m", 300: "5m", 900: "15m", 1800: "30m", 3600: "1h", 14400: "4h", 21600: "6h", 86400: "1d", 604800: "1w" };
const tfName = tf => TF_NAMES[tf] || `${tf}s`;
const SLOW = Math.max(15 * MIN, Math.min(cfg.SLOW_REFRESH_MS || 30 * MIN, 60 * MIN));

function resolveAsset(a) {
  if (!a) return null;
  if (typeof a === "object") {
    if (a.assetClass) return a;
    if (a.symbol) return resolveAsset(`${a.assetClass === "crypto" ? "CRYPTO" : "STOCK"}:${a.symbol}`);
    return null;
  }
  const s = String(a).trim().toUpperCase();
  const found = cfg.ASSETS.find(x => x.id === s) || cfg.ASSETS.find(x => x.symbol === s);
  if (found) return found;
  const [cls, symRaw] = s.includes(":") ? s.split(":") : ["STOCK", s];
  const sym = symRaw.replace(/[^A-Z0-9.\-]/g, "");
  if (!sym) return null;
  if (cls === "CRYPTO") {
    const u = cfg.CRYPTO_UNIVERSE[sym];
    return u ? { ...u, assetClass: "crypto", id: `CRYPTO:${sym}` }
      : { symbol: sym, name: sym, assetClass: "crypto", id: `CRYPTO:${sym}`, coinbase: `${sym}-USD`, kraken: `${sym}USD`, okx: `${sym}-USDT-SWAP`, coingecko: null, llama: null };
  }
  return { symbol: sym, name: sym, assetClass: "stock", id: `STOCK:${sym}`, etf: stocks.KNOWN_ETFS.has(sym) };
}
const isCrypto = a => a && a.assetClass === "crypto";
const provider = a => (isCrypto(a) ? crypto : stocks);

function candleTtl(tfSec) { return tfSec >= 86400 ? 10 * MIN : tfSec >= 3600 ? MIN : 30000; }

async function candles(asset, tfSec = 86400, limit = 300) {
  const a = resolveAsset(asset);
  if (!a) return [];
  const k = `candles:${a.id}:${tfSec}`;
  try {
    // A fresh, longer history for the same (asset, tf) serves shorter requests without a refetch.
    const big = peek(k);
    if (big && big.limit >= limit && big.v.length) return big.v.slice(-limit);
    const v = await cached(`${k}:${limit}`, candleTtl(tfSec), () => provider(a).candles(a, tfSec, limit), { emptyTtlMs: 20000 });
    if (Array.isArray(v) && v.length && (!big || limit >= big.limit)) put(k, { limit, v }, candleTtl(tfSec));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

async function quote(asset) {
  const a = resolveAsset(asset);
  if (!a) return null;
  try { return await cached(`quote:${a.id}`, 15000, () => provider(a).quote(a), { emptyTtlMs: 10000 }); }
  catch { return null; }
}

async function fundamentals(asset) {
  const a = resolveAsset(asset);
  if (!a) return null;
  try { return await cached(`fund:${a.id}`, SLOW, () => provider(a).fundamentals(a), { emptyTtlMs: 5 * MIN }); }
  catch { return null; }
}

async function derivatives(asset) {
  const a = resolveAsset(asset);
  if (!isCrypto(a)) return null;
  try { return await cached(`deriv:${a.id}`, 15 * MIN, () => crypto.derivatives(a), { emptyTtlMs: 2 * MIN }); }
  catch { return null; }
}

async function news(asset) {
  const a = resolveAsset(asset);
  if (!a) return [];
  try { return await cached(`news:${a.id}`, 15 * MIN, () => newsP.headlines(a), { emptyTtlMs: 3 * MIN }); }
  catch { return []; }
}

async function social(asset) {
  const a = resolveAsset(asset);
  if (!a) return null;
  try { return await cached(`social:${a.id}`, 15 * MIN, () => newsP.social(a), { emptyTtlMs: 5 * MIN }); }
  catch { return null; }
}

async function macro() {
  try { return await cached("macro", SLOW, () => macroP.snapshot(), { emptyTtlMs: 5 * MIN }); }
  catch { return { vix: [], dgs10: [], t10y2y: [], dxy: [], hyOas: [] }; }
}

async function fearGreed() {
  try { return await cached("fng", SLOW, () => crypto.fearGreed(), { emptyTtlMs: 5 * MIN }); }
  catch { return null; }
}

async function microstructure(asset) {
  const a = resolveAsset(asset);
  if (!isCrypto(a)) return null;
  try { return await cached(`micro:${a.id}`, 3000, () => crypto.microstructure(a), { emptyTtlMs: 3000 }); }
  catch { return null; }
}

/** Start real-time streams (Coinbase WS for crypto; stocks are polled). onTick({symbol, assetId, price, ts}). */
function startStreams(assets, onTick) {
  const list = (assets || cfg.ASSETS).map(resolveAsset).filter(Boolean);
  try { return crypto.startStream(list.filter(isCrypto), onTick); }
  catch { return { stop() {} }; }
}

function live(asset) {
  const a = resolveAsset(asset);
  return isCrypto(a) ? crypto.live(a.symbol) : null;
}

function marketOpen(now = Date.now()) { return stocks.marketOpen(now); }

/** Wall-clock end of `ahead` bars of `tfSec` from `fromMs` (stocks: regular-session time only). */
function horizonEnd(asset, fromMs, ahead, tfSec) {
  const a = resolveAsset(asset);
  return stocks.horizonEndMs(a ? a.assetClass : "crypto", fromMs, ahead, tfSec);
}

/** Which timeframes gather() loads for a base tf. */
function timeframesFor(tfSec, assetClass) {
  if (tfSec >= 86400) return assetClass === "crypto" ? [900, 3600, tfSec] : [3600, tfSec];
  if (tfSec <= 900) return [tfSec, 3600, 86400];
  return [tfSec, 86400];
}

const SOURCE_TIMEOUT = 25000;
const settle = (p, ms = SOURCE_TIMEOUT) => timeout(Promise.resolve().then(() => p), ms);

/**
 * gather(asset, horizonCfg) — everything the analyzers need, fetched in parallel. Never throws.
 * horizonCfg: { tf, history } (cfg.HORIZONS[x]) or a horizon name.
 */
async function gather(asset, horizonCfg = cfg.HORIZONS[cfg.HORIZON]) {
  const empty = { candles: [], candlesByTf: {}, quote: null, fundamentals: null, derivatives: null, news: [], social: null,
    macro: null, fearGreed: null, microstructure: null, dataQuality: { freshnessSec: null, sources: {} } };
  try {
    const a = resolveAsset(asset);
    if (!a) return { ...empty, dataQuality: { freshnessSec: null, sources: { asset: "fail" } } };
    const h = typeof horizonCfg === "string" ? cfg.HORIZONS[horizonCfg] : horizonCfg || cfg.HORIZONS.swing;
    const tf = h.tf || 86400, history = h.history || 400;
    const crypt = isCrypto(a);
    const tfs = timeframesFor(tf, a.assetClass);
    // Full history for the base timeframe; ~300 bars for the auxiliary MTF timeframes.
    const limitFor = t => (t === tf ? history : 300);

    const jobs = {
      quote: quote(a),
      fundamentals: fundamentals(a),
      derivatives: crypt ? derivatives(a) : Promise.resolve(null),
      news: news(a),
      social: social(a),
      macro: macro(),
      fearGreed: crypt ? fearGreed() : Promise.resolve(null),
      microstructure: crypt ? microstructure(a) : Promise.resolve(null),
    };
    for (const t of tfs) jobs[`tf:${t}`] = candles(a, t, limitFor(t));
    const keys = Object.keys(jobs);
    // Long histories (e.g. 3,500 × 15m = 12 Coinbase pages) get more time; the fetch keeps
    // running past the timeout and lands in the cache for the next call.
    const res = await Promise.allSettled(keys.map(k => settle(jobs[k], k.startsWith("tf:") ? 60000 : SOURCE_TIMEOUT)));
    const val = Object.fromEntries(keys.map((k, i) => [k, res[i].status === "fulfilled" ? res[i].value : null]));

    const candlesByTf = {};
    for (const t of tfs) candlesByTf[tfName(t)] = Array.isArray(val[`tf:${t}`]) ? val[`tf:${t}`] : [];
    const base = candlesByTf[tfName(tf)];

    const ok = v => (v == null ? "fail" : Array.isArray(v) ? (v.length ? "ok" : "fail") : "ok");
    const macroOk = val.macro && Object.values(val.macro).some(s => Array.isArray(s) && s.length);
    const sources = {
      candles: ok(base),
      ...Object.fromEntries(tfs.filter(t => t !== tf).map(t => [`candles_${tfName(t)}`, ok(candlesByTf[tfName(t)])])),
      quote: ok(val.quote),
      fundamentals: !crypt && a.etf ? "n/a" : ok(val.fundamentals),
      derivatives: crypt ? ok(val.derivatives) : "n/a",
      news: ok(val.news),
      social: ok(val.social),
      macro: macroOk ? "ok" : "fail",
      fearGreed: crypt ? ok(val.fearGreed) : "n/a",
      microstructure: crypt ? ok(val.microstructure) : "n/a",
    };
    // Freshness = age of the newest price we have (live tick / quote / last bar close).
    const now = Date.now();
    const lv = crypt ? live(a) : null;
    const last = base.length ? base[base.length - 1] : null;
    const priceTs = Math.max(lv && !lv.stale ? lv.ts : 0, val.quote?.ts || 0, last ? Math.min(last.t + tf * 1000, now) : 0);
    const freshnessSec = priceTs ? Math.max(0, Math.round((now - priceTs) / 1000)) : null;

    return {
      asset: a,
      candles: base, candlesByTf,
      quote: val.quote || null,
      fundamentals: val.fundamentals || null,
      derivatives: val.derivatives || null,
      news: Array.isArray(val.news) ? val.news : [],
      social: val.social || null,
      macro: val.macro || null,
      fearGreed: val.fearGreed || null,
      microstructure: val.microstructure || null,
      dataQuality: {
        freshnessSec, marketOpen: crypt ? true : marketOpen(now), sources,
        coverage: Object.values(sources).filter(s => s !== "n/a").length
          ? Object.values(sources).filter(s => s === "ok").length / Object.values(sources).filter(s => s !== "n/a").length : 0,
      },
    };
  } catch {
    return { ...empty, dataQuality: { freshnessSec: null, sources: { gather: "fail" } } };
  }
}

module.exports = {
  candles, quote, fundamentals, derivatives, news, social, macro, fearGreed, microstructure,
  startStreams, live, marketOpen, horizonEnd, gather,
  resolveAsset, tfName, timeframesFor,
  providers: { crypto, stocks, news: newsP, macro: macroP },
};
