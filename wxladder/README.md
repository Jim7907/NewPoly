# Temperature Ladder Bot (Polymarket) — paper trading

A standalone bot + dashboard for Polymarket's **daily "Highest/Lowest temperature in {city}"**
markets. Instead of guessing one bucket, it buys a **ladder**: 3–4 adjacent temperature buckets
centred on a bias-corrected forecast for the exact station the market resolves on. **Paper
trading only** — no keys, no orders, no live-trading code path.

It implements the ladder strategy as described, and then does the two things that decide whether
it makes money rather than just feels clever: it **corrects the station bias**, and it **refuses
to buy a cluster that costs more than it is worth**.

---

## The market, as it actually resolves

Each event is one city + one day, split into 11 mutually-exclusive Yes/No buckets
(`negRisk: true`) — a bottom tail, nine single-degree buckets, a top tail:

```
Highest temperature in Singapore on August 25?
  25°C or below  26  27  28  29  30  31  32  33  34  35°C or higher
```

Three details from the live resolution text drive the whole design:

**1. It resolves on a specific ICAO station, and it is rarely the one you would guess.**
Every non-Hong-Kong market says *"information from NOAA, specifically the highest reading under
the 'Temp' column for all times on this day, available at
`weather.gov/wrh/timeseries?site=<icao>`"*. That gives:

| City | Station | City | Station |
|---|---|---|---|
| London | **EGLC** — City, not Heathrow | Paris | **LFPB** — Le Bourget, not CDG |
| Taipei | **RCSS** — Songshan, not Taoyuan | Moscow | **UUWW** — Vnukovo |
| Milan | **LIMC** — Malpensa | Seoul | **RKSI** — Incheon |

All 32 stations, with the coordinates the METAR API reports for them, are in
[`server/config.js`](server/config.js). Hong Kong is listed but **excluded by default**: it
resolves off the HK Observatory's *Absolute Daily Max* to 0.1 °C, a different instrument and a
different rounding rule from the METAR pipeline everything here is verified against.

**2. The resolved value is an integer.** The source reports whole degrees, so bucket "31°C" is
the event `round(T) == 31`. Bucket probabilities are therefore computed on the **±0.5 rounding
boundaries** of a latent continuous temperature, and settlement takes the max (or min) of the
station's rounded readings across its **local** calendar day.

**3. These markets charge a taker fee.** They return
`feeSchedule {exponent: 1, rate: 0.05, takerOnly: true}` ⇒ `fee/share = 0.05·min(q, 1−q)`.
For *any* rung priced under 0.50 that is a **flat 5% of the capital deployed**. The "cheap
wings" of a ladder are not cheap in relative terms — they pay the same 5% haircut as the centre.

---

## Why the naive ladder is not free money

The pitch is that a 47c basket paying $1 doubles when any rung hits. The arithmetic that gets
skipped: **a cluster of buckets is just a coarser event, and it costs the sum of its parts.**
47c buys it only when the market thinks the neighbourhood is worth ~47%. Break even needs

```
P(outcome lands in the cluster)  >  basket cost + fees
```

and these ladders quote a real overround — the Yes prices across the 11 buckets sum to **1.02–1.14**
in live samples. The basket buyer pays that vig on every rung.

So the cluster is not the edge. The cluster is the *shape*: it converts "be exactly right" into
"be approximately right", which is a bet a calibrated forecast can actually win. The **edge** has
to come from having a better distribution than the book. That is what the rest of this is.

---

## What the backtest measured

`npm run backtest` replays archived forecasts against the station readings the markets settle on,
**walk-forward** — the bias at each date is fit only on strictly earlier days. Over 2026-06-24 →
2026-08-23, 5 stations, 265 scored days:

| | |
|---|---|
| Centre error, **raw** model | MAE **1.31 °C** |
| Centre error, **bias-corrected** | MAE **0.64 °C** |
| 3-rung cover rate | **89.8%** (model claimed 90.6% — gap −0.8pp) |
| 4-rung cover rate | **97.0%** (claimed 96.4% — gap +0.5pp) |
| Break-even basket cost | **0.855** (3 rungs) · **0.924** (4 rungs) |

Two things worth reading twice:

- **The bias correction halves the error**, and it is not a small tweak — it is often a whole
  bucket. Per-station offsets from a live seeding run:

  | Station | Bias | MAE raw → corrected |
  |---|---|---|
  | Tokyo / Haneda `RJTT` | **+2.32 °C** | 2.58 → 1.13 |
  | Taipei / Songshan `RCSS` | **+2.06 °C** | 2.28 → 0.99 |
  | Singapore / Changi `WSSS` | **+1.42 °C** | 1.50 → 0.48 |
  | Manila `RPLL` | +1.24 °C | 1.59 → 1.00 |
  | London / City `EGLC` | +0.32 °C | 0.79 → 0.72 |

  These are coastal airports whose model grid cell sits partly over water. Feed a ladder the raw
  forecast at Haneda and the whole cluster is centred two buckets low.

- **The calibration gap is under 1pp.** The model's claimed cover and its realized cover agree,
  which is the only reason its probabilities are usable as prices at all.

`MAX_BASKET_COST` defaults to **0.85** because of the 0.855 number above, not because it is round.

---

## How the model works

```
centre = W_DET·(high-res deterministic consensus) + (1−W_DET)·(ensemble mean)  +  station bias
sigma  = station's realized post-correction error  ×  (today's spread / its own median)^SPREAD_GAMMA
P(bucket k) = Φ((k+0.5 − centre)/sigma) − Φ((k−0.5 − centre)/sigma)
P_used = W_MODEL·P_model + (1−W_MODEL)·P_market            (market de-vigged to sum to 1)
```

- **Ensemble** — every member of ECMWF-IFS / GFS / ICON as an *hourly* series, sampled at the
  station's coordinates. Each member contributes its own daily extreme, mirroring how the market
  resolves, rather than trusting a single `temperature_2m_max` field.
- **Centre from the deterministic runs, spread from the ensemble.** The high-res deterministic
  grids resolve the station's cell better; the ensemble is what knows about uncertainty.
- **Sigma is anchored on realized error, not on the ensemble's opinion of itself.** Raw ensemble
  spread is famously underdispersive at a point. The anchor is this station's own measured
  post-correction residual; today's ensemble only *scales* it.
- **Blend toward the market.** The book aggregates later model runs, local knowledge, and the
  readings already posted. `W_MODEL=0.6` tilts to the model — that is the thesis — without
  pretending the book knows nothing.
- **Circuit breakers.** If model and market describe different worlds (total-variation distance
  > `MAX_TVD`) or a basket implies more than +150%/$, that is a broken model far more often than
  a free lunch. It refuses.

### The underdispersion filter

`dispRatio = today's ensemble spread ÷ this station+lead's own median spread`

- **tight** (≤ 0.85) — models quietly agree ⇒ sigma shrinks, cluster narrows to 3, budget ×1.5
- **normal** — widths 3–4, budget ×1
- **wide** (≥ 1.25) — sigma inflates, cluster widens to 4, budget ×0.5 (or sit out entirely)

This one **cannot be seeded**: Open-Meteo returns nulls for past-date ensemble members, so
historical spread is unavailable. It reports `regime: unknown` (treated as normal, no conviction
bonus) until `MIN_DISP_SAMPLES` days of live spread have accumulated. Stated plainly rather than
papered over.

### Sizing

The buckets are mutually exclusive, so rungs are sized with **multi-outcome (horse-race) Kelly**
(Smoczynski & Tomkins closed form) rather than leg-by-leg. It naturally puts the money on the
centre and a thin stake on the wings — and it **holds cash back on its own** when the rungs are
not worth their price, so an all-zero allocation is a real answer, not a bug.
`SIZING=prob` gives the plain probability-weighted scheme; `SIZING=equal` buys equal *shares*, the
true "any rung pays the same dollar" basket.

### Guardrails

| Guard | Default | Why |
|---|---|---|
| `LADDER_MIN_W` / `MAX_W` | 3 / 4 | Wider and a single winner barely clears the basket |
| `MAX_BASKET_COST` | 0.85 | The measured break-even for a 3-rung cluster |
| `MIN_BASKET_EV` | 0.08 | After fees, slippage, and the book's overround |
| `MIN_COVER_PROB` | 0.70 | The cluster has to actually cover |
| `MIN_BIAS_SAMPLES` | 8 | **Refuses to trade an uncalibrated station at all** |
| `MIN_LEG_DEPTH_USD` / `MIN_ORDER_SHARES` | 20 / 5 | A rung that cannot be filled is not bought |
| `BUDGET_FRAC` / `AGG_CAP` | 0.02 / 0.25 | Per-market and aggregate exposure |

Rungs are re-priced by **walking the real ask book** for the size being bought, and trimmed back
if the walk costs more than the allocation — the basket never exceeds its budget.

---

## The learning loop

The bot refuses to trade a station until its bias is calibrated, so it must collect the
calibration whether or not it trades. Every scan it logs the forecast for every station it
watches, and backfills observations for past dates. On first boot it **seeds ~45 days** of
(archived forecast, observed station value) pairs so it starts calibrated instead of spending its
first week refusing everything.

Sources: [Open-Meteo](https://open-meteo.com) ensemble/forecast/historical-forecast APIs, the
[Iowa State IEM ASOS archive](https://mesonet.agron.iastate.edu) for station history, and
`aviationweather.gov` METAR as the live fallback. All free, no keys.

---

## Quick start

```bash
cp .env.example .env
npm install
npm test              # 82 deterministic unit tests, no network
npm run server        # API + scan loop + WS  ->  http://localhost:3003
npm run dev           # + Vite frontend on http://localhost:3001
npm run backtest      # walk-forward backtest + parameter fit (prints JSON)
```

First boot seeds the bias history (a few minutes for all 32 stations). Watch the **STATIONS** tab
to see which are calibrated. Narrow `CITIES` in `.env` to cut the forecast API load.

## Deploy to a VPS

Paper mode is the only mode — there is no live-trading code, no API keys, no real orders.

```bash
curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/temperature-ladder-polymarket-ac1c04/wxladder/deploy.sh | bash
```

or manually:

```bash
git clone https://github.com/Jim7907/NewPoly.git
cd NewPoly && git checkout claude/temperature-ladder-polymarket-ac1c04
cd wxladder && docker compose up --build -d
```

Then open `http://<vps-ip>:3003`. Without Docker, use `systemd/wxladder.service`. Open port
**3003** in the firewall (ideally behind nginx/Caddy with TLS). Data persists in the
`wxladder_data` volume (or `wxladder/data/` for the systemd path).

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | server status, seeding state, last scan |
| `GET /api/live` | every live ladder: distribution, rungs, gates, refusal reasons |
| `GET /api/ladder/:eventId` | one ladder in full |
| `GET /api/stations` | station table + each station's bias fit and calibration state |
| `GET /api/baskets` | placed/settled ladders with their rungs |
| `GET /api/stats` | balance / hit rate / P&L / ROI |
| `GET /api/calibration` | rung reliability, claimed vs realized cover, residual centre error |
| `GET/POST /api/backtest` | last result / run the walk-forward fit |
| `POST /api/seed` | seed bias history from the archives (safe to re-run) |
| `POST /api/paper-trade` | place the current plan for one market by hand |
| `POST /api/settings` | thresholds, sizing mode, pause/resume |
| `POST /api/scan` | force a scan now |
| `POST /api/reset-paper` | reset the paper balance |

## Honest expectations & risks

- **The measured claim is calibration, not profit.** Historical CLOB prices are not freely
  replayable, so the backtest scores the *distribution* (log-loss, cover rate, break-even cost)
  and does not assert a P&L. Whether ladders are affordable at those break-evens is proven
  forward on the **CALIBRATION** tab, which compares claimed cover to realized cover. The app
  measures its edge; it does not assume it.
- **Biggest risk: the break-even is not that far away.** A 3-rung cluster needs to be bought
  under ~85c. Live ladders often quote the centre bucket rich enough that no window clears the
  cap — the correct response is to buy nothing, which is what it does. Expect **few trades**.
- **Second risk: the bias is not stationary.** Station offsets drift with season and wind regime.
  Hence the exponentially-weighted fit (`BIAS_HALFLIFE_DAYS`), the clamp, and the residual
  centre-error readout on the CALIBRATION tab as the early-warning signal.
- **Third: grid snap.** Ensemble members run on ~0.25° cells, so a coastal station is evaluated
  up to ~20 km away. That residual is exactly what the bias term absorbs — which is also why an
  uncalibrated station is refused rather than traded with a shrug.
- **Fees are modelled, not waved at.** Every leg pays `0.05·min(q,1−q)` per share plus slippage,
  and the EV gate is applied after them.
- The underdispersion filter is the least-proven component: it ships enabled but with no
  conviction bonus until it has real spread history, and `SKIP_WHEN_WIDE` is off by default.
