// Centralized configuration: symbol universe, timeframes, and the default strategy params.
require("dotenv").config();

const num = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const str = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const bool = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] === "true" : d);

// Two venues. Crypto ids are Coinbase Exchange products; equity tickers come from Yahoo, which
// serves decades of split-adjusted daily bars without a key. `source` routes the fetch.
const CRYPTO = [
  { id: "BTC-USD",  label: "BTC/USD",  tick: 0.01 },
  { id: "ETH-USD",  label: "ETH/USD",  tick: 0.01 },
  { id: "SOL-USD",  label: "SOL/USD",  tick: 0.01 },
  { id: "XRP-USD",  label: "XRP/USD",  tick: 0.0001 },
  { id: "DOGE-USD", label: "DOGE/USD", tick: 0.00001 },
  { id: "LINK-USD", label: "LINK/USD", tick: 0.001 },
  { id: "AVAX-USD", label: "AVAX/USD", tick: 0.001 },
].map(s => ({ ...s, source: "coinbase", asset: "crypto" }));

const EQUITY = [
  { id: "SPY",  label: "S&P 500 (SPY)" },
  { id: "QQQ",  label: "Nasdaq 100 (QQQ)" },
  { id: "IWM",  label: "Russell 2000 (IWM)" },
  { id: "AAPL", label: "Apple" },
  { id: "MSFT", label: "Microsoft" },
  { id: "NVDA", label: "NVIDIA" },
  { id: "AMZN", label: "Amazon" },
  { id: "GOOGL", label: "Alphabet" },
  { id: "META", label: "Meta" },
  { id: "TSLA", label: "Tesla" },
  { id: "JPM",  label: "JPMorgan" },
  { id: "XOM",  label: "Exxon" },
  { id: "JNJ",  label: "Johnson & Johnson" },
  { id: "WMT",  label: "Walmart" },
  { id: "GLD",  label: "Gold (GLD)" },
  { id: "TLT",  label: "20y Treasuries (TLT)" },
].map(s => ({ ...s, source: "yahoo", asset: "equity", tick: 0.01 }));

const SYMBOLS = [...CRYPTO, ...EQUITY];

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
  // These defaults were selected on BTC daily bars before 2023 and then validated on the
  // post-2023 BTC period and on six symbols that took no part in the selection. See the
  // "Choosing the defaults" section of the README for the numbers.
  slMode: "atr",           // atr (fixed ATR distance) | level (just under the broken boundary,
                           // which flips to support) | range (far side of the whole range)
  slAtrMult: 2,            // atr mode: stop distance in ATR
  slBufferAtr: 0.25,       // level/range mode: padding beyond the structural price
  maxRiskAtr: 4,           // reject setups already extended too far past the level to stop safely

  // No static targets by default: the position rides until the trailing stop takes it out.
  // Scaling out caps winners while losers stay whole, which is what turned the four-target
  // ladder negative out of sample. Set tpR to enable targets (the "GG ladder" preset does).
  tpR: [],                 // static targets, in R multiples
  tpAlloc: [],             // fraction of the position banked at each target
  beAfterTp1: true,        // move stop to breakeven once TP1 fills
  trailAfterTp: 0,         // targets banked before the ATR trail arms (0 = from entry)
  trailAtrMult: 3.0,       // trail width in ATR; 0 turns the trail off entirely
  maxBars: 150,            // time stop

  // ── Account ──
  equity: 10000,
  riskPct: 1.0,            // % of equity risked per trade (entry→stop distance)
  maxLeverage: 5,          // notional cap, so a very tight stop cannot imply an absurd size
  feeBps: 10,              // per fill, each side
  slipBps: 2,              // entry + exit slippage
  pessimisticFills: true,  // if a bar touches both stop and target, assume the stop first
};

// Exit styles, which is the choice that decides whether this strategy makes money.
// The ladder is the GG-Shot-faithful configuration; it is kept because comparing it against
// the runner in the stats panel is the single most instructive thing this tool does.
const PRESETS = {
  trend:  { label: "Trend",  tf: "1d", params: { tpR: [], tpAlloc: [], trailAfterTp: 0, trailAtrMult: 3 } },
  ladder: { label: "GG ladder", tf: "1d", params: { tpR: [1, 2, 3, 5], tpAlloc: [0.5, 0.25, 0.15, 0.10], trailAfterTp: 2, trailAtrMult: 2 } },
  runner: { label: "Runner", tf: "1d", params: { tpR: [2, 4, 8, 16], tpAlloc: [0.15, 0.15, 0.15, 0.55], trailAfterTp: 1, trailAtrMult: 3 } },
  swing:  { label: "6h swing", tf: "6h", params: { tpR: [], tpAlloc: [], trailAfterTp: 0, trailAtrMult: 3, rangeLen: 30 } },
  // Equities only. Shorting breakdowns in a market with 24 years of upward drift is the single
  // most destructive thing this strategy can do (see test/equities.test.js), so this preset
  // takes the long side only. It is still barely profitable in money terms — see the README.
  equity: { label: "Equity long", tf: "1d", params: { direction: "long", tpR: [], tpAlloc: [], trailAfterTp: 0, trailAtrMult: 3 } },
};

module.exports = {
  PORT: num("PORT", 3003),
  CACHE_DIR: str("CACHE_DIR", null),
  CACHE_TTL_MS: num("CACHE_TTL_MS", 5 * 60 * 1000),
  MAX_BARS: num("MAX_BARS", 8000),      // daily equity history runs to ~24 years
  ALLOW_SYNTHETIC: bool("ALLOW_SYNTHETIC", true),
  SYMBOLS, TIMEFRAMES, DEFAULT_PARAMS, PRESETS,
};
