// Centralized configuration + the asset universe.
// Pyth feed IDs verified against hermes.pyth.network /v2/price_feeds (crypto, *.USD).
require("dotenv").config();

const num  = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] === "true" : d);
const str  = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);

// Full universe. `ASSETS` env selects which are active.
const UNIVERSE = {
  BTC:  { symbol: "BTC",  name: "Bitcoin",   coinbase: "BTC-USD",  series: "btc-up-or-down-15m",  pyth: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  ETH:  { symbol: "ETH",  name: "Ethereum",  coinbase: "ETH-USD",  series: "eth-up-or-down-15m",  pyth: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  SOL:  { symbol: "SOL",  name: "Solana",    coinbase: "SOL-USD",  series: "sol-up-or-down-15m",  pyth: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  XRP:  { symbol: "XRP",  name: "XRP",       coinbase: "XRP-USD",  series: "xrp-up-or-down-15m",  pyth: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8" },
  DOGE: { symbol: "DOGE", name: "Dogecoin",  coinbase: "DOGE-USD", series: "doge-up-or-down-15m", pyth: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c" },
};

const ASSET_KEYS = str("ASSETS", "BTC,ETH,SOL,XRP,DOGE")
  .split(",").map(s => s.trim().toUpperCase()).filter(k => UNIVERSE[k]);

const ASSETS = ASSET_KEYS.map(k => UNIVERSE[k]);

const WINDOW_SEC = 15 * 60; // 15-minute markets

const cfg = {
  PORT:          num("PORT", 3002),
  DB_PATH:       str("DB_PATH", null),
  SCAN_MS:       num("SCAN_MS", 5000),
  WINDOW_SEC,

  DRIFT_ENABLED: bool("DRIFT_ENABLED", false),
  MIN_EDGE:      num("MIN_EDGE", 0.10),
  MIN_P:         num("MIN_P", 0.80),
  MIN_Z:         num("MIN_Z", 0.8),
  LATE_WINDOW_S: num("LATE_WINDOW_S", 360),
  NO_TAKER_LAST_S: num("NO_TAKER_LAST_S", 60),
  BASIS_BPS:     num("BASIS_BPS", 3),
  MODE_B:        bool("MODE_B", false),

  TAKER_FEE_K:   num("TAKER_FEE_K", 0.036),
  SLIP:          num("SLIP", 0.005),

  PAPER_BALANCE: num("PAPER_BALANCE", 1000),
  KELLY_K:       num("KELLY_K", 0.15),
  F_MAX:         num("F_MAX", 0.04),
  AGG_CAP:       num("AGG_CAP", 0.12),

  W_OFI: num("W_OFI", 0.15),
  W_CVD: num("W_CVD", 0.10),
  W_OBI: num("W_OBI", 0.05),
  W_MOM: num("W_MOM", 0.05),

  MAX_SPREAD_C:  num("MAX_SPREAD_C", 4),
  MIN_DEPTH_USD: num("MIN_DEPTH_USD", 50),

  BACKTEST_TARGET_WR: num("BACKTEST_TARGET_WR", 0.80),
  BACKTEST_MIN_TRADES: num("BACKTEST_MIN_TRADES", 50),

  ASSETS,
  ASSET_KEYS,
  UNIVERSE,
};

module.exports = cfg;
