# Breakout Lab — range-breakout strategy with a visual backtester

A self-contained clone of the GG-Shot workflow: find the boundary of a consolidation, take the
break of it, place the stop at structure, scale out across four volatility-derived targets, and
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

**Stop.** `level` (default) puts it just under the boundary that broke, which flips from
resistance to support; `range` uses the far side of the whole range; `atr` uses a fixed distance.
Any mode is floored at 0.5 ATR of risk so noise alone cannot stop you out.

**Targets.** Four static levels at `tpR` multiples of the realized entry→stop distance, scaled
out 50 / 25 / 15 / 10. After TP1 the stop moves to breakeven; after `trailAfterTp` targets the
runner switches to an ATR trailing stop — the two "dynamic" exits.

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

On real BTC/ETH data over a few hundred recent bars the default parameters come out **negative** —
tight structural stops plus round-trip taker fees eat most of a 1R unit, and a 50/25/15/10 ladder
caps winners while leaving losers whole. That is the tool working, not failing.

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
test/                  41 unit tests — `npm test`
```

## Caveats

Historical performance of a parameter set is not a forecast. Coinbase spot candles are not the
venue you would trade, fee tiers vary, and a few hundred bars is a small sample. Treat the
out-of-sample column as the only number worth much, and treat a positive one as a hypothesis.
