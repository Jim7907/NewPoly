# Gold & Silver "Up or Down" markets — opportunity check (2026-11-05)

**Bottom line: no tradable edge for our bots right now.** The markets are real and resolve
cleanly, but they are ~1–2% the size of BTC 15m, the fee is the full crypto rate, and the
market price already beats our lead model. Worth a paper-trade watch, not real capital.

## What actually exists

| Series (Gamma slug) | Series id | 24h volume | Liquidity |
|---|---|---|---|
| `gold-up-or-down-15m`   | 12967 | ~$54k | ~$1.8k |
| `silver-up-or-down-15m` | 12968 | ~$13k | ~$1.4k |
| `gold-up-or-down-1h`    | —     | ~$90  | ~$0.4k |
| `silver-up-or-down-1h`  | —     | ~$35  | ~$0.4k |
| *(reference)* `btc-up-or-down-15m` | — | ~$3.1M | ~$1.1M |

- **No 5-minute gold/silver series exists** (5m exists only for BTC/ETH/SOL/XRP/DOGE/BNB/HYPE).
- Event slugs: `xau-updown-15m-<startUnix>`, `xag-updown-15m-<startUnix>`; created 2026-10-22.
- Tags are `finance`, `gold`/`silver`, `15M`, `up-or-down` — **not `crypto`**, so the crypto15m
  bot's `tag_slug=crypto` discovery would never see them.
- Resolution: Up if close ≥ open on the **Chainlink XAU/USD / XAG/USD forex data streams**.
  Resolved events carry `eventMetadata.priceToBeat` / `finalPrice` (the exact Chainlink values).
- **No windows are listed while metals markets are closed** (weekend, 5–6pm ET daily break), so
  there's no "frozen feed ⇒ tie ⇒ Up" quirk to exploit. Only 2 ties in 722 silver windows, 0 in gold.
- Windows are pre-listed ~24h ahead, sitting at ~0.46/0.54 until they go live.

## Fees

`feeType: crypto_fees_v2`, `feeSchedule {rate: 0.07, exponent: 1, takerOnly, rebateRate: 0.2}` —
identical to BTC 15m, i.e. the **crypto** rate, not the cheaper 0.04 "Finance" rate.

Per Polymarket docs: `fee = C × 0.07 × p × (1−p)` ⇒ fee as a fraction of stake = `0.07·(1−p)`
(3.5% at 50¢, 1.05% at 85¢, 0.7% at 90¢). Makers pay 0 and get 20% of taker fees as rebate.
No liquidity-rewards program is active on these markets (`clobRewards: null`).

## Volatility & reference feed

From 722 resolved windows per asset (Chainlink open/close):

| | 15m move median | 15m move stdev |
|---|---|---|
| Gold   | 7.1 bps | 13.6 bps |
| Silver | 14.2 bps | 27.5 bps |

Candidate reference: **Hyperliquid `xyz:GOLD` / `xyz:SILVER`** (public 1m candles, 24/7).
- Constant **+4.4 bps premium** vs Chainlink (must lead off HL's own window-open, not `priceToBeat`).
- 15m-return tracking error vs Chainlink ≈ 2.1 bps stdev; direction agreement 94–95%.
- Pyth Hermes (`hermes.pyth.network`) now returns **401 Unauthorized** without an API key.

## Backtests

Data: 722 windows/asset (Oct 22 – Nov 5) of Polymarket price history; ~320 windows/asset with
HL coverage for the lead model (HL only serves the last ~5000 minutes).

**1. Market calibration (buy the favorite at the printed price, fee-adjusted).**
Favorites ≥80¢ in the last 5 min win slightly more than priced: pooled EV ≈ +1% to +3% per $
(gold T-300s best: n=318, WR 95.0% vs avg price 91.7%, EV +3.1%). That is at the *printed*
price (mid/last), not the ask; 1–2¢ of spread at ~92¢ costs 1–2% and erases it.

**2. Lead model** `P = Φ(L / (σ√τ))`, L from HL, σ from trailing 60×1m HL returns, with the
reference never newer than the Polymarket print it's compared against:
- **Market Brier beats model Brier at every horizon** for both metals (e.g. gold T-120s:
  0.1175 market vs 0.1374 model). The model is overconfident (cases with P_model≈0.91 win ~80–89%).
- A few gold cells (P_model ≥ 0.8, edge ≥ 0.10–0.15) show positive EV, but n = 10–30 with
  CIs that are wide or touch zero, and they were picked out of ~40 cells — consistent with noise.
- An earlier, naive run showed +15–50% EV; that came from (a) HL's +4.4 bps premium biasing to Up
  and (b) a reference fresher than the market print. Both are fixed in `lead2.py`.

Caveat: minute candles are coarse; a tick-level reference could do better than this backtest.

## Capacity (if an edge did exist)

Gold averages ~$275 volume per window (median $193, 23% of windows zero); silver ~$73
(median $0, 57% zero). A live sample of the 12:15–12:30 UTC 2026-11-05 window at T-12–13 min
showed depth within 3¢ of touch of $44–151 per side for gold (spread 1–3¢) and $54–136 for silver
(spread 5–6¢), vs $576–1,157 for BTC (spread 1¢). Even a real
5% edge on ~$50 per trade × a few trades/day is a few dollars/day.

## Issues found in the existing crypto15m bot (not changed here)

1. `TAKER_FEE_K` default is `0.036`; the live crypto fee rate is **0.07**, so fees are
   understated ~2× in signals, EV and backtests.
2. Pyth Hermes returns 401 here, so `feeds.js` is likely running on the Coinbase REST fallback.

## If we want to keep watching

Cheapest path: a paper-only adapter in crypto15m — discover via `series_id=12967/12968` (or
`tag_slug=gold`), use HL `xyz:GOLD`/`xyz:SILVER` as the reference (leading off HL's own
window-open), read `priceToBeat` from Gamma, fee `0.07`, and gate on real book depth. Let the
CALIBRATION tab gather a few weeks of data before deciding anything.

## Reproduce

```bash
mkdir data && cd data
../scripts/fetch_data.sh          # Gamma resolved windows + HL candles
python3 ../scripts/fetch_hist.py  # Polymarket price history per window
python3 ../scripts/calib.py       # market calibration
python3 ../scripts/lead2.py       # lead model vs market
python3 ../scripts/livebook.py    # live book sampler for the current window
```
