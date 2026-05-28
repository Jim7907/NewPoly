// Market-data layer.
//   • Pyth Hermes  -> oracle-grade reference price + per-second EWMA volatility (PRIMARY,
//                     used for the lead L, window open/close snapshots, and resolution).
//   • Coinbase WS  -> trades (matches) + book (level2) for microstructure: TFI, CVD slope,
//                     momentum, VPIN, OBI (powers optional drift; VPIN gate always on).
//   • REST fallback (Coinbase ticker) if Pyth is unavailable.
// Designed so the lead-only core works on Pyth alone; Coinbase WS failure only disables drift.
const axios = require("axios");
const WebSocket = require("ws");
const cfg = require("./config");
const { ewmaVar, bookImbalance, tradeFlowImbalance } = require("./math");

const HERMES = "https://hermes.pyth.network";
const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const ext = axios.create({ timeout: 8000, headers: { Accept: "application/json", "User-Agent": "crypto15m-bot/1.0" } });

// ── Token-bucket rate limiter ───────────────────────────────────
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
const pythLimiter = new RateLimiter(0.8, 3);      // Hermes ~10/10s -> stay well under
const coinbaseRest = new RateLimiter(8, 10);      // Coinbase ~10/s

// ── Per-asset state ─────────────────────────────────────────────
const state = {};
for (const a of cfg.ASSETS) {
  state[a.symbol] = {
    ref: null, refTs: 0, varPerSec: 0, lastRet: 0, refSource: "none",
    prices: [],                          // {t, p} ring for momentum
    trades: [],                          // {t, side, size} ring for TFI/CVD/VPIN
    book: { bids: [], asks: [] },
    bookOk: false, wsStale: true,
  };
}

// ── Pyth reference + volatility ─────────────────────────────────
const idToSym = Object.fromEntries(cfg.ASSETS.map(a => [a.pyth.toLowerCase(), a.symbol]));

async function pollPyth() {
  await pythLimiter.acquire();
  const q = cfg.ASSETS.map(a => `ids[]=${a.pyth}`).join("&");
  const { data } = await ext.get(`${HERMES}/v2/updates/price/latest?${q}&parsed=true`);
  const now = Date.now();
  for (const p of (data.parsed || [])) {
    const sym = idToSym[String(p.id).toLowerCase()];
    if (!sym) continue;
    const price = Number(p.price.price) * Math.pow(10, p.price.expo);
    if (!(price > 0)) continue;
    updateRef(sym, price, now, "pyth");
  }
}

function updateRef(sym, price, now, source) {
  const s = state[sym];
  if (s.ref != null && s.refTs > 0) {
    const dt = Math.max((now - s.refTs) / 1000, 0.001);
    const ret = Math.log(price / s.ref);
    s.lastRet = ret;
    // EWMA variance of per-sample returns, normalized to per-second.
    const varSample = ewmaVar(s.varPerSec * dt, ret, 0.94);
    s.varPerSec = varSample / dt;
  }
  s.ref = price; s.refTs = now; s.refSource = source;
  s.prices.push({ t: now, p: price });
  if (s.prices.length > 600) s.prices.shift();
}

// REST fallback reference (Coinbase ticker) when Pyth is unreachable.
async function pollCoinbaseTickerFallback() {
  const now = Date.now();
  await Promise.all(cfg.ASSETS.map(async (a) => {
    const s = state[a.symbol];
    if (now - s.refTs < 8000) return;              // Pyth is fresh, skip
    try {
      await coinbaseRest.acquire();
      const { data } = await ext.get(`${COINBASE_REST}/products/${a.coinbase}/ticker`);
      const px = Number(data.price);
      if (px > 0) updateRef(a.symbol, px, now, "coinbase-rest");
    } catch { /* ignore */ }
  }));
}

// ── Coinbase WebSocket (trades + book) ──────────────────────────
let ws = null, wsBackoff = 1000;
function connectCoinbaseWS() {
  const products = cfg.ASSETS.map(a => a.coinbase);
  try { ws = new WebSocket(COINBASE_WS); } catch { return scheduleReconnect(); }

  ws.on("open", () => {
    wsBackoff = 1000;
    ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: products,
      channels: ["matches", { name: "level2_batch", product_ids: products }],
    }));
  });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const sym = cfg.ASSETS.find(a => a.coinbase === m.product_id)?.symbol;
    if (!sym) return;
    const s = state[sym];
    if (m.type === "match" || m.type === "last_match") {
      s.trades.push({ t: Date.parse(m.time) || Date.now(), side: m.side === "sell" ? "sell" : "buy", size: Number(m.size) || 0 });
      if (s.trades.length > 1000) s.trades.shift();
      s.wsStale = false;
    } else if (m.type === "snapshot") {
      s.book = {
        bids: (m.bids || []).slice(0, 25).map(l => ({ price: +l[0], size: +l[1] })),
        asks: (m.asks || []).slice(0, 25).map(l => ({ price: +l[0], size: +l[1] })),
      };
      s.bookOk = true; s.wsStale = false;
    } else if (m.type === "l2update") {
      applyL2(s, m.changes || []);
      s.wsStale = false;
    } else if (m.type === "error") {
      // level2 may require auth on some deployments — degrade to trades-only.
      s.bookOk = false;
    }
  });

  ws.on("close", scheduleReconnect);
  ws.on("error", () => { try { ws.close(); } catch {} });
}
function scheduleReconnect() {
  for (const sym of Object.keys(state)) state[sym].wsStale = true;
  wsBackoff = Math.min(wsBackoff * 2, 30000);
  setTimeout(connectCoinbaseWS, wsBackoff);
}
function applyL2(s, changes) {
  const side = (arr, price, size) => {
    const i = arr.findIndex(l => l.price === price);
    if (size === 0) { if (i >= 0) arr.splice(i, 1); return; }
    if (i >= 0) arr[i].size = size; else arr.push({ price, size });
  };
  for (const [dir, p, sz] of changes) {
    const price = +p, size = +sz;
    if (dir === "buy") side(s.book.bids, price, size); else side(s.book.asks, price, size);
  }
  s.book.bids.sort((a, b) => b.price - a.price); s.book.bids = s.book.bids.slice(0, 25);
  s.book.asks.sort((a, b) => a.price - b.price); s.book.asks = s.book.asks.slice(0, 25);
}

// ── Derived microstructure signals ──────────────────────────────
function micro(sym) {
  const s = state[sym];
  const now = Date.now();
  const recent = s.trades.filter(t => now - t.t <= 120000);   // last 2 min
  const tfi = tradeFlowImbalance(recent);

  // Depth-weighted OBI within ~15 bps of mid.
  let obi = 0;
  if (s.bookOk && s.book.bids.length && s.book.asks.length) {
    const mid = (s.book.bids[0].price + s.book.asks[0].price) / 2;
    const band = mid * 0.0015;
    const bids = s.book.bids.filter(l => mid - l.price <= band);
    const asks = s.book.asks.filter(l => l.price - mid <= band);
    obi = bookImbalance(bids, asks);
  }

  // CVD slope over the window (signed volume per second, normalized).
  let cvdSlope = 0;
  if (recent.length > 2) {
    const span = Math.max((recent[recent.length - 1].t - recent[0].t) / 1000, 1);
    const signed = recent.reduce((acc, t) => acc + (t.side === "buy" ? t.size : -t.size), 0);
    const vol = recent.reduce((acc, t) => acc + t.size, 0) || 1;
    cvdSlope = (signed / span) / (vol / span);            // == signed/vol, bounded [-1,1]
  }

  // VPIN: |buyVol - sellVol| / totalVol over recent trades (bulk approximation).
  const buy = recent.filter(t => t.side === "buy").reduce((a, t) => a + t.size, 0);
  const sell = recent.filter(t => t.side === "sell").reduce((a, t) => a + t.size, 0);
  const vpin = (buy + sell) > 0 ? Math.abs(buy - sell) / (buy + sell) : 0;

  // Momentum: EWMA-ish drift over last ~3 min, z-scored by sigma.
  let momZ = 0;
  const old = s.prices.find(p => now - p.t >= 180000);
  if (old && s.ref) {
    const ret = Math.log(s.ref / old.p);
    const sd = Math.sqrt(Math.max(s.varPerSec * 180, 1e-12));
    momZ = sd > 0 ? ret / sd : 0;
  }
  return { tfi, obi, cvdSlope, vpin, momZ, bookOk: s.bookOk, wsStale: s.wsStale };
}

// Reference snapshot for lead / open / close. {price, sigmaPerSec, ts, stale, source}
function getRef(sym) {
  const s = state[sym];
  return {
    price: s.ref,
    sigmaPerSec: Math.sqrt(Math.max(s.varPerSec, 0)),
    ts: s.refTs,
    stale: Date.now() - s.refTs > 15000 || s.ref == null,
    source: s.refSource,
  };
}

// One-shot reference fetch (used by engine resolution if a fresh snapshot is needed).
async function fetchRefNow(sym) {
  const a = cfg.ASSETS.find(x => x.symbol === sym);
  if (!a) return null;
  try {
    await pythLimiter.acquire();
    const { data } = await ext.get(`${HERMES}/v2/updates/price/latest?ids[]=${a.pyth}&parsed=true`);
    const p = (data.parsed || [])[0];
    if (p) return Number(p.price.price) * Math.pow(10, p.price.expo);
  } catch { /* ignore */ }
  return null;
}

// Historical reference price at a unix timestamp (seconds) — used for window resolution.
async function fetchRefAt(sym, unixSec) {
  const a = cfg.ASSETS.find(x => x.symbol === sym);
  if (!a) return null;
  try {
    await pythLimiter.acquire();
    const { data } = await ext.get(`${HERMES}/v2/updates/price/${unixSec}?ids[]=${a.pyth}&parsed=true`);
    const p = (data.parsed || [])[0];
    if (p) return Number(p.price.price) * Math.pow(10, p.price.expo);
  } catch { /* ignore */ }
  return null;
}

let timers = [];
function start() {
  const tick = async () => { try { await pollPyth(); } catch {} try { await pollCoinbaseTickerFallback(); } catch {} };
  tick();
  timers.push(setInterval(tick, 1500));
  connectCoinbaseWS();
}
function stop() { timers.forEach(clearInterval); timers = []; try { ws && ws.close(); } catch {} }

module.exports = { start, stop, getRef, micro, fetchRefNow, fetchRefAt, state, RateLimiter };
