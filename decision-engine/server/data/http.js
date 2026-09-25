// Shared plumbing for every data provider:
//   • axios instances (JSON API, browser-like for Nasdaq, SEC with contact UA, plain text)
//   • token-bucket RateLimiter + named per-host limiters
//   • withRetry — exponential backoff on 429 / 5xx / timeouts / resets (honours Retry-After)
//   • cached(key, ttlMs, fn) — in-memory TTL cache with in-flight de-duplication and
//     stale-on-error (a failed refresh returns the last good value instead of nothing)
//   • small parsing helpers (toNum for "$1,234.50" / "0.32%" strings, candle aggregation)
const axios = require("axios");
const cfg = require("../config");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// JSON APIs (Coinbase, Kraken, OKX, CoinGecko, DefiLlama, alternative.me, StockTwits).
const api = axios.create({
  timeout: 10000,
  headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
});
// Nasdaq hangs without a browser UA + explicit JSON Accept; keep a hard 10s timeout.
const browser = axios.create({
  timeout: 10000,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": BROWSER_UA,
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  },
});
// SEC requires a descriptive UA with contact info; companyfacts can be several MB.
const sec = axios.create({
  timeout: 30000,
  maxContentLength: 80 * 1024 * 1024,
  headers: { Accept: "application/json", "User-Agent": cfg.SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" },
});
// Text payloads (RSS XML, FRED CSV).
const text = axios.create({
  timeout: 15000,
  responseType: "text",
  transformResponse: [d => d],
  headers: { Accept: "*/*", "User-Agent": BROWSER_UA },
});

// ── Token-bucket rate limiter (same shape as crypto15m/server/feeds.js) ──
class RateLimiter {
  constructor(ratePerSec, burst) { this.rate = ratePerSec; this.tokens = burst; this.burst = burst; this.last = Date.now(); }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / 1000 * this.rate);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await new Promise(r => setTimeout(r, Math.ceil((1 - this.tokens) / this.rate * 1000)));
    }
  }
}

// Conservative per-host budgets (public, keyless tiers).
const limiters = {
  coinbase:   new RateLimiter(6, 8),      // ~10/s public
  kraken:     new RateLimiter(0.8, 3),    // ~1/s public
  okx:        new RateLimiter(4, 6),      // 20 req / 2s per endpoint
  coingecko:  new RateLimiter(0.2, 3),    // free tier ~10-30/min
  llama:      new RateLimiter(1, 3),
  fng:        new RateLimiter(0.5, 2),
  nasdaq:     new RateLimiter(2, 4),
  yahoo:      new RateLimiter(0.3, 1),
  sec:        new RateLimiter(5, 5),      // SEC fair-access: <=10/s
  fred:       new RateLimiter(2, 5),
  google:     new RateLimiter(0.5, 3),
  stocktwits: new RateLimiter(0.3, 3),    // ~200/hour unauthenticated
};

// ── Retry with exponential backoff ──
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isRetryable(err) {
  const s = err?.response?.status;
  if (s === 429 || (s >= 500 && s < 600)) return true;
  if (s) return false;                                         // other HTTP errors are final
  const code = err?.code || "";
  return ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ERR_BAD_RESPONSE", "ECONNREFUSED"].includes(code)
    || /timeout|socket hang up/i.test(err?.message || "");
}
async function withRetry(fn, { retries = 2, baseMs = 600, maxMs = 8000, limiter = null } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      if (limiter) await limiter.acquire();
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const ra = Number(err?.response?.headers?.["retry-after"]);
      const backoff = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, maxMs)
        : Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt++;
      await sleep(backoff);
    }
  }
}

// GET helper: limiter + retry, returns response body.
async function get(client, url, { limiter, retries = 2, ...opts } = {}) {
  const res = await withRetry(() => client.get(url, opts), { retries, limiter });
  return res.data;
}

// ── TTL cache with in-flight de-dup and stale-on-error ──
const store = new Map();      // key -> { v, exp, at }
const inflight = new Map();   // key -> Promise
const isEmpty = v => v == null || (Array.isArray(v) && v.length === 0);

/**
 * cached(key, ttlMs, fn): returns fresh cached value, or runs fn() once for all concurrent
 * callers. Empty results (null / []) are cached for at most `emptyTtlMs` so a flaky source is
 * retried soon. If fn throws and a stale value exists it is returned; otherwise the error
 * propagates (providers catch and degrade to null/[]).
 */
async function cached(key, ttlMs, fn, { emptyTtlMs = 60000 } = {}) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.exp > now) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      if (isEmpty(v) && hit && !isEmpty(hit.v)) {                 // keep last good value
        hit.exp = Date.now() + Math.min(ttlMs, emptyTtlMs);
        return hit.v;
      }
      store.set(key, { v, at: Date.now(), exp: Date.now() + (isEmpty(v) ? Math.min(ttlMs, emptyTtlMs) : ttlMs) });
      return v;
    } catch (err) {
      if (hit) { hit.exp = Date.now() + Math.min(ttlMs, emptyTtlMs); return hit.v; }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
/** Fresh cached value or undefined (no fetch). */
function peek(key) { const h = store.get(key); return h && h.exp > Date.now() ? h.v : undefined; }
/** Store a value directly. */
function put(key, v, ttlMs) { store.set(key, { v, at: Date.now(), exp: Date.now() + ttlMs }); }
function cacheAge(key) { const h = store.get(key); return h ? Date.now() - h.at : null; }
function clearCache(prefix = "") { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); }

// Wrap a promise so a slow provider cannot stall the caller.
function timeout(p, ms, label = "timeout") {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} after ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

// ── Parsing helpers ──
/** "$1,234.50" -> 1234.5, "0.32%" -> 0.32, "N/A"/"" -> null. Numbers pass through. */
function toNum(x) {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = String(x).replace(/[$,%\s]/g, "").replace(/^\+/, "");
  if (s === "" || /^(n\/?a|na|--|-|null|undefined)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Aggregate ascending candles (or {t,price,size} points via mapper) into tfMs buckets. */
function aggregateCandles(candles, tfMs) {
  const out = [];
  let cur = null;
  for (const k of candles) {
    const b = Math.floor(k.t / tfMs) * tfMs;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || 0 };
    } else {
      if (k.h > cur.h) cur.h = k.h;
      if (k.l < cur.l) cur.l = k.l;
      cur.c = k.c;
      cur.v += k.v || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Ascending by t, one candle per t (last write wins), finite OHLC only. */
function cleanCandles(candles) {
  const m = new Map();
  for (const k of candles) {
    if (!k || ![k.t, k.o, k.h, k.l, k.c].every(Number.isFinite)) continue;
    m.set(k.t, { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: Number.isFinite(k.v) ? k.v : 0 });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

module.exports = {
  BROWSER_UA, api, browser, sec, text,
  RateLimiter, limiters, withRetry, isRetryable, get, sleep,
  cached, peek, put, cacheAge, clearCache, timeout,
  toNum, aggregateCandles, cleanCandles,
};
