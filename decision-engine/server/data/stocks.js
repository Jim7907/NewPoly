// US equities / ETFs (§3.2) + normalized StockFundamentals from SEC EDGAR (§3.3).
//   • Daily candles : Nasdaq /historical (rows newest-first, "$1,234.50" strings).
//   • Intraday      : Nasdaq /chart?charttype=rs (1-min points of the CURRENT/LAST session,
//                     x = ET wall-clock encoded as UTC ms) → aggregated to 5m/15m/1h.
//     Fallback for both: Yahoo v8 chart (frequently 429 from datacenter IPs — last resort).
//   • quote / summary: Nasdaq /info, /summary.
//   • fundamentals   : SEC companyfacts → TTM (last 4 discrete quarters) + prior TTM, balance
//                      sheet latest + ~1y earlier; merged with Nasdaq summary + live price.
// Stock daily candle `t` = 00:00 UTC of the trading date (same convention as crypto daily bars).
const { api, browser, sec, get, limiters, toNum, aggregateCandles, cleanCandles, cached } = require("./http");

const NASDAQ = "https://api.nasdaq.com/api";
const YAHOO = "https://query2.finance.yahoo.com/v8/finance/chart";
const SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json";
const SEC_FACTS = "https://data.sec.gov/api/xbrl/companyfacts";
const DAY = 86400000;
const KNOWN_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "VOO", "VTI", "TLT", "GLD", "SLV", "XLK", "XLF", "XLE", "XLV", "ARKK", "SMH", "HYG", "EEM", "EFA"]);

const assetClassParam = a => (a.etf || KNOWN_ETFS.has(a.symbol) ? "etf" : "stocks");
const nasdaqSym = s => String(s).toUpperCase().replace(/[.-]/g, ".");   // BRK.B style works on Nasdaq

// ── Eastern-time helpers ───────────────────────────────────────
const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
function etParts(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: p.weekday };
}
/** Offset (ms) to ADD to an ET wall-clock-as-UTC timestamp to get true UTC (4h EDT / 5h EST). */
function etOffsetMs(utcMs) {
  const p = etParts(utcMs);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((utcMs - wall) / 60000) * 60000;
}
function etWallToUtc(wallMs) {
  // First guess with the offset at wall+5h, then correct once (handles DST edges).
  let off = etOffsetMs(wallMs + 5 * 3600000);
  off = etOffsetMs(wallMs + off);
  return wallMs + off;
}
/** "Sep 25, 2026 8:17 AM ET" / "Closed at Sep 24, 2026 4:00 PM ET" → UTC ms (null if unparsable). */
function parseEtTimestamp(s) {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}) (AM|PM))?/.exec(String(s || ""));
  if (!m) return null;
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]);
  if (mo < 0) return null;
  let h = m[4] ? Number(m[4]) % 12 : 16;
  if (m[6] === "PM") h += 12;
  return etWallToUtc(Date.UTC(+m[3], mo, +m[2], h, m[5] ? +m[5] : 0));
}

// NYSE full-day holidays (best-effort, 2025–2027).
const HOLIDAYS = new Set([
  "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
/**
 * Advance `tradingMs` of NYSE REGULAR-SESSION time (09:30–16:00 ET, weekdays, listed holidays
 * excluded; half-days treated as full) from `fromMs`; time outside the session does not count.
 * E.g. 5 daily bars = 5 × 6.5 h: Fri 11:00 ET → next Fri 11:00 ET; Sat → next Fri 16:00 (close).
 */
function addTradingTime(fromMs, tradingMs, { maxDays = 800 } = {}) {
  const from = Number(fromMs), need = Math.max(0, Number(tradingMs) || 0);
  if (!Number.isFinite(from)) return NaN;
  let remaining = need, cur = from;
  const p = etParts(from);
  let dayWall = Date.UTC(p.y, p.mo - 1, p.d);
  for (let k = 0; k < maxDays; k++, dayWall += DAY) {
    const dt = new Date(dayWall), wd = dt.getUTCDay();
    if (wd === 0 || wd === 6 || HOLIDAYS.has(dt.toISOString().slice(0, 10))) continue;
    const open = etWallToUtc(dayWall + 570 * 60000), close = etWallToUtc(dayWall + 960 * 60000);
    if (cur >= close) continue;
    const start = Math.max(cur, open);
    if (remaining <= close - start) return start + remaining;
    remaining -= close - start;
    cur = close;
  }
  return from + need;
}

/**
 * Wall-clock end of a label / holding period of `ahead` bars of `tfSec` starting at `fromMs`.
 * Crypto trades 24/7 (plain calendar time). Stocks count only regular-session time: a daily bar is
 * one 6.5 h session, an intraday bar is tfSec of session time. AUDIT (2026-09): the engine and the
 * paper portfolio used fromMs + ahead·tfSec·1000 for stocks too, so a "5-bar" swing label or
 * position expiry spanned only 3.0–4.8 trading days (mean ≈ 3.4) instead of the 5 the backtests,
 * the ML labels and the calibrator were built on.
 */
function horizonEndMs(assetClass, fromMs, ahead, tfSec) {
  const n = Math.max(0, Number(ahead) || 0), tf = Math.max(1, Number(tfSec) || 86400);
  if (assetClass !== "stock") return Number(fromMs) + n * tf * 1000;
  const perBar = tf >= 86400 ? (tf / 86400) * 6.5 * 3600e3 : tf * 1000;
  return addTradingTime(fromMs, n * perBar);
}

/** NYSE regular session: weekdays 09:30–16:00 America/New_York, excluding listed holidays. */
function marketOpen(now = Date.now()) {
  const p = etParts(typeof now === "number" ? now : new Date(now).getTime());
  if (p.wd === "Sat" || p.wd === "Sun") return false;
  const key = `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  if (HOLIDAYS.has(key)) return false;
  const mins = p.h * 60 + p.mi;
  return mins >= 570 && mins < 960;
}

// ── Nasdaq parsers (exported for tests) ────────────────────────
/** /historical JSON → Candle[] ascending. Rows: {date:"09/24/2026", close:"$335.92", volume:"24,733,100", ...} */
function parseNasdaqHistorical(json) {
  const rows = json?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) return [];
  return cleanCandles(rows.map(r => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(r.date || "").trim());
    if (!m) return null;
    const c = toNum(r.close);
    const o = toNum(r.open) ?? c, h = toNum(r.high) ?? Math.max(o ?? c, c), l = toNum(r.low) ?? Math.min(o ?? c, c);
    return { t: Date.UTC(+m[3], +m[1] - 1, +m[2]), o, h, l, c, v: toNum(r.volume) ?? 0 };
  }));
}

/**
 * /chart JSON (1-min points {x: ET-wall-clock-as-UTC ms, y: price, w?: shares}) → Candle[] at tfSec.
 * Points carry only a price, so each bucket's OHLC comes from the minute prints; volume from `w`
 * (charttype=rs) or `z.shares`, else 0. opts.regularOnly keeps only 09:30–16:00 ET prints: the feed
 * starts at 04:00 ET, and thin pre/post-market bars (tiny ranges, ~1% of normal volume) were being
 * appended to RTH-only Yahoo history, distorting ATR, volume z-scores and every 1h/15m signal
 * (AUDIT 2026-09). The live fetcher uses regularOnly; the parser default is unchanged.
 */
function parseNasdaqIntraday(json, tfSec = 900, { regularOnly = false } = {}) {
  const pts = json?.data?.chart;
  if (!Array.isArray(pts)) return [];
  const minute = [];
  for (const p of pts) {
    const x = Number(p?.x), y = toNum(p?.y ?? p?.z?.value ?? p?.z?.price);
    if (!Number.isFinite(x) || !(y > 0)) continue;
    if (regularOnly) {
      const m = Math.floor((((x % DAY) + DAY) % DAY) / 60000);   // ET wall-clock minute of day
      if (m < 570 || m >= 960) continue;
    }
    const v = toNum(p?.w ?? p?.z?.shares) ?? 0;
    minute.push({ t: etWallToUtc(x), o: y, h: y, l: y, c: y, v });
  }
  minute.sort((a, b) => a.t - b.t);
  return aggregateCandles(minute, tfSec * 1000);
}

/** Yahoo v8 chart JSON → Candle[] ascending. */
function parseYahooChart(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  return cleanCandles(ts.map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0 })));
}

function parseNasdaqQuote(json) {
  const d = json?.data;
  if (!d) return null;
  const pd = d.primaryData || {}, sd = d.secondaryData || {};
  const price = toNum(pd.lastSalePrice) ?? toNum(sd.lastSalePrice);
  if (!(price > 0)) return null;
  const pct = toNum(pd.percentageChange);
  return {
    price, ts: parseEtTimestamp(pd.lastTradeTimestamp) || Date.now(),
    change: toNum(pd.netChange), changePct: pct, volume: toNum(pd.volume),
    bid: toNum(pd.bidPrice), ask: toNum(pd.askPrice),
    prevClose: toNum(sd.lastSalePrice), marketStatus: d.marketStatus || null, name: d.companyName || null,
  };
}

function parseNasdaqSummary(json) {
  const s = json?.data?.summaryData;
  if (!s) return null;
  const v = k => s[k]?.value;
  const yieldPct = toNum(v("Yield") ?? v("CurrentYield"));
  const hl = String(v("FiftTwoWeekHighLow") || "").split("/").map(toNum);
  return {
    exchange: v("Exchange") || null, sector: v("Sector") || null, industry: v("Industry") || null,
    analystTarget: toNum(v("OneYrTarget")), marketCap: toNum(v("MarketCap")),
    peRatio: toNum(v("PERatio")), forwardPE: toNum(v("ForwardPE1Yr")), eps: toNum(v("EarningsPerShare")),
    dividendYield: yieldPct != null ? yieldPct / 100 : null, annualDividend: toNum(v("AnnualizedDividend")),
    avgVolume: toNum(v("AverageVolume") ?? v("FiftyDayAvgDailyVol")), beta: toNum(v("Beta")),
    high52w: hl[0] ?? null, low52w: hl[1] ?? null,
    aum: toNum(v("AUM")), expenseRatio: toNum(v("ExpenseRatio")),
  };
}

// ── Candles ────────────────────────────────────────────────────
const ymd = ms => new Date(ms).toISOString().slice(0, 10);

async function nasdaqDaily(asset, limit) {
  const from = Date.now() - Math.ceil(limit * 1.47 + 10) * DAY;       // ~252 trading days / 365
  const url = `${NASDAQ}/quote/${nasdaqSym(asset.symbol)}/historical?assetclass=${assetClassParam(asset)}` +
    `&fromdate=${ymd(from)}&todate=${ymd(Date.now() + DAY)}&limit=9999`;
  return parseNasdaqHistorical(await get(browser, url, { limiter: limiters.nasdaq, retries: 1 })).slice(-limit);
}

async function nasdaqIntraday(asset, tfSec) {
  const url = `${NASDAQ}/quote/${nasdaqSym(asset.symbol)}/chart?assetclass=${assetClassParam(asset)}&charttype=rs`;
  return parseNasdaqIntraday(await get(browser, url, { limiter: limiters.nasdaq, retries: 1 }), tfSec, { regularOnly: true });
}

async function yahooCandles(asset, tfSec, limit) {
  // Yahoo is rate-limited from here; remember failures for 10 minutes to avoid hammering it.
  return cached(`yahoo:${asset.symbol}:${tfSec}`, tfSec >= 86400 ? 10 * 60000 : 60000, async () => {
    const interval = { 60: "1m", 300: "5m", 900: "15m", 3600: "60m", 86400: "1d" }[tfSec] || "15m";
    const range = tfSec >= 86400 ? (limit > 500 ? "5y" : "2y") : tfSec >= 3600 ? "730d" : tfSec >= 300 ? "60d" : "7d";
    const sym = asset.symbol.replace(".", "-");
    const d = await get(api, `${YAHOO}/${sym}?interval=${interval}&range=${range}`, { limiter: limiters.yahoo, retries: 0, timeout: 6000 });
    return parseYahooChart(d);
  }, { emptyTtlMs: 10 * 60000 }).catch(() => []);
}

/** candles(asset, tfSec, limit) → Candle[] ascending. Intraday history = current/last session only. */
async function candles(asset, tfSec = 86400, limit = 300) {
  if (tfSec >= 86400) {
    let cs = [];
    try { cs = await nasdaqDaily(asset, limit); } catch { cs = []; }
    if (cs.length < Math.min(limit, 30)) {
      const y = await yahooCandles(asset, 86400, limit);
      if (y.length > cs.length) cs = y.slice(-limit);
    }
    if (tfSec > 86400) cs = aggregateCandles(cs, tfSec * 1000).slice(-limit);
    return cs;
  }
  let cs = [];
  try { cs = await nasdaqIntraday(asset, tfSec); } catch { cs = []; }
  if (cs.length < limit) {
    // Try to extend history with Yahoo (multi-day); Nasdaq prints win on overlap.
    const y = await yahooCandles(asset, tfSec, limit);
    if (y.length) cs = cleanCandles([...y, ...cs]);
  }
  return cs.slice(-limit);
}

async function quote(asset) {
  try {
    const d = await get(browser, `${NASDAQ}/quote/${nasdaqSym(asset.symbol)}/info?assetclass=${assetClassParam(asset)}`, { limiter: limiters.nasdaq, retries: 1 });
    return parseNasdaqQuote(d);
  } catch { return null; }
}

async function summary(asset) {
  try {
    const d = await get(browser, `${NASDAQ}/quote/${nasdaqSym(asset.symbol)}/summary?assetclass=${assetClassParam(asset)}`, { limiter: limiters.nasdaq, retries: 1 });
    return parseNasdaqSummary(d);
  } catch { return null; }
}

// ── SEC EDGAR: TTM computation (pure; exported for tests) ──────
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const isFiling = f => /^(10-K|10-Q|20-F|40-F|10-KT|10-QT)(\/A)?$/.test(f.form || "");

function unitFacts(tagObj, unitPrefs = ["USD", "USD/shares", "shares"]) {
  if (!tagObj?.units) return [];
  for (const u of unitPrefs) if (Array.isArray(tagObj.units[u])) return tagObj.units[u];
  const first = Object.values(tagObj.units)[0];
  return Array.isArray(first) ? first : [];
}

/**
 * Discrete fiscal quarters from duration facts, newest first: [{start, end, val}].
 * Sources: (1) direct ~3-month facts; (2) differences of cumulative YTD facts sharing a start
 * date (6M−3M, 9M−6M, FY−9M — cash-flow items are usually only reported YTD); (3) Q4 = FY − Q1..Q3.
 * Duplicate (start,end) pairs keep the latest-filed value (restatements win).
 */
function quarterlySeries(facts) {
  const byPeriod = new Map();
  for (const f of facts || []) {
    if (!f.start || !f.end || !Number.isFinite(f.val) || !isFiling(f)) continue;
    const k = `${f.start}|${f.end}`;
    const prev = byPeriod.get(k);
    if (!prev || (f.filed || "") >= (prev.filed || "")) byPeriod.set(k, f);
  }
  const periods = [...byPeriod.values()].map(f => ({ start: f.start, end: f.end, val: f.val, d: days(f.start, f.end) }));
  const quarters = new Map();                               // end -> {start,end,val,src}
  const put = (q, src) => { if (!quarters.has(q.end)) quarters.set(q.end, { start: q.start, end: q.end, val: q.val, src }); };
  for (const p of periods) if (p.d >= 80 && p.d <= 100) put(p, "q");
  // Cumulative (YTD) differencing.
  const byStart = new Map();
  for (const p of periods) if (p.d >= 80 && p.d <= 380) (byStart.get(p.start) || byStart.set(p.start, []).get(p.start)).push(p);
  for (const arr of byStart.values()) {
    arr.sort((a, b) => a.d - b.d);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i], gap = b.d - a.d;
      if (gap >= 80 && gap <= 100) put({ start: new Date(Date.parse(a.end) + DAY).toISOString().slice(0, 10), end: b.end, val: b.val - a.val }, "ytd");
    }
  }
  // Q4 = FY − (three discrete quarters inside the fiscal year).
  for (const p of periods) {
    if (p.d < 350 || p.d > 380 || quarters.has(p.end)) continue;
    const inside = [...quarters.values()].filter(q => days(p.start, q.start) >= -7 && days(q.end, p.end) >= 70);
    if (inside.length === 3) {
      const lastEnd = inside.map(q => q.end).sort().pop();
      put({ start: new Date(Date.parse(lastEnd) + DAY).toISOString().slice(0, 10), end: p.end, val: p.val - inside.reduce((s, q) => s + q.val, 0) }, "fy-3q");
    }
  }
  return [...quarters.values()].sort((a, b) => (a.end < b.end ? 1 : -1));
}

/** Annual (FY) facts, newest first — used when fewer than 4 contiguous quarters exist (e.g. 20-F filers). */
function annualSeries(facts) {
  const m = new Map();
  for (const f of facts || []) {
    if (!f.start || !f.end || !Number.isFinite(f.val) || !isFiling(f)) continue;
    const d = days(f.start, f.end);
    if (d < 350 || d > 380) continue;
    const prev = m.get(f.end);
    if (!prev || (f.filed || "") >= (prev.filed || "")) m.set(f.end, f);
  }
  return [...m.values()].sort((a, b) => (a.end < b.end ? 1 : -1)).map(f => ({ start: f.start, end: f.end, val: f.val }));
}

/** { ttm, prev, end } — sum of the latest 4 contiguous quarters and the 4 before them. */
function ttmFromFacts(facts) {
  const qs = quarterlySeries(facts);
  const chain = [];
  for (const q of qs) {
    if (!chain.length) { chain.push(q); continue; }
    const last = chain[chain.length - 1];
    const gap = days(q.end, last.start);                      // previous quarter ends the day before
    if (gap >= -3 && gap <= 10) chain.push(q);
    else if (q.end < last.start) break;
    if (chain.length >= 8) break;
  }
  const annual = annualSeries(facts);
  const sum = a => a.reduce((s, q) => s + q.val, 0);
  if (chain.length >= 4) {
    // Prefer quarters, but if a newer FY exists than the latest quarter, annual data is fresher.
    if (!(annual.length && annual[0].end > chain[0].end)) {
      return { ttm: sum(chain.slice(0, 4)), prev: chain.length >= 8 ? sum(chain.slice(4, 8)) : (annual.find(a => Math.abs(days(a.end, chain[3].start)) <= 10)?.val ?? null), end: chain[0].end };
    }
  }
  if (annual.length) {
    const prev = annual.find(a => Math.abs(days(a.end, annual[0].start)) <= 10);
    return { ttm: annual[0].val, prev: prev ? prev.val : null, end: annual[0].end };
  }
  return { ttm: null, prev: null, end: null };
}

/** { latest, prev, end } from direct ~3-month duration facts (no differencing) — for averages
 *  like weighted diluted shares, where YTD differences are meaningless. */
function quarterPointFromFacts(facts) {
  const m = new Map();
  for (const f of facts || []) {
    if (!f.start || !f.end || !Number.isFinite(f.val) || !isFiling(f)) continue;
    const d = days(f.start, f.end);
    if (d < 80 || d > 100) continue;
    const prev = m.get(f.end);
    if (!prev || (f.filed || "") >= (prev.filed || "")) m.set(f.end, f);
  }
  return instantFromFacts([...m.values()].map(f => ({ end: f.end, val: f.val, filed: f.filed, accn: f.accn })));
}

/** { latest, prev, end } for point-in-time facts; prev = value ~1y before latest (±60d). */
function instantFromFacts(facts, { sumSameFiling = false } = {}) {
  const byEnd = new Map();                                  // end -> {filed, accn, vals[]}
  for (const f of facts || []) {
    if (!f.end || !Number.isFinite(f.val) || f.start) continue;
    const cur = byEnd.get(f.end);
    const filed = f.filed || "";
    if (!cur || filed > cur.filed) byEnd.set(f.end, { filed, accn: f.accn, vals: [f.val] });
    // Multi-class cover pages list one count per class: sum the DISTINCT values in one filing.
    else if (filed === cur.filed && f.accn === cur.accn && sumSameFiling && !cur.vals.includes(f.val)) cur.vals.push(f.val);
  }
  const rows = [...byEnd.entries()].map(([end, r]) => ({ end, val: sumSameFiling ? r.vals.reduce((a, b) => a + b, 0) : r.vals[r.vals.length - 1] }))
    .sort((a, b) => (a.end < b.end ? 1 : -1));
  if (!rows.length) return { latest: null, prev: null, end: null };
  const target = Date.parse(rows[0].end) - 365 * DAY;
  let best = null;
  for (const r of rows.slice(1)) {
    const dd = Math.abs(Date.parse(r.end) - target) / DAY;
    if (dd <= 60 && (!best || dd < best.dd)) best = { ...r, dd };
  }
  return { latest: rows[0].val, prev: best ? best.val : null, end: rows[0].end };
}

// Tag fallbacks (first match with the most recent data wins).
const TAGS = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet", "RevenuesNetOfInterestExpense"],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"],
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"],
  cfo: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"],
  interest: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense", "InterestPaidNet"],
  assets: ["Assets"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  liabilities: ["Liabilities"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  retainedEarnings: ["RetainedEarningsAccumulatedDeficit"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
  sharesOutGaap: ["CommonStockSharesOutstanding"],
};

function pickDuration(gaap, tags) {
  let best = null;
  for (const t of tags) {
    const r = ttmFromFacts(unitFacts(gaap[t]));
    if (r.ttm == null) continue;
    if (!best || r.end > best.end) best = { ...r, tag: t };
  }
  return best || { ttm: null, prev: null, end: null, tag: null };
}
function pickInstant(gaap, tags, opts) {
  let best = null;
  for (const t of tags) {
    const r = instantFromFacts(unitFacts(gaap[t]), opts);
    if (r.latest == null) continue;
    if (!best || r.end > best.end) best = { ...r, tag: t };
  }
  return best || { latest: null, prev: null, end: null, tag: null };
}

const div = (a, b) => (a != null && b != null && b !== 0 && Number.isFinite(a / b) ? a / b : null);
const sub = (a, b) => (a != null && b != null ? a - b : null);

/** SEC companyfacts JSON → StockFundamentals core (no market data). */
function computeFundamentals(facts, symbol) {
  const gaap = facts?.facts?.["us-gaap"] || facts?.facts?.["ifrs-full"] || {};
  const dei = facts?.facts?.dei || {};
  if (!Object.keys(gaap).length) return null;

  const rev = pickDuration(gaap, TAGS.revenue);
  const ni = pickDuration(gaap, TAGS.netIncome);
  const op = pickDuration(gaap, TAGS.operatingIncome);
  let gp = pickDuration(gaap, TAGS.grossProfit);
  if (gp.ttm == null || (rev.end && gp.end && gp.end < rev.end)) {
    const cogs = pickDuration(gaap, TAGS.costOfRevenue);
    if (cogs.ttm != null && rev.ttm != null && cogs.end === rev.end) gp = { ttm: rev.ttm - cogs.ttm, prev: sub(rev.prev, cogs.prev), end: rev.end, tag: "Revenue-CostOfRevenue" };
  }
  const eps = pickDuration(gaap, TAGS.eps);
  const cfo = pickDuration(gaap, TAGS.cfo);
  const capex = pickDuration(gaap, TAGS.capex);
  const intr = pickDuration(gaap, TAGS.interest);
  const assets = pickInstant(gaap, TAGS.assets);
  const ca = pickInstant(gaap, TAGS.currentAssets);
  const cl = pickInstant(gaap, TAGS.currentLiabilities);
  const liab = pickInstant(gaap, TAGS.liabilities);
  const ltd = pickInstant(gaap, TAGS.longTermDebt);
  const eq = pickInstant(gaap, TAGS.equity);
  const re = pickInstant(gaap, TAGS.retainedEarnings);
  const cash = pickInstant(gaap, TAGS.cash);
  // Shares: dei cover-page count (multi-class issuers report one fact per class → sum per filing).
  let shares = instantFromFacts(unitFacts(dei.EntityCommonStockSharesOutstanding, ["shares"]), { sumSameFiling: true });
  if (shares.latest == null) shares = pickInstant(gaap, TAGS.sharesOutGaap);
  if (shares.latest == null) shares = quarterPointFromFacts(unitFacts(gaap.WeightedAverageNumberOfDilutedSharesOutstanding, ["shares"]));

  // Drop series a company stopped reporting (e.g. a tag last used 3 years ago would otherwise
  // masquerade as current TTM): anything > ~400 days older than the freshest statement is null.
  const refEnd = [rev.end, ni.end, assets.end].filter(Boolean).sort().pop();
  const stale = r => r.end && refEnd && days(r.end, refEnd) > 400;
  for (const r of [rev, ni, op, gp, eps, cfo, capex, intr]) if (stale(r)) { r.ttm = null; r.prev = null; }
  for (const r of [assets, ca, cl, liab, ltd, eq, re, cash, shares]) if (stale(r)) { r.latest = null; r.prev = null; }

  const totalLiabilities = liab.latest ?? sub(assets.latest, eq.latest);
  const periodEnd = [rev.end, ni.end, assets.end].filter(Boolean).sort().pop() || null;
  return {
    symbol, name: facts.entityName || null, cik: facts.cik ?? null, periodEnd,
    sharesOut: shares.latest, sharesOutPrev: shares.prev,
    revenueTTM: rev.ttm, revenuePrevTTM: rev.prev,
    grossProfitTTM: gp.ttm, grossProfitPrevTTM: gp.prev,
    operatingIncomeTTM: op.ttm,
    netIncomeTTM: ni.ttm, netIncomePrevTTM: ni.prev,
    epsTTM: eps.ttm, epsPrevTTM: eps.prev,
    cfoTTM: cfo.ttm, capexTTM: capex.ttm != null ? Math.abs(capex.ttm) : null,
    fcfTTM: cfo.ttm != null && capex.ttm != null ? cfo.ttm - Math.abs(capex.ttm) : cfo.ttm,
    totalAssets: assets.latest, totalAssetsPrev: assets.prev,
    currentAssets: ca.latest, currentLiabilities: cl.latest,
    currentAssetsPrev: ca.prev, currentLiabilitiesPrev: cl.prev,
    currentRatioPrev: div(ca.prev, cl.prev),
    totalLiabilities,
    longTermDebt: ltd.latest, longTermDebtPrev: ltd.prev,
    equity: eq.latest, retainedEarnings: re.latest,
    ebitTTM: op.ttm,
    interestExpenseTTM: intr.ttm != null ? Math.abs(intr.ttm) : null,
    grossMarginPrev: div(gp.prev, rev.prev),
    assetTurnoverPrev: div(rev.prev, assets.prev),
    roaPrev: div(ni.prev, assets.prev),
    cash: cash.latest,
    tags: { revenue: rev.tag, netIncome: ni.tag, grossProfit: gp.tag, longTermDebt: ltd.tag, cash: cash.tag },
  };
}

/** Merge SEC core + Nasdaq summary + quote into the §3.3 StockFundamentals shape. */
function mergeFundamentals(core, sum, q, symbol) {
  if (!core) return null;
  const price = q?.price ?? null;
  let marketCap = price != null && core.sharesOut ? price * core.sharesOut : null;
  // Multi-class oddities (e.g. BRK A/B) make price × cover-page shares meaningless: trust Nasdaq's
  // market cap when the two disagree by more than 2×.
  if (sum?.marketCap > 0 && (marketCap == null || marketCap / sum.marketCap > 2 || marketCap / sum.marketCap < 0.5)) marketCap = sum.marketCap;
  const pe = sum?.peRatio
    ?? (marketCap > 0 && core.netIncomeTTM > 0 ? marketCap / core.netIncomeTTM : null)
    ?? (price != null && core.epsTTM > 0 ? price / core.epsTTM : null);
  return {
    ...core, symbol, asOf: new Date().toISOString(), price, marketCap,
    sector: sum?.sector ?? null, industry: sum?.industry ?? null,
    analystTarget: sum?.analystTarget ?? null, peRatio: pe, dividendYield: sum?.dividendYield ?? null,
  };
}

// ── SEC fetchers ───────────────────────────────────────────────
async function tickerMap() {
  return cached("sec:tickers", 24 * 3600000, async () => {
    const d = await get(sec, SEC_TICKERS, { limiter: limiters.sec });
    const m = {};
    for (const r of Object.values(d || {})) if (r?.ticker) m[String(r.ticker).toUpperCase()] = r.cik_str;
    return Object.keys(m).length ? m : null;
  });
}

async function cikFor(symbol) {
  const m = await tickerMap();
  if (!m) return null;
  const s = String(symbol).toUpperCase();
  return m[s] ?? m[s.replace(".", "-")] ?? m[s.replace("-", ".")] ?? null;
}

async function secCore(symbol) {
  return cached(`sec:core:${symbol}`, 12 * 3600000, async () => {
    const cik = await cikFor(symbol);
    if (!cik) return null;
    const url = `${SEC_FACTS}/CIK${String(cik).padStart(10, "0")}.json`;
    const facts = await get(sec, url, { limiter: limiters.sec, retries: 2 });
    return computeFundamentals(facts, symbol);               // the multi-MB JSON is dropped here
  }, { emptyTtlMs: 30 * 60000 });
}

/** fundamentals(asset) → StockFundamentals | null (ETFs → null). */
async function fundamentals(asset) {
  if (asset.etf || KNOWN_ETFS.has(asset.symbol)) return null;
  try {
    const [core, sum, q] = await Promise.all([
      secCore(asset.symbol).catch(() => null), summary(asset), quote(asset),
    ]);
    return mergeFundamentals(core, sum, q, asset.symbol);
  } catch { return null; }
}

module.exports = {
  candles, quote, summary, fundamentals, marketOpen, addTradingTime, horizonEndMs,
  // pure (tests)
  parseNasdaqHistorical, parseNasdaqIntraday, parseYahooChart, parseNasdaqQuote, parseNasdaqSummary,
  parseEtTimestamp, etWallToUtc, etOffsetMs,
  quarterlySeries, annualSeries, ttmFromFacts, instantFromFacts, quarterPointFromFacts, computeFundamentals, mergeFundamentals,
  KNOWN_ETFS, TAGS,
};
