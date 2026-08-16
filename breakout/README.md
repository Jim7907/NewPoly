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

Open http://localhost:3004. It loads Coinbase candles for the selected market and backtests
immediately; edit any parameter and the run repeats (debounced). With no network, switch **data**
to `synthetic demo` — a seeded regime-switching generator, clearly labelled in the header so its
numbers are never mistaken for real ones.

Docker:

```bash
docker compose up --build -d      # http://localhost:3003
```

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

## Fill model

Backtests flatter themselves in predictable ways, so these are the choices made here:

- Entry is the **next bar's open**. The signal is only known at the signal bar's close.
  `close` mode fills at that close, `retest` places a limit at the level and expires after
  `retestBars`.
- A bar that touches both the stop and a target is resolved **stop-first** by default
  (`pessimisticFills`) — O/H/L/C does not reveal the intrabar path.
- Gaps fill at the open when the open is already through the order price, so a gap through a
  stop costs more than 1R (as it does live).
- Stop exits are market orders and pay slippage; target exits are limits and do not.
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
server/candles.js      Coinbase fetch + cache, seeded synthetic fallback
server/optimize.js     grid search + walk-forward validation
src/Chart.jsx          canvas candlestick renderer and all overlays (no chart library)
src/App.jsx            controls, stats panel, blotter, optimizer, scanner
test/                  52 unit tests — `npm test`
test/fixtures/         real out-of-sample BTC daily bars, used by the defaults regression test
```

## Caveats

Historical performance is not a forecast. The default's out-of-sample edge rests on 26 BTC trades
and 186 across the held-out symbols — enough to prefer it over the ladder, nowhere near enough to
size a real position on. Coinbase spot candles are not the venue you would trade, fee tiers vary,
and crypto's daily history is dominated by two bull markets that a long-biased breakout system
flatters itself on. Treat the out-of-sample column as the only number worth much, and a positive
one as a hypothesis.
