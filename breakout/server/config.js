// Centralized configuration: symbol universe, timeframes, and the default strategy params.
require("dotenv").config();

const num = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const str = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const bool = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] === "true" : d);

// Coinbase Exchange product ids. Fee defaults below are taker-side crypto assumptions.
const SYMBOLS = [
  { id: "BTC-USD",  label: "BTC/USD",  tick: 0.01 },
  { id: "ETH-USD",  label: "ETH/USD",  tick: 0.01 },
  { id: "SOL-USD",  label: "SOL/USD",  tick: 0.01 },
  { id: "XRP-USD",  label: "XRP/USD",  tick: 0.0001 },
  { id: "DOGE-USD", label: "DOGE/USD", tick: 0.00001 },
  { id: "LINK-USD", label: "LINK/USD", tick: 0.001 },
  { id: "AVAX-USD", label: "AVAX/USD", tick: 0.001 },
];

// Coinbase only serves these granularities (seconds).
const TIMEFRAMES = [
  { id: "1m",  seconds: 60 },
  { id: "5m",  seconds: 300 },
  { id: "15m", seconds: 900 },
  { id: "1h",  seconds: 3600 },
  { id: "6h",  seconds: 21600 },
  { id: "1d",  seconds: 86400 },
];

// Strategy defaults. Every one of these is overridable per backtest request; the UI exposes
// them as controls so a run is fully reproducible from the params object alone.
const DEFAULT_PARAMS = {
  // ── Range / level detection ──
  rangeLen: 20,            // bars of range whose boundary must break
  pivotLeft: 5,            // fractal pivot geometry for the drawn key levels
  pivotRight: 5,
  snapToPivotAtr: 0.5,     // snap a Donchian level to a confirmed pivot within this many ATR
  maxRangeWidthAtr: 10,    // skip ranges wider than this. A 20-bar Donchian width runs ~8 ATR
                           // at the median, so this keeps the tighter-than-usual coils.
  minRangeWidthAtr: 0.5,   // skip degenerate flat lines
  breakoutBufferAtr: 0.10, // close must clear the level by this * ATR to count as a break
  closeBeyondLevel: true,  // require a CLOSE beyond the level, not just a wick

  // ── Filters (GG-Shot's false-signal suppression) ──
  volFilter: true,
  volLen: 20,
  volMult: 1.4,            // breakout bar volume vs its own 20-bar baseline
  flatFilter: true,
  minAdx: 18,              // trend-strength floor
  minAtrRank: 0.20,        // volatility percentile floor (0 = off)
  trendFilter: false,      // only long above the trend EMA / short below
  trendEmaLen: 200,
  direction: "both",       // both | long | short
  cooldownBars: 5,         // bars to wait after a trade closes before re-arming

  // ── Entry ──
  entryMode: "nextOpen",   // nextOpen (honest fill) | close (signal-bar close) | retest
  retestBars: 5,           // retest mode: bars allowed for price to return to the level
  atrLen: 14,

  // ── Risk: stop at structure, targets scaled off the resulting risk ──
  slMode: "level",         // level (just under the broken boundary, which flips to support)
                           // | range (far side of the whole range) | atr (fixed ATR distance)
  slAtrMult: 1.5,          // atr mode: stop distance in ATR
  slBufferAtr: 0.25,       // level/range mode: padding beyond the structural price
  maxRiskAtr: 4,           // reject setups already extended too far past the level to stop safely
  tpR: [1, 2, 3, 5],       // four static targets, in R multiples
  tpAlloc: [0.5, 0.25, 0.15, 0.10], // GG-Shot's suggested scale-out ladder
  beAfterTp1: true,        // move stop to breakeven once TP1 fills
  trailAfterTp: 2,         // arm the ATR trail after this many TPs (the "dynamic" targets)
  trailAtrMult: 2.0,
  maxBars: 150,            // time stop

  // ── Account ──
  equity: 10000,
  riskPct: 1.0,            // % of equity risked per trade (entry→stop distance)
  maxLeverage: 5,          // notional cap, so a very tight stop cannot imply an absurd size
  feeBps: 10,              // per fill, each side
  slipBps: 2,              // entry + exit slippage
  pessimisticFills: true,  // if a bar touches both stop and target, assume the stop first
};

// Named starting points. Not magic — just sensible (rangeLen, filter) pairings per horizon.
const PRESETS = {
  scalp:    { label: "Scalp",    tf: "5m",  params: { rangeLen: 14, minAdx: 20, volMult: 1.6, maxBars: 60,  tpR: [1, 1.8, 2.6, 4] } },
  intraday: { label: "Intraday", tf: "15m", params: { rangeLen: 20, minAdx: 18, volMult: 1.4, maxBars: 150, tpR: [1, 2, 3, 5] } },
  swing:    { label: "Swing",    tf: "1h",  params: { rangeLen: 30, minAdx: 16, volMult: 1.3, maxBars: 200, tpR: [1, 2, 3.5, 6], trendFilter: true } },
  position: { label: "Position", tf: "1d",  params: { rangeLen: 40, minAdx: 15, volMult: 1.2, maxBars: 250, tpR: [1, 2, 4, 8], trendFilter: true } },
};

module.exports = {
  PORT: num("PORT", 3003),
  CACHE_DIR: str("CACHE_DIR", null),
  CACHE_TTL_MS: num("CACHE_TTL_MS", 5 * 60 * 1000),
  MAX_BARS: num("MAX_BARS", 3000),
  ALLOW_SYNTHETIC: bool("ALLOW_SYNTHETIC", true),
  SYMBOLS, TIMEFRAMES, DEFAULT_PARAMS, PRESETS,
};
