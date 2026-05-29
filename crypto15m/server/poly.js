// Polymarket Gamma (market discovery) + CLOB (order book / price) integration.
const axios = require("axios");
const cfg = require("./config");

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

const ext = axios.create({
  timeout: 12000,
  headers: { Accept: "application/json", "User-Agent": "crypto15m-bot/1.0" },
});

const parseJSON = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

// ── Pure helpers (unit-tested) ──────────────────────────────────

// Given a list of {asset, endDateMs, ...} candidate windows and `nowMs`, pick the
// single live window per asset: the nearest FUTURE endDate within one window length.
function selectLiveWindows(candidates, nowMs, windowSec = cfg.WINDOW_SEC) {
  const horizon = windowSec * 1000;
  const best = {};
  for (const c of candidates) {
    const dt = c.endDateMs - nowMs;
    if (dt <= 0 || dt > horizon) continue;          // not currently open
    if (!best[c.asset] || c.endDateMs < best[c.asset].endDateMs) best[c.asset] = c;
  }
  return best;
}

// Map a Gamma event/market into a normalized candidate, or null if not a 15m up/down
// market for a configured asset.
function toCandidate(event) {
  const series = (event.series || [])[0];
  const slug = series && series.slug;
  if (!slug) return null;
  const asset = cfg.ASSETS.find(a => a.series === slug);
  if (!asset) return null;
  const market = (event.markets || [])[0] || event;
  const endDate = market.endDate || event.endDate;
  if (!endDate) return null;
  const tokens = parseJSON(market.clobTokenIds, null);
  if (!Array.isArray(tokens) || tokens.length < 2) return null;
  const endDateMs = Date.parse(endDate);
  return {
    asset: asset.symbol,
    name: asset.name,
    coinbase: asset.coinbase,
    pyth: asset.pyth,
    marketId: market.conditionId || market.id || event.id,
    question: market.question || event.title,
    endDate,
    endDateMs,
    windowOpenMs: endDateMs - cfg.WINDOW_SEC * 1000,
    upToken: String(tokens[0]),
    downToken: String(tokens[1]),
  };
}

// ── Network ─────────────────────────────────────────────────────

async function getLiveWindows(nowMs = Date.now()) {
  // end_date_min skips the large backlog of stale unresolved past windows so the
  // currently-open windows aren't buried beyond the 100-row page cap.
  const minIso = new Date(nowMs - 60000).toISOString();
  const { data } = await ext.get(
    `${GAMMA}/events?tag_slug=crypto&active=true&closed=false&limit=100&order=endDate&ascending=true&end_date_min=${encodeURIComponent(minIso)}`
  );
  const events = Array.isArray(data) ? data : (data.data || data.events || []);
  const candidates = events.map(toCandidate).filter(Boolean);
  return selectLiveWindows(candidates, nowMs);
}

// Fetch the Up-token book/price. Returns {mid, ask, bid, spreadC, depthBuyUsd, depthSellUsd} or null.
async function getPolyUp(market) {
  const tokenId = market.upToken;
  let book = null;
  try {
    const { data } = await ext.get(`${CLOB}/book?token_id=${tokenId}`);
    if (data && !data.error && (data.bids || data.asks)) book = data;
  } catch { /* fall through */ }

  if (book) {
    const bids = (book.bids || []).map(l => ({ price: +l.price, size: +l.size })).filter(l => l.price > 0);
    const asks = (book.asks || []).map(l => ({ price: +l.price, size: +l.size })).filter(l => l.price > 0);
    // CLOB returns bids ascending / asks descending depending on version — normalize.
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    if (bestBid != null && bestAsk != null) {
      const mid = (bestBid + bestAsk) / 2;
      const within = (arr, ref, dir) => arr.filter(l => dir * (l.price - ref) <= 0.03).reduce((s, l) => s + l.price * l.size, 0);
      return {
        mid, ask: bestAsk, bid: bestBid,
        spreadC: +((bestAsk - bestBid) * 100).toFixed(2),
        depthBuyUsd:  +within(asks, bestAsk, 1).toFixed(2),  // cost to buy Up (asks)
        depthSellUsd: +within(bids, bestBid, -1).toFixed(2),
        source: "clob-book",
      };
    }
  }

  // Fallback: midpoint endpoint, then Gamma outcomePrices.
  try {
    const { data } = await ext.get(`${CLOB}/midpoint?token_id=${tokenId}`);
    const m = parseFloat(data?.mid);
    if (!isNaN(m)) return { mid: m, ask: m, bid: m, spreadC: null, depthBuyUsd: 0, depthSellUsd: 0, source: "clob-mid" };
  } catch { /* ignore */ }
  return null;
}

module.exports = { getLiveWindows, getPolyUp, selectLiveWindows, toCandidate, ext, GAMMA, CLOB };
