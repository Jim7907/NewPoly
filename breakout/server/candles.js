// Market data. Coinbase Exchange OHLCV with pagination + caching, and a deterministic
// synthetic generator so the app (and the tests) work with no network at all.
//
// Coinbase returns at most 300 candles per request as [time, low, high, open, close, volume],
// newest first, and only for the granularities in config.TIMEFRAMES.

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const COINBASE = "https://api.exchange.coinbase.com";
const ext = axios.create({ timeout: 15000, headers: { Accept: "application/json", "User-Agent": "breakout-backtester/1.0" } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CACHE_DIR = cfg.CACHE_DIR ? path.resolve(cfg.CACHE_DIR) : path.join(__dirname, "../data");
const mem = new Map();                           // key -> { ts, bars }

const tfSeconds = (tf) => (cfg.TIMEFRAMES.find(t => t.id === tf) || {}).seconds;
const key = (symbol, tf) => `${symbol}:${tf}`;

function readDiskCache(k) {
  try {
    const f = path.join(CACHE_DIR, k.replace(/[^\w.-]/g, "_") + ".json");
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(raw.bars) ? raw : null;
  } catch { return null; }
}
function writeDiskCache(k, payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, k.replace(/[^\w.-]/g, "_") + ".json"), JSON.stringify(payload));
  } catch { /* cache is best-effort */ }
}

// One page of at most 300 candles ending at `endSec`.
async function fetchPage(symbol, granularity, startSec, endSec) {
  const url = `${COINBASE}/products/${symbol}/candles`
    + `?granularity=${granularity}`
    + `&start=${new Date(startSec * 1000).toISOString()}`
    + `&end=${new Date(endSec * 1000).toISOString()}`;
  const { data } = await ext.get(url);
  if (!Array.isArray(data)) return [];
  return data.map(c => ({ t: c[0], l: +c[1], h: +c[2], o: +c[3], c: +c[4], v: +c[5] }));
}

// Walk backwards from now until `limit` bars are collected.
async function fetchCoinbase(symbol, tf, limit) {
  const gran = tfSeconds(tf);
  if (!gran) throw new Error(`unsupported timeframe: ${tf}`);
  const perPage = 300;
  let end = Math.floor(Date.now() / 1000);
  const acc = new Map();

  for (let page = 0; page < Math.ceil(limit / perPage) + 1 && acc.size < limit; page++) {
    const start = end - perPage * gran;
    const rows = await fetchPage(symbol, gran, start, end);
    if (!rows.length) break;
    for (const r of rows) if (Number.isFinite(r.c)) acc.set(r.t, r);
    end = Math.min(...rows.map(r => r.t)) - gran;
    if (page > 0) await sleep(180);              // stay under Coinbase's public rate limit
  }

  const bars = [...acc.values()].sort((a, b) => a.t - b.t);
  // The most recent candle is still forming; an incomplete bar would fake breakouts.
  const nowBucket = Math.floor(Date.now() / 1000 / gran) * gran;
  return bars.filter(b => b.t < nowBucket).slice(-limit);
}

// ── Synthetic market ────────────────────────────────────────────
// Deterministic (seeded) regime-switching process: the walk alternates between low-volatility
// ranges and trending expansions, which is exactly the structure a breakout strategy trades.
// Used for offline demos and tests — never presented as real data.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthetic(symbol, tf, limit, seed = 42) {
  const gran = tfSeconds(tf) || 900;
  const rnd = mulberry32(seed + symbol.length * 7919);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const startT = Math.floor(Date.now() / 1000 / gran) * gran - limit * gran;
  let price = 100 + rnd() * 50;
  let regime = "range", regimeLeft = 30 + Math.floor(rnd() * 40), drift = 0;
  const baseVol = 0.004 * Math.sqrt(gran / 900);
  let vol = baseVol;
  const bars = [];

  for (let i = 0; i < limit; i++) {
    if (--regimeLeft <= 0) {
      regime = regime === "range" ? "trend" : "range";
      regimeLeft = regime === "range" ? 25 + Math.floor(rnd() * 45) : 15 + Math.floor(rnd() * 35);
      drift = regime === "trend" ? (rnd() < 0.5 ? -1 : 1) * baseVol * (0.6 + rnd() * 0.9) : 0;
    }
    vol = 0.9 * vol + 0.1 * (regime === "trend" ? baseVol * 1.6 : baseVol * 0.7);

    // Build the bar from 4 sub-steps so O/H/L/C are mutually consistent.
    const o = price;
    let hi = o, lo = o, last = o;
    for (let s = 0; s < 4; s++) {
      last = last * Math.exp(drift / 4 + vol * gauss() / 2);
      hi = Math.max(hi, last); lo = Math.min(lo, last);
    }
    price = last;
    const move = Math.abs(Math.log(price / o)) / (vol || 1e-9);
    const v = Math.max(1, (0.6 + rnd() * 0.8) * (regime === "trend" ? 2 : 1) * (1 + move) * 1000);
    bars.push({ t: startT + i * gran, o: +o.toFixed(4), h: +hi.toFixed(4), l: +lo.toFixed(4), c: +price.toFixed(4), v: +v.toFixed(2) });
  }
  return bars;
}

// Main entry: cached Coinbase data, falling back to synthetic when the network is unavailable.
async function getBars(symbol, tf, limit = 1500, opts = {}) {
  const lim = Math.min(Math.max(Number(limit) || 1500, 100), cfg.MAX_BARS);
  const k = key(symbol, tf);

  if (opts.source === "synthetic") {
    return { bars: synthetic(symbol, tf, lim, opts.seed ?? 42), source: "synthetic", cached: false };
  }

  const hit = mem.get(k) || readDiskCache(k);
  const fresh = hit && Date.now() - hit.ts < cfg.CACHE_TTL_MS && hit.bars.length >= lim;
  if (fresh && !opts.refresh) return { bars: hit.bars.slice(-lim), source: hit.source || "coinbase", cached: true };

  try {
    const bars = await fetchCoinbase(symbol, tf, lim);
    if (bars.length < 60) throw new Error(`only ${bars.length} bars returned`);
    const payload = { ts: Date.now(), bars, source: "coinbase" };
    mem.set(k, payload);
    writeDiskCache(k, payload);
    return { bars, source: "coinbase", cached: false };
  } catch (e) {
    if (hit) return { bars: hit.bars.slice(-lim), source: hit.source || "coinbase", cached: true, stale: true, error: e.message };
    if (!cfg.ALLOW_SYNTHETIC) throw e;
    return { bars: synthetic(symbol, tf, lim), source: "synthetic", cached: false, error: e.message };
  }
}

module.exports = { getBars, fetchCoinbase, synthetic, mulberry32, tfSeconds };
