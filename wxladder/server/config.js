// Centralized configuration + the resolution-station universe.
//
// Every station below was read out of the live Polymarket resolution text, which for all
// but Hong Kong says: "information from NOAA, specifically the highest reading under the
// 'Temp' column for all times on this day, available here:
// https://www.weather.gov/wrh/timeseries?site=<icao>".  So the resolving instrument is the
// station METAR — NOT the city, and often NOT the airport you would guess (London is
// EGLC/City, not Heathrow; Paris is LFPB/Le Bourget, not CDG; Taipei is RCSS/Songshan;
// Moscow is UUWW/Vnukovo).  Lat/lon/elev are the station coordinates reported by the
// aviationweather.gov METAR API.
require("dotenv").config();

const num  = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] === "true" : d);
const str  = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);

// city (as Polymarket titles it) -> resolution station.
// `resolver: "metar"` means the daily extreme is the max/min of the station's METAR
// integer-degree readings over the local calendar day — which is what we model.
const UNIVERSE = {
  "Amsterdam":       { icao: "EHAM", lat: 52.315, lon: 4.790,   elev: -2,  tz: "Europe/Amsterdam",   name: "Amsterdam/Schiphol" },
  "Ankara":          { icao: "LTAC", lat: 40.128, lon: 32.995,  elev: 952, tz: "Europe/Istanbul",    name: "Ankara/Esenboga" },
  "Beijing":         { icao: "ZBAA", lat: 40.082, lon: 116.603, elev: 31,  tz: "Asia/Shanghai",      name: "Beijing Capital" },
  "Busan":           { icao: "RKPK", lat: 35.179, lon: 128.938, elev: 3,   tz: "Asia/Seoul",         name: "Busan/Gimhae" },
  "Cape Town":       { icao: "FACT", lat: -33.965, lon: 18.602, elev: 48,  tz: "Africa/Johannesburg",name: "Cape Town Intl" },
  "Chengdu":         { icao: "ZUUU", lat: 30.576, lon: 103.950, elev: 494, tz: "Asia/Shanghai",      name: "Chengdu/Shuangliu" },
  "Chongqing":       { icao: "ZUCK", lat: 29.718, lon: 106.639, elev: 416, tz: "Asia/Shanghai",      name: "Chongqing/Jiangbei" },
  "Guangzhou":       { icao: "ZGGG", lat: 23.392, lon: 113.307, elev: 11,  tz: "Asia/Shanghai",      name: "Guangzhou/Baiyun" },
  "Helsinki":        { icao: "EFHK", lat: 60.327, lon: 24.957,  elev: 56,  tz: "Europe/Helsinki",    name: "Helsinki/Vantaa" },
  "Istanbul":        { icao: "LTFM", lat: 41.262, lon: 28.740,  elev: 99,  tz: "Europe/Istanbul",    name: "Istanbul Arpt" },
  "Jeddah":          { icao: "OEJN", lat: 21.685, lon: 39.166,  elev: 8,   tz: "Asia/Riyadh",        name: "Jeddah/King Abdulaziz" },
  "Karachi":         { icao: "OPKC", lat: 24.902, lon: 67.139,  elev: 20,  tz: "Asia/Karachi",       name: "Karachi/Jinnah" },
  "Kuala Lumpur":    { icao: "WMKK", lat: 2.747,  lon: 101.714, elev: 21,  tz: "Asia/Kuala_Lumpur",  name: "Kuala Lumpur Intl" },
  "London":          { icao: "EGLC", lat: 51.505, lon: 0.055,   elev: 10,  tz: "Europe/London",      name: "London City" },
  "Lucknow":         { icao: "VILK", lat: 26.761, lon: 80.889,  elev: 121, tz: "Asia/Kolkata",       name: "Lucknow/Singh" },
  "Madrid":          { icao: "LEMD", lat: 40.466, lon: -3.555,  elev: 589, tz: "Europe/Madrid",      name: "Madrid/Barajas" },
  "Manila":          { icao: "RPLL", lat: 14.507, lon: 121.004, elev: 15,  tz: "Asia/Manila",        name: "Manila/Aquino" },
  "Milan":           { icao: "LIMC", lat: 45.631, lon: 8.728,   elev: 221, tz: "Europe/Rome",        name: "Milan/Malpensa" },
  "Moscow":          { icao: "UUWW", lat: 55.592, lon: 37.261,  elev: 195, tz: "Europe/Moscow",      name: "Moscow/Vnukovo" },
  "Munich":          { icao: "EDDM", lat: 48.348, lon: 11.813,  elev: 445, tz: "Europe/Berlin",      name: "Munich Intl" },
  "Paris":           { icao: "LFPB", lat: 48.967, lon: 2.428,   elev: 50,  tz: "Europe/Paris",       name: "Paris/Le Bourget" },
  "Qingdao":         { icao: "ZSQD", lat: 36.362, lon: 120.087, elev: 2,   tz: "Asia/Shanghai",      name: "Qingdao/Jiaodong" },
  "Seoul (Incheon)": { icao: "RKSI", lat: 37.469, lon: 126.451, elev: 7,   tz: "Asia/Seoul",         name: "Seoul/Incheon" },
  "Shanghai":        { icao: "ZSPD", lat: 31.146, lon: 121.800, elev: 4,   tz: "Asia/Shanghai",      name: "Shanghai/Pudong" },
  "Shenzhen":        { icao: "ZGSZ", lat: 22.639, lon: 113.803, elev: 18,  tz: "Asia/Shanghai",      name: "Shenzhen/Bao'an" },
  "Singapore":       { icao: "WSSS", lat: 1.368,  lon: 103.982, elev: 17,  tz: "Asia/Singapore",     name: "Singapore/Changi" },
  "Taipei":          { icao: "RCSS", lat: 25.069, lon: 121.552, elev: 8,   tz: "Asia/Taipei",        name: "Taipei/Songshan" },
  "Tel Aviv":        { icao: "LLBG", lat: 32.011, lon: 34.887,  elev: 35,  tz: "Asia/Jerusalem",     name: "Tel Aviv/Ben Gurion" },
  "Tokyo":           { icao: "RJTT", lat: 35.553, lon: 139.781, elev: 5,   tz: "Asia/Tokyo",         name: "Tokyo/Haneda" },
  "Warsaw":          { icao: "EPWA", lat: 52.163, lon: 20.961,  elev: 107, tz: "Europe/Warsaw",      name: "Warsaw/Chopin" },
  "Wellington":      { icao: "NZWN", lat: -41.331, lon: 174.806, elev: 12, tz: "Pacific/Auckland",   name: "Wellington Intl" },
  "Wuhan":           { icao: "ZHHH", lat: 30.783, lon: 114.205, elev: 33,  tz: "Asia/Shanghai",      name: "Wuhan/Tianhe" },
};
// METAR stations report whole degrees, so bucket "31C" is the event round(T) == 31 and the
// reading settles it directly. `settleGraceDays` is short because METAR is published live.
for (const [city, s] of Object.entries(UNIVERSE)) {
  s.city = city; s.resolver = "metar"; s.bucketRule = "round"; s.obsSource = "metar";
  s.settleGraceDays = num("SETTLE_GRACE_DAYS", 3);
  s.biasWindowDays = num("BIAS_WINDOW_DAYS", 30);
}

// Hong Kong is the one market that does not resolve off METAR, and every difference matters:
//
//   • Instrument: the HK Observatory HEADQUARTERS gauge in Tsim Sha Tsui, not the airport.
//     Over July 2026 the HQ daily max ran a mean -0.45 C from VHHH and differed by >=1 C on
//     13 of 31 days, so pointing this at the airport would inject its own bias plus noise.
//   • Bucket rule: HKO publishes to 0.1 C and Polymarket resolves to "the range that
//     contains" it. Checked against 31 resolved markets, floor(T) matched 31/31 while
//     round(T) matched 12/31 — so bucket "31C" is [31.0, 32.0), shifted a HALF DEGREE from
//     every other city. Using the METAR rule here would mis-centre every ladder.
//   • Publication: the Daily Extract lands with up to a month's lag, so settlement has to
//     wait rather than void.
UNIVERSE["Hong Kong"] = {
  city: "Hong Kong", icao: "HKO", lat: 22.302, lon: 114.174, elev: 32,
  tz: "Asia/Hong_Kong", name: "HK Observatory HQ", resolver: "hko",
  bucketRule: "floor", obsSource: "hko", settleGraceDays: num("HKO_SETTLE_GRACE_DAYS", 45),
  // The Daily Extract publishes about a month in arrears, so a 30-day bias window would
  // usually contain only a handful of readable days and the station would sit permanently
  // uncalibrated. The window is widened to cover the lag rather than the gate being relaxed.
  biasWindowDays: num("HKO_BIAS_WINDOW_DAYS", 90),
};

const CITY_KEYS = str("CITIES", "")
  ? str("CITIES", "").split(",").map(s => s.trim()).filter(c => UNIVERSE[c])
  : Object.keys(UNIVERSE).filter(c => !UNIVERSE[c].unsupported);

const STATIONS = CITY_KEYS.map(c => UNIVERSE[c]);

const cfg = {
  PORT:     num("PORT", 3003),
  DB_PATH:  str("DB_PATH", null),
  SCAN_MS:  num("SCAN_MS", 120000),        // markets are daily; a 2-min loop is plenty
  WX_TTL_MIN: num("WX_TTL_MIN", 45),       // forecast cache TTL (model runs are 6-12h apart)
  WX_CONCURRENCY: num("WX_CONCURRENCY", 6), // parallel station forecasts per scan

  KINDS:    str("KINDS", "high,low").split(",").map(s => s.trim()).filter(Boolean),

  // ── Horizon ────────────────────────────────────────────
  MIN_LEAD_DAYS: num("MIN_LEAD_DAYS", 1),  // D+1 and D+2 are where the ladder feeds (art. §5)
  MAX_LEAD_DAYS: num("MAX_LEAD_DAYS", 2),

  // ── Forecast model ─────────────────────────────────────
  ENS_MODELS: str("ENS_MODELS", "ecmwf_ifs025,gfs025,icon_seamless").split(",").map(s => s.trim()),
  DET_MODELS: str("DET_MODELS", "ecmwf_ifs025,gfs_seamless,icon_seamless,jma_seamless").split(",").map(s => s.trim()),
  W_DET:     num("W_DET", 0.65),           // center = W_DET*deterministic + (1-W_DET)*ensemble mean
  SPREAD_GAMMA: num("SPREAD_GAMMA", 0.5),  // how much today's ensemble spread moves sigma (0=climo, 1=full)
  SD_FLOOR:  num("SD_FLOOR", 0.6),         // deg C — representativeness floor, sigma never below this
  SD_FALLBACK: num("SD_FALLBACK", 1.6),    // deg C — predictive sigma before any error history exists
  SIGMA_MULT: num("SIGMA_MULT", 1.0),      // post-hoc sigma calibration; the backtest fits this
  EMPIRICAL_W: num("EMPIRICAL_W", 0),      // blend weight on the raw member histogram (0 = pure parametric)

  // The market aggregates information the ensemble does not have (later runs, local
  // knowledge, the readings already posted today). Blend toward it rather than assuming
  // the model is simply right: P_used = W_MODEL*P_model + (1-W_MODEL)*P_market_devigged.
  W_MODEL:  num("W_MODEL", 0.6),
  // Circuit breaker: if the model and the market describe different worlds, the model is
  // far likelier to be broken (stale run, wrong station, bad bias) than the book is.
  MAX_TVD:  num("MAX_TVD", 0.55),          // total-variation distance model vs market
  MAX_SANE_EV: num("MAX_SANE_EV", 1.5),    // an implied +150%/$ basket is a bug, not an edge

  // ── Bias correction (art. §8: "skip bias correction and the whole cluster is off-center") ──
  BIAS_WINDOW_DAYS: num("BIAS_WINDOW_DAYS", 30),
  BIAS_HALFLIFE_DAYS: num("BIAS_HALFLIFE_DAYS", 10),   // recent days weigh more (seasonal drift)
  MIN_BIAS_SAMPLES: num("MIN_BIAS_SAMPLES", 8),   // refuse to trade a station until it is calibrated
  BIAS_CLAMP:  num("BIAS_CLAMP", 4.0),            // deg C — never shift the center further than this

  // ── Underdispersion filter (art. §6) ───────────────────
  UNDERDISP_LO: num("UNDERDISP_LO", 0.85),  // today's spread / station median spread below this = tight
  OVERDISP_HI:  num("OVERDISP_HI", 1.25),   // above this = wide; widen the ladder or sit out
  TIGHT_BUDGET_MULT: num("TIGHT_BUDGET_MULT", 1.5),
  WIDE_BUDGET_MULT:  num("WIDE_BUDGET_MULT", 0.5),
  SKIP_WHEN_WIDE: bool("SKIP_WHEN_WIDE", false),
  MIN_DISP_SAMPLES: num("MIN_DISP_SAMPLES", 10),  // spread history needed before the filter is trusted

  // ── Ladder shape (art. §8: too wide and one winner barely profits) ──
  LADDER_MIN_W: num("LADDER_MIN_W", 3),
  LADDER_MAX_W: num("LADDER_MAX_W", 4),
  // 0.85 is not a round number: the walk-forward backtest measured a 89.8% realized cover
  // rate for 3-rung clusters, which puts the BREAK-EVEN basket cost at ~0.855 after the
  // weather taker fee. Paying more than that is a losing trade however good the forecast is.
  // `npm run backtest` recomputes it from current data.
  MAX_BASKET_COST: num("MAX_BASKET_COST", 0.85),  // sum of asks across the rungs
  MIN_BASKET_EV:   num("MIN_BASKET_EV", 0.08),    // min EV per $1 of basket cost, after fees
  MIN_COVER_PROB:  num("MIN_COVER_PROB", 0.70),   // model P(outcome lands in the cluster)

  // ── Costs ──────────────────────────────────────────────
  // Live weather markets return feeSchedule {exponent:1, rate:0.05, takerOnly:true}.
  // fee/share = FEE_RATE * min(q,1-q)^FEE_EXP  =>  a flat ~5% of stake for any q <= 0.5.
  FEE_RATE: num("FEE_RATE", 0.05),
  FEE_EXP:  num("FEE_EXP", 1),
  USE_MARKET_FEE_SCHEDULE: bool("USE_MARKET_FEE_SCHEDULE", true),
  SLIP:     num("SLIP", 0.002),            // extra probability-units paid crossing the book

  // ── Liquidity gates ────────────────────────────────────
  MAX_LEG_SPREAD_C: num("MAX_LEG_SPREAD_C", 6),
  MIN_LEG_DEPTH_USD: num("MIN_LEG_DEPTH_USD", 20),
  MIN_ORDER_SHARES: num("MIN_ORDER_SHARES", 5),   // Polymarket orderMinSize on these markets

  // ── Sizing ─────────────────────────────────────────────
  SIZING:   str("SIZING", "kelly"),        // kelly | prob | equal
  PAPER_BALANCE: num("PAPER_BALANCE", 1000),
  KELLY_K:  num("KELLY_K", 0.25),
  BUDGET_FRAC: num("BUDGET_FRAC", 0.02),   // max fraction of bankroll per market
  AGG_CAP:  num("AGG_CAP", 0.25),          // max aggregate open exposure

  // ── Settlement ─────────────────────────────────────────
  SETTLE_GRACE_DAYS: num("SETTLE_GRACE_DAYS", 3),   // void a basket the station never reported
  OBS_BACKFILL_PER_SCAN: num("OBS_BACKFILL_PER_SCAN", 12),
  SEED_DAYS: num("SEED_DAYS", 45),
  SEED_ON_BOOT: bool("SEED_ON_BOOT", true),

  // ── Backtest ───────────────────────────────────────────
  BACKTEST_DAYS: num("BACKTEST_DAYS", 60),
  BACKTEST_MIN_BASKETS: num("BACKTEST_MIN_BASKETS", 40),

  UNIVERSE, STATIONS, CITY_KEYS,
};

module.exports = cfg;
