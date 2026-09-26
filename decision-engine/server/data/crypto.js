// Crypto market data (§3.1).
//   • Candles  : Coinbase Exchange REST (paginated, 300/req) → fallback Kraken OHLC.
//   • Book/trades (REST) + Coinbase WS (ticker + matches) for live price and signed trade flow.
//   • Fundamentals: CoinGecko /coins/{id} + DefiLlama chain TVL.
//   • Derivatives : OKX public funding rate / history / open interest.
//   • Fear & Greed: alternative.me.
// Every exported fetcher degrades to null / [] — nothing here throws into the engine loop.
const WebSocket = require("ws");
const { api, get, limiters, toNum, aggregateCandles, cleanCandles, cached } = require("./http");

const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const KRAKEN = "https://api.kraken.com";
const OKX = "https://www.okx.com";
const COINGECKO = "https://api.coingecko.com/api/v3";
const LLAMA = "https://api.llama.fi";
const FNG = "https://api.alternative.me/fng/";

const COINBASE_GRANS = [60, 300, 900, 3600, 21600, 86400];
const KRAKEN_INTERVALS = [1, 5, 15, 30, 60, 240, 1440, 10080]; // minutes

// ── Pure parsers (exported for tests) ──────────────────────────
/** Coinbase: [[time(sec), low, high, open, close, volume], ...] newest-first → Candle[] asc. */
function normalizeCoinbaseCandles(rows) {
  if (!Array.isArray(rows)) return [];
  return cleanCandles(rows.filter(Array.isArray).map(r => ({
    t: Number(r[0]) * 1000, l: Number(r[1]), h: Number(r[2]), o: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
  })));
}

/** Kraken OHLC result: { PAIRNAME: [[time, o, h, l, c, vwap, vol, count]], last } → Candle[] asc. */
function normalizeKrakenOHLC(result) {
  if (!result || typeof result !== "object") return [];
  const key = Object.keys(result).find(k => k !== "last" && Array.isArray(result[k]));
  if (!key) return [];
  return cleanCandles(result[key].map(r => ({
    t: Number(r[0]) * 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]),
  })));
}

/**
 * Coinbase `side` on matches/trades is the MAKER side (verified live: side "buy" prints at the best
 * bid): "buy" = a resting bid was hit, i.e. the
 * aggressor SOLD. We store the aggressor side so buy = buying pressure.
 */
function aggressorSide(makerSide) { return makerSide === "buy" ? "sell" : "buy"; }

function normalizeTrades(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    t: Date.parse(r.time) || 0, side: aggressorSide(r.side), size: Number(r.size) || 0, price: Number(r.price) || 0,
  })).filter(x => x.t > 0 && x.price > 0).sort((a, b) => a.t - b.t);
}

function normalizeBook(data, depth = 50) {
  const lv = arr => (Array.isArray(arr) ? arr : []).slice(0, depth).map(l => [Number(l[0]), Number(l[1])])
    .filter(([p, s]) => p > 0 && s >= 0);
  const bids = lv(data?.bids), asks = lv(data?.asks);
  const mid = bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : null;
  return { bids, asks, mid };
}

function parseFearGreed(json) {
  const d = Array.isArray(json?.data) ? json.data : [];
  if (!d.length) return null;
  const history = d.map(x => ({ t: Number(x.timestamp) * 1000, v: Number(x.value) }))
    .filter(x => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  return { value: Number(d[0].value), classification: d[0].value_classification || null, ts: Number(d[0].timestamp) * 1000, history };
}

function parseCoinGecko(d, symbol, tvl = null) {
  if (!d || !d.market_data) return null;
  const m = d.market_data;
  const usd = o => toNum(o?.usd);
  return {
    symbol, asOf: new Date().toISOString(),
    price: usd(m.current_price), marketCap: usd(m.market_cap), fdv: usd(m.fully_diluted_valuation),
    volume24h: usd(m.total_volume),
    circulatingSupply: toNum(m.circulating_supply), totalSupply: toNum(m.total_supply), maxSupply: toNum(m.max_supply),
    ath: usd(m.ath), athChangePct: usd(m.ath_change_percentage),
    change7d: toNum(m.price_change_percentage_7d), change30d: toNum(m.price_change_percentage_30d),
    change1y: toNum(m.price_change_percentage_1y),
    tvl: toNum(tvl),
    devCommits4w: toNum(d.developer_data?.commit_count_4_weeks), devStars: toNum(d.developer_data?.stars),
    twitterFollowers: toNum(d.community_data?.twitter_followers),
    redditSubscribers: toNum(d.community_data?.reddit_subscribers),
    sentimentUpPct: toNum(d.sentiment_votes_up_percentage),
  };
}

function parseOkxDerivatives({ fr, frHist, oiNow, oiHist }) {
  const f0 = fr?.data?.[0];
  const fundingHistory = (frHist?.data || []).map(x => ({ t: Number(x.fundingTime), rate: toNum(x.realizedRate ?? x.fundingRate) }))
    .filter(x => Number.isFinite(x.t) && x.rate != null).sort((a, b) => a.t - b.t);
  // rubik open-interest-volume rows: [ts, oiUsd, volUsd]
  const oiHistory = (oiHist?.data || []).map(r => ({ t: Number(r[0]), oi: toNum(r[1]), vol: toNum(r[2]) }))
    .filter(x => Number.isFinite(x.t) && x.oi != null).sort((a, b) => a.t - b.t);
  const o0 = oiNow?.data?.[0];
  const premium = toNum(f0?.premium);
  const out = {
    fundingRate: toNum(f0?.fundingRate) ?? (fundingHistory.length ? fundingHistory[fundingHistory.length - 1].rate : null),
    nextFundingTime: toNum(f0?.nextFundingTime) ?? toNum(f0?.fundingTime),
    fundingHistory,
    openInterest: toNum(o0?.oiUsd) ?? (oiHistory.length ? oiHistory[oiHistory.length - 1].oi : null),
    openInterestCoins: toNum(o0?.oiCcy),
    oiHistory,
    basisBps: premium != null ? premium * 1e4 : null,     // perp premium index vs spot index
  };
  return out.fundingRate == null && out.openInterest == null && !fundingHistory.length && !oiHistory.length ? null : out;
}

// ── Candles ────────────────────────────────────────────────────
async function coinbaseCandles(product, gran, limit) {
  const out = [];
  let end = Math.floor(Date.now() / 1000);
  const maxPages = Math.ceil(limit / 300) + 1;
  for (let page = 0; page < maxPages && out.length < limit; page++) {
    const start = end - 300 * gran;
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${gran}` +
      `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    const rows = await get(api, url, { limiter: limiters.coinbase });
    const cs = normalizeCoinbaseCandles(rows);
    if (!cs.length) break;
    out.push(...cs);
    end = start - 1;
  }
  return cleanCandles(out).slice(-limit);
}

async function krakenCandles(pair, tfSec, limit) {
  const mins = tfSec / 60;
  const interval = [...KRAKEN_INTERVALS].reverse().find(i => i <= mins && mins % i === 0) || 1;
  const since = Math.floor(Date.now() / 1000) - Math.ceil(limit * (tfSec / (interval * 60))) * interval * 60;
  const data = await get(api, `${KRAKEN}/0/public/OHLC?pair=${pair}&interval=${interval}&since=${since}`, { limiter: limiters.kraken });
  if (data?.error?.length) throw new Error(`kraken: ${data.error.join(",")}`);
  let cs = normalizeKrakenOHLC(data?.result);
  if (interval * 60 !== tfSec) cs = aggregateCandles(cs, tfSec * 1000);
  return cs.slice(-limit);
}

/** candles(asset, tfSec, limit) → Candle[] (ascending; last bar may still be forming). */
async function candles(asset, tfSec = 86400, limit = 300) {
  try {
    if (COINBASE_GRANS.includes(tfSec)) return await coinbaseCandles(asset.coinbase, tfSec, limit);
    // Non-native tf (e.g. 4h = 14400): pull the largest native granularity that divides it.
    const base = [...COINBASE_GRANS].reverse().find(g => g < tfSec && tfSec % g === 0) || 60;
    const raw = await coinbaseCandles(asset.coinbase, base, Math.min(limit * (tfSec / base) + tfSec / base, 3000));
    const agg = aggregateCandles(raw, tfSec * 1000);
    if (agg.length) return agg.slice(-limit);
    throw new Error("no coinbase candles");
  } catch (e) {
    try { return asset.kraken ? await krakenCandles(asset.kraken, tfSec, limit) : []; }
    catch { return []; }
  }
}

// ── REST microstructure ────────────────────────────────────────
async function book(asset) {
  try {
    const data = await get(api, `${COINBASE_REST}/products/${asset.coinbase}/book?level=2`, { limiter: limiters.coinbase, retries: 1 });
    const b = normalizeBook(data, 50);
    return b.bids.length && b.asks.length ? b : null;
  } catch { return null; }
}

async function trades(asset, limit = 1000) {
  try {
    const rows = await get(api, `${COINBASE_REST}/products/${asset.coinbase}/trades?limit=${Math.min(limit, 1000)}`, { limiter: limiters.coinbase, retries: 1 });
    return normalizeTrades(rows);
  } catch { return []; }
}

/** 24h quote from Coinbase /stats (or the live WS price when fresh). */
async function quote(asset) {
  const lv = live(asset.symbol);
  try {
    const s = await get(api, `${COINBASE_REST}/products/${asset.coinbase}/stats`, { limiter: limiters.coinbase, retries: 1 });
    const last = toNum(s?.last), open = toNum(s?.open);
    const fresh = lv && Date.now() - lv.ts < 30000;
    const price = fresh ? lv.price : last;
    if (!(price > 0)) return null;
    return {
      price, ts: fresh ? lv.ts : Date.now(),
      change: open ? price - open : null, changePct: open ? (price / open - 1) * 100 : null,
      volume: toNum(s?.volume), high24h: toNum(s?.high), low24h: toNum(s?.low), marketStatus: "open",
    };
  } catch {
    return lv && lv.price ? { price: lv.price, ts: lv.ts, change: null, volume: null, marketStatus: "open" } : null;
  }
}

// ── Coinbase WebSocket: ticker + matches ───────────────────────
const liveState = {};   // symbol -> { price, ts, trades: [{t, side, size, price}] }
const TRADE_RING = 2000;
let ws = null, wsBackoff = 1000, wsStopped = false, wsProducts = [], wsOnTick = null, wsTimer = null;
const lastTickEmit = {};

function ensureLive(sym) { return (liveState[sym] ||= { price: null, ts: 0, trades: [], bookHistory: [], connected: false }); }
const BOOK_RING = 1200;
/** Append a top-of-book snapshot {t, bidPx, bidSz, askPx, askSz} (skips unchanged quotes). */
function pushTop(s, top) {
  if (!(top.bidPx > 0 && top.askPx > 0)) return;
  const h = s.bookHistory, last = h[h.length - 1];
  if (last && last.bidPx === top.bidPx && last.bidSz === top.bidSz && last.askPx === top.askPx && last.askSz === top.askSz) return;
  if (last && top.t < last.t) return;
  h.push(top);
  if (h.length > BOOK_RING) h.splice(0, h.length - BOOK_RING);
}

/** Subscribe Coinbase WS ticker+matches; onTick({symbol, assetId, price, ts}) at most 1/s per symbol. */
function startStream(assets, onTick) {
  const cryptos = (assets || []).filter(a => a && a.assetClass === "crypto" && a.coinbase);
  wsProducts = cryptos.map(a => ({ product: a.coinbase, symbol: a.symbol, id: a.id || `CRYPTO:${a.symbol}` }));
  wsOnTick = typeof onTick === "function" ? onTick : null;
  wsStopped = false;
  for (const a of cryptos) ensureLive(a.symbol);
  if (wsProducts.length) connect();
  return { stop: stopStream };
}

function stopStream() {
  wsStopped = true;
  clearTimeout(wsTimer);
  try { ws && ws.close(); } catch {}
  ws = null;
}

function connect() {
  if (wsStopped) return;
  const products = wsProducts.map(p => p.product);
  const bySymbol = Object.fromEntries(wsProducts.map(p => [p.product, p.symbol]));
  const idBySymbol = Object.fromEntries(wsProducts.map(p => [p.symbol, p.id]));
  let sock;
  try { sock = new WebSocket(COINBASE_WS); } catch { return scheduleReconnect(); }
  ws = sock;
  sock.on("open", () => {
    wsBackoff = 1000;
    sock.send(JSON.stringify({ type: "subscribe", product_ids: products, channels: ["ticker", "matches"] }));
    for (const s of Object.values(bySymbol)) ensureLive(s).connected = true;
  });
  sock.on("message", raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const sym = bySymbol[m.product_id];
    if (!sym) return;
    const s = ensureLive(sym);
    const t = Date.parse(m.time) || Date.now();
    if (m.type === "ticker") {
      // Ticker carries best bid/ask + sizes → top-of-book history for OFI.
      pushTop(s, { t, bidPx: Number(m.best_bid), bidSz: Number(m.best_bid_size), askPx: Number(m.best_ask), askSz: Number(m.best_ask_size) });
      const p = Number(m.price);
      if (p > 0) {
        s.price = p; s.ts = t;
        if (wsOnTick && t - (lastTickEmit[sym] || 0) >= 1000) {
          lastTickEmit[sym] = t;
          try { wsOnTick({ symbol: sym, assetId: idBySymbol[sym], price: p, ts: t }); } catch {}
        }
      }
    } else if (m.type === "match" || m.type === "last_match") {
      const p = Number(m.price);
      s.trades.push({ t, side: aggressorSide(m.side), size: Number(m.size) || 0, price: p });
      if (s.trades.length > TRADE_RING) s.trades.splice(0, s.trades.length - TRADE_RING);
      if (p > 0 && t >= s.ts) { s.price = p; s.ts = t; }
    }
  });
  sock.on("close", () => { if (ws === sock) scheduleReconnect(); });
  sock.on("error", () => { try { sock.close(); } catch {} });
}

function scheduleReconnect() {
  for (const s of Object.values(liveState)) s.connected = false;
  if (wsStopped) return;
  wsBackoff = Math.min(wsBackoff * 2, 30000);
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connect, wsBackoff);
  if (wsTimer.unref) wsTimer.unref();
}

/** live(symbol) → { price, ts, trades, stale } or null if never seen. */
function live(symbol) {
  const s = liveState[symbol];
  if (!s || !s.price) return null;
  return { price: s.price, ts: s.ts, trades: s.trades.slice(), bookHistory: s.bookHistory.slice(), stale: !s.connected || Date.now() - s.ts > 30000 };
}

/** { book, trades, mid } — REST book + WS trades when we have enough, else REST trades. */
async function microstructure(asset) {
  const lv = live(asset.symbol);
  const recentLive = lv && !lv.stale ? lv.trades.filter(t => Date.now() - t.t < 10 * 60000) : [];
  const [b, tr] = await Promise.all([book(asset), recentLive.length >= 50 ? recentLive : trades(asset)]);
  if (!b && !tr.length) return null;
  const st = ensureLive(asset.symbol);
  if (b && b.bids.length && b.asks.length) pushTop(st, { t: Date.now(), bidPx: b.bids[0][0], bidSz: b.bids[0][1], askPx: b.asks[0][0], askSz: b.asks[0][1] });
  const bookHistory = st.bookHistory.filter(x => Date.now() - x.t < 15 * 60000);
  const mid = b?.mid ?? lv?.price ?? (tr.length ? tr[tr.length - 1].price : null);
  // trades[].side is the TAKER (aggressor) side; bookHistory = recent top-of-book snapshots (WS ticker + REST polls).
  return { book: b ? { bids: b.bids, asks: b.asks } : { bids: [], asks: [] }, trades: tr, mid, bookHistory, source: recentLive.length >= 50 ? "ws" : "rest" };
}

// ── Fundamentals (CoinGecko + DefiLlama) ───────────────────────
async function llamaChains() {
  return cached("llama:chains", 30 * 60000, async () => {
    const d = await get(api, `${LLAMA}/v2/chains`, { limiter: limiters.llama });
    return Array.isArray(d) ? d : [];
  });
}

async function fundamentals(asset) {
  if (!asset.coingecko) return null;
  try {
    const url = `${COINGECKO}/coins/${asset.coingecko}?localization=false&tickers=false&market_data=true` +
      `&community_data=true&developer_data=true&sparkline=false`;
    const [cg, chains] = await Promise.all([
      get(api, url, { limiter: limiters.coingecko, retries: 2 }),
      asset.llama ? llamaChains().catch(() => []) : Promise.resolve([]),
    ]);
    const chain = asset.llama ? chains.find(c => c.name === asset.llama || c.gecko_id === asset.coingecko) : null;
    return parseCoinGecko(cg, asset.symbol, chain?.tvl ?? null);
  } catch { return null; }
}

// ── Derivatives (OKX public) ───────────────────────────────────
async function derivatives(asset) {
  const inst = asset.okx || `${asset.symbol}-USDT-SWAP`;
  const g = url => get(api, `${OKX}${url}`, { limiter: limiters.okx, retries: 1 }).catch(() => null);
  const [fr, frHist, oiNow, oiHist] = await Promise.all([
    g(`/api/v5/public/funding-rate?instId=${inst}`),
    g(`/api/v5/public/funding-rate-history?instId=${inst}&limit=100`),
    g(`/api/v5/public/open-interest?instType=SWAP&instId=${inst}`),
    g(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${asset.symbol}&period=1D`),
  ]);
  try { return parseOkxDerivatives({ fr, frHist, oiNow, oiHist }); } catch { return null; }
}

// ── Fear & Greed ───────────────────────────────────────────────
async function fearGreed() {
  try { return parseFearGreed(await get(api, `${FNG}?limit=30`, { limiter: limiters.fng })); }
  catch { return null; }
}

module.exports = {
  candles, book, trades, quote, microstructure, startStream, stopStream, live,
  fundamentals, derivatives, fearGreed,
  // pure parsers (tests)
  normalizeCoinbaseCandles, normalizeKrakenOHLC, normalizeTrades, normalizeBook, aggressorSide,
  parseFearGreed, parseCoinGecko, parseOkxDerivatives,
  COINBASE_GRANS,
};
