# Breakout Lab — range-breakout strategy with a visual backtester

A self-contained clone of the GG-Shot workflow: find the boundary of a consolidation, take the
break of it, size the stop off volatility, exit on a trailing stop or a ladder of targets, and
**see every one of those decisions drawn on the chart** next to a live statistics panel.

Backtest only. Nothing here places an order, holds a key, or talks to an exchange's trading API.

```
┌ sidebar ─────────┬ chart ────────────────────────────────────────────┐
│ symbol / timefr. │  consolidation boxes, the broken level, entry     │
│ range + break    │  arrows, SL/TP ladders, exit dots, volume         │
│ filters          ├───────────────────────────────────────────────────┤
│ entry / risk     │  win rate · profit factor · expectancy · max DD   │
│ account costs    │  per-target hit rates · long vs short · equity    │
└──────────────────┴───────────────────────────────────────────────────┘
```

Defaults ship on **BTC daily bars with the runner exit**, which is the configuration that
survived out-of-sample validation (+0.32R expectancy, PF 1.62 on bars it was never fitted to).
The GG-Shot four-target ladder is one click away and returns +0.13R on the same bars — see
[Choosing the defaults](#choosing-the-defaults).

## Quick start

```bash
cd breakout
npm install
npm run dev          # API on :3003, UI on :3004
```

Open http://localhost:3004. It loads candles for the selected market — Coinbase for crypto,
Yahoo for the equity tickers, neither needing a key — and backtests
immediately; edit any parameter and the run repeats (debounced). With no network, switch **data**
to `synthetic demo` — a seeded regime-switching generator, clearly labelled in the header so its
numbers are never mistaken for real ones.

Docker (local):

```bash
docker compose up --build -d      # http://localhost:3003
```

## Deploy to a VPS

One command, run **on the VPS**. Re-run any time to pull the latest and rebuild:

```bash
curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/breakout-strategy-backtesting-kdx75b/breakout/deploy.sh | bash
```

It clones (or updates) the repo, then builds with Docker Compose if available and falls back to
Node otherwise. Then open `http://<vps-ip>:3003` — and open the port if the firewall is on:

```bash
sudo ufw allow 3003/tcp
```

Without Docker, run it as a service instead:

```bash
cd ~/NewPoly/breakout && npm install && npm run build
sudo cp systemd/breakout.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now breakout
```

There are no API keys and no order placement, so the only thing worth securing is the port
itself — put it behind nginx/Caddy with TLS if it is publicly reachable. Fetched candles are
cached in the `breakout_data` volume (or `breakout/data/` on the systemd path).

## The strategy

**Level.** The boundary is the highest high / lowest low of the previous `rangeLen` bars
(the current bar is excluded — a bar cannot break a level it helped define). For display the
boundary snaps to a nearby *confirmed* fractal pivot, so the drawn line matches the swing a
trader would have marked.

**Break.** A close beyond that boundary by `breakoutBufferAtr × ATR`. Turning off
`closeBeyondLevel` lets wicks count instead.

**Filters** — the false-signal suppression:

| filter | rejects when |
|---|---|
| `range_width` | the consolidation is wider than `maxRangeWidthAtr` ATR (a 20-bar Donchian runs ~8 ATR at the median, so the default of 10 keeps the tighter-than-usual coils) |
| `volume` | the break bar's volume is below `volMult ×` its own 20-bar baseline |
| `adx` / `volatility` | ADX under `minAdx`, or ATR percentile under `minAtrRank` — the flat-market filter |
| `trend` | optional: longs only above the trend EMA, shorts only below |
| `risk_width` | price has already run so far past the level that no sane stop fits inside `maxRiskAtr` ATR |
| `cooldown` | another signal fired on the same side less than `cooldownBars` ago |

Rejected breakouts are **kept, not discarded** — the SIGNAL AUDIT tab shows how many raw breaks
each filter removed, and the `filtered` chart toggle draws them as faded crosses.

**Stop.** `atr` (default) uses a fixed 2 ATR distance; `level` puts it just under the boundary
that broke, which flips from resistance to support; `range` uses the far side of the whole range.
Any mode is floored at 0.5 ATR of risk so noise alone cannot stop you out.

**Exit.** Two styles, and this is the choice that decides whether the strategy makes money:

- **Runner (default).** No static targets. The whole position rides a 3 ATR trailing stop until
  it is taken out. Low win rate, large winners.
- **Ladder (the GG-Shot configuration).** Four static targets at `tpR` multiples of the realized
  risk, scaled out 50 / 25 / 15 / 10, breakeven stop after TP1, trail on the remainder. Higher
  win rate, capped winners.

Switch between them with **exit style** in the sidebar. The comparison is the most instructive
thing in the tool: see below.

## Choosing the defaults

The defaults are not the top row of a leaderboard. They were selected on **BTC daily bars before
2023-01-01** and then validated on data that took no part in the choice: the post-2023 BTC period
and six other symbols' full daily history.

Parameter tuning on the training period did **not** survive. A grid-search winner improved
in-sample expectancy from 0.22R to 0.29R, then produced −0.03R on the held-out BTC period and was
worse than the untuned settings on 5 of the 6 held-out symbols. It was fitted, not real, and none
of it was kept.

Two changes did survive, both structural rather than fitted:

**1. Daily bars instead of 15m.** Costs are charged on notional, and risk-based sizing means
notional scales inversely with the stop distance. A 15m stop 0.14% from price plus 1% account
risk implies ~7× notional, so a 20 bps round trip costs **1.19R per trade** — more than the entire
risk unit, which no hit rate can overcome. The same rules on daily bars cost **0.02R**. This is
arithmetic, not backtesting. Intraday timeframes are still selectable and still show the cost
banner; that is the point.

**2. Stop capping winners, not just losers.** Scaling 50% out at 1R while losers run to the full
stop is what turned the four-target ladder negative out of sample.

Out-of-sample results, BTC daily after 2023-01-01 (`npm test` re-runs this against a committed
fixture of those exact bars):

| exit style | trades | win rate | profit factor | expectancy | cost/trade |
|---|---|---|---|---|---|
| runner + 3 ATR trail (default) | 26 | 35% | 1.62 | **+0.32R** | 0.03R |
| GG ladder 50/25/15/10 | 28 | 54% | 1.25 | +0.13R | 0.03R |

The ladder wins more often and earns less — exactly the trade-off the panel is there to show.

Across the six symbols that took no part in selection (ETH, SOL, LINK, AVAX, XRP, DOGE; full
daily history, 186 trades) the default averages **+0.23R** and is positive on **4 of 6**. It loses
on LINK and DOGE. It is a modest, uneven edge on daily crypto — not a money printer — and on 1h
bars it is still negative.

## Does it work on stocks?

No — and the failure is more statistically solid than the crypto success.

Equities are a clean test: the defaults were chosen on BTC, so no stock data took any part in
selecting them. Run over 16 US tickers and ETFs (indices, mega-caps, gold, treasuries), ~24 years
of split-adjusted daily bars each, **1,210 trades**:

| configuration | trades | mean | t-stat | positive symbols |
|---|---|---|---|---|
| shipped defaults (long + short) | 1210 | −0.19R | **−4.71** | 4 / 16 |
| short side only | 739 | −0.49R | **−13.39** | 0 / 16 |
| long side only | 546 | +0.19R | **+2.50** | 9 / 16 |

The short side is the whole problem. Shorting breakdowns in a market with decades of upward drift
loses on *every symbol tested* with a t-stat of −13, and it drags the combined system deep into
the red. Costs are not the explanation — they run 0.03–0.11R here, and the result stays negative
with fees set to zero.

The long side is genuinely positive and, unlike the crypto result, statistically significant. It
is also stable across regimes: +0.215R (t 1.68) over 2002–2013 and +0.170R (t 1.81) over
2014–2026.

**But it is economically worthless.** Trades are rare — about 1.4 per symbol per year — so a
+0.19R edge at 1% risk compounds to almost nothing:

| median annualized, 16 symbols, ~24y | |
|---|---|
| long-only strategy @ 1% risk/trade | +0.09%/yr |
| long-only strategy @ 10% risk/trade | −0.17%/yr |
| buy & hold | **+14.15%/yr** |

Raising risk makes it *worse*, because drawdowns compound against you faster than the thin edge
accumulates. A real edge that is too small and too infrequent to pay for itself is still not a
strategy. The `Equity long` preset exists so you can reproduce this; `test/equities.test.js` pins
it against a committed 24-year SPY fixture.

## Can it be made intraday / high frequency?

Not with these rules, and the reason is worth stating precisely because it is not a tuning
problem.

Cost in R is governed by one ratio: `round-trip cost ÷ (stop distance as a % of price)`. Raising
frequency shrinks the denominator, so it makes the cost problem strictly worse. On BTC:

| timeframe | stop as % of price | cost / trade | expectancy |
|---|---|---|---|
| 1m | 0.023% | **12.99R** | −15.62R |
| 5m | 0.141% | 2.26R | −2.52R |
| 15m | 0.353% | 0.72R | −1.09R |
| 1h | 1.078% | 0.20R | −0.37R |
| 1d | 8.125% | 0.03R | **+0.47R** |

Two things were added to give the intraday case its fairest possible hearing:

**Maker vs taker fees are now modelled separately.** A `retest` entry rests a *limit* order at
the level and a take-profit is also a limit; a next-bar-open entry and every stop are *market*
orders that cross the spread and pay slippage. Routing entries through limits roughly halves the
cost drag (1m: 12.99R → 7.98R), which is the single biggest legitimate lever available.

**A break-even fee metric.** `breakEvenFeeBps` is the exact round-trip rate at which the run's
profit reaches zero — gross profit ÷ turnover, not an estimate. It turns "is this viable?" into a
number you can check against your fee schedule.

It does not save the strategy, because **the signal has no gross edge intraday at all**. With
fees *and* slippage set to zero, the break-even fee is still ≈0 at 1m and 5m and negative at 15m
and 1h — the raw P&L is already flat-to-losing before anyone charges anything. Sweeping ~650
parameter combinations per timeframe at zero cost, positive-gross configurations are the
*minority*:

| timeframe | configs with positive gross expectancy |
|---|---|
| 5m | 41% |
| 15m | 28% |
| 1h | 20% |
| **1d (for contrast)** | **94%** |

A coin flip would score 50%. On daily bars the profitable region is broad and consistent; intraday
it is thinner than chance, which is what an absent edge looks like. Cheaper fills cannot preserve
an edge that is not there.

If you want to pursue intraday seriously, the honest conclusion is that it needs a *different
signal* — one built for the horizon (opening-range, session anchoring, order-flow) — plus a venue
where round-trip costs are under a basis point. The tool now measures both requirements for you.

## Fill model

Backtests flatter themselves in predictable ways, so these are the choices made here:

- Entry is the **next bar's open**. The signal is only known at the signal bar's close.
  `close` mode fills at that close, `retest` places a limit at the level and expires after
  `retestBars`.
- A bar that touches both the stop and a target is resolved **stop-first** by default
  (`pessimisticFills`) — O/H/L/C does not reveal the intrabar path.
- Gaps fill at the open when the open is already through the order price, so a gap through a
  stop costs more than 1R (as it does live).
- Orders are priced by how they fill: limit fills (retest entries, take-profits) pay `feeBpsMaker`
  and never slip; market fills (next-open/close entries, stops, time exits) pay `feeBpsTaker`
  plus slippage. Setting a single `feeBps` still applies one rate to both.
- Fees are charged on the full entry notional and on every partial exit.
- Size comes from `riskPct` of current equity divided by the entry→stop distance, capped by
  `maxLeverage`. Equity compounds trade to trade.
- No lookahead: signal acceptance is decided entirely from bars up to the signal bar. A unit test
  asserts this by truncating the series and requiring identical earlier signals.

## Optimizer

`OPTIMIZER` grid-searches `rangeLen × breakoutBufferAtr × minAdx × volMult × trailAfterTp` on the
first 70% of the bars, then re-runs the top candidates on the held-out 30% and reports both
columns plus a **hold-up** ratio (out-of-sample expectancy ÷ in-sample expectancy).

It also returns a verdict, because a leaderboard always has a top row even when every row loses:

| verdict | meaning |
|---|---|
| `positive_both` | the winner made money in-sample and kept making it out-of-sample |
| `did_not_hold_up` | in-sample winner, out-of-sample loser — the signature of curve-fitting |
| `no_edge_found` | every combination lost in-sample; the ranking is between losers |
| `no_candidates` | nothing reached the minimum trade count |

A negative verdict is a real answer. On BTC 1h the search still returns `no_edge_found` under
these rules — the defaults are viable on daily bars, not on every market and horizon.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/config` | symbols, timeframes, default params, presets |
| `GET /api/candles?symbol=&tf=&limit=` | raw OHLCV (cached) |
| `POST /api/backtest` | bars + signals + trades + stats — everything the chart draws |
| `POST /api/signals` | signals only (cheap, for parameter scrubbing) |
| `POST /api/optimize` | grid search + walk-forward split |
| `POST /api/scan` | the same parameters across every symbol |

Body: `{ symbol, tf, limit, params, source }`. `source: "synthetic"` forces demo data.

## Layout

```
server/indicators.js   pure TA: SMA/EMA/RMA, ATR, ADX, Donchian, pivots, relative volume
server/strategy.js     level detection, filters, stop + target construction
server/backtest.js     bar-by-bar simulation with partial fills and dynamic exits
server/stats.js        panel metrics: PF, expectancy, drawdown, per-TP hit rates
server/candles.js      Coinbase (crypto) + Yahoo (equities) fetch + cache, synthetic fallback
server/optimize.js     grid search + walk-forward validation
src/Chart.jsx          canvas candlestick renderer and all overlays (no chart library)
src/App.jsx            controls, stats panel, blotter, optimizer, scanner
test/                  60 unit tests — `npm test`
test/fixtures/         real out-of-sample bars (BTC daily, 24y of SPY) behind the regression tests
```

## Caveats

Historical performance is not a forecast. The default's out-of-sample edge rests on 26 BTC trades
and 186 across the held-out symbols — enough to prefer it over the ladder, nowhere near enough to
size a real position on. Coinbase spot candles are not the venue you would trade, fee tiers vary,
and crypto's daily history is dominated by two bull markets that a long-biased breakout system
flatters itself on. Treat the out-of-sample column as the only number worth much, and a positive
one as a hypothesis.
