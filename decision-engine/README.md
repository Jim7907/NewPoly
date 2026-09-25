# Decision Engine — real-time AI decisions for stocks + crypto (paper trading)

A real-time decision engine that fuses **technical, fundamental, sentiment, macro, derivatives,
order-flow, regime (HMM) and machine-learning** evidence into one **calibrated, confidence-gated**
call per asset: `STRONG_BUY / BUY / HOLD / SELL / STRONG_SELL`. Each call comes with an
up-probability, a confidence score, the drivers for and against it, and a stop/target/size plan.
An optional **Claude analyst** reads the headlines, fundamentals and macro backdrop and adds one
signal plus a written bull/bear case.

**Paper trading only.** There is no live-order code, and no exchange or broker keys are used.

```
data layer (parallel, cached, rate-limited, fallbacks)
  Coinbase REST+WS · Kraken · OKX funding/OI · CoinGecko · DefiLlama · Fear&Greed
  Nasdaq (daily + 1-min) · SEC EDGAR XBRL · FRED macro · Google News RSS · StockTwits
        │
        ▼
analyzers → Signal{ id, family, score∈[-1,1], confidence, reason }
  technical (multi-timeframe: trend, momentum, mean-reversion, volume, volatility, structure, divergences)
  regime (ADX / Hurst / efficiency ratio / vol percentile + Gaussian HMM, Baum-Welch)
  ml (logistic + gradient-boosted trees, purged walk-forward, OOS-AUC-gated confidence)
  fundamental (Piotroski F, Altman Z, value / quality / growth; crypto NVT, supply, TVL)
  sentiment (finance lexicon news scoring, StockTwits, Fear & Greed, contrarian at extremes)
  macro (VIX, credit spreads, rates, dollar, curve) · derivatives (funding, OI) · microstructure (OBI, CVD, VPIN)
  llm (optional Claude analyst: news in context → one signal + narrative)
        │
        ▼
ensemble (the brain)
  log-odds pooling · per-subfamily diminishing sums (correlated evidence isn't counted 10×)
  regime- and horizon-conditioned family weights × learned per-signal weights
  calibration (Platt → isotonic by effective sample size) · confidence = f(edge, agreement,
  coverage, data quality, calibrator reliability) · abstain unless every gate clears
  risk plan: ATR stop/target, fee-aware E[r], fractional Kelly ∧ vol-target sizing, caps
        │
        ▼
paper portfolio (stops / targets / horizon expiry / signal flips / drawdown breaker)
learning loop: every decision is resolved at its horizon → Hedge weight updates + calibrator refit
warm start: walk-forward backtests on history seed the calibrator + weights on first boot
```

The design choices and their evidence are in **[docs/RESEARCH.md](docs/RESEARCH.md)**. The
module interfaces are in **[docs/CONTRACT.md](docs/CONTRACT.md)**.

## v2: self-learning and self-improvement

The engine now measures, retrains and upgrades itself, and it refuses any upgrade it can't justify statistically.

```
point-in-time panel dataset (65 assets × ~1,600 bars; swing / position / intraday; no lookahead)
      │
signal report card: IC per signal (Fama–MacBeth cross-sectional + point-in-time timing IC),
  Newey–West t-stats, Benjamini–Hochberg FDR, stability, per-regime / per-class  → evidence-gated mask
      │
challengers: stacked models for y (up), yEx (beat SPY/BTC), tbLong (bracket hits target) + meta-labeler,
  purged walk-forward, calibrated; thresholds tuned by nested walk-forward with deflated Sharpe + PBO
      │
promotion gate, evaluated on the most recent 20% of dates, which neither model trained on:
  (a) log-loss beats the calibrated v1 baseline AND the current champion
  (b) Diebold–Mariano p < 0.10
  (c) beats the class-conditional base rate, so a model can't win by learning "alts lag BTC"
      │
versioned model registry (champion / challenger / retired, rollback) → hot-reloaded into live serving
      │
live outcomes → drift detection (Page–Hinkley + ADWIN) → de-risk (+0.05 min confidence, ½ size) + early retrain
```

Cycles run every 6 h per horizon in a worker thread; the **LAB** tab shows each cycle, the champions,
the report card and drift state. The **RANKINGS** tab ranks the research universe by the probability of beating the benchmark.

### What the measurements say (see [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md) and [docs/AUDIT.md](docs/AUDIT.md))
- **Daily horizons (5-day, 20-day):** 0 of ~40 signals survive multiple-testing control, for direction,
  excess return and bracket outcome. The v1 pooled probability has no out-of-sample skill. The live
  engine therefore mostly abstains, and **no model has been promoted**, because none beats the base
  rates significantly on the holdout.
- **The only consistent daily pattern is cross-sectional momentum** on excess returns (IC +0.02,
  t ≈ 2, the same sign in 5 of 6 years). It's weak and not yet significant, and it's the leading
  candidate for the next promotion as data accumulates.
- **Intraday crypto has real, significant structure** (15/34 signals pass FDR: short-term reversal plus a
  BTC→alt lead), but its size (0.3–6 bp per 2 h) is smaller than taker costs (30 bp). It stays analysis-only unless fills are at maker fees.
- **Audit:** 30+ issues found; the critical ones are fixed:
  - the calibrator was inventing edges on noise;
  - the calibration signals differed between training and live serving;
  - the weight learner rewarded drift instead of skill;
  - stock labels ran on calendar days instead of trading days;
  - the same evidence was counted twice;
  - the data layer was missing from git.

## Quick start

```bash
cd decision-engine
cp .env.example .env          # optional: add ANTHROPIC_API_KEY for the Claude analyst
npm install
npm test                      # deterministic unit tests (no network)
npm run server                # API + real-time loops + WS  ->  http://localhost:3003
npm run dev                   # + Vite dashboard on http://localhost:3000
npm run analyze -- BTC NVDA   # one-shot decisions in the terminal
npm run backtest -- --symbol BTC --class crypto --horizon swing
```

## Deploy to a VPS (gives you a dashboard URL)

On the VPS (Docker recommended):
```bash
curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/ai-trading-decision-engine-kksxds/decision-engine/deploy.sh | bash
```
Then open `http://<vps-ip>:3003` (open port 3003 in the firewall, and ideally put it behind
nginx/Caddy with TLS). Data persists in the `decision_engine_data` Docker volume. Re-run the script to update.

## Horizons

| Horizon | Bars | "Up" means | Stop / target |
|---|---|---|---|
| `intraday` | 15m | close higher 2h later | 2 / 3 ATR |
| `swing` (default) | 1d | close higher 5 days later | 2 / 3 ATR |
| `position` | 1d | close higher 20 days later | 3.5 / 5.5 ATR |

Switch horizons live from the dashboard, or with `POST /api/settings {"horizon":"position"}`.

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | status, LLM on/off, market open, settings |
| `GET /api/decisions` | latest decision per watched asset |
| `GET /api/decision/:assetId` | full decision (all signals, drivers, risk plan, LLM narrative) + history |
| `GET /api/candles/:assetId?tf=86400&limit=300` | OHLCV |
| `POST /api/analyze {symbol, assetClass, horizon?, deep?}` | on-demand decision for **any** US ticker / crypto |
| `GET /api/portfolio` | paper equity, positions, trades, stats, equity curve |
| `GET /api/performance` | live calibration (Brier / ECE), learned signal weights, hit-rate by action / family |
| `GET/POST /api/backtest {assetId, horizon}` | walk-forward backtest vs buy-and-hold |
| `POST /api/settings` | `min_confidence, min_prob_edge, min_agreement, horizon, auto_trade, scan_active, llm_enabled` |
| `POST /api/reset-paper {amount}` | reset the paper account |
| `WS /ws` | `decisions`, `decision`, `tick`, `trade` pushes |

## Honest expectations

- For liquid assets, calibrated directional probabilities mostly land around **45–58%**. A single
  signal is typically right 52–56% of the time, and anyone showing 70%+ out-of-sample direction
  accuracy is almost certainly leaking future data.
- The engine earns "high confidence" by **abstaining**: it says HOLD unless the evidence is
  strong, consistent across independent families, well covered by data, and larger than trading
  costs. Expect most readings to be HOLD. That is intended.
- Confidence only becomes meaningful once the calibrator has out-of-sample history. The warm-start
  backtests provide that immediately. The live learning loop then keeps the calibrator honest
  (see the PERFORMANCE tab: reliability diagram, Brier, ECE).
- Backtests cover only the families that have history (technical, regime, ML). Fundamental,
  sentiment and LLM signals are judged live.
- **Nothing here is financial advice.** Paper-trade it for weeks, and read the calibration, before
  trusting any number it prints.
