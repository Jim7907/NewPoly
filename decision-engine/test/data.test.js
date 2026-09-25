// Data-layer parser / normalizer tests. Pure functions over captured (trimmed) fixtures —
// no network access. Requiring the modules must not open sockets either.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const http = require("../server/data/http");
const crypto = require("../server/data/crypto");
const stocks = require("../server/data/stocks");
const news = require("../server/data/news");
const macro = require("../server/data/macro");
const data = require("../server/data");

const FX = path.join(__dirname, "fixtures");
const json = f => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const txt = f => fs.readFileSync(path.join(FX, f), "utf8");
const DAY = 86400000;

function assertCandles(cs) {
  for (let i = 0; i < cs.length; i++) {
    const k = cs[i];
    for (const f of ["t", "o", "h", "l", "c", "v"]) assert.ok(Number.isFinite(k[f]), `candle[${i}].${f} finite`);
    assert.ok(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c), `candle[${i}] OHLC consistent`);
    if (i) assert.ok(k.t > cs[i - 1].t, "strictly ascending");
  }
}

// ── http helpers ───────────────────────────────────────────────
test("toNum parses money / percent / thousands strings", () => {
  assert.strictEqual(http.toNum("$1,234.50"), 1234.5);
  assert.strictEqual(http.toNum("24,733,100"), 24733100);
  assert.strictEqual(http.toNum("0.32%"), 0.32);
  assert.strictEqual(http.toNum("+0.44"), 0.44);
  assert.strictEqual(http.toNum("-1.10"), -1.1);
  assert.strictEqual(http.toNum("N/A"), null);
  assert.strictEqual(http.toNum(""), null);
  assert.strictEqual(http.toNum(NaN), null);
  assert.strictEqual(http.toNum(42), 42);
});

test("aggregateCandles buckets OHLCV", () => {
  const base = Date.UTC(2026, 0, 1);
  const m = [[1, 2, 0.5, 1.5, 10], [1.5, 3, 1.4, 2.5, 5], [2.5, 2.6, 2, 2.2, 1], [2.2, 2.4, 2.1, 2.3, 2]]
    .map(([o, h, l, c, v], i) => ({ t: base + i * 5 * 60000, o, h, l, c, v }));
  const out = http.aggregateCandles(m, 15 * 60000);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { t: base, o: 1, h: 3, l: 0.5, c: 2.2, v: 16 });
  assert.deepStrictEqual(out[1], { t: base + 15 * 60000, o: 2.2, h: 2.4, l: 2.1, c: 2.3, v: 2 });
});

test("cached de-dups in-flight calls, honours TTL, serves stale on error", async () => {
  let calls = 0;
  const fn = async () => { calls++; await http.sleep(10); return [calls]; };
  const [a, b] = await Promise.all([http.cached("t:1", 1000, fn), http.cached("t:1", 1000, fn)]);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(await http.cached("t:1", 1000, fn), [1]);
  // expire, then fail → stale value
  await http.cached("t:2", 1, async () => ["good"]);
  await http.sleep(5);
  assert.deepStrictEqual(await http.cached("t:2", 1, async () => { throw new Error("boom"); }), ["good"]);
  await assert.rejects(() => http.cached("t:3", 1000, async () => { throw new Error("no stale"); }));
});

test("withRetry retries 429/5xx but not 4xx", async () => {
  let n = 0;
  const v = await http.withRetry(async () => { if (++n < 3) { const e = new Error("x"); e.response = { status: 503, headers: {} }; throw e; } return "ok"; }, { retries: 3, baseMs: 1 });
  assert.strictEqual(v, "ok"); assert.strictEqual(n, 3);
  let m = 0;
  await assert.rejects(() => http.withRetry(async () => { m++; const e = new Error("nf"); e.response = { status: 404 }; throw e; }, { retries: 3, baseMs: 1 }));
  assert.strictEqual(m, 1);
});

// ── crypto ─────────────────────────────────────────────────────
test("Coinbase candles: newest-first [t,l,h,o,c,v] → ascending ms candles, de-duplicated", () => {
  const cs = crypto.normalizeCoinbaseCandles(json("coinbase_candles.json"));
  assert.strictEqual(cs.length, 5);                        // 6 rows incl. one duplicate
  assertCandles(cs);
  const last = cs[cs.length - 1];
  assert.deepStrictEqual(last, { t: 1790294400000, o: 84385.47, h: 85250, l: 83720, c: 84217.61, v: 2845.16531504 });
  assert.strictEqual(cs[0].t, 1789948800000);
  assert.deepStrictEqual(crypto.normalizeCoinbaseCandles({ message: "err" }), []);
});

test("Kraken OHLC → candles", () => {
  const cs = crypto.normalizeKrakenOHLC(json("kraken_ohlc.json").result);
  assert.strictEqual(cs.length, 4);
  assertCandles(cs);
  assert.deepStrictEqual(cs[3], { t: 1790294400000, o: 84380, h: 85247.4, l: 83740.1, c: 84360.6, v: 1366.1557478 });
});

test("Coinbase trade side is flipped from maker to taker", () => {
  const tr = crypto.normalizeTrades([
    { time: "2026-09-25T12:19:08.825Z", side: "buy", size: "0.5", price: "100" },   // maker bid hit → taker SELL
    { time: "2026-09-25T12:19:07.000Z", side: "sell", size: "0.25", price: "101" },
  ]);
  assert.strictEqual(tr[0].side, "buy");                 // ascending: the 12:19:07 print first
  assert.strictEqual(tr[0].size, 0.25);
  assert.strictEqual(tr[1].side, "sell");
  assert.strictEqual(crypto.aggressorSide("buy"), "sell");
});

test("book normalization + mid", () => {
  const b = crypto.normalizeBook({ bids: [["100", "1", 1], ["99", "2", 1]], asks: [["101", "3", 1]] });
  assert.deepStrictEqual(b, { bids: [[100, 1], [99, 2]], asks: [[101, 3]], mid: 100.5 });
  assert.strictEqual(crypto.normalizeBook({}).mid, null);
});

test("OKX derivatives + fear/greed + CoinGecko parsing", () => {
  const d = crypto.parseOkxDerivatives(json("okx_btc.json"));
  assert.ok(Math.abs(d.fundingRate - 0.0000662512534855) < 1e-15);
  assert.strictEqual(d.fundingHistory.length, 3);
  assert.ok(d.fundingHistory[0].t < d.fundingHistory[2].t);
  assert.strictEqual(d.oiHistory.length, 4);
  assert.ok(d.oiHistory[0].t < d.oiHistory[3].t && d.oiHistory[3].oi > 1e9);
  assert.ok(d.openInterest > 1e9);
  assert.ok(Number.isFinite(d.basisBps));
  assert.strictEqual(crypto.parseOkxDerivatives({}), null);

  const fg = crypto.parseFearGreed(json("fng.json"));
  assert.strictEqual(fg.value, 71);
  assert.strictEqual(fg.classification, "Greed");
  assert.strictEqual(fg.history.length, 5);
  assert.ok(fg.history[0].t < fg.history[4].t);

  const cg = crypto.parseCoinGecko(json("coingecko_bitcoin.json"), "BTC", 4.5e9);
  assert.strictEqual(cg.symbol, "BTC");
  assert.ok(cg.price > 0 && cg.marketCap > 0 && cg.maxSupply === 21000000);
  assert.strictEqual(cg.tvl, 4.5e9);
  assert.strictEqual(cg.devCommits4w, null);
});

// ── stocks: Nasdaq ─────────────────────────────────────────────
test("Nasdaq historical rows ('$1,234.50' strings, newest-first) → ascending candles", () => {
  const cs = stocks.parseNasdaqHistorical(json("nasdaq_historical_aapl.json"));
  assert.strictEqual(cs.length, 5);
  assertCandles(cs);
  assert.deepStrictEqual(cs[4], { t: Date.UTC(2026, 8, 24), o: 336.72, h: 338.91, l: 334.3, c: 335.92, v: 24733100 });
  assert.strictEqual(cs[3].o, 341.075);
  // ETF rows come without "$"
  const etf = stocks.parseNasdaqHistorical({ data: { tradesTable: { rows: [
    { date: "09/24/2026", close: "767.18", volume: "43,983,660", open: "764.065", high: "768.95", low: "763.245" },
    { date: "N/A", close: "1", volume: "1", open: "1", high: "1", low: "1" },
  ] } } });
  assert.strictEqual(etf.length, 1);
  assert.strictEqual(etf[0].c, 767.18);
  assert.deepStrictEqual(stocks.parseNasdaqHistorical({ data: null }), []);
});

test("Nasdaq intraday 1-min points → 15m candles in true UTC (ET wall-clock correction)", () => {
  const cs = stocks.parseNasdaqIntraday(json("nasdaq_chart_rs_aapl.json"), 900);
  assert.strictEqual(cs.length, 3);                           // 04:00–04:34 ET
  assertCandles(cs);
  // x = 1790308800000 is "4:00 AM ET" encoded as UTC; true time is 08:00Z (EDT, UTC−4).
  assert.strictEqual(cs[0].t, Date.UTC(2026, 8, 25, 8, 0));
  assert.strictEqual(cs[1].t - cs[0].t, 900000);
  assert.strictEqual(cs[0].o, 335.9925);
  assert.strictEqual(cs[0].l, 335.63);
  assert.ok(cs[0].v > 26000 && cs[0].v < 26100);              // from `w` shares
  const hourly = stocks.parseNasdaqIntraday(json("nasdaq_chart_rs_aapl.json"), 3600);
  assert.strictEqual(hourly.length, 1);
  assert.strictEqual(hourly[0].c, cs[2].c);
  // Points without volume → v = 0
  const nov = stocks.parseNasdaqIntraday({ data: { chart: [{ x: 1790308800000, y: 10 }, { x: 1790308860000, y: 11 }] } }, 300);
  assert.deepStrictEqual(nov, [{ t: Date.UTC(2026, 8, 25, 8, 0), o: 10, h: 11, l: 10, c: 11, v: 0 }]);
});

test("ET conversions handle EST and EDT", () => {
  assert.strictEqual(stocks.etWallToUtc(Date.UTC(2026, 0, 15, 9, 30)), Date.UTC(2026, 0, 15, 14, 30));   // EST
  assert.strictEqual(stocks.etWallToUtc(Date.UTC(2026, 6, 15, 9, 30)), Date.UTC(2026, 6, 15, 13, 30));   // EDT
  assert.strictEqual(stocks.parseEtTimestamp("Sep 25, 2026 8:17 AM ET"), Date.UTC(2026, 8, 25, 12, 17));
  assert.strictEqual(stocks.parseEtTimestamp("Closed at Sep 24, 2026 4:00 PM ET"), Date.UTC(2026, 8, 24, 20, 0));
  assert.strictEqual(stocks.parseEtTimestamp("garbage"), null);
});

test("Nasdaq quote + summary parsing", () => {
  const q = stocks.parseNasdaqQuote(json("nasdaq_info_aapl.json"));
  assert.strictEqual(q.price, 336.41);
  assert.strictEqual(q.change, 0.49);
  assert.strictEqual(q.marketStatus, "Pre-Market");
  assert.strictEqual(q.ts, Date.UTC(2026, 8, 25, 12, 17));
  const s = stocks.parseNasdaqSummary(json("nasdaq_summary_aapl.json"));
  assert.strictEqual(s.sector, "Technology");
  assert.strictEqual(s.industry, "Computer Manufacturing");
  assert.strictEqual(s.analystTarget, 335);
  assert.strictEqual(s.marketCap, 4908752443000);
  assert.ok(Math.abs(s.dividendYield - 0.0032) < 1e-12);
  assert.strictEqual(s.high52w, 345.34);
  assert.strictEqual(s.low52w, 243.42);
});

test("marketOpen: NYSE hours in America/New_York, weekends and holidays closed", () => {
  assert.strictEqual(stocks.marketOpen(Date.UTC(2026, 8, 25, 14, 0)), true);    // Fri 10:00 EDT
  assert.strictEqual(stocks.marketOpen(Date.UTC(2026, 8, 25, 13, 29)), false);  // 09:29
  assert.strictEqual(stocks.marketOpen(Date.UTC(2026, 8, 25, 20, 0)), false);   // 16:00 close
  assert.strictEqual(stocks.marketOpen(Date.UTC(2026, 8, 26, 15, 0)), false);   // Saturday
  assert.strictEqual(stocks.marketOpen(Date.UTC(2026, 11, 25, 15, 0)), false);  // Christmas
  assert.strictEqual(stocks.marketOpen(Date.UTC(2026, 0, 5, 14, 45)), true);    // Mon 09:45 EST
  assert.strictEqual(data.marketOpen(Date.UTC(2026, 0, 5, 14, 25)), false);     // 09:25 EST
});

// ── SEC EDGAR fundamentals ─────────────────────────────────────
test("SEC companyfacts (AAPL) → TTM / prior TTM / balance sheet", () => {
  const f = stocks.computeFundamentals(json("sec_companyfacts_aapl.json"), "AAPL");
  // Revenue TTM = FQ4'25 + FQ1..FQ3'26 (Q4 derived as FY − 9M YTD).
  assert.strictEqual(f.revenueTTM, 466823000000);
  assert.strictEqual(f.revenuePrevTTM, 408625000000);
  assert.strictEqual(f.netIncomeTTM, 128930000000);
  assert.strictEqual(f.netIncomePrevTTM, 99280000000);
  assert.strictEqual(f.grossProfitTTM, 227123000000);
  assert.strictEqual(f.operatingIncomeTTM, 154859000000);
  assert.ok(Math.abs(f.epsTTM - 8.71) < 1e-9);
  // CFO is only reported YTD in 10-Qs → quarters come from YTD differencing.
  assert.strictEqual(f.cfoTTM, 146724000000);
  assert.strictEqual(f.capexTTM, 10041000000);
  assert.strictEqual(f.fcfTTM, 146724000000 - 10041000000);
  assert.strictEqual(f.totalAssets, 383266000000);
  assert.strictEqual(f.totalAssetsPrev, 331495000000);
  assert.strictEqual(f.currentAssets, 149818000000);
  assert.strictEqual(f.currentLiabilities, 149326000000);
  assert.ok(Math.abs(f.currentRatioPrev - 122491 / 141120) < 1e-9);
  assert.strictEqual(f.longTermDebt, 71340000000);
  assert.strictEqual(f.longTermDebtPrev, 82430000000);
  assert.strictEqual(f.sharesOut, 14594180000);
  assert.strictEqual(f.sharesOutPrev, 14840390000);
  assert.strictEqual(f.periodEnd, "2026-06-27");
  assert.ok(Math.abs(f.roaPrev - 99280 / 331495) < 1e-9);
  assert.ok(Math.abs(f.grossMarginPrev - 190739 / 408625) < 1e-9);
  assert.strictEqual(f.interestExpenseTTM, null);             // tag not in fixture → null, not NaN
  for (const [k, v] of Object.entries(f)) if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} finite`);

  const m = stocks.mergeFundamentals(f, stocks.parseNasdaqSummary(json("nasdaq_summary_aapl.json")), { price: 336 }, "AAPL");
  assert.strictEqual(m.price, 336);
  assert.strictEqual(m.marketCap, 336 * 14594180000);
  assert.strictEqual(m.sector, "Technology");
  assert.ok(m.peRatio > 30 && m.peRatio < 45);
  assert.strictEqual(stocks.mergeFundamentals(null, null, null, "SPY"), null);
});

test("SEC TTM: Q4 = FY − Q1..Q3, contiguity, prior year, and annual-only fallback", () => {
  const q = (start, end, val, form = "10-Q", filed = end) => ({ start, end, val, form, filed });
  const facts = [
    q("2024-01-01", "2024-03-31", 10), q("2024-04-01", "2024-06-30", 11), q("2024-07-01", "2024-09-30", 12),
    q("2024-01-01", "2024-12-31", 50, "10-K", "2025-02-15"),                 // → Q4'24 = 17
    q("2025-01-01", "2025-03-31", 20), q("2025-04-01", "2025-06-30", 21), q("2025-07-01", "2025-09-30", 22),
    q("2025-01-01", "2025-12-31", 90, "10-K", "2026-02-15"),                 // → Q4'25 = 27
    q("2026-01-01", "2026-03-31", 30),
    q("2026-01-01", "2026-03-31", 31, "10-Q/A", "2026-06-01"),               // restatement wins
    q("2026-01-01", "2026-03-31", 999, "8-K", "2026-07-01"),                 // non-periodic form ignored
  ];
  const qs = stocks.quarterlySeries(facts);
  assert.deepStrictEqual(qs.slice(0, 2).map(x => [x.end, x.val]), [["2026-03-31", 31], ["2025-12-31", 27]]);
  const r = stocks.ttmFromFacts(facts);
  assert.strictEqual(r.ttm, 31 + 27 + 22 + 21);
  assert.strictEqual(r.prev, 20 + 17 + 12 + 11);
  assert.strictEqual(r.end, "2026-03-31");

  // Annual-only (20-F style) → latest FY and the one before.
  const annual = [q("2023-01-01", "2023-12-31", 100, "20-F"), q("2024-01-01", "2024-12-31", 120, "20-F")];
  assert.deepStrictEqual(stocks.ttmFromFacts(annual), { ttm: 120, prev: 100, end: "2024-12-31" });
  assert.deepStrictEqual(stocks.ttmFromFacts([]), { ttm: null, prev: null, end: null });

  // Instant values: latest and ~1y earlier; multi-class share counts summed per filing.
  const inst = stocks.instantFromFacts([
    { end: "2025-06-30", val: 5, filed: "2025-08-01", accn: "a" }, { end: "2026-06-30", val: 7, filed: "2026-08-01", accn: "b" },
    { end: "2026-03-31", val: 6, filed: "2026-05-01", accn: "c" },
  ]);
  assert.deepStrictEqual(inst, { latest: 7, prev: 5, end: "2026-06-30" });
  const cls = stocks.instantFromFacts([
    { end: "2026-07-20", val: 5.8e9, filed: "2026-07-25", accn: "x" }, { end: "2026-07-20", val: 0.86e9, filed: "2026-07-25", accn: "x" },
    { end: "2026-07-20", val: 5.3e9, filed: "2026-07-25", accn: "x" },
  ], { sumSameFiling: true });
  assert.ok(Math.abs(cls.latest - 11.96e9) < 1);
});

test("SEC tag fallbacks: GrossProfit from Revenue − CostOfRevenue; missing us-gaap → null", () => {
  const dur = (start, end, val) => ({ start, end, val, form: "10-Q", filed: end });
  const quarters = ["2025-07-01|2025-09-30", "2025-10-01|2025-12-31", "2026-01-01|2026-03-31", "2026-04-01|2026-06-30"];
  const series = v => quarters.map(p => dur(...p.split("|"), v));
  const facts = { facts: { "us-gaap": {
    SalesRevenueNet: { units: { USD: series(100) } },
    CostOfGoodsSold: { units: { USD: series(60) } },
    NetIncomeLoss: { units: { USD: series(10) } },
    Assets: { units: { USD: [{ end: "2026-06-30", val: 1000, filed: "2026-08-01", accn: "a" }] } },
  }, dei: {} } };
  const f = stocks.computeFundamentals(facts, "XYZ");
  assert.strictEqual(f.revenueTTM, 400);
  assert.strictEqual(f.grossProfitTTM, 160);
  assert.strictEqual(f.netIncomeTTM, 40);
  assert.strictEqual(f.totalAssets, 1000);
  assert.strictEqual(f.sharesOut, null);
  assert.strictEqual(stocks.computeFundamentals({ facts: {} }, "SPY"), null);
});

// ── news / social ──────────────────────────────────────────────
test("Google News RSS parsing: entities, CDATA, source suffix stripping, de-dup, newest-first", () => {
  const items = news.parseRss(txt("gnews_aapl.xml"));
  assert.strictEqual(items.length, 5);                        // 6 items, one duplicate title
  const cdata = items.find(i => i.source === "Reuters");
  assert.strictEqual(cdata.title, 'Apple & Nvidia beat estimates on "record" quarter');
  assert.strictEqual(cdata.url, "https://example.com/a?x=1&y=2");
  const ent = items.find(i => i.source === "MarketWatch");
  assert.strictEqual(ent.title, "Apple's \"AI\" push & margins — analysts weigh in");
  const yf = items.find(i => i.source === "Yahoo Finance");
  assert.strictEqual(yf.title, "Why Apple's stock chart is probably putting a smile on the face of new CEO John Ternus");
  assert.strictEqual(yf.ts, Date.parse("Wed, 23 Sep 2026 13:53:40 GMT"));
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].ts >= items[i].ts);
  for (const i of items) assert.ok(i.title && i.url && Number.isFinite(i.ts));
  assert.deepStrictEqual(news.parseRss(""), []);
  assert.strictEqual(news.decodeEntities("&amp;nbsp;&#8217;&#x41;&bogus;"), " ’A&bogus;");
});

test("StockTwits parsing counts Bullish / Bearish tags", () => {
  const s = news.parseStockTwits(json("stocktwits_aapl.json"));
  assert.strictEqual(s.total, 10);
  assert.strictEqual(s.bullish, 6);
  assert.strictEqual(s.bearish, 1);
  assert.ok(s.watchlistCount > 0);
  assert.strictEqual(s.messages.filter(m => m.sentiment === null).length, 3);
  assert.ok(s.messages.every(m => Number.isFinite(m.t) && typeof m.body === "string"));
  assert.strictEqual(news.parseStockTwits({}), null);
});

test("news query per asset class", () => {
  assert.strictEqual(news.newsQuery({ assetClass: "crypto", symbol: "BTC", name: "Bitcoin" }), "Bitcoin crypto");
  assert.strictEqual(news.newsQuery({ assetClass: "stock", symbol: "AAPL", name: "AAPL" }), "AAPL stock");
  assert.strictEqual(news.newsQuery({ assetClass: "stock", symbol: "SPY", etf: true }), "SPY ETF");
});

// ── macro ──────────────────────────────────────────────────────
test("FRED CSV parsing skips '.' and empty observations", () => {
  const s = macro.parseFredCsv(txt("fred_vixcls.csv"));
  assert.strictEqual(s.length, 5);
  assert.deepStrictEqual(s[0], { t: Date.UTC(2026, 8, 10), v: 16.02 });
  assert.deepStrictEqual(s[s.length - 1], { t: Date.UTC(2026, 8, 18), v: 16.45 });
  assert.ok(s.every(x => Number.isFinite(x.v)));
  assert.deepStrictEqual(macro.parseFredCsv(""), []);
});

// ── facade (offline-safe parts) ────────────────────────────────
test("facade: asset resolution and timeframe plan", () => {
  assert.strictEqual(data.resolveAsset("CRYPTO:BTC").coinbase, "BTC-USD");
  assert.strictEqual(data.resolveAsset("STOCK:SPY").etf, true);
  const x = data.resolveAsset("STOCK:ZZZT");
  assert.strictEqual(x.assetClass, "stock");
  assert.strictEqual(x.id, "STOCK:ZZZT");
  assert.strictEqual(data.resolveAsset("CRYPTO:PEPE").coinbase, "PEPE-USD");
  assert.strictEqual(data.resolveAsset(null), null);
  assert.deepStrictEqual(data.timeframesFor(86400, "crypto").map(data.tfName), ["15m", "1h", "1d"]);
  assert.deepStrictEqual(data.timeframesFor(86400, "stock").map(data.tfName), ["1h", "1d"]);
  assert.deepStrictEqual(data.timeframesFor(900, "stock").map(data.tfName), ["15m", "1h", "1d"]);
  assert.strictEqual(data.live("STOCK:AAPL"), null);
  assert.strictEqual(data.live("CRYPTO:BTC"), null);           // no stream started
});

// ── Audit regressions (2026-09) ──
test("audit: stock horizons run in NYSE session time (5 daily bars = 5 sessions), crypto in calendar time", () => {
  const H = 6.5 * 3600e3;
  const fri11 = Date.UTC(2026, 8, 25, 15, 0);                        // Fri 25 Sep 2026 11:00 EDT
  assert.strictEqual(stocks.horizonEndMs("stock", fri11, 5, 86400), Date.UTC(2026, 9, 2, 15, 0));   // next Fri 11:00
  const sat = Date.UTC(2026, 8, 26, 15, 0);                          // Saturday → next Fri close
  assert.strictEqual(stocks.horizonEndMs("stock", sat, 5, 86400), Date.UTC(2026, 9, 2, 20, 0));
  const friAfter = Date.UTC(2026, 8, 25, 21, 0);                     // Fri 17:00 EDT (after close)
  assert.strictEqual(stocks.horizonEndMs("stock", friAfter, 5, 86400), Date.UTC(2026, 9, 2, 20, 0));
  // holidays are skipped: Thu 26 Nov 2026 (Thanksgiving)
  const wed = Date.UTC(2026, 10, 25, 15, 0);                         // Wed 25 Nov 10:00 EST
  assert.strictEqual(stocks.horizonEndMs("stock", wed, 1, 86400), Date.UTC(2026, 10, 27, 15, 0));
  // intraday: 8 × 15m = 2 h of session time; 15:00 ET → 1 h today + 1 h next session
  const late = Date.UTC(2026, 8, 24, 19, 0);                         // Thu 15:00 EDT
  assert.strictEqual(stocks.horizonEndMs("stock", late, 8, 900), Date.UTC(2026, 8, 25, 14, 30));
  // exactly 5 sessions of trading time between start and end
  let mins = 0;
  for (let t = fri11; t < stocks.horizonEndMs("stock", fri11, 5, 86400); t += 60000) if (stocks.marketOpen(t)) mins++;
  assert.strictEqual(mins, 5 * 390);
  assert.strictEqual(stocks.horizonEndMs("crypto", fri11, 5, 86400), fri11 + 5 * 86400e3);
  assert.ok(H > 0);
});

test("audit: live Nasdaq intraday keeps only regular-session prints", () => {
  const pre = { x: Date.UTC(2026, 8, 25, 9, 0), y: 10, w: 5 };       // 09:00 ET (pre-market)
  const rth1 = { x: Date.UTC(2026, 8, 25, 9, 30), y: 11, w: 100 }, rth2 = { x: Date.UTC(2026, 8, 25, 15, 59), y: 12, w: 100 };
  const post = { x: Date.UTC(2026, 8, 25, 16, 0), y: 13, w: 5 };
  const json = { data: { chart: [pre, rth1, rth2, post] } };
  const all = stocks.parseNasdaqIntraday(json, 3600);
  const rth = stocks.parseNasdaqIntraday(json, 3600, { regularOnly: true });
  assert.ok(all.length > rth.length);
  assert.ok(rth.every((c) => stocks.marketOpen(c.t) || stocks.marketOpen(c.t + 1800e3)), JSON.stringify(rth));
  assert.strictEqual(rth.reduce((s, c) => s + c.v, 0), 200);
});
