// Polymarket integration — Gamma (daily-temperature event + bucket discovery) and
// CLOB (order books for the rungs we actually intend to buy).
//
// Shape of these markets: one EVENT per city+kind+date ("Highest temperature in Singapore
// on August 24?"), holding 11 mutually-exclusive Yes/No sub-markets — a bottom tail
// ("25°C or below"), nine single-degree buckets, and a top tail ("35°C or higher").
// negRisk is true, so the buckets really are exclusive and exhaustive: exactly the
// structure a ladder is built on.
const axios = require("axios");
const cfg = require("./config");

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

const ext = axios.create({
  timeout: 20000,
  headers: { Accept: "application/json", "User-Agent": "wxladder-bot/1.0" },
});

const parseJSON = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

const MONTHS = ["january", "february", "march", "april", "may", "june",
                "july", "august", "september", "october", "november", "december"];

// ── Pure parsers (unit-tested) ──────────────────────────────────

// "25°C or below" | "26°C" | "35°C or higher"  ->  { lo, hi, deg, kind, unit }
// Interior buckets are a single whole degree because the resolution source reports whole
// degrees; the tails are open-ended.
function parseBucketLabel(label) {
  if (!label) return null;
  const s = String(label).trim();
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([CF])?/i);
  if (!m) return null;
  const deg = parseFloat(m[1]);
  if (!isFinite(deg)) return null;
  const unit = (m[2] || "C").toUpperCase();
  const low = /or\s+(below|lower|less|under)/i.test(s);
  const high = /or\s+(higher|above|greater|more|over)/i.test(s);
  if (low)  return { lo: -Infinity, hi: deg, deg, type: "tail-low", unit, label: s };
  if (high) return { lo: deg, hi: Infinity, deg, type: "tail-high", unit, label: s };
  return { lo: deg, hi: deg, deg, type: "exact", unit, label: s };
}

// "Highest temperature in Singapore on August 24?" -> { kind:"high", city:"Singapore" }
function parseEventTitle(title) {
  const m = String(title || "").match(/^(Highest|Lowest)\s+temperature\s+in\s+(.+?)\s+on\s+/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase() === "lowest" ? "low" : "high", city: m[2].trim() };
}

// The market's calendar date. The slug carries an unambiguous year
// ("...-on-august-24-2026"), so prefer it; fall back to endDate's UTC date.
function parseEventDate(slug, endDate) {
  const m = String(slug || "").match(/-on-([a-z]+)-(\d{1,2})-(\d{4})$/i);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
  }
  return endDate ? new Date(endDate).toISOString().slice(0, 10) : null;
}

// Today's date in the station's own timezone — the market's day is a LOCAL day.
function localToday(tz, nowMs = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(nowMs));
}
const leadDays = (fromDate, toDate) =>
  Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);

// Per-market taker fee schedule. Live weather markets return
// {exponent:1, rate:0.05, takerOnly:true, rebateRate:0.25}; we take the schedule at face
// value and ignore the rebate (it is not guaranteed to a taker).
function feeParams(market) {
  if (cfg.USE_MARKET_FEE_SCHEDULE) {
    const fs = parseJSON(market && market.feeSchedule, null);
    if (fs && market.feesEnabled !== false && isFinite(Number(fs.rate))) {
      return { rate: Number(fs.rate), exp: Number(fs.exponent) || 1, source: "market" };
    }
    if (market && market.feesEnabled === false) return { rate: 0, exp: 1, source: "market-disabled" };
  }
  return { rate: cfg.FEE_RATE, exp: cfg.FEE_EXP, source: "config" };
}

// Map a Gamma event into a normalized ladder, or null if it is not a supported
// daily-temperature market. Buckets come back sorted coldest -> hottest.
function toLadder(event, universe = cfg.UNIVERSE) {
  const head = parseEventTitle(event && event.title);
  if (!head) return null;
  const station = universe[head.city];
  if (!station) return null;

  const date = parseEventDate(event.slug, event.endDate);
  if (!date) return null;

  const buckets = [];
  for (const m of (event.markets || [])) {
    if (m.active === false || m.archived === true) continue;
    const b = parseBucketLabel(m.groupItemTitle || m.question);
    if (!b) continue;
    const tokens = parseJSON(m.clobTokenIds, null);
    if (!Array.isArray(tokens) || tokens.length < 2) continue;
    const prices = parseJSON(m.outcomePrices, null);
    const outcomes = parseJSON(m.outcomes, ["Yes", "No"]);
    const yesIdx = Math.max(0, outcomes.findIndex(o => String(o).toLowerCase() === "yes"));
    const bid = m.bestBid != null ? Number(m.bestBid) : null;
    const ask = m.bestAsk != null ? Number(m.bestAsk) : null;
    buckets.push({
      ...b,
      threshold: m.groupItemThreshold != null ? Number(m.groupItemThreshold) : null,
      marketId: m.conditionId || m.id,
      yesToken: String(tokens[yesIdx]),
      noToken: String(tokens[1 - yesIdx]),
      lastPrice: Array.isArray(prices) ? Number(prices[yesIdx]) : null,
      bid: isFinite(bid) ? bid : null,
      ask: isFinite(ask) ? ask : null,
      tick: m.orderPriceMinTickSize != null ? Number(m.orderPriceMinTickSize) : 0.01,
      minShares: m.orderMinSize != null ? Number(m.orderMinSize) : cfg.MIN_ORDER_SHARES,
      acceptingOrders: m.acceptingOrders !== false,
      liquidity: m.liquidityNum != null ? Number(m.liquidityNum) : null,
      fee: feeParams(m),
    });
  }
  if (buckets.length < 3) return null;

  buckets.sort((a, b) => {
    if (a.threshold != null && b.threshold != null && a.threshold !== b.threshold) return a.threshold - b.threshold;
    return a.deg - b.deg;
  });

  return {
    eventId: String(event.id),
    slug: event.slug,
    title: event.title,
    city: head.city,
    kind: head.kind,
    station,
    date,
    endDate: event.endDate,
    negRisk: event.negRisk === true,
    unit: buckets[0].unit,
    buckets,
    // Sum of Yes prices across the ladder. Above 1.0 is the vig a basket buyer pays.
    overround: +buckets.reduce((s, b) => s + (b.ask ?? b.lastPrice ?? 0), 0).toFixed(4),
  };
}

// Keep only ladders inside the configured horizon and on supported stations.
function selectTradable(ladders, { nowMs = Date.now(), minLead = cfg.MIN_LEAD_DAYS,
                                   maxLead = cfg.MAX_LEAD_DAYS, kinds = cfg.KINDS,
                                   cities = cfg.CITY_KEYS } = {}) {
  const allowed = cities && cities.length ? new Set(cities) : null;
  const out = [];
  for (const l of ladders) {
    if (!kinds.includes(l.kind)) continue;
    if (allowed && !allowed.has(l.city)) continue;   // honour a narrowed CITIES universe
    const today = localToday(l.station.tz, nowMs);
    const lead = leadDays(today, l.date);
    if (lead < minLead || lead > maxLead) continue;
    out.push({ ...l, today, leadDays: lead, unsupported: !!l.station.unsupported });
  }
  return out.sort((a, b) => (a.date === b.date ? a.city.localeCompare(b.city) : a.date.localeCompare(b.date)));
}

// ── Network ─────────────────────────────────────────────────────

async function getLadders(nowMs = Date.now()) {
  // end_date_min drops the backlog of stale unresolved past events so the live ones are
  // not buried past the page cap.
  const minIso = new Date(nowMs - 6 * 3600 * 1000).toISOString();
  const all = [];
  for (let page = 0; page < 3; page++) {
    const { data } = await ext.get(`${GAMMA}/events?tag_slug=weather&active=true&closed=false` +
      `&limit=100&offset=${page * 100}&order=endDate&ascending=true&end_date_min=${encodeURIComponent(minIso)}`);
    const events = Array.isArray(data) ? data : (data.data || data.events || []);
    if (!events.length) break;
    all.push(...events);
    if (events.length < 100) break;
  }
  return all.map(e => toLadder(e)).filter(Boolean);
}

// Batch order books. CLOB returns them unordered, so key by asset_id.
async function getBooks(tokenIds) {
  if (!tokenIds.length) return {};
  const out = {};
  const CHUNK = 30;
  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    const chunk = tokenIds.slice(i, i + CHUNK);
    try {
      const { data } = await ext.post(`${CLOB}/books`, chunk.map(t => ({ token_id: t })));
      for (const b of (Array.isArray(data) ? data : [])) {
        const parsed = parseBook(b);
        if (parsed) out[String(b.asset_id)] = parsed;
      }
    } catch (e) { console.error(`[poly] books: ${e.message}`); }
  }
  return out;
}

// Normalize one CLOB book into top-of-book + depth within 3c of touch.
function parseBook(book) {
  if (!book) return null;
  const bids = (book.bids || []).map(l => ({ price: +l.price, size: +l.size })).filter(l => l.price > 0 && l.size > 0);
  const asks = (book.asks || []).map(l => ({ price: +l.price, size: +l.size })).filter(l => l.price > 0 && l.size > 0);
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;
  if (bid == null && ask == null) return null;
  // Dollars available to lift within 3c of the best ask (what we can actually buy).
  const askDepthUsd = ask == null ? 0
    : asks.filter(l => l.price - ask <= 0.03).reduce((s, l) => s + l.price * l.size, 0);
  const askDepthShares = ask == null ? 0
    : asks.filter(l => l.price - ask <= 0.03).reduce((s, l) => s + l.size, 0);
  return {
    bid, ask,
    mid: bid != null && ask != null ? +((bid + ask) / 2).toFixed(4) : (ask ?? bid),
    spreadC: bid != null && ask != null ? +((ask - bid) * 100).toFixed(2) : null,
    askDepthUsd: +askDepthUsd.toFixed(2),
    askDepthShares: +askDepthShares.toFixed(2),
    asks: asks.slice(0, 10),
  };
}

// Average fill price walking the ask side for `shares`. Returns null if the book is too
// thin to fill — a ladder rung that cannot be filled must not be counted as bought.
function walkAsks(asks, shares) {
  let need = shares, cost = 0;
  for (const lvl of asks || []) {
    if (need <= 0) break;
    const take = Math.min(need, lvl.size);
    cost += take * lvl.price;
    need -= take;
  }
  if (need > 1e-9) return null;
  return +(cost / shares).toFixed(4);
}

module.exports = {
  getLadders, getBooks, toLadder, selectTradable,
  parseBucketLabel, parseEventTitle, parseEventDate, localToday, leadDays,
  feeParams, parseBook, walkAsks, ext, GAMMA, CLOB,
};
