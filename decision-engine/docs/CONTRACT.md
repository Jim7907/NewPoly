# Decision Engine — Module Contract

This file is the single source of truth that every module is built against. Conventions match
the sibling `crypto15m/` project: **Node 20+, CommonJS (`require`/`module.exports`), no TypeScript,
no native deps**, pure functions wherever possible, `node:test` + `node:assert` for tests (run with
`npm test`, which executes every `test/*.test.js`). Tests must be deterministic and **must not hit
the network** — use fixtures in `test/fixtures/` or synthetic data.

Runtime deps available: `axios`, `express`, `cors`, `ws`, `sql.js`, `dotenv`. Do **not** add deps
without a very strong reason (the math/ML is hand-written on purpose — auditable, dependency-free).

Config: `server/config.js` (read it). Paper trading is the **only** execution mode — never write
code that places real orders.

---

## 1. Core data shapes

```js
// Candle — times are epoch **milliseconds** (bar open time), ascending order, no duplicates.
{ t: 1727222400000, o: 101.2, h: 103.9, l: 100.7, c: 103.1, v: 123456.7 }

// Asset (from config.ASSETS)
{ id: "CRYPTO:BTC", symbol: "BTC", assetClass: "crypto", name: "Bitcoin", coinbase: "BTC-USD", ... }
{ id: "STOCK:AAPL", symbol: "AAPL", assetClass: "stock", name: "AAPL", etf: false }

// Signal — the universal output of every analyzer. One analyzer may emit several signals.
{
  id: "tech.trend.ema_stack",        // stable dotted id: <family>.<subfamily>.<name>
  family: "technical",               // "technical" | "regime" | "fundamental" | "sentiment"
                                     // | "macro" | "microstructure" | "ml" | "llm" | "derivatives"
  score: 0.62,                       // directional view in [-1, +1]; +1 = maximally bullish
  confidence: 0.7,                   // how much this signal trusts ITSELF right now, [0, 1]
                                     // (data quality, sample size, strength of pattern)
  horizon: "swing",                  // which horizon it speaks to (or "any")
  value: { ema20: 101.2, ema50: 99 },// raw numbers behind the score, for UI / audit (small!)
  reason: "EMA20 > EMA50 > EMA200, price above all — established uptrend",  // one human sentence
}
```

A signal with no opinion returns `score: 0, confidence: 0` (or is omitted). **Never NaN** — every
module must guard against NaN/Infinity and short inputs (return `[]` / neutral signal).

---

## 2. Modules

### 2.1 `server/analysis/indicators.js` — pure indicator math (arrays in, arrays out)
All take plain number arrays (or candles where noted) and return arrays **aligned to the input
length**, with `null` for warm-up positions. Required exports:

`sma(x,n) ema(x,n) wma(x,n) stdev(x,n) rsi(x,n=14) macd(x,fast=12,slow=26,signal=9)->{macd,signal,hist}
bollinger(x,n=20,k=2)->{mid,upper,lower,pctB,bandwidth} atr(candles,n=14) adx(candles,n=14)->{adx,pdi,mdi}
stochastic(candles,k=14,d=3)->{k,d} cci(candles,n=20) williamsR(candles,n=14) roc(x,n) obv(candles)
mfi(candles,n=14) vwap(candles) (cumulative, session-agnostic) donchian(candles,n=20)->{upper,lower,mid}
keltner(candles,n=20,mult=2)->{mid,upper,lower} ichimoku(candles)->{tenkan,kijun,spanA,spanB}
supertrend(candles,n=10,mult=3)->{line,dir} (dir +1/-1) logReturns(x) realizedVol(x,n) (per-bar stdev of log returns)
hurst(x) (scalar, R/S on log returns, needs >=64 pts else null) efficiencyRatio(x,n) (Kaufman)
linregSlope(x,n) (slope of log price per bar, aligned) zscore(x,n) percentileRank(x,n) (0..1, aligned)
kalmanTrend(x,{q,r})->{level,slope} (local-linear-trend Kalman filter on log price)`

### 2.2 `server/analysis/technical.js`
`analyze(candles, { horizon, assetClass }) -> Signal[]` (family `"technical"`). Needs ≥ 60 candles
else `[]`. Must cover: trend (EMA stack, supertrend, ADX/DMI, Ichimoku cloud, linreg slope, Kalman
slope), momentum (RSI with regime-aware interpretation, MACD hist & cross, stochastic, ROC, 12-1
style time-series momentum), mean reversion (Bollinger %B, z-score, Williams %R) — **mean-reversion
signals must be down-weighted (confidence) in strong trends** — volume (OBV slope vs price, MFI,
volume-confirmed breakouts, VWAP position), volatility (squeeze / expansion), structure (Donchian
breakout, distance to 52w-high style extremes, support/resistance from swing pivots), and
divergences (RSI/price bullish/bearish divergence on swing pivots).
Also export `multiTimeframe(candlesByTf, opts) -> Signal[]` that runs `analyze` on each timeframe
(`{ "15m": [...], "1h": [...], "1d": [...] }`) and emits one `tech.mtf.alignment` signal (plus the
per-tf signals prefixed e.g. `tech.1h.trend.ema_stack`).

### 2.3 `server/analysis/regime.js`
`detect(candles) -> { trend: "up"|"down"|"range", vol: "low"|"normal"|"high"|"extreme",
 hurst, efficiency, adx, volPercentile, hmm: { state, probs:[..], means:[..], vols:[..] } | null,
 label: "trending-up/low-vol" }`
and `signals(regime) -> Signal[]` (family `"regime"`). Include a **2–3 state Gaussian HMM** on daily
log-returns fit with Baum-Welch (scaled forward-backward, deterministic init by quantiles, max ~50
iters, guard degenerate variances) — export `fitHMM(returns, k=3)` and `hmmFilter(model, returns)`.
Regime output is also consumed by the ensemble to condition weights (trend-followers get more weight
in trending regimes, mean-reversion in ranging, everyone gets less in "extreme" vol).

### 2.4 `server/analysis/fundamental.js`
`stockSignals(f) -> Signal[]` where `f` is the normalized stock fundamentals object (§3.3). Covers:
valuation (earnings yield, FCF yield, P/S, P/B vs sensible absolute bands; EV/EBIT if available),
quality (ROE, ROA, gross/operating margin, accruals ratio), growth (revenue & EPS YoY, TTM),
balance sheet (debt/equity, current ratio, interest coverage), **Piotroski F-score (0–9)**,
**Altman Z-score**, share-count change (buyback/dilution), and analyst target vs price if present.
Export `piotroski(f)` and `altmanZ(f)` separately (return null on missing inputs).
ETFs get `[]` (no fundamentals) — the ensemble handles it.

`cryptoSignals(f) -> Signal[]` where `f` is normalized crypto fundamentals (§3.3): market-cap/volume
turnover (NVT-like), supply inflation & fully-diluted overhang, drawdown from ATH, TVL/mcap for L1s,
developer/community activity if present, 30d/1y performance relative to BTC.

### 2.5 `server/analysis/sentiment.js`
- `scoreText(text) -> { score in [-1,1], hits: n }` — finance-specific lexicon (Loughran–McDonald
  flavoured: positive/negative/uncertainty words + negation handling within 3 tokens + intensifiers
  + domain phrases like "beats estimates", "misses", "downgrade", "guidance cut", "SEC probe",
  "hack", "exploit", "ETF approval", "delisting", "bankruptcy").
- `newsSignals(headlines, { now }) -> Signal[]` — headlines `[{title, source, ts, url}]`, recency-
  decayed (half-life ~24h) aggregate, confidence grows with count & agreement; also a
  `sent.news.volume_spike` style attention signal.
- `socialSignals(social) -> Signal[]` — StockTwits-like `{ bullish, bearish, total }` counts;
  contrarian at extremes (very high bullish share = mild bearish).
- `fearGreedSignal(fg) -> Signal` — `{ value 0..100, classification }`, contrarian at extremes.

### 2.6 `server/analysis/macro.js`
`signals(macro, asset) -> Signal[]` from `macro = { vix:[{t,v}], dgs10:[..], t10y2y:[..],
dxy:[..], hyOas:[..] }` (daily series, any may be missing): risk-on/off regime (VIX level + 20d change,
credit spreads widening), rates momentum, dollar strength (bearish for crypto & multinationals),
yield-curve inversion. Map risk-off to negative scores for risk assets (crypto gets larger beta).

### 2.7 `server/analysis/derivatives.js` (crypto)
`signals(d) -> Signal[]` from `d = { fundingRate, fundingHistory:[{t,rate}], openInterest,
oiHistory:[{t,oi}], basisBps? }`: extreme positive funding = crowded longs (contrarian bearish),
negative funding + rising price = short squeeze fuel, OI rising with price = trend confirmation,
OI rising against price = fragility.

### 2.8 `server/analysis/microstructure.js` (crypto real-time)
`signals(ms) -> Signal[]` from `ms = { book:{bids:[[p,s]],asks:[[p,s]]}, trades:[{t,side,size,price}],
mid }`: depth-weighted order-book imbalance (within 10/25/50 bps), trade-flow imbalance, CVD slope,
spread in bps, VPIN-style toxicity. Short horizon — confidence should be LOW for swing/position
horizons and higher for intraday.

### 2.9 `server/analysis/ml.js` — learned model
Pure-JS models, no deps:
- `buildFeatures(candles, i) -> number[] | null` — a fixed, documented feature vector computed only
  from `candles[0..i]` (NO lookahead): returns over 1/3/5/10/20/60 bars, RSI, MACD hist/price,
  %B, ATR/price, ADX, volume z, dist to 20/50/200 EMA, realized vol ratio (5/20), efficiency ratio,
  hurst-lite, day-of-week (for daily) etc. Export `FEATURE_NAMES`.
- `LogisticModel` class: `fit(X, y, {l2, epochs, lr})`, `predictProba(x)`, `toJSON()/fromJSON()`,
  with feature standardization stored inside.
- `GBMClassifier` class: gradient-boosted decision stumps/shallow trees (depth ≤ 3) with shrinkage,
  subsampling, deterministic seed; same API.
- `trainWalkForward(candles, { ahead, minTrain=250, step=20 }) -> { model, oosPredictions:[{t,p,y}],
  oosAuc, oosBrier, oosAccuracy }` — expanding-window walk-forward; label y = 1 if forward return over
  `ahead` bars > 0 (use a small dead-zone: drop |ret| < 0.1·σ from training).
- `signals(candles, { ahead }) -> Signal[]` (family `"ml"`) — trains/uses an ensemble of both models,
  maps P(up) to score = 2p−1, confidence from OOS AUC (AUC ≤ 0.52 ⇒ confidence ≈ 0).
Cache trained models per (symbol, tf) in memory keyed by last candle t; retrain at most every N bars.

### 2.10 `server/decision/ensemble.js` — the brain
`decide({ asset, signals, regime, horizon, price, atr, weights, calibrator, now }) -> Decision`

Method (document it in code):
1. Each signal → log-odds evidence `e_i = logit(0.5 + 0.5·score_i·κ)` where κ ≤ 0.9 prevents
   infinities; weight `w_i = familyWeight(family, regime) × learnedWeight(id) × confidence_i`.
2. **Correlated evidence de-duplication**: within a family, combine with a diminishing sum
   (sort by |w·e|, apply 1, 0.6, 0.4, 0.3, 0.25 …) so 10 correlated trend indicators don't count 10×.
3. Aggregate log-odds `L = Σ_family β_f · family_logodds_f`; `pRaw = σ(L)`.
4. Calibrate: `pUp = calibrator ? calibrator.apply(pRaw) : shrink(pRaw toward 0.5, 0.5)` —
   uncalibrated output is always shrunk (humility prior).
5. Confidence (0..1) = f(|pUp−0.5|, **agreement** (weighted share on chosen side), **coverage**
   (how many families reported), data-quality, regime clarity, calibrator reliability). Document the
   formula; it must be monotone in each input.
6. Action: `STRONG_BUY | BUY | HOLD | SELL | STRONG_SELL` — abstain to `HOLD` unless
   `confidence ≥ MIN_CONFIDENCE && |pUp−0.5| ≥ MIN_PROB_EDGE && agreement ≥ MIN_AGREEMENT`;
   STRONG_* when `confidence ≥ STRONG_CONFIDENCE`. For crypto and stocks "SELL" means exit/short.
7. Risk plan: `stop = price ∓ STOP_ATR·atr`, `target = price ± TARGET_ATR·atr`, expected return
   `E[r] = pUp·avgWin − (1−pUp)·avgLoss` (ATR-based), `riskReward`, suggested size via
   `server/decision/risk.js`.
8. Explanation: top 5 drivers for and top 3 against (by |w·e|), family breakdown, and a
   one-paragraph `summary` string generated deterministically from the numbers.

```js
// Decision
{
  assetId: "CRYPTO:BTC", symbol: "BTC", assetClass: "crypto", ts: "ISO", horizon: "swing",
  horizonLabel: "5d", price: 84500.1,
  action: "BUY", pUp: 0.64, pRaw: 0.71, confidence: 0.72, agreement: 0.78, coverage: 0.8,
  edge: 0.14,                      // |pUp - 0.5|
  expectedReturn: 0.021,           // fraction over the horizon, fee-aware
  risk: { stop, target, atr, atrPct, riskReward, sizeFrac, sizeUsd, var95, maxLossUsd },
  regime: { label, trend, vol, hmmState },
  families: { technical: { score, weight, logodds, n }, fundamental: {...}, ... },
  drivers: [{ id, family, score, confidence, contribution, reason }],   // top for
  against: [{ ... }],                                                   // top against
  signals: Signal[],              // full list (UI detail view)
  abstainReason: null | "confidence 0.58 < 0.65",
  summary: "BUY BTC (5d): 64% up-probability, 72% confidence. Trend and momentum aligned ...",
}
```

### 2.11 `server/decision/risk.js`
`positionSize({ pUp, riskReward, atrPct, annVol, equity, cfg, openPositions, correlation }) ->
{ sizeFrac, sizeUsd, kellyFrac, volTargetFrac, capped: [...reasons] }` — min(fractional Kelly for
the ATR bracket, vol-target fraction), capped by `MAX_POS_FRAC`, gross cap, correlation haircut.
`var95(returns, value)` historical + parametric; `cvar95`; `maxDrawdown(equityCurve)`;
`sharpe(returns, periodsPerYear)`; `sortino`; `correlation(a,b)`.

### 2.12 `server/learning/calibrator.js`
`Calibrator` with `fit(pairs:[{p, y}])` using **Platt scaling** when n < 200 else **isotonic
regression (PAV)** blended with Platt; `apply(p)`; `reliability()` → `{ n, brier, logloss, ece,
bins }`; `toJSON/fromJSON`. With n < 30 it's an identity-with-shrink and reports `reliable: false`.

### 2.13 `server/learning/weights.js`
`WeightLearner` — per-signal-id multiplicative weights (Hedge): after a decision resolves with
outcome y∈{0,1}, each signal that voted gets `w ← w·exp(η·(correct ? +1 : −1)·|score|·conf)`,
clamped to [0.25, 4], slow decay toward 1. `get(id)`, `update(signals, y)`, `toJSON/fromJSON`,
`report()` → per-id `{ w, n, hitRate }`.

### 2.14 `server/learning/backtest.js`
`run({ candles, asset, horizon, cfg, feeBps }) -> { trades, equity:[{t,v}], metrics:{ cagr, sharpe,
sortino, maxDD, hitRate, nTrades, avgWin, avgLoss, profitFactor, exposure, brier, ece },
calibrationPairs:[{p,y}], signalStats:{ id:{n,hits} } }` — walk-forward, bar-by-bar, **only uses
candles[0..i]** for decisions at bar i, enters next bar open, exits at stop/target/horizon, applies
fees + slippage. Only technical+regime+ml families (others lack history). Compare vs buy-and-hold.
When run as a script (`npm run backtest`) it fetches history via `server/data/*` and prints JSON.

---

## 3. Data layer — `server/data/`

All providers: axios with timeouts, token-bucket rate limiting, **in-memory TTL cache**,
retries with backoff on 429/5xx, and graceful failure (return `null`/`[]`, never throw into the
loop). Browser-like `User-Agent` for Nasdaq; `cfg.SEC_USER_AGENT` for SEC.

### 3.1 `server/data/crypto.js`
- `candles(asset, tfSec, limit) -> Candle[]` — Coinbase Exchange REST
  `/products/{id}/candles?granularity=` (granularities 60,300,900,3600,21600,86400; max 300/req —
  paginate with start/end for more; Coinbase returns **[time(sec), low, high, open, close, volume]
  newest-first** → normalize). Fallback: Kraken `/0/public/OHLC`. For 4h, aggregate 1h.
- `book(asset) -> {bids,asks,mid}` (Coinbase level2 REST, top 50), `trades(asset) -> [...]`.
- `startStream(assets, onTick)` — Coinbase WS `ticker` + `matches` channels → live last price,
  signed trade ring buffer, reconnect w/ backoff. `live(symbol) -> { price, ts, trades }`.
- `fundamentals(asset) -> CryptoFundamentals` (CoinGecko `/coins/{id}` + DefiLlama chain TVL).
- `derivatives(asset) -> { fundingRate, fundingHistory, openInterest, oiHistory }` (OKX public
  `/api/v5/public/funding-rate`, `/funding-rate-history`, `/rubik/stat/contracts/open-interest-volume`).
- `fearGreed() -> { value, classification, history:[{t,v}] }` (api.alternative.me/fng/?limit=30).

### 3.2 `server/data/stocks.js`
- `candles(asset, tfSec, limit)` — daily: Nasdaq `api.nasdaq.com/api/quote/{SYM}/historical?
  assetclass=stocks|etf&fromdate=YYYY-MM-DD&todate=...&limit=9999` (rows newest-first with "$" and
  "," strings → parse). Intraday (1m points): Nasdaq `/api/quote/{SYM}/chart?assetclass=...` →
  aggregate to 5m/15m/1h candles (volume may be missing → 0). Fallback: Yahoo
  `query2.finance.yahoo.com/v8/finance/chart/{SYM}?interval=&range=` (often 429 — keep it fallback).
- `quote(asset) -> { price, ts, change, volume, marketStatus }` (Nasdaq `/info`).
- `summary(asset)` (Nasdaq `/summary`: sector, industry, mkt cap, 1y target, PE, EPS, dividend yield).
- `fundamentals(asset) -> StockFundamentals` — SEC EDGAR `company_tickers.json` (ticker→CIK, cache
  24h) + `data.sec.gov/api/xbrl/companyfacts/CIK##########.json` → compute TTM + prior-year values.
- `marketOpen(now) -> boolean` (NYSE regular hours, America/New_York, weekdays; holidays best-effort).

### 3.3 Normalized fundamentals
```js
// StockFundamentals (null for any missing field; all $ in USD; TTM = trailing 4 quarters)
{ symbol, asOf, price, marketCap, sharesOut, sharesOutPrev, revenueTTM, revenuePrevTTM,
  grossProfitTTM, operatingIncomeTTM, netIncomeTTM, netIncomePrevTTM, epsTTM, epsPrevTTM,
  cfoTTM, capexTTM, fcfTTM, totalAssets, totalAssetsPrev, currentAssets, currentLiabilities,
  currentRatioPrev, totalLiabilities, longTermDebt, longTermDebtPrev, equity, retainedEarnings,
  ebitTTM, interestExpenseTTM, grossMarginPrev, assetTurnoverPrev, roaPrev, cash,
  sector, industry, analystTarget, peRatio, dividendYield }

// CryptoFundamentals
{ symbol, asOf, price, marketCap, fdv, volume24h, circulatingSupply, totalSupply, maxSupply,
  ath, athChangePct, change7d, change30d, change1y, tvl, devCommits4w, devStars,
  twitterFollowers, redditSubscribers, sentimentUpPct }
```

### 3.4 `server/data/news.js`
`headlines(asset) -> [{title, source, ts, url}]` — Google News RSS
`news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en` (parse XML with regex, no deps),
query e.g. `"AAPL stock"` / `"Bitcoin crypto"`; `social(asset) -> { bullish, bearish, total,
messages }` — StockTwits `api.stocktwits.com/api/2/streams/symbol/{SYM}.json` (crypto: `BTC.X`).

### 3.5 `server/data/macro.js`
`snapshot() -> { vix, dgs10, t10y2y, dxy, hyOas }` each `[{t,v}]` (last ~300 obs) from FRED CSV
`fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS|DGS10|T10Y2Y|DTWEXBGS|BAMLH0A0HYM2` ("." = missing).

---

## 4. Server / orchestration (integrator owns these)
`server/engine.js` (real-time loop: per asset gather → analyze → decide → persist → broadcast),
`server/db.js` (sql.js: decisions, outcomes, paper positions, settings, model state),
`server/llm/analyst.js` (optional Claude analyst → one `llm.*` signal + narrative),
`server/index.js` (Express + WS), `src/App.jsx` (dashboard).

### HTTP API (dashboard consumes these)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{status, uptime, assets, llm, ts}` |
| GET | `/api/decisions` | `{ decisions: Decision[] (without .signals), ts }` — latest per asset |
| GET | `/api/decision/:assetId` | full `Decision` (with signals) + `history:[{ts,pUp,confidence,action,price}]` |
| GET | `/api/candles/:assetId?tf=86400&limit=300` | `{ candles }` |
| POST | `/api/analyze` `{symbol, assetClass}` | on-demand full decision for any ticker |
| GET | `/api/portfolio` | `{ equity, cash, positions, trades, stats, equityCurve }` |
| GET | `/api/performance` | `{ calibration, weights: WeightLearner.report(), byAction, byFamily }` |
| GET/POST | `/api/backtest` | `{assetId, horizon}` → backtest result |
| POST | `/api/settings` | thresholds (min_confidence, min_prob_edge, horizon, auto_trade) |
| WS | `/ws` | pushes `{type:"decisions", decisions}`, `{type:"decision", decision}`, `{type:"tick", symbol, price, ts}`, `{type:"trade", trade}` |
