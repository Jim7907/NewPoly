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

Docker: `docker compose up --build -d` then open `http://<host>:3003`.

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
