# Decision Engine v2 — Self-Learning & Self-Improvement Contract

Round 2 goal: raise real out-of-sample accuracy and make the system **improve itself** through
measurement. It must never fool itself along the way. Read `docs/CONTRACT.md` (v1 module
contract) and `docs/RESEARCH.md` first. House rules are unchanged:
- Node 20, CommonJS, no new dependencies.
- Pure functions where possible; `node:test` tests that are deterministic and use no network.
- Paper trading only.

## Why v2: what v1 measured
- About 10k out-of-sample (pRaw, y) pairs from walk-forward backtests on 14 assets, with technical + regime signals only, at the 5-day swing horizon. The calibrated probability hardly separated up weeks from down weeks: stocks 56–59% up whatever the score, crypto 47–50%.
- The ML model's out-of-sample AUC on BTC was 0.42.
- A full-engine backtest on BTC ended roughly flat, with a deflated Sharpe of about 10%.
- Conclusion: hand-weighted pooling of time-series technical signals predicting the **absolute
  direction** has ~no edge at 5d. v2 attacks this on four fronts:
  1. **Better targets:** excess return vs. a benchmark (cross-sectional / relative) and
     triple-barrier labels that match the actual trade bracket, not just sign(5d return).
  2. **Measure every signal:** an Information Coefficient report card with overlap-robust
     t-stats and false-discovery-rate control. Signals that don't work get pruned automatically.
  3. **Learn the combination:** a stacked model over signal scores, with purged walk-forward
     training, plus **meta-labeling** (López de Prado 2018) to predict when a call will be right.
  4. **Self-improvement loop:** champion/challenger model registry, statistical promotion tests,
     drift detection, and scheduled retraining in a worker thread. A new model goes live only
     when it beats the current one out of sample with statistical significance.

---

## 1. Panel dataset — `server/research/dataset.js`

This is a point-in-time panel of historical decision snapshots across a **research universe**.
The research universe is larger than the live watchlist, so there is more data to learn from.

```js
// Row (one asset at one bar; everything computed from candles[0..i] only — NO lookahead)
{
  assetId: "STOCK:NVDA", symbol: "NVDA", assetClass: "stock", t: 1727222400000, i: 812,
  price: 118.2, atrPct: 0.031, annVol: 0.52,
  regime: { trend: "up", vol: "normal", label: "trending-up/normal-vol", hmmState: 2 },
  sig: { "tech.trend.ema_stack": [0.62, 0.7], "macro.risk.vix": [-0.2, 0.4], ... },   // id -> [score, confidence]
  fam: { technical: 0.31, regime: 0.12, macro: -0.05, relative: 0.4, sentiment: 0.1 }, // family mean score·conf
  pRaw: 0.54,                      // v1 ensemble pooled probability (no calibrator) at this bar
  lab: {
    ret: 0.012,                    // log return close[i] -> close[i+ahead]
    exRet: 0.004,                  // ret − benchmark ret over the same window (benchmark: SPY for stocks, BTC for crypto; the benchmark's own exRet = 0 and it is excluded from the relative training set)
    y: 1,                          // ret > 0
    yEx: 1,                        // exRet > 0
    tbLong: 1, tbShort: -1,        // triple barrier for a long / short bracket (ensemble.BRACKETS[horizon] stop/target in ATR,
                                   //  vertical barrier = ahead bars): +1 target hit first, −1 stop first, 0 = timed out
    tbLongRet: 0.021, tbShortRet: -0.014, // realized bracket return net of round-trip costs (cfg fees + slippage)
  },
}
// Dataset
{ version: 2, horizon: "swing", tf: 86400, ahead: 5, built: ISO, universe: [assetIds],
  benchmarks: { stock: "STOCK:SPY", crypto: "CRYPTO:BTC" }, signalIds: [...], rows: Row[] /* sorted by t, then assetId */ }
```

Exports:
- `buildDataset({ horizon, assets, candlesByAsset?, macroHistory?, fearGreedHistory?, stride=1, lookback, onProgress }) -> Dataset`.
  - If candles are not injected, fetch via `server/data` (`candles(asset, tf, limit)`).
  - Macro series: FRED gives full history; slice each series to ≤ t.
  - Fear & Greed history: `api.alternative.me/fng/?limit=0`, crypto only; slice to ≤ t.
  - Signal families computed point-in-time: technical (base tf), regime, **relative** (§3), macro, fear-greed.
  - News, fundamentals, derivatives and microstructure have no point-in-time history. **Exclude them.**
  - Macro series publish with a lag: use the value dated ≤ t − 1 day.
  - Rows whose label window extends past the last candle have `lab = null` (usable for inference, not training).
- `saveDataset(ds, file)`, `loadDataset(file)` — JSON (optionally gzip via zlib) under `data/research/`.
- `updateDataset(ds, opts)` — incremental: only compute new bars and fill labels that have now matured.
- `RESEARCH_UNIVERSE` (export) — default: the live watchlist plus about 30 liquid US large caps across sectors (e.g. JPM, XOM, UNH, JNJ, PG, KO, WMT, HD, V, MA, LLY, AVGO, COST, PEP, ORCL, CRM, AMD, NFLX, ADBE, CSCO, CVX, BAC, MRK, ABBV, TMO, DIS, INTC, QCOM, CAT, GE) and IWM, DIA, plus crypto BTC, ETH, SOL, XRP, DOGE, AVAX, LINK. Overridable with the env var `RESEARCH_STOCKS` / `RESEARCH_CRYPTO`.

## 2. Signal report card — `server/research/signalEval.js`

- `reportCard(dataset, { target: "ret"|"exRet"|"tbLong", byRegime=true, minN=200 }) -> { signals: { [id]: SignalStat }, families: {...}, fdr: {q, nSignificant}, built }`
- The output is **SignalStat**:
  `{ id, family, n, nEff, ic, icT, icP, hitRate, hitRateCI:[lo,hi], meanRetWhenLong, meanRetWhenShort, byRegime:{ label:{n, ic} }, byClass:{ stock:{n,ic}, crypto:{n,ic} }, decay:{ ic_h1, ic_h2 }, stable, verdict }`.
- **IC** = cross-sectionally pooled Spearman rank correlation between score·confidence and the target.
  - Compute it **per date**, then average over dates (Fama–MacBeth style).
  - Its t-stat uses a Newey–West HAC standard error with lag = ahead, because labels overlap.
- **FDR:** apply Benjamini–Hochberg at q = 0.10 across all signals.
- **stable:** the IC has the same sign in the first and second half of the sample.
- **verdict** is one of four values:
  - `"keep"` — significant after FDR, positive IC, stable.
  - `"weak"` — positive but not significant.
  - `"drop"` — IC ≤ 0 with p < 0.2, or unstable sign.
  - `"invert-candidate"` — significantly negative after FDR and stable. **This is never auto-applied**; it is reported only (flipping signs is data snooping unless it is re-validated on fresh data).
- `signalMask(report) -> { [id]: multiplier }` sets the multiplier per verdict:
  - keep → 1 to 1.5, scaled by the IC t-stat
  - weak → 0.6
  - drop → 0
  - unknown or low-n → 0.8
- The engine multiplies each signal's confidence by this mask.

## 3. Relative / cross-sectional analyzer — `server/analysis/relative.js`

- `signals(candles, { peers, benchmark, assetClass, horizon, t }) -> Signal[]` (family `"relative"`).
  - `peers` is `{ symbol: Candle[] }` for the same asset class; `benchmark` is a `Candle[]`.
  - Use only bars with time ≤ the asset's last bar.
- It emits the following signals:
  - Relative strength vs the benchmark over 1, 3, 6 and 12 months (skip-month for 12-1).
  - Cross-sectional momentum rank percentile among peers (Jegadeesh–Titman 1993; for crypto, Liu–Tsyvinski–Wu 2022).
  - Short-term (1-week) cross-sectional reversal, stocks only (Lehmann 1990).
  - Idiosyncratic volatility rank (Ang et al. 2006; low-vol anomaly).
  - Beta to the benchmark (context only).
  - Correlation-to-benchmark regime.
  - For alts: a BTC-lead signal, from BTC's recent return × the alt's beta.
- Ids: `rel.rs.1m`, `rel.rs.3m`, `rel.rs.6m`, `rel.rs.12_1`, `rel.xs.mom_rank`, `rel.xs.reversal_1w`, `rel.xs.ivol_rank`, `rel.beta`, `rel.btc_lead`.
- The `value` field includes `{ rank, nPeers, beta, … }`.
- **This family feeds the relative prediction target.**

## 4. Stacker + meta-labeler — `server/research/stacker.js`, `server/research/metaLabel.js`

- `featurize(row, spec) -> number[]`, with a stable `spec = { signalIds:[...], families:[...], regimes:[...], classes:[...] }`.
  - Signals enter as score·conf, filtered by the mask.
  - Also: family aggregates, regime one-hots, asset-class one-hot, atrPct, annVol and pRaw.
- `trainStacker(dataset, { target: "y"|"yEx"|"tbLong", mask, model: "logistic"|"gbm"|"ensemble", purge=ahead, embargo, folds }) -> { model, spec, oos: [{t, assetId, p, y, pBaseline}], metrics: { auc, brier, logloss, aucBaseline, brierBaseline, dm: {stat, p} }, trainedThrough: t }`.
  - Training uses **purged walk-forward by date**: no row whose label window overlaps the test window.
  - `pBaseline` = the v1 pooled pRaw calibrated on the training folds, compared on the same OOS rows.
  - `dm` = Diebold–Mariano test on the log-loss differential with HAC variance.
- Reuse `LogisticModel` / `GBMClassifier` from `server/analysis/ml.js`. Do not duplicate them.
- `Stacker` has `predict(row) -> p`, plus `toJSON`/`fromJSON`.
  - It must also accept a *live* row. The engine builds one from live signals (`sig`, `fam`, `regime`, `atrPct`, `annVol`, `pRaw`, `assetClass`) with the same shape as a dataset row.
- **Meta-labeling:**
  - `trainMetaLabeler(dataset, { primary: "pooled"|"stacker", stacker?, minEdge })`.
  - Primary side = sign(p − base rate) where |p − base| ≥ minEdge.
  - Meta label = 1 if the triple-barrier bracket return on that side, net of costs, is > 0.
  - Features = the stacker features + |edge| + side.
  - Returns `{ model, oos, metrics: { precisionAt: {thr: {precision, coverage}}, auc } }`.
  - `MetaLabeler.predict(row, side, p) -> P(trade succeeds)`.
  - The engine uses it as the **decisive confidence input** and as a sizing multiplier, with fractional Kelly based on meta-P.

## 5. Self-improvement loop — `server/learning/{registry,drift,tuner,selfImprove}.js`

- **registry.js:** a versioned model registry persisted with `db.saveModel/loadModel` under keys
  `registry:<horizon>`.
  - Entry: `{ version, ts, kind: "stacker"|"meta"|"mask"|"thresholds", target, metrics, trainedThrough, dataHash, model (JSON), status: "champion"|"challenger"|"retired", promotedAt, reason }`.
  - API: `champion(horizon, kind)`, `propose(entry)`, `promote(version, reason)`, `history(horizon)`, `rollback(horizon, kind)`.
- **drift.js:**
  - `PageHinkley` (and/or ADWIN-lite) over the live per-decision log-loss and the hit indicator.
  - `DriftMonitor` with `update(p, y) -> { drift: bool, level: "ok"|"warn"|"drift", stat }`, plus `toJSON`/`fromJSON`.
  - On drift the orchestrator (a) triggers a retrain cycle early and (b) sets a temporary **de-risk** state: +0.05 MIN_CONFIDENCE and half size, until the next promotion or 2× the horizon passes.
- **tuner.js:**
  - `tuneThresholds(oosRows, { costs, grid })` chooses `MIN_CONFIDENCE` / `MIN_PROB_EDGE` (or meta-P threshold) to maximize net expected return per decision.
  - Constraints: ≥ 15% activity and precision ≥ 55%.
  - Use **nested** walk-forward: thresholds chosen on inner folds are evaluated on outer folds.
  - Report the deflated Sharpe (Bailey & López de Prado 2014) for the number of grid points tried, and the PBO via CSCV (Bailey et al. 2017).
  - Refuse to promote when PBO > 0.5 or the deflated Sharpe < 0.5.
- **selfImprove.js** — `runCycle({ horizon, reason }) -> CycleReport`. It runs in a worker thread and does the following in order:
  1. Update the dataset.
  2. Build the report card and mask.
  3. Train challenger stacker(s) for targets y, yEx and tbLong.
  4. Train the meta-labeler.
  5. Tune thresholds.
  6. Evaluate each challenger against the champion on the **most recent holdout window, which neither model trained on**.
  7. Promote a challenger only if the DM p-value < 0.10 **and** its OOS log-loss is better than the champion's and the calibrated baseline's.
  8. Write registry entries and a `CycleReport { ts, horizon, reason, datasetRows, reportCardSummary, challengers:[{kind,target,metrics,promoted,reason}], thresholds, drift }` to `db.saveModel("cycles:<horizon>", last 50 reports)`.
  - `schedule({ everyMs = 6h, horizons })` runs the cycles in the background, one at a time, never blocking the event loop.
  - `status()` reports the running state, the next run, the last report, and the drift state.
  - The *first* cycle on a fresh install must finish in ≤ ~10 min on this machine for about 50 assets × 1,000 daily bars. Use stride, incremental dataset caching and small GBMs to stay within that.

## 6. Engine integration (integrator owns `server/engine.js`, `server/decision/ensemble.js`, `server/index.js`)

- Live signal confidences are multiplied by `mask`.
- `relative.signals` gets peer candles from a per-class candle cache.
- If a champion stacker exists for the horizon:
  - `pUp = calibrated stacker P` for target `y`.
  - v1 pooling stays as a feature and as a fallback.
- If a champion meta-labeler exists, confidence = f(meta-P, calibration reliability, data quality), and it gates actions.
- `yEx` stacker → `decision.relative = { pOutperform, rank }` and the `/api/rankings` endpoint.

### New HTTP endpoints (the UI consumes these)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/lab/status` | `selfImprove.status()` + registry champions per horizon/kind + drift state |
| GET | `/api/lab/cycles?horizon=` | last CycleReports |
| POST | `/api/lab/run {horizon}` | triggers a cycle now → `{ started: true }` |
| GET | `/api/lab/report-card?horizon=` | latest report card (signals sorted by \|icT\|) |
| GET | `/api/lab/registry?horizon=` | registry history |
| POST | `/api/lab/rollback {horizon, kind}` | roll back the champion |
| GET | `/api/rankings?horizon=&class=` | `{ rankings: [{assetId, symbol, assetClass, pOutperform, expExRet, rank, action}] }` |
