// Offline backtest + threshold auto-tuning.
//   1. Pull recently-RESOLVED 15m windows (ground-truth Up/Down) from Gamma.
//   2. Reconstruct reference price history from Coinbase 1-min candles (same feed family
//      used live for the lead L). NOTE: live CLOB price history isn't freely replayable, so
//      this scores the LEAD-MODEL probability vs realized outcome (win-rate + calibration);
//      the market-shrink/edge term is validated forward, live. Stated as a known limit.
//   3. Replay the Mode-A decision rule and grid-search MIN_P x MIN_Z x LATE_WINDOW_S to
//      maximize trade count subject to win-rate >= target.
const axios = require("axios");
const cfg = require("./config");
const { leadZ, pUp, ewmaVar, clamp } = require("./math");

const GAMMA = "https://gamma-api.polymarket.com";
const COINBASE = "https://api.exchange.coinbase.com";
const ext = axios.create({ timeout: 15000, headers: { Accept: "application/json", "User-Agent": "crypto15m-bot/1.0" } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parseJSON = (v, f) => { try { return typeof v === "string" ? JSON.parse(v) : (v ?? f); } catch { return f; } };

// Pull resolved 15m windows for configured assets.
async function fetchResolvedWindows(maxPages = 4) {
  const wins = [];
  for (let page = 0; page < maxPages; page++) {
    const { data } = await ext.get(`${GAMMA}/events?tag_slug=crypto&closed=true&limit=200&offset=${page * 200}&order=endDate&ascending=false`);
    const events = Array.isArray(data) ? data : (data.data || data.events || []);
    if (!events.length) break;
    for (const e of events) {
      const slug = (e.series || [])[0]?.slug;
      const asset = cfg.ASSETS.find(a => a.series === slug);
      if (!asset) continue;
      const m = (e.markets || [])[0]; if (!m || !m.endDate) continue;
      const prices = parseJSON(m.outcomePrices, null);
      if (!Array.isArray(prices) || prices.length < 2) continue;
      const up = parseFloat(prices[0]); // outcomes ["Up","Down"] -> index 0 = Up
      if (isNaN(up)) continue;
      wins.push({ asset: asset.symbol, coinbase: asset.coinbase, endMs: Date.parse(m.endDate), outcomeUp: up >= 0.5 });
    }
    await sleep(150);
  }
  return wins;
}

// Coinbase 1-min candles covering [start,end] (unix sec). Returns [{t, close}] ascending.
async function fetchCandles(product, startSec, endSec) {
  const url = `${COINBASE}/products/${product}/candles?granularity=60&start=${new Date(startSec * 1000).toISOString()}&end=${new Date(endSec * 1000).toISOString()}`;
  const { data } = await ext.get(url);
  if (!Array.isArray(data)) return [];
  return data.map(c => ({ t: c[0], close: c[4] })).sort((a, b) => a.t - b.t);
}

// Replay one window with given thresholds. Returns {traded, win, side, pModel} or null.
function replayWindow(candles, win, params) {
  const openSec = Math.floor(win.endMs / 1000) - cfg.WINDOW_SEC;
  const openC = candles.find(c => c.t >= openSec) || candles[0];
  if (!openC) return null;
  const sOpen = openC.close;

  // Warm σ from candles preceding the window.
  let varPerMin = 0, prev = null;
  for (const c of candles) {
    if (c.t > openSec) break;
    if (prev) varPerMin = ewmaVar(varPerMin, Math.log(c.close / prev), 0.94);
    prev = c.close;
  }
  const within = candles.filter(c => c.t >= openSec && c.t <= win.endMs / 1000);
  for (const c of within) {
    if (prev) varPerMin = ewmaVar(varPerMin, Math.log(c.close / prev), 0.94);
    prev = c.close;
    const tau = win.endMs / 1000 - c.t;
    if (tau <= params.NO_TAKER_LAST_S || tau > params.LATE_WINDOW_S) continue;
    const sigmaPerSec = Math.sqrt(Math.max(varPerMin / 60, 1e-14));
    const L = Math.log(c.close / sOpen);
    const z = leadZ(L, sigmaPerSec, tau);
    const pModel = pUp(z);
    const side = pModel >= 0.5 ? "UP" : "DOWN";
    const pSide = side === "UP" ? pModel : 1 - pModel;
    if (Math.abs(z) < params.MIN_Z) continue;
    if (pSide < params.MIN_P) continue;
    if (Math.abs(L) < params.BASIS_BPS / 1e4) continue;
    const winBet = (side === "UP" && win.outcomeUp) || (side === "DOWN" && !win.outcomeUp);
    return { traded: true, win: winBet, side, pSide };
  }
  return null;
}

async function gatherWindows(limitPerAsset = 80) {
  const wins = await fetchResolvedWindows();
  const out = [];
  const counts = {};
  for (const w of wins) {
    counts[w.asset] = (counts[w.asset] || 0);
    if (counts[w.asset] >= limitPerAsset) continue;
    const endSec = Math.floor(w.endMs / 1000);
    let candles = [];
    try { candles = await fetchCandles(w.coinbase, endSec - cfg.WINDOW_SEC - 1800, endSec); } catch { continue; }
    await sleep(120);
    if (candles.length < 10) continue;
    out.push({ ...w, candles });
    counts[w.asset]++;
  }
  return out;
}

function evalParams(windows, params) {
  const trades = [];
  for (const w of windows) {
    const r = replayWindow(w.candles, w, params);
    if (r && r.traded) trades.push({ asset: w.asset, side: r.side, pSide: r.pSide, resolvedUp: w.outcomeUp ? 1 : 0, win: r.win });
  }
  const n = trades.length;
  const wins = trades.filter(t => t.win).length;
  const wr = n ? wins / n : 0;
  // Fee-aware breakeven proxy: bets are favorites at ~pSide; need WR > avg pSide + fee to profit
  // vs a market priced at the model. Reported as informational.
  const avgP = n ? trades.reduce((s, t) => s + t.pSide, 0) / n : 0;
  return { trades: n, winRate: +(wr * 100).toFixed(1), avgPSide: +avgP.toFixed(3), rows: trades };
}

// Grid-search thresholds; pick most trades subject to WR >= target & min trades.
async function run(opts = {}) {
  const target = opts.targetWr ?? cfg.BACKTEST_TARGET_WR;
  const minTrades = opts.minTrades ?? cfg.BACKTEST_MIN_TRADES;
  const windows = await gatherWindows(opts.limitPerAsset ?? 80);

  const grid = [];
  for (const MIN_P of [0.75, 0.80, 0.85, 0.90]) {
    for (const MIN_Z of [0.6, 0.8, 1.0, 1.3]) {
      for (const LATE_WINDOW_S of [180, 300, 360]) {
        const params = { MIN_P, MIN_Z, LATE_WINDOW_S, NO_TAKER_LAST_S: cfg.NO_TAKER_LAST_S, BASIS_BPS: cfg.BASIS_BPS };
        const res = evalParams(windows, params);
        grid.push({ MIN_P, MIN_Z, LATE_WINDOW_S, trades: res.trades, winRate: res.winRate, avgPSide: res.avgPSide });
      }
    }
  }
  const eligible = grid.filter(g => g.winRate / 100 >= target && g.trades >= minTrades);
  eligible.sort((a, b) => b.trades - a.trades || b.winRate - a.winRate);
  const best = eligible[0] || [...grid].sort((a, b) => b.winRate - a.winRate || b.trades - a.trades)[0];

  // Calibration of the model probability over the best params.
  const { calibration } = require("./calib");
  const bestRows = evalParams(windows, { ...best, NO_TAKER_LAST_S: cfg.NO_TAKER_LAST_S, BASIS_BPS: cfg.BASIS_BPS }).rows;

  return {
    windowsTested: windows.length,
    perAsset: cfg.ASSET_KEYS.map(k => ({ asset: k, windows: windows.filter(w => w.asset === k).length })),
    target, minTrades,
    best, frontier: grid.sort((a, b) => b.winRate - a.winRate).slice(0, 15),
    calibration: calibration(bestRows),
    note: "Win-rate is of the lead-model decision rule vs realized Chainlink-resolved outcomes. " +
          "Edge/EV vs the live Poly price is validated forward (CLOB history not freely replayable).",
  };
}

module.exports = { run, fetchResolvedWindows, fetchCandles, replayWindow, evalParams, gatherWindows };

// CLI: `npm run backtest`
if (require.main === module) {
  run().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
       .catch(e => { console.error("backtest failed:", e.message); process.exit(1); });
}
