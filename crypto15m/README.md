# 15-Minute Crypto Imbalance Bot (Polymarket) — paper trading

A standalone bot/dashboard for Polymarket's **"{Asset} Up or Down – 15 minute"** crypto markets
(BTC, ETH, SOL, XRP, DOGE). **Paper-trading only.** Built around the research finding that, at a
15-minute horizon, raw order-book imbalance is near-noise — the durable, high-win-rate edge is the
**time-scaled "current lead"** term.

## Strategy

Markets resolve **Up if the close ≥ the open** (a *terminal* value), sourced from the **Chainlink
`<asset>-usd` data stream**. The model is therefore the digital Gaussian:

```
P_up = Φ( (L + μ·τ) / (σ·√τ) )      L = ln(S / S_open),  τ = seconds to close
```

- **Lead-only by default** (`μ = 0`). Microstructure drift (OFI / CVD / OBI / momentum) ships
  **disabled** and is only enabled once the backtest/calibration harness proves it adds EV.
- `P_used = w·P_model + (1−w)·P_market`, with `w` rising as the window nears close (trust the model
  late, the Poly price early).
- **Reference price = Pyth Hermes** (oracle-grade, close to Chainlink) for the lead, the window-open
  snapshot, and resolution — chosen to minimize basis risk vs the settlement feed. Coinbase WS powers
  optional microstructure; Coinbase ticker is the REST fallback.
- **Fees are modeled honestly.** Crypto is Polymarket's highest-fee category: effective taker fee
  ≈ `0.036·(1−p)` per share (~1.8% at p=0.50, →0 at the extremes). So the bot trades **favorites late
  in the window**, where fees are cheapest and `Φ` is sharpest.
- **Guardrails:** favorites only (`P ≥ MIN_P`), `|z| ≥ MIN_Z`, basis buffer + skip-near-zero, spread/
  depth liquidity gates, VPIN/vol gates, no taker entries in the final `NO_TAKER_LAST_S` seconds.
- **Sizing:** fractional Kelly (`k=0.15`) with a per-trade cap and an aggregate (correlation) cap.

## Quick start

```bash
cp .env.example .env
npm install
npm test            # deterministic unit tests (no network)
npm run server      # API + scan loop + WS  ->  http://localhost:3002
npm run dev         # + Vite frontend on http://localhost:3000 (proxies to :3002)
npm run backtest    # offline backtest + threshold auto-tune (prints JSON)
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | server status |
| `GET /api/live` | live per-asset signals + stats + settings |
| `GET /api/trades` | paper trade history |
| `GET /api/stats` | balance / win-rate / P&L / EV |
| `GET /api/calibration` | reliability bins + Brier / log-loss / ECE + per-asset WR |
| `GET/POST /api/backtest` | last result / run + auto-tune thresholds |
| `POST /api/paper-trade` | manual paper trade from the live signal |
| `POST /api/settings` | toggle paper/scan/drift, thresholds |
| `POST /api/reset-paper` | reset paper balance |

## Honest expectations & risks

- **Mode A target:** entries at `P_used ≈ 0.80–0.92` ⇒ win-rate ~78–88% *if* σ is well-estimated and
  the basis buffer holds; net EV ~+6–10%/stake after fees; **low trade count**, concentrated in the
  final minutes. **These are priors — the BACKTEST tab sets the real thresholds and the CALIBRATION
  tab confirms realized WR/EV.** The app measures its edge; it doesn't assume it.
- **#1 risk: oracle basis** (Pyth proxy vs Chainlink settlement) → mitigated by the Pyth reference,
  the basis buffer, and skip-near-zero. Other risks: last-second reversals (no taker entries ≤60 s),
  σ misestimation (clamp + shrink + vol gate), thin alt books (liquidity gates), correlated drawdown
  (aggregate cap), taker-fee drag (favorites-only).
- A real-money **taker** bot likely has no durable edge here after fees. This app's value is a rigorous
  paper harness for the late-window lead-lock-in thesis, with a calibration loop to prove/disprove it.

Binance.com is geo-blocked in some regions; the bot uses Pyth + Coinbase precisely so it works anyway.
