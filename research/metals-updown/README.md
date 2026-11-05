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

## Part 2: can a *taker* bot be profitable? (tick data, 2026-11-05)

Market making was ruled out by preference, so this part looks only at strategies that buy at the
ask and hold to settlement.

### Who has made money (Data API v2, every fill, Oct 22 – Nov 5)

20,758 taker fills, about $134k notional (`fetch_trades.py`, `flow.py`, `makers.py`):

| | Taker net P&L (after fees) | Maker P&L (+20% rebate) |
|---|---|---|
| Gold, all fills | −$5,993 (−6.0%) | +$4,134 (+4.1%) |
| Silver, all fills | −$136 | −$464 |
| Silver, last 60 s | **+$1,019** | −$1,109 (−12.4%) |

- About five wallets supply ~85% of liquidity, and the best of them earn +4–10%. Takers lose in aggregate.
- The profitable takers are few and fast: `ply-pm2` (+22.9%, buys in the last ~56 s) and a
  wallet sweeping winners *after* the close (+11.9%). In late October, post-close silver asks
  below $1 paid +12.7%.

### Settlement feed is available

Polymarket's RTDS socket (`wss://ws-live-data.polymarket.com`, topic `equity_prices`,
symbols `xauusd` / `xagusd`, **one subscription per connection**) streams the Chainlink price
once per second with no auth (the PolyBolt successor requires CLOB API keys). It matches Gamma's
`priceToBeat`/`finalPrice` to within 0–3 s, i.e. ~0–3 bps at the boundary. `priceToBeat` is
published in event metadata shortly after a window opens.

### Tick recording: 12:29–14:09 UTC, 6 resolved windows per metal (`recorder/`, `analyze_ticks.py`)

- **Quotes react fast.** After a ≥3σ one-second Chainlink move, Polymarket's best prices change
  within 1 s 75–88% of the time and within 3 s 92–95% of the time (median 0.1–0.3 s). A bot on a
  1-second feed is usually behind the market makers, who appear to read Chainlink directly.
- **No post-close sweep.** Within ~2–5 s of the close the book is in a settled state (winner bid
  0.99–0.999 in size with no asks, loser offered at 0.001–0.01). No winning-side asks below 0.999
  were seen after any recorded close.
- **Late-window mispricing disappears once vol is calibrated.** With the raw 1-second volatility
  estimate, favorites-only signals (model p ≥ 0.8, edge ≥ 2¢ after fee) fired in 8 windows and all
  won (+17.5%). But that estimator runs 15–20% below realized 15m vol (gold 11.1 vs 13.6 bps,
  silver 24.1 vs 27.5 bps). With σ scaled ×1.25 to de-bias it, only one silver window keeps a
  signal ($42 available) and gold has essentially none. The "edge" was model overconfidence.
- With the exact feed, the model's Brier score roughly matches the market mid (better in 8 of 12
  windows), so the market prices these windows about as well as a correct model does.

### Verdict

No profitable taker strategy found. The market is priced close to the Chainlink-implied
probability and re-prices within a second; the post-close and late-minute edges that existed in
late October have been competed away by bots with faster access to Chainlink. Beating them would
take sub-second Chainlink Data Streams access (paid) and colocation, against incumbents who
already have it, for a prize pool of perhaps $100–300/day across all participants.

What could still change this, cheaply: run `recorder/` on the VPS for 1–2 weeks (~1,300 windows
per metal) and re-run `analyze_ticks.py --min-p 0.8 --sigma-mult 1.25`. Look specifically at
macro-release minutes (8:30 / 10:00 ET) and the Asian session, where quotes may be slower.
Build a paper taker bot only if that shows a positive, stable edge.

## Reproduce

```bash
mkdir data && cd data
../scripts/fetch_data.sh          # Gamma resolved windows + HL candles
python3 ../scripts/fetch_hist.py  # Polymarket price history per window
python3 ../scripts/calib.py       # market calibration
python3 ../scripts/lead2.py       # lead model vs market
python3 ../scripts/livebook.py    # live book sampler for the current window
python3 ../scripts/fetch_trades.py && python3 ../scripts/flow.py   # taker/maker P&L from all fills

# tick recorder (Node >= 18): records until stopped, or RUN_SECONDS
cd ../recorder && npm install && DATA_DIR=./data node record.js
python3 ../scripts/analyze_ticks.py ./data --margin 0.02 --min-p 0.8 --sigma-mult 1.25
```
