require("dotenv").config();
const db = require("./db");
const express   = require("express");
const cors      = require("cors");
const axios     = require("axios");
const rateLimit = require("express-rate-limit");
const cron      = require("node-cron");
const path      = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const http      = require("http");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/api/", rateLimit({ windowMs: 60000, max: 300 }));

const GAMMA   = "https://gamma-api.polymarket.com";
const CLOB    = "https://clob.polymarket.com";
const POLY_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const STATIONS = [
  // US Cities
  { city:"New York",     country:"US", stationId:"KLGA", stationName:"LaGuardia Airport",      lat:40.7769,  lon:-73.8740,  tz:"America/New_York",    unit:"F" },
  { city:"Miami",        country:"US", stationId:"KMIA", stationName:"Miami Intl Airport",      lat:25.7959,  lon:-80.2870,  tz:"America/New_York",    unit:"F" },
  { city:"Chicago",      country:"US", stationId:"KORD", stationName:"OHare Airport",           lat:41.9742,  lon:-87.9073,  tz:"America/Chicago",     unit:"F" },
  { city:"Los Angeles",  country:"US", stationId:"KLAX", stationName:"LAX Airport",             lat:33.9425,  lon:-118.4081, tz:"America/Los_Angeles", unit:"F" },
  { city:"Houston",      country:"US", stationId:"KIAH", stationName:"Houston Intercontinental", lat:29.9902,  lon:-95.3368,  tz:"America/Chicago",     unit:"F" },
  { city:"Dallas",       country:"US", stationId:"KDFW", stationName:"Dallas Fort Worth",       lat:32.8998,  lon:-97.0403,  tz:"America/Chicago",     unit:"F" },
  { city:"Phoenix",      country:"US", stationId:"KPHX", stationName:"Phoenix Sky Harbor",      lat:33.4373,  lon:-112.0078, tz:"America/Phoenix",     unit:"F" },
  { city:"Seattle",      country:"US", stationId:"KSEA", stationName:"Seattle Tacoma Airport",  lat:47.4502,  lon:-122.3088, tz:"America/Los_Angeles", unit:"F" },
  { city:"Atlanta",      country:"US", stationId:"KATL", stationName:"Hartsfield Atlanta",      lat:33.6407,  lon:-84.4277,  tz:"America/New_York",    unit:"F" },
  { city:"Boston",       country:"US", stationId:"KBOS", stationName:"Logan International",     lat:42.3656,  lon:-71.0096,  tz:"America/New_York",    unit:"F" },
  // Europe
  { city:"London",       country:"UK", stationId:"EGLC", stationName:"London City Airport",    lat:51.5048,  lon:0.0495,    tz:"Europe/London",       unit:"C" },
  { city:"Paris",        country:"FR", stationId:"LFPO", stationName:"Paris Orly Airport",      lat:48.7262,  lon:2.3652,    tz:"Europe/Paris",        unit:"C" },
  { city:"Berlin",       country:"DE", stationId:"EDDB", stationName:"Berlin Brandenburg",      lat:52.3667,  lon:13.5033,   tz:"Europe/Berlin",       unit:"C" },
  { city:"Amsterdam",    country:"NL", stationId:"EHAM", stationName:"Schiphol Airport",        lat:52.3105,  lon:4.7683,    tz:"Europe/Amsterdam",    unit:"C" },
  { city:"Madrid",       country:"ES", stationId:"LEMD", stationName:"Barajas Airport",         lat:40.4983,  lon:-3.5676,   tz:"Europe/Madrid",       unit:"C" },
  // Asia / Pacific
  { city:"Hong Kong",    country:"HK", stationId:"VHHH", stationName:"HK Intl Airport",        lat:22.3089,  lon:113.9149,  tz:"Asia/Hong_Kong",      unit:"C" },
  { city:"Tokyo",        country:"JP", stationId:"RJTT", stationName:"Tokyo Haneda Airport",    lat:35.5533,  lon:139.7811,  tz:"Asia/Tokyo",          unit:"C" },
  { city:"Singapore",    country:"SG", stationId:"WSSS", stationName:"Changi Airport",          lat:1.3644,   lon:103.9915,  tz:"Asia/Singapore",      unit:"C" },
  { city:"Sydney",       country:"AU", stationId:"YSSY", stationName:"Sydney Kingsford Smith",  lat:-33.9461, lon:151.1772,  tz:"Australia/Sydney",    unit:"C" },
  { city:"Dubai",        country:"AE", stationId:"OMDB", stationName:"Dubai International",     lat:25.2528,  lon:55.3644,   tz:"Asia/Dubai",          unit:"C" },
];

// Use Open-Meteo /v1/forecast — auto best-match model per location
// No models param needed — avoids 400 errors from invalid model names
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const CtoF  = (c) => +(c * 9/5 + 32).toFixed(1);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Single axios instance — all external calls go through here
const ext = axios.create({
  timeout: 20000,
  headers: {
    "Accept":     "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; polymarket-bot/1.0)",
  },
});

// ── Core logic functions (no HTTP round-trips) ────────────────

function calcSingleProbs(data, station) {
  const model = { heatBiasF: 0.0, precipBias: 0.0 }; // best_match needs no bias correction
  const d = data.daily, cur = data.current;
  let maxC = (d.temperature_2m_max[0] || 0) - (model.heatBiasF * 5/9);
  const maxF   = CtoF(maxC);
  const minC   = d.temperature_2m_min[0] || 0;
  const precMm = (d.precipitation_sum[0] || 0) * (1 - model.precipBias);
  const pPct   = clamp((d.precipitation_probability_max[0] || 0) / 100 * (1 - model.precipBias * 0.5), 0, 1);
  const snowMm = d.snowfall_sum[0] || 0;
  const wind   = d.wind_speed_10m_max[0] || 0;
  const wmo    = cur.weather_code || 0; // use current weather_code instead
  const hum    = cur.relative_humidity_2m || 0;
  const precIn = precMm * 0.03937;
  const hot = station.unit === "F"
    ? clamp(maxF>=90?0.88+(maxF-90)*0.015:maxF>=86?0.55+(maxF-86)*0.08:maxF>=80?0.20+(maxF-80)*0.06:0.04, 0.02, 0.97)
    : clamp(maxC>=32?0.88+(maxC-32)*0.02:maxC>=30?0.55+(maxC-30)*0.16:maxC>=27?0.20+(maxC-27)*0.11:0.04, 0.02, 0.97);
  const rain = clamp(pPct>0.7&&precIn>0.5?0.85+pPct*0.10:pPct>0.5&&precIn>0.2?0.65+pPct*0.15:pPct>0.3&&precIn>0.05?0.38+pPct*0.22:pPct>0.1?0.12+pPct*0.20:0.04, 0.03, 0.96);
  const snow = clamp(snowMm>10&&minC<0?0.92:snowMm>5&&minC<2?0.76:snowMm>1&&minC<4?0.55:snowMm>0&&minC<6?0.34:minC<0&&pPct>0.3?0.22:0.02, 0.01, 0.97);
  const storm = clamp(wmo>=95?0.82+(hum-60)*0.003:wmo>=80&&hum>75&&wind>30?0.48:hum>80&&wind>25&&pPct>0.5?0.32:hum>70&&wind>20?0.16:0.05, 0.02, 0.95);
  return { hot, rain, snow, storm, tempC:+(cur.temperature_2m).toFixed(1), maxC:+maxC.toFixed(1), maxF, precMm:+precMm.toFixed(1), precIn:+precIn.toFixed(3), hum, wind:+(cur.wind_speed_10m||0).toFixed(1) };
}

function buildEnsemble(results) {
  const keys = ["hot","rain","snow","storm"];
  const total = results.reduce((s,r) => s+r.model.weight, 0);
  const ens = {}, spread = {};
  keys.forEach(k => {
    const vals = results.map(r => r.probs[k]);
    ens[k] = results.reduce((s,r) => s+r.probs[k]*r.model.weight, 0) / total;
    const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
    spread[k] = +(Math.sqrt(vals.reduce((s,v)=>s+(v-mean)**2,0)/vals.length)*100).toFixed(1);
  });
  return { ens, spread };
}

// Fetch weather — single reliable call, Open-Meteo auto-selects best model
async function getEnsemble(station) {
  const daily   = "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max";
  const current = "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code";

  const url = `${FORECAST_URL}?latitude=${station.lat}&longitude=${station.lon}`
    + `&timezone=${encodeURIComponent(station.tz)}&forecast_days=3`
    + `&current=${current}&daily=${daily}`;

  const { data } = await ext.get(url);
  const probs = calcSingleProbs(data, station);

  return {
    ensemble:          probs,
    spread:            { hot:0, rain:0, snow:0, storm:0 },
    modelsOk:          1,
    failed:            [],
    currentConditions: probs,
    perModel:          [{ modelId:"best_match", name:"Open-Meteo Best Match", probs }],
  };
}

// Weather keywords that must appear in the market question
const WEATHER_KEYWORDS = ["temperature", "rain", "rainfall", "precipitation",
  "snow", "snowfall", "thunder", "storm", "humid", "wind", "weather", "forecast",
  "high temp", "low temp", "degrees", "celsius", "fahrenheit", "inches", "heat",
  "cold", "warm", "hot", "fog", "hail", "lightning", "freeze"];

// Fetch live Polymarket weather markets
// Tries multiple API patterns since tag_slug reliability varies
async function getMarkets() {
  let allMarkets = [];

  // Strategy 1: tag_slug=weather (original)
  try {
    const { data } = await ext.get(`${GAMMA}/markets?tag_slug=weather&active=true&limit=200&closed=false`);
    const m = Array.isArray(data) ? data : (data.data || data.markets || []);
    allMarkets.push(...m);
    console.log(`[markets] tag_slug=weather: ${m.length} results`);
  } catch(e) { console.warn("[markets] tag_slug failed:", e.message); }

  // Strategy 2: events endpoint with weather tag
  try {
    const { data } = await ext.get(`${GAMMA}/events?tag_slug=weather&active=true&limit=50&closed=false`);
    const events = Array.isArray(data) ? data : (data.data || data.events || []);
    const eventMarkets = events.flatMap(e => e.markets || []);
    allMarkets.push(...eventMarkets);
    console.log(`[markets] events tag_slug=weather: ${eventMarkets.length} results`);
  } catch(e) { console.warn("[markets] events failed:", e.message); }

  // Strategy 3: search by weather keywords directly
  try {
    const { data } = await ext.get(`${GAMMA}/markets?active=true&limit=200&closed=false&keyword=weather`);
    const m = Array.isArray(data) ? data : (data.data || data.markets || []);
    allMarkets.push(...m);
    console.log(`[markets] keyword=weather: ${m.length} results`);
  } catch(e) {}

  // Deduplicate by conditionId
  const seen = new Set();
  const deduped = allMarkets.filter(m => {
    const key = m.conditionId || m.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Filter to only actual weather content
  const weatherOnly = deduped.filter(m => {
    const q = (m.question || m.title || "").toLowerCase();
    return WEATHER_KEYWORDS.some(kw => q.includes(kw));
  });

  console.log(`[markets] Total weather markets after dedup+filter: ${weatherOnly.length}`);
  return weatherOnly;
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 2: NegRisk Rebalancing Arbitrage
// Scans multi-outcome markets where YES prices sum < $1.00
// Pure math — guaranteed profit if you can buy all outcomes
// ═══════════════════════════════════════════════════════════════
async function scanNegRisk(minEdgePct) {
  const opportunities = [];
  try {
    // Fetch multi-outcome markets (negRisk flag or multiple outcomes)
    const { data } = await ext.get(
      `${GAMMA}/markets?active=true&limit=200&closed=false&neg_risk=true`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    // Group by event/condition
    const byEvent = {};
    markets.forEach(m => {
      const key = m.conditionId || m.questionID || m.slug?.split('-').slice(0,-1).join('-');
      if (!key) return;
      if (!byEvent[key]) byEvent[key] = [];
      byEvent[key].push(m);
    });

    for (const [eventKey, mkts] of Object.entries(byEvent)) {
      if (mkts.length < 2) continue;
      // Get YES prices for all outcomes
      const prices = [];
      for (const m of mkts) {
        const p = m.outcomePrices
          ? parseFloat(typeof m.outcomePrices === 'string'
              ? JSON.parse(m.outcomePrices)[0]
              : m.outcomePrices[0])
          : null;
        if (p != null && !isNaN(p)) prices.push({ market: m, yesPrice: p });
      }
      if (prices.length < 2) continue;

      const totalCost = prices.reduce((s, p) => s + p.yesPrice, 0);
      const rawEdge   = (1 - totalCost) * 100;
      const fee       = 0.01 * prices.length; // ~1% per leg
      const netEdge   = rawEdge - fee * 100;

      if (netEdge > (minEdgePct || 0.5)) {
        opportunities.push({
          strategy:   "NegRisk Rebalancing",
          type:       "negrisk",
          question:   mkts[0]?.question?.slice(0, 80) || eventKey,
          outcomes:   prices.length,
          totalCost:  +totalCost.toFixed(4),
          rawEdge:    +rawEdge.toFixed(2),
          netEdge:    +netEdge.toFixed(2),
          direction:  "BUY ALL YES",
          isLive:     true,
          markets:    prices.map(p => ({ question: p.market.question, yesPrice: p.yesPrice })),
        });
      }
    }
  } catch(e) {
    console.warn("[negrisk]", e.message);
  }
  return opportunities;
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 3: Crypto Price Lag Arbitrage
// Compares Binance spot price against Polymarket crypto markets
// Polymarket updates lag real exchange prices by 30-120 seconds
// ═══════════════════════════════════════════════════════════════

// Free Binance public API — no key needed
const BINANCE_API = "https://api.binance.com/api/v3";

async function getBinancePrice(symbol) {
  try {
    const { data } = await ext.get(`${BINANCE_API}/ticker/price?symbol=${symbol}USDT`, { timeout: 3000 });
    return parseFloat(data.price);
  } catch(e) {
    // Try alternative endpoint
    try {
      const { data } = await ext.get(`${BINANCE_API}/ticker/24hr?symbol=${symbol}USDT`, { timeout: 3000 });
      return parseFloat(data.lastPrice);
    } catch(e2) { return null; }
  }
}

async function scanCryptoLag(minEdgePct) {
  const opportunities = [];
  const CRYPTO_TARGETS = [
    { symbol:"BTC", name:"Bitcoin",  keywords:["bitcoin","btc"] },
    { symbol:"ETH", name:"Ethereum", keywords:["ethereum","eth"] },
    { symbol:"SOL", name:"Solana",   keywords:["solana","sol"] },
  ];

  try {
    // Get Binance prices in parallel
    const spotPrices = {};
    await Promise.all(CRYPTO_TARGETS.map(async t => {
      const price = await getBinancePrice(t.symbol);
      if (price) spotPrices[t.symbol] = price;
    }));

    // Get Polymarket crypto price markets
    const { data } = await ext.get(
      `${GAMMA}/markets?tag_slug=crypto&active=true&limit=100&closed=false`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    for (const t of CRYPTO_TARGETS) {
      const spot = spotPrices[t.symbol];
      if (!spot) continue;

      // Find relevant Polymarket markets for this crypto
      const relevant = markets.filter(m => {
        const q = (m.question || "").toLowerCase();
        return t.keywords.some(k => q.includes(k)) &&
               (q.includes("above") || q.includes("below") || q.includes("price") || q.includes("reach"));
      });

      for (const mkt of relevant.slice(0, 5)) {
        // Extract the threshold price from the question
        // e.g. "Will BTC be above $95,000?" -> threshold = 95000
        const q = mkt.question || "";
        const priceMatch = q.match(/\$?([\d,]+(?:\.\d+)?)[kK]?/g);
        if (!priceMatch) continue;

        const threshold = parseFloat(priceMatch[priceMatch.length - 1].replace(/[$,]/g, "")) *
          (priceMatch[priceMatch.length - 1].toLowerCase().includes("k") ? 1000 : 1);
        if (!threshold || isNaN(threshold)) continue;

        const isAbove   = q.toLowerCase().includes("above") || q.toLowerCase().includes("over") || q.toLowerCase().includes("exceed");
        const isBelow   = q.toLowerCase().includes("below") || q.toLowerCase().includes("under");
        if (!isAbove && !isBelow) continue;

        // Get current Polymarket price
        const polyPrice = mkt.outcomePrices
          ? parseFloat(typeof mkt.outcomePrices === "string"
              ? JSON.parse(mkt.outcomePrices)[0]
              : mkt.outcomePrices[0])
          : null;
        if (!polyPrice || isNaN(polyPrice)) continue;

        // Simple model: if spot is clearly above/below threshold, market should reflect it
        // This is most useful for same-day resolution markets
        const endDate = new Date(mkt.endDate || mkt.end_date_iso);
        const hoursToResolution = (endDate - Date.now()) / 3600000;
        if (hoursToResolution > 24 || hoursToResolution < 0) continue; // Only same-day markets

        // How far from threshold as % of threshold
        const distancePct = Math.abs(spot - threshold) / threshold * 100;
        let modelProb;

        if (isAbove) {
          // Spot is above threshold — high probability of YES
          modelProb = spot > threshold
            ? Math.min(0.95, 0.5 + distancePct * 3) // Scale confidence with distance
            : Math.max(0.05, 0.5 - distancePct * 3);
        } else {
          // Spot is below threshold
          modelProb = spot < threshold
            ? Math.min(0.95, 0.5 + distancePct * 3)
            : Math.max(0.05, 0.5 - distancePct * 3);
        }

        const rawEdge = (modelProb - polyPrice) * 100;
        const netEdge = rawEdge - 1.25; // 1.25% fee

        if (Math.abs(netEdge) > (minEdgePct || 1.5) && distancePct > 1) {
          opportunities.push({
            strategy:   "Crypto Price Lag",
            type:       "crypto",
            question:   q.slice(0, 80),
            symbol:     t.symbol,
            spotPrice:  spot,
            threshold,
            hoursToResolution: +hoursToResolution.toFixed(1),
            distancePct: +distancePct.toFixed(2),
            modelProb:  +modelProb.toFixed(3),
            polyProb:   +polyPrice.toFixed(3),
            rawEdge:    +rawEdge.toFixed(2),
            netEdge:    +netEdge.toFixed(2),
            direction:  netEdge > 0 ? "BUY YES" : "BUY NO",
            isLive:     true,
          });
        }
      }
    }
  } catch(e) {
    console.warn("[crypto-lag]", e.message);
  }
  return opportunities;
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 4: Combinatorial Arbitrage
// Finds logically related markets where implied probabilities
// violate logical constraints (e.g. P(A) > P(B) when A implies B)
// ═══════════════════════════════════════════════════════════════
async function scanCombinatorial(minEdgePct) {
  const opportunities = [];
  try {
    const { data } = await ext.get(
      `${GAMMA}/markets?active=true&limit=300&closed=false&min_volume=1000`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    // Get prices for all
    const withPrices = markets.map(m => {
      const p = m.outcomePrices
        ? parseFloat(typeof m.outcomePrices === "string"
            ? JSON.parse(m.outcomePrices)[0]
            : m.outcomePrices[0])
        : null;
      return { ...m, yesPrice: (p && !isNaN(p)) ? p : null };
    }).filter(m => m.yesPrice != null);

    // Look for logical violations between related markets
    // Strategy: find markets about same topic where P(specific) > P(general)
    // e.g. "Will Bitcoin hit $150k" > "Will Bitcoin hit $120k" is impossible
    const PATTERNS = [
      { topic:"bitcoin|btc",   type:"price_level" },
      { topic:"ethereum|eth",  type:"price_level" },
      { topic:"fed|federal reserve|interest rate", type:"rate_level" },
      { topic:"inflation|cpi", type:"rate_level" },
    ];

    for (const pattern of PATTERNS) {
      const regex = new RegExp(pattern.topic, "i");
      const group = withPrices.filter(m => regex.test(m.question || ""));
      if (group.length < 2) continue;

      // For price-level markets, higher threshold = lower probability
      // Find pairs where this is violated
      for (let i = 0; i < group.length; i++) {
        for (let j = i+1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const qa = (a.question || "").toLowerCase();
          const qb = (b.question || "").toLowerCase();

          // Extract thresholds
          const matchA = qa.match(/\$?([\d,]+)k?/);
          const matchB = qb.match(/\$?([\d,]+)k?/);
          if (!matchA || !matchB) continue;

          const threshA = parseFloat(matchA[1].replace(",","")) * (qa.includes("k") ? 1000 : 1);
          const threshB = parseFloat(matchB[1].replace(",","")) * (qb.includes("k") ? 1000 : 1);

          // Both must be "above" type for price comparison to be meaningful
          if (!qa.includes("above") || !qb.includes("above")) continue;
          if (threshA === threshB) continue;

          // Higher threshold should have LOWER probability
          // If higher threshold has HIGHER price → arbitrage
          const [lo, hi] = threshA < threshB ? [a, b] : [b, a];
          const priceDiff = hi.yesPrice - lo.yesPrice;

          if (priceDiff > 0.03) { // Higher threshold priced higher — logical violation
            const netEdge = priceDiff * 100 - 2.5; // 2 legs × 1.25% fee
            if (netEdge > (minEdgePct || 1.0)) {
              opportunities.push({
                strategy:  "Combinatorial Arbitrage",
                type:      "combinatorial",
                question:  `${hi.question?.slice(0,50)} vs ${lo.question?.slice(0,50)}`,
                action:    `BUY NO on "${hi.question?.slice(0,40)}" + BUY YES on "${lo.question?.slice(0,40)}"`,
                priceDiff: +priceDiff.toFixed(3),
                netEdge:   +netEdge.toFixed(2),
                isLive:    true,
                marketA:   { question: hi.question, yesPrice: hi.yesPrice },
                marketB:   { question: lo.question, yesPrice: lo.yesPrice },
              });
            }
          }
        }
      }
    }
  } catch(e) {
    console.warn("[combinatorial]", e.message);
  }
  return opportunities;
}


// Fetch live YES price from CLOB
async function getPrice(tokenId) {
  try {
    const { data } = await ext.get(`${CLOB}/price?token_id=${tokenId}&side=BUY`);
    const p = parseFloat(data.price);
    return isNaN(p) ? null : p;
  } catch(e) {
    return null;
  }
}

// Get price — try CLOB first, fall back to Gamma outcomePrices
async function getPriceWithFallback(market) {
  // Try CLOB token ID
  const tokenId = market.clobTokenIds?.[0] || market.tokens?.[0]?.token_id;
  if (tokenId) {
    const clobPrice = await getPrice(tokenId);
    if (clobPrice != null) return { price: clobPrice, source: "clob" };
  }
  // Fall back to Gamma outcomePrices (YES = index 0)
  if (market.outcomePrices) {
    try {
      const prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
      const p = parseFloat(prices[0]);
      if (!isNaN(p)) return { price: p, source: "gamma" };
    } catch(e) {}
  }
  return null;
}

// Full scan for one station — pure function
async function scanStation(station, minEdge) {
  // 1. Get weather ensemble
  const ensData = await getEnsemble(station);

  // 2. Get live markets
  const allMarkets = await getMarkets();
  const city = station.city.toLowerCase();
  // Build multiple search terms for each city
  const cityAliases = {
    "new york":    ["new york", "nyc", "jfk", "laguardia", "klga"],
    "los angeles": ["los angeles", "l.a.", "lax", "klax"],
    "hong kong":   ["hong kong", "hk", "vhhh"],
    "chicago":     ["chicago", "kord", "o'hare", "ohare"],
  };
  const aliases = cityAliases[city] || [city, station.stationId.toLowerCase()];

  const markets = allMarkets.filter(m => {
    const q = (m.question||m.title||"").toLowerCase();
    return aliases.some(a => q.includes(a));
  }).slice(0, 8);

  console.log(`[scan] ${station.stationId}: ${allMarkets.length} total weather markets, ${markets.length} matched for ${station.city}`);

  // 3. Fetch live prices — try CLOB then fall back to Gamma outcomePrices
  const priceMap = {};
  const priceSourceMap = {};
  await Promise.all(markets.map(async m => {
    const result = await getPriceWithFallback(m);
    if (result) {
      const key = m.conditionId || m.id;
      priceMap[key]       = result.price;
      priceSourceMap[key] = result.source;
    }
  }));

  // 4. Compute opportunities
  const OKEYS = [
    { key:"hot",   label:"HOT (>90F/32C)", fee:0.0125 },
    { key:"rain",  label:"RAIN (>0.5in)",  fee:0.0125 },
    { key:"snow",  label:"SNOW",           fee:0.0125 },
    { key:"storm", label:"STORM",          fee:0.0125 },
  ];

  // Detect if a Polymarket question's YES means the event HAPPENED
  // e.g. "Will it rain?" YES=rain happened  → modelProb(rain) vs polyProb(YES)
  // e.g. "Will temp be ≤14C?" YES=cold/NOT hot → modelProb(NOT hot) vs polyProb(YES)
  function detectYesDirection(question, outcomeKey) {
    const q = (question || "").toLowerCase();
    // "or below", "or lower", "at most", "below", "under" → YES means NOT the event
    const yesIsCold = /or below|or lower|at most|below|under|at or below/.test(q);
    // "or above", "or higher", "at least", "above", "exceed" → YES means event happened
    const yesIsHot  = /or above|or higher|at least|above|exceed|at or above|over/.test(q);
    if (outcomeKey === "hot") {
      if (yesIsCold) return "inverted";  // YES = cold = our model prob should be inverted
      if (yesIsHot)  return "normal";    // YES = hot  = matches our model directly
    }
    if (outcomeKey === "rain") {
      if (/will it rain|will there be rain|rain.*yes|precipitation.*occur/.test(q)) return "normal";
      if (/no rain|dry|without rain/.test(q)) return "inverted";
    }
    // Default: assume YES = event happened = normal direction
    return "normal";
  }

  const opportunities = [];
  OKEYS.forEach(o => {
    const prob = ensData.ensemble[o.key];
    const sp   = ensData.spread[o.key];
    const mkt  = markets.find(m => {
      const q = (m.question||"").toLowerCase();
      return (o.key==="hot"&&(q.includes("temperature")||q.includes("temp")||q.includes("degrees")||q.includes("celsius")||q.includes("fahrenheit")))
          || (o.key==="rain"&&(q.includes("rain")||q.includes("precipitation")||q.includes("rainfall")))
          || (o.key==="snow"&&(q.includes("snow")||q.includes("snowfall")))
          || (o.key==="storm"&&(q.includes("thunder")||q.includes("storm")||q.includes("lightning")));
    });
    const mktId    = mkt ? (mkt.conditionId||mkt.id) : null;
    const polyProb = mktId ? priceMap[mktId] : null;
    if (polyProb == null) return;

    // Determine if market YES aligns with our model probability
    const direction = detectYesDirection(mkt?.question, o.key);
    const modelAligned = direction === "inverted" ? (1 - prob) : prob;

    const raw = (modelAligned - polyProb) * 100;
    const net = raw - o.fee * 100;
    if (Math.abs(net) > minEdge && sp < 15) {
      opportunities.push({
        outcome: o.label, key: o.key,
        modelProb: +prob.toFixed(3),
        modelAligned: +modelAligned.toFixed(3),
        polyProb: +polyProb.toFixed(3),
        rawEdge: +raw.toFixed(2), netEdge: +net.toFixed(2),
        spread: sp, direction: net > 0 ? "BUY YES" : "BUY NO",
        yesDirection: direction,
        marketId: mktId, question: mkt?.question, isLive: true,
      });
    }
  });

  return {
    station,
    ensemble:   ensData.ensemble,
    spread:     ensData.spread,
    modelsOk:   ensData.modelsOk,
    conditions: ensData.currentConditions,
    markets,
    liveMarkets: markets.length,
    opportunities,
    fetchTime: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 2: Economics / Fed / CPI Markets
// These resolve against official data releases (BLS, Fed) with
// zero ambiguity. Thin retail attention = regular mispricings.
// FEE: 1.25% — same as weather
// ═══════════════════════════════════════════════════════════════
async function scanEconomics() {
  const opps = [];
  try {
    const { data } = await ext.get(
      `${GAMMA}/markets?tag_slug=economics&active=true&limit=100&closed=false`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    // Economic data we can model with public sources
    const ECO_KEYWORDS = [
      { keys:["cpi","inflation","consumer price"],   type:"cpi" },
      { keys:["unemployment","jobs","nonfarm","payroll"], type:"jobs" },
      { keys:["fed","federal reserve","interest rate","rate cut","rate hike"], type:"fed" },
      { keys:["gdp","recession"],                    type:"gdp" },
    ];

    for (const m of markets) {
      const q = (m.question || "").toLowerCase();
      const matched = ECO_KEYWORDS.find(e => e.keys.some(k => q.includes(k)));
      if (!matched) continue;

      const price = m.outcomePrices
        ? parseFloat(typeof m.outcomePrices === "string"
            ? JSON.parse(m.outcomePrices)[0]
            : m.outcomePrices[0])
        : null;
      if (!price || isNaN(price)) continue;

      const vol = parseFloat(m.volume || m.volumeNum || 0);

      // Flag low-volume economics markets (under $50k) — these are the ones
      // with thin liquidity where retail mispricings persist longest
      if (vol < 50000 && vol > 500) {
        opps.push({
          strategy:  "Economics / Macro",
          type:      "economics",
          tag:       matched.type,
          question:  (m.question || "").slice(0, 100),
          yesPrice:  +price.toFixed(3),
          noPrice:   +(1 - price).toFixed(3),
          volume:    vol,
          fee:       0.0125,
          note:      "Low-volume market — check if price matches recent data release",
          conditionId: m.conditionId || m.id,
          endDate:   m.endDate || m.end_date_iso,
        });
      }
    }
  } catch(e) {
    console.warn("[economics]", e.message);
  }
  return opps.slice(0, 20);
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 3: Geopolitics (0% FEE — best category for arb)
// Only category with zero taker fees. Any edge is pure profit.
// Resolves against verifiable real-world events.
// ═══════════════════════════════════════════════════════════════
async function scanGeopolitics() {
  const opps = [];
  try {
    const { data } = await ext.get(
      `${GAMMA}/markets?tag_slug=geopolitics&active=true&limit=100&closed=false`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    for (const m of markets) {
      const price = m.outcomePrices
        ? parseFloat(typeof m.outcomePrices === "string"
            ? JSON.parse(m.outcomePrices)[0]
            : m.outcomePrices[0])
        : null;
      if (!price || isNaN(price)) continue;

      const vol = parseFloat(m.volume || m.volumeNum || 0);
      const endDate = m.endDate ? new Date(m.endDate) : null;
      const daysLeft = endDate ? (endDate - Date.now()) / 86400000 : 999;

      // Near-certain markets (price > 0.88 or < 0.12) resolving soon = high edge
      // 0% fee means any mispricing is pure profit
      const isCertain = price > 0.88 || price < 0.12;
      const isResolving = daysLeft < 7 && daysLeft > 0;

      if (isCertain && isResolving && vol > 1000) {
        const direction = price > 0.88 ? "BUY YES" : "BUY NO";
        const edgePrice = price > 0.88 ? price : (1 - price);
        const netEdge   = (1 - edgePrice) * 100; // 0% fee

        opps.push({
          strategy:  "Geopolitics (0% fee)",
          type:      "geopolitics",
          question:  (m.question || "").slice(0, 100),
          yesPrice:  +price.toFixed(3),
          direction,
          daysLeft:  +daysLeft.toFixed(1),
          netEdge:   +netEdge.toFixed(2),
          volume:    vol,
          fee:       0,
          note:      "ZERO FEE — full edge kept. Verify resolution criteria before trading.",
          conditionId: m.conditionId || m.id,
        });
      }
    }
  } catch(e) {
    console.warn("[geopolitics]", e.message);
  }
  return opps.slice(0, 20);
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 4: NegRisk Rebalancing
// Multi-outcome markets where YES prices sum < $1.00
// Guaranteed profit if you buy all outcomes.
// ═══════════════════════════════════════════════════════════════
async function scanNegRisk() {
  const opps = [];
  try {
    const { data } = await ext.get(
      `${GAMMA}/markets?active=true&limit=200&closed=false&neg_risk=true`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    // Group by condition/event
    const byCondition = {};
    for (const m of markets) {
      const key = m.conditionId || m.questionID || m.groupItemTitle;
      if (!key) continue;
      if (!byCondition[key]) byCondition[key] = [];
      byCondition[key].push(m);
    }

    for (const [key, group] of Object.entries(byCondition)) {
      if (group.length < 3) continue; // Need 3+ outcomes for meaningful negrisk

      const prices = [];
      for (const m of group) {
        const raw = m.outcomePrices;
        if (!raw) continue;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const p = parseFloat(parsed[0]);
        if (!isNaN(p)) prices.push({ question: m.question, yesPrice: p, id: m.conditionId || m.id });
      }
      if (prices.length < 3) continue;

      const total  = prices.reduce((s, p) => s + p.yesPrice, 0);
      const rawEdge = (1 - total) * 100;
      // No fee on the guaranteed leg since one always resolves YES
      const netEdge = rawEdge - 0.5; // small slippage buffer

      if (netEdge > 0.5) {
        opps.push({
          strategy:  "NegRisk Rebalancing",
          type:      "negrisk",
          question:  (group[0]?.question || key).slice(0, 80),
          outcomes:  prices.length,
          totalCost: +total.toFixed(4),
          payout:    1.0,
          rawEdge:   +rawEdge.toFixed(2),
          netEdge:   +netEdge.toFixed(2),
          direction: "BUY ALL YES",
          fee:       0,
          note:      "Buy YES on all " + prices.length + " outcomes at combined cost $" + total.toFixed(3) + " — one will pay $1.00",
          markets:   prices,
        });
      }
    }
  } catch(e) {
    console.warn("[negrisk]", e.message);
  }
  return opps.slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 5: Crypto Price Lag (Binance vs Polymarket same-day)
// Binance public API — no key needed. Exploits 30-120s lag.
// FEE: 1.80% — highest, so need 3%+ raw edge
// ═══════════════════════════════════════════════════════════════
async function scanCryptoLag() {
  const opps = [];
  const PAIRS = [
    { symbol:"BTC", name:"Bitcoin",  keywords:["bitcoin","btc"] },
    { symbol:"ETH", name:"Ethereum", keywords:["ethereum","eth"] },
    { symbol:"SOL", name:"Solana",   keywords:["solana","sol"] },
    { symbol:"XRP", name:"XRP",      keywords:["xrp","ripple"] },
  ];

  try {
    // Fetch spot prices from Binance
    const spotPrices = {};
    await Promise.all(PAIRS.map(async p => {
      try {
        const { data } = await ext.get(
          `https://api.binance.com/api/v3/ticker/price?symbol=${p.symbol}USDT`,
          { timeout: 4000 }
        );
        spotPrices[p.symbol] = parseFloat(data.price);
      } catch(e) {}
    }));

    if (Object.keys(spotPrices).length === 0) return opps;

    // Fetch Polymarket crypto markets
    const { data } = await ext.get(
      `${GAMMA}/markets?tag_slug=crypto&active=true&limit=100&closed=false`
    );
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);

    for (const pair of PAIRS) {
      const spot = spotPrices[pair.symbol];
      if (!spot) continue;

      const relevant = markets.filter(m => {
        const q = (m.question || "").toLowerCase();
        return pair.keywords.some(k => q.includes(k)) &&
               (q.includes("above") || q.includes("below") || q.includes("reach") || q.includes("hit") || q.includes("exceed"));
      });

      for (const mkt of relevant.slice(0, 8)) {
        const q = mkt.question || "";
        // Extract numeric threshold from question
        const nums = q.match(/[\d,]+\.?\d*/g);
        if (!nums) continue;
        const candidates = nums.map(n => parseFloat(n.replace(/,/g, ""))).filter(n => n > 100);
        if (!candidates.length) continue;
        const threshold = candidates[candidates.length - 1];

        const isAbove = /above|over|exceed|higher|more than/i.test(q);
        const isBelow = /below|under|lower|less than/i.test(q);
        if (!isAbove && !isBelow) continue;

        const endDate = mkt.endDate ? new Date(mkt.endDate) : null;
        const hoursLeft = endDate ? (endDate - Date.now()) / 3600000 : 999;
        if (hoursLeft < 0 || hoursLeft > 48) continue; // Only short-dated markets

        const polyPrice = mkt.outcomePrices
          ? parseFloat(typeof mkt.outcomePrices === "string"
              ? JSON.parse(mkt.outcomePrices)[0]
              : mkt.outcomePrices[0])
          : null;
        if (!polyPrice || isNaN(polyPrice)) continue;

        // Distance from threshold as fraction
        const distFrac = (spot - threshold) / threshold;

        // Estimate model probability based on how far spot is from threshold
        let modelProb;
        if (isAbove) {
          if (distFrac > 0.05) modelProb = 0.92;       // 5%+ above threshold
          else if (distFrac > 0.02) modelProb = 0.80;
          else if (distFrac > 0) modelProb = 0.65;
          else if (distFrac > -0.02) modelProb = 0.35;
          else if (distFrac > -0.05) modelProb = 0.20;
          else modelProb = 0.08;
        } else {
          if (distFrac < -0.05) modelProb = 0.92;
          else if (distFrac < -0.02) modelProb = 0.80;
          else if (distFrac < 0) modelProb = 0.65;
          else if (distFrac < 0.02) modelProb = 0.35;
          else if (distFrac < 0.05) modelProb = 0.20;
          else modelProb = 0.08;
        }

        const rawEdge = (modelProb - polyPrice) * 100;
        const netEdge = rawEdge - 1.80; // crypto fee is 1.80%

        if (Math.abs(netEdge) > 3.0) { // Higher threshold for crypto due to higher fee
          opps.push({
            strategy:    "Crypto Price Lag",
            type:        "crypto",
            question:    q.slice(0, 100),
            symbol:      pair.symbol,
            spotPrice:   spot,
            threshold,
            distancePct: +(distFrac * 100).toFixed(2),
            hoursLeft:   +hoursLeft.toFixed(1),
            modelProb:   +modelProb.toFixed(3),
            polyProb:    +polyPrice.toFixed(3),
            rawEdge:     +rawEdge.toFixed(2),
            netEdge:     +netEdge.toFixed(2),
            direction:   netEdge > 0 ? "BUY YES" : "BUY NO",
            fee:         0.018,
            note:        pair.symbol + " spot $" + spot.toLocaleString() + " vs threshold $" + threshold.toLocaleString() + " (" + (distFrac*100).toFixed(1) + "% " + (distFrac>0?"above":"below") + ")",
          });
        }
      }
    }
  } catch(e) {
    console.warn("[crypto-lag]", e.message);
  }
  return opps;
}

// Run all strategies and combine results
async function runAllStrategies() {
  const [eco, geo, neg, crypto] = await Promise.allSettled([
    scanEconomics(),
    scanGeopolitics(),
    scanNegRisk(),
    scanCryptoLag(),
  ]);
  return {
    economics:   eco.status === "fulfilled"   ? eco.value   : [],
    geopolitics: geo.status === "fulfilled"   ? geo.value   : [],
    negrisk:     neg.status === "fulfilled"   ? neg.value   : [],
    crypto:      crypto.status === "fulfilled"? crypto.value: [],
    all: [
      ...(eco.status === "fulfilled" ? eco.value : []),
      ...(geo.status === "fulfilled" ? geo.value : []),
      ...(neg.status === "fulfilled" ? neg.value : []),
      ...(crypto.status === "fulfilled" ? crypto.value : []),
    ],
  };
}

// ── WebSocket relay ───────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();
const subIds  = new Set();
let polyWs = null;

function connectPolyWS() {
  try {
    polyWs = new WebSocket(POLY_WS);
    polyWs.on("open",    () => { console.log("[WS] Polymarket connected"); if(subIds.size>0) polyWs.send(JSON.stringify({type:"subscribe",market_ids:[...subIds]})); });
    polyWs.on("message", (d) => clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(d.toString()); }));
    polyWs.on("close",   () => { console.log("[WS] Reconnecting..."); setTimeout(connectPolyWS,5000); });
    polyWs.on("error",   (e) => console.error("[WS]",e.message));
  } catch(e) { setTimeout(connectPolyWS, 10000); }
}

wss.on("connection", ws => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", msg => {
    try {
      const d = JSON.parse(msg);
      if(d.type==="subscribe" && Array.isArray(d.market_ids)) {
        d.market_ids.forEach(id => subIds.add(id));
        if(polyWs?.readyState===WebSocket.OPEN) polyWs.send(msg.toString());
      }
    } catch(e) {}
  });
});

// ── HTTP Routes ───────────────────────────────────────────────

app.get("/api/health", (req,res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  wsClients: clients.size,
  polyWsConnected: polyWs?.readyState === WebSocket.OPEN,
  ts: new Date().toISOString(),
}));

// Connectivity test — tests each external API directly
app.get("/api/test", async (req,res) => {
  const tests = [
    { name:"open-meteo", url:"https://api.open-meteo.com/v1/forecast?latitude=40.77&longitude=-73.87&current=temperature_2m&timezone=auto&forecast_days=1" },
    { name:"gamma-api",  url:"https://gamma-api.polymarket.com/markets?limit=1&active=true" },
    { name:"clob-api",   url:"https://clob.polymarket.com/markets?limit=1" },
  ];
  const results = {};
  for (const t of tests) {
    try {
      const r = await ext.get(t.url, { timeout: 8000 });
      results[t.name] = { ok:true, status:r.status, ms: Date.now() };
    } catch(e) {
      results[t.name] = { ok:false, error:e.message, code:e.code, status:e.response?.status };
    }
  }
  const allOk = Object.values(results).every(r => r.ok);
  console.log("[test]", JSON.stringify(results));
  res.status(allOk?200:502).json({ allOk, results, ts:new Date().toISOString() });
});

app.get("/api/stations", (req,res) => res.json(STATIONS));

app.get("/api/ensemble/:stationId", async (req,res) => {
  const st = STATIONS.find(s => s.stationId===req.params.stationId);
  if(!st) return res.status(404).json({error:"Station not found"});
  try {
    const data = await getEnsemble(st);
    res.json({ station:st, ...data, fetchTime:new Date().toISOString() });
  } catch(e) {
    console.error("[ensemble]", st.stationId, e.message);
    res.status(502).json({ error:e.message, code:e.code, station:st });
  }
});

app.get("/api/polymarket/markets", async (req,res) => {
  const markets = await getMarkets();
  res.json({ markets, count:markets.length, fetchTime:new Date().toISOString() });
});

app.get("/api/polymarket/price/:tokenId", async (req,res) => {
  const price = await getPrice(req.params.tokenId);
  if (price == null) return res.status(502).json({error:"Price unavailable"});
  res.json({ tokenId:req.params.tokenId, price });
});

app.get("/api/scan/:stationId", async (req,res) => {
  const st = STATIONS.find(s => s.stationId===req.params.stationId);
  if(!st) return res.status(404).json({error:"Station not found"});
  try {
    const data = await scanStation(st, parseFloat(req.query.minEdge)||1.5);
    res.json(data);
  } catch(e) {
    console.error("[scan]", st.stationId, e.message);
    res.status(502).json({ error:e.message, code:e.code, station:st });
  }
});

// Multi-strategy scan — all strategies in parallel
app.get("/api/scan-multi", async (req,res) => {
  const minEdge = parseFloat(req.query.minEdge)||1.0;
  try {
    const [negrisk, crypto, combo] = await Promise.all([
      scanNegRisk(minEdge),
      scanCryptoLag(minEdge),
      scanCombinatorial(minEdge),
    ]);
    const all = [...negrisk, ...crypto, ...combo];
    console.log(`[multi-scan] NegRisk:${negrisk.length} Crypto:${crypto.length} Combo:${combo.length}`);
    res.json({ opportunities:all, total:all.length, breakdown:{ negrisk:negrisk.length, crypto:crypto.length, combinatorial:combo.length }, fetchTime:new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

app.get("/api/scan-all", async (req,res) => {
  const minEdge = parseFloat(req.query.minEdge)||1.0;
  const results = [];
  for (const st of STATIONS) {
    try {
      const data = await scanStation(st, minEdge);
      results.push(data);
      console.log(`[scan] ${st.stationId} OK — ${data.modelsOk}/3 models, ${data.opportunities.length} edges`);
    } catch(e) {
      console.error(`[scan] ${st.stationId} FAILED:`, e.message);
      results.push({ station:st, error:e.message, opportunities:[] });
    }
    await sleep(300);
  }
  const opps = results.flatMap(r => (r.opportunities||[]).map(o=>({...o,city:r.station?.city,stationId:r.station?.stationId})));
  res.json({ results, opportunities:opps, total:opps.length, fetchTime:new Date().toISOString() });
});

// Debug: show raw market fetch results — use this to diagnose 0 markets
app.get("/api/debug-markets", async (req, res) => {
  const results = {};
  try {
    const r1 = await ext.get(`${GAMMA}/markets?tag_slug=weather&active=true&limit=5&closed=false`);
    results.tagSlugWeather = { count: (Array.isArray(r1.data)?r1.data:r1.data?.markets||[]).length, sample: (Array.isArray(r1.data)?r1.data:r1.data?.markets||[]).slice(0,2).map(m=>m.question) };
  } catch(e) { results.tagSlugWeather = { error: e.message }; }
  try {
    const r2 = await ext.get(`${GAMMA}/events?tag_slug=weather&active=true&limit=5&closed=false`);
    const evs = Array.isArray(r2.data)?r2.data:r2.data?.events||[];
    results.eventsWeather = { count: evs.length, markets: evs.flatMap(e=>e.markets||[]).length, sample: evs.slice(0,2).map(e=>e.title||e.slug) };
  } catch(e) { results.eventsWeather = { error: e.message }; }
  try {
    const r3 = await ext.get(`${GAMMA}/markets?active=true&limit=5&closed=false&keyword=rain`);
    results.keywordRain = { count: (Array.isArray(r3.data)?r3.data:r3.data?.markets||[]).length, sample: (Array.isArray(r3.data)?r3.data:r3.data?.markets||[]).slice(0,2).map(m=>m.question) };
  } catch(e) { results.keywordRain = { error: e.message }; }
  try {
    const r4 = await ext.get(`${GAMMA}/markets?active=true&limit=5&closed=false&search=temperature`);
    results.searchTemp = { count: (Array.isArray(r4.data)?r4.data:r4.data?.markets||[]).length };
  } catch(e) { results.searchTemp = { error: e.message }; }
  res.json({ results, ts: new Date().toISOString() });
});

// ── LIVE TRADING ENDPOINT ────────────────────────────────────
// Requires POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE in .env
// Polymarket CLOB API: https://docs.polymarket.com/#create-order
app.post("/api/trade", async (req, res) => {
  const { marketId, direction, price, size } = req.body;
  if (!marketId || !direction || !price) {
    return res.status(400).json({ error: "marketId, direction, price required" });
  }

  const apiKey      = process.env.POLY_API_KEY;
  const secret      = process.env.POLY_SECRET;
  const passphrase  = process.env.POLY_PASSPHRASE;

  if (!apiKey || !secret || !passphrase) {
    return res.status(403).json({
      error: "API keys not configured. Add POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE to .env",
      hint:  "Generate keys at polymarket.com → Profile → API Keys"
    });
  }

  try {
    // Build order for Polymarket CLOB
    const side    = direction === "BUY YES" ? "BUY" : "BUY"; // BUY YES = buy YES token; BUY NO = buy NO token
    const outcome = direction === "BUY YES" ? 0 : 1;          // 0 = YES token, 1 = NO token
    const orderSize = size || 10; // USDC amount

    // Timestamp for request signing
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce     = Date.now().toString();

    // Build the order payload
    const orderPayload = {
      market:   marketId,
      outcome:  outcome,
      side:     "BUY",
      price:    +parseFloat(price).toFixed(4),
      size:     +parseFloat(orderSize).toFixed(2),
      orderType:"FOK",  // Fill Or Kill — all or nothing
      timeInForce: "FOK",
    };

    // Sign request with HMAC-SHA256 (Polymarket CLOB auth)
    const crypto   = require("crypto");
    const msgParts = [timestamp, "POST", "/order", JSON.stringify(orderPayload)];
    const msg      = msgParts.join("");
    const sig      = crypto.createHmac("sha256", Buffer.from(secret, "base64"))
                           .update(msg).digest("base64");

    const response = await ext.post(`${CLOB}/order`, orderPayload, {
      headers: {
        "Content-Type":    "application/json",
        "POLY-ADDRESS":    apiKey,
        "POLY-SIGNATURE":  sig,
        "POLY-TIMESTAMP":  timestamp,
        "POLY-NONCE":      nonce,
        "POLY-PASSPHRASE": passphrase,
      },
      timeout: 8000,
    });

    console.log("[trade] Order placed:", JSON.stringify(response.data));
    res.json({ success: true, orderId: response.data?.orderID || response.data?.id, raw: response.data });

  } catch(e) {
    const errMsg = e.response?.data?.error || e.response?.data || e.message;
    console.error("[trade] Failed:", errMsg);
    res.status(500).json({ error: String(errMsg), hint: "Check API keys and market ID" });
  }
});

// ── DATABASE API ROUTES ─────────────────────────────────────

// Full stats dashboard
app.get("/api/stats", (req, res) => {
  try {
    const stats    = db.getStats();
    const settings = db.getAllSettings();
    const open     = db.getOpenTrades();
    res.json({ stats, settings, openTrades: open.length, ts: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all trades
app.get("/api/trades", (req, res) => {
  try {
    const limit  = parseInt(req.query.limit) || 100;
    const trades = db.getRecentTrades(limit);
    res.json({ trades, count: trades.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get recent opportunities
app.get("/api/opportunities", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const opps  = db.getRecentOpportunities(limit);
    res.json({ opportunities: opps, count: opps.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Place a manual paper trade
app.post("/api/paper-trade", (req, res) => {
  try {
    const { direction, marketId, question, price, size } = req.body;
    if (!direction || !price) return res.status(400).json({ error: "direction and price required" });
    const paperBal = parseFloat(db.getSetting("paper_balance") || "0");
    const tradeSize = Math.min(size || 10, paperBal);
    if (tradeSize < 0.5) return res.status(400).json({ error: "Insufficient paper balance: $" + paperBal });
    const tradeId = db.placeTrade({ mode:"paper", direction, marketId, question, price, size: tradeSize });
    const stats   = db.getStats();
    res.json({ success: true, tradeId, newBalance: stats.paperBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resolve a trade (mark won or lost)
app.post("/api/resolve-trade", (req, res) => {
  try {
    const { tradeId, resolvedYes } = req.body;
    if (!tradeId) return res.status(400).json({ error: "tradeId required" });
    const result = db.resolveTrade(tradeId, resolvedYes);
    const stats  = db.getStats();
    res.json({ success: true, ...result, newBalance: stats.paperBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update settings
app.post("/api/settings", (req, res) => {
  try {
    const allowed = ["paper_balance","paper_enabled","live_enabled","min_edge","max_position","scan_active"];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) db.setSetting(k, v);
    }
    res.json({ success: true, settings: db.getAllSettings() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reset paper balance
app.post("/api/reset-paper", (req, res) => {
  try {
    const amount = parseFloat(req.body.amount) || 1000;
    db.setSetting("paper_balance", amount.toFixed(2));
    res.json({ success: true, newBalance: amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update /api/latest to include DB stats
// (override the existing one)

// Multi-strategy scan endpoint
app.get("/api/scan-multi", async (req, res) => {
  try {
    const multi = await runAllStrategies();
    res.json({ ...multi, total: multi.all.length, fetchTime: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Serve React in production
if (process.env.NODE_ENV==="production") {
  app.use(express.static(path.join(__dirname,"../build")));
  app.get("*",(req,res) => res.sendFile(path.join(__dirname,"../build/index.html")));
}

// Scan every 2 minutes — weather + all strategies
cron.schedule("*/2 * * * *", async () => {
  console.log("[cron] Full scan starting...");
  try {
    // 1. Weather stations
    const results = [];
    for (const st of STATIONS) {
      try { results.push(await scanStationCached(st, 1.0)); }
      catch(e) { console.error("[cron]", st.stationId, e.message); }
      await sleep(300);
    }
    // Save weather opportunities to DB
    const allWeatherOpps = results.flatMap(r =>
      (r.opportunities || []).map(o => ({...o, city: r.station?.city, stationId: r.station?.stationId}))
    );
    allWeatherOpps.forEach(o => db.saveOpportunity(o));
    const wOpps = allWeatherOpps.length;

    // 2. All other strategies
    try {
      const multi = await runAllStrategies();
      multiOppCache.length = 0;
      multi.all.forEach(o => multiOppCache.push(o));

      // Save all opps to DB
      multi.all.forEach(o => db.saveOpportunity(o));

      // Auto paper-trade if enabled and edge is strong enough
      const paperEnabled = db.getSetting("paper_enabled") === "true";
      const scanActive   = db.getSetting("scan_active")   === "true";
      const paperBal     = parseFloat(db.getSetting("paper_balance") || "0");
      const maxPos       = parseFloat(db.getSetting("max_position")  || "50");
      const minEdgeSet   = parseFloat(db.getSetting("min_edge")      || "1.5");

      if (paperEnabled && scanActive && paperBal > 10) {
        const strongOpps = [...allWeatherOpps, ...multi.all]
          .filter(o => Math.abs(o.netEdge || 0) >= minEdgeSet + 0.5 && o.marketId);
        for (const opp of strongOpps.slice(0, 3)) { // max 3 auto-trades per cycle
          const size = Math.min(maxPos, paperBal * 0.02); // 2% of balance
          if (size < 1) break;
          const oppId = db.saveOpportunity(opp);
          db.placeTrade({
            oppId, mode: "paper",
            direction: opp.direction,
            marketId:  opp.marketId,
            question:  opp.question,
            price:     opp.polyProb || 0.5,
            size:      +size.toFixed(2),
          });
          console.log("[paper] Auto-trade:", opp.direction, opp.question?.slice(0,40), "size=$"+size.toFixed(2));
        }
      }
      console.log("[cron] Done — weather:" + wOpps +
        " eco:" + multi.economics.length +
        " geo:" + multi.geopolitics.length +
        " negrisk:" + multi.negrisk.length +
        " crypto:" + multi.crypto.length);
    } catch(e) { console.error("[cron-multi]", e.message); }

  } catch(e) { console.error("[cron]", e.message); }
});

// ── Result cache — stores last scan per station ──────────────
const scanCache = {};
const multiOppCache = []; // stores latest multi-strategy opportunities
const lastScanTime = { ts: null };

// Override scanStation to cache results
const _originalScanStation = scanStation;
async function scanStationCached(station, minEdge) {
  const result = await _originalScanStation(station, minEdge);
  scanCache[station.stationId] = result;
  lastScanTime.ts = new Date().toISOString();
  return result;
}

// Latest cached results — frontend polls this, no new API calls
app.get("/api/latest", (req, res) => {
  try {
    const stats = db.getStats();
    res.json({
      stations:   Object.values(scanCache),
      lastScan:   lastScanTime.ts,
      count:      Object.keys(scanCache).length,
      multiOpps:  multiOppCache,
      dbStats:    stats,
      scanActive: db.getSetting("scan_active") === "true",
      ts:         new Date().toISOString(),
    });
  } catch(e) {
    res.json({ stations: Object.values(scanCache), lastScan: lastScanTime.ts, count: Object.keys(scanCache).length, multiOpps: multiOppCache, ts: new Date().toISOString() });
  }
});

// Override scan routes to use cached version
app.get("/api/scan-cached/:stationId", async (req, res) => {
  const cached = scanCache[req.params.stationId];
  if (cached) return res.json(cached);
  // Not cached yet — run fresh scan
  const st = STATIONS.find(s => s.stationId===req.params.stationId);
  if (!st) return res.status(404).json({error:"Not found"});
  try {
    const data = await scanStationCached(st, 1.0);
    res.json(data);
  } catch(e) {
    res.status(502).json({error:e.message});
  }
});

// ── Init DB then start server ────────────────────────────────
db.initDB().then(() => {
  server.listen(PORT, () => {
  console.log(`\n Polymarket Weather Bot`);
    console.log(` http://localhost:${PORT}`);
    console.log(` Connectivity test: http://localhost:${PORT}/api/test\n`);
    connectPolyWS();
  });
}).catch(e => {
  console.error("[db] Init failed:", e.message);
  // Start server anyway without DB
  server.listen(PORT, () => {
    console.log(` Server started (no DB) on http://localhost:${PORT}`);
    connectPolyWS();
  });
});
