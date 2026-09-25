// Centralized configuration + the tradable universe (stocks + crypto).
require("dotenv").config();

const num  = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] === "true" : d);
const str  = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const list = (k, d) => str(k, d).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

// Crypto universe: Coinbase product (primary candles + WS), Kraken pair (fallback),
// OKX swap (funding / open interest), CoinGecko id (fundamentals), DefiLlama chain (TVL).
const CRYPTO_UNIVERSE = {
  BTC:  { symbol: "BTC",  name: "Bitcoin",   coinbase: "BTC-USD",  kraken: "XBTUSD",  okx: "BTC-USDT-SWAP",  coingecko: "bitcoin",      llama: "Bitcoin" },
  ETH:  { symbol: "ETH",  name: "Ethereum",  coinbase: "ETH-USD",  kraken: "ETHUSD",  okx: "ETH-USDT-SWAP",  coingecko: "ethereum",     llama: "Ethereum" },
  SOL:  { symbol: "SOL",  name: "Solana",    coinbase: "SOL-USD",  kraken: "SOLUSD",  okx: "SOL-USDT-SWAP",  coingecko: "solana",       llama: "Solana" },
  XRP:  { symbol: "XRP",  name: "XRP",       coinbase: "XRP-USD",  kraken: "XRPUSD",  okx: "XRP-USDT-SWAP",  coingecko: "ripple",       llama: null },
  DOGE: { symbol: "DOGE", name: "Dogecoin",  coinbase: "DOGE-USD", kraken: "XDGUSD",  okx: "DOGE-USDT-SWAP", coingecko: "dogecoin",     llama: null },
  AVAX: { symbol: "AVAX", name: "Avalanche", coinbase: "AVAX-USD", kraken: "AVAXUSD", okx: "AVAX-USDT-SWAP", coingecko: "avalanche-2",  llama: "Avalanche" },
  LINK: { symbol: "LINK", name: "Chainlink", coinbase: "LINK-USD", kraken: "LINKUSD", okx: "LINK-USDT-SWAP", coingecko: "chainlink",    llama: null },
};

const CRYPTO = list("CRYPTO", "BTC,ETH,SOL,XRP,DOGE").filter(k => CRYPTO_UNIVERSE[k])
  .map(k => ({ ...CRYPTO_UNIVERSE[k], assetClass: "crypto", id: `CRYPTO:${k}` }));

// Stocks: any US ticker works (Nasdaq API + SEC EDGAR); these are defaults.
const STOCKS = list("STOCKS", "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,SPY,QQQ")
  .map(k => ({ symbol: k, name: k, assetClass: "stock", id: `STOCK:${k}`, etf: ["SPY", "QQQ", "IWM", "DIA"].includes(k) }));

const cfg = {
  PORT:        num("PORT", 3003),
  DB_PATH:     str("DB_PATH", null),
  NODE_ENV:    str("NODE_ENV", "development"),

  // Real-time loop cadence.
  CRYPTO_SCAN_MS: num("CRYPTO_SCAN_MS", 15000),   // full re-decision per crypto asset
  STOCK_SCAN_MS:  num("STOCK_SCAN_MS", 60000),    // full re-decision per stock
  SLOW_REFRESH_MS: num("SLOW_REFRESH_MS", 30 * 60 * 1000), // fundamentals / macro / news cache TTL

  // Defaults follow docs/RESEARCH.md §5.1.
  // Decision horizons (what "UP" means): forward return over this many bars of the base timeframe.
  HORIZON: str("HORIZON", "swing"),               // "intraday" | "swing" | "position"

  // Confidence gating — the engine abstains (HOLD) unless all of these clear.
  MIN_CONFIDENCE: num("MIN_CONFIDENCE", 0.60),    // calibrated confidence in [0,1]
  MIN_PROB_EDGE:  num("MIN_PROB_EDGE", 0.04),     // |P(up) - 0.5| minimum
  MIN_AGREEMENT:  num("MIN_AGREEMENT", 0.60),     // share of weighted evidence on the chosen side
  STRONG_CONFIDENCE: num("STRONG_CONFIDENCE", 0.80),

  // Risk / sizing (paper portfolio).
  PAPER_BALANCE: num("PAPER_BALANCE", 100000),
  KELLY_K:       num("KELLY_K", 0.25),            // fractional Kelly
  MAX_POS_FRAC:  num("MAX_POS_FRAC", 0.10),       // per-position cap, stocks (fraction of equity)
  MAX_POS_FRAC_CRYPTO: num("MAX_POS_FRAC_CRYPTO", 0.05), // per-position cap, crypto (higher vol, correlated)
  MAX_GROSS:     num("MAX_GROSS", 1.0),           // gross exposure cap
  TARGET_VOL:    num("TARGET_VOL", 0.12),         // annualized vol target per position
  MAX_DRAWDOWN:  num("MAX_DRAWDOWN", 0.15),       // circuit breaker: halt new entries
  STOP_ATR:      num("STOP_ATR", 2.0),
  TARGET_ATR:    num("TARGET_ATR", 3.0),
  FEE_BPS_CRYPTO: num("FEE_BPS_CRYPTO", 10),
  FEE_BPS_STOCK:  num("FEE_BPS_STOCK", 1),
  SLIPPAGE_BPS:   num("SLIPPAGE_BPS", 5),

  // Online learning of signal weights (Hedge / multiplicative weights).
  LEARN_RATE:    num("LEARN_RATE", 0.05),

  // Optional LLM analyst (Claude). Off unless a key is present.
  ANTHROPIC_API_KEY: str("ANTHROPIC_API_KEY", null),
  LLM_MODEL:     str("LLM_MODEL", "claude-opus-5"),
  LLM_EFFORT:    str("LLM_EFFORT", "medium"),
  LLM_ENABLED:   bool("LLM_ENABLED", true),
  LLM_TTL_MS:    num("LLM_TTL_MS", 60 * 60 * 1000),

  // Optional keyed providers (all free-tier). Keyless providers are used otherwise.
  FRED_API_KEY:      str("FRED_API_KEY", null),
  SEC_USER_AGENT:    str("SEC_USER_AGENT", "decision-engine research contact@example.com"),

  CRYPTO, STOCKS, CRYPTO_UNIVERSE,
  ASSETS: [...CRYPTO, ...STOCKS],
};

// Horizon presets: base timeframe (bar interval, seconds), bars ahead that define the label,
// and how many bars of history each analysis pass loads.
cfg.HORIZONS = {
  intraday: { tf: 900,   ahead: 8,  history: 3500, label: "2h"  },   // 15m bars, 2h ahead
  swing:    { tf: 86400, ahead: 5,  history: 1000, label: "5d"  },   // daily bars, 1 week ahead
  position: { tf: 86400, ahead: 20, history: 1500, label: "20d" },   // daily bars, ~1 month ahead
};

module.exports = cfg;
