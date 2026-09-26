# Decision Engine v1: Correctness Audit (September 2026)

**Scope.** This is an adversarial review of the v1 decision path, in priority order:

1. `decision/ensemble.js` and `decision/risk.js`
2. `engine.js` (the learning loop)
3. `learning/{backtest,calibrator,weights}.js` and `analysis/ml.js`
4. every analyzer
5. the data layer
6. `portfolio.js`

**Method.** I only called something a bug after a probe script with concrete inputs reproduced it. Some probes used live data through `server/data`; others were simulations or Monte Carlo runs. Findings are ranked by their effect on decision accuracy. "Fixed" means the fix is in the working tree and has a regression test in the matching `test/*.test.js`. Files I was not allowed to edit (`engine.js`, `ensemble.js`, `db.js`, `index.js`) get exact patches in §4. Those patches were applied to a scratch copy of the tree, where the full suite passes (287/287) and a live smoke test behaved as intended.

---

## 1. Headline findings

0. **Critical: the whole data layer is untracked by git.**
   - `.gitignore` line 3 is `data`. Git matches a pattern without a slash at every depth, so it ignores both `./data` (the SQLite dir, intended) and **`server/data/`**. Evidence: `git check-ignore -v server/data/stocks.js` reports `.gitignore:3:data`, and `git ls-files server/data` is empty.
   - Consequences:
     - `deploy.sh` does `git clone`, so a fresh deploy has no `crypto.js`, `stocks.js`, `http.js`, `index.js`, `macro.js` or `news.js`, and `require("./data")` fails at boot.
     - `test/data.test.js` fails on any clone.
     - The integrator's WIP snapshot commits do not contain the data layer, nor this audit's fixes in `server/data/stocks.js` and `server/data/index.js`.
   - `.dockerignore` is not affected: Docker patterns are root-anchored.
   - **Fix** (outside my edit scope, so for the integrator): in `.gitignore`, change `data` to `/data`, then `git add server/data`.

1. **The v1 pooled probability has no out-of-sample skill, and the calibrator was inventing edges.**
   - I ran warm-start backtests on 8 crypto assets and 15 stocks (about 1,000 daily bars each) and fitted the calibrator on them. Scored out of fold, the old (unshrunk) isotonic map was *worse* than the constant base rate:
     - crypto: OOF Brier 0.2505 vs 0.2499 for the base rate;
     - stocks: OOF Brier 0.2463 vs 0.2460.
   - Its in-sample ECE was about 0.00001, so the ensemble trusted it: reliability K ≈ 1, Kelly reliability ≈ 1.
   - Out of fold, the stock calls where it reported a "≥ 0.04 edge over the base rate" were 600 longs. They hit **55.5%**, against an unconditional up-rate of **56.5%**, which is worse than always going long.
   - On pure noise with persistent scores and overlapping labels, the map gave **9.5% of bars** a fake ≥ 0.04 edge.
   - **Fix:** the calibrator now shrinks every fitted map toward the base rate, by an amount chosen from purged, blocked out-of-fold log-loss. It also reports honest OOF metrics.
   - **Result:** on real data λ = 0 for both classes, so the pooled v1 path now abstains instead of trading noise. v2 models can still override it through `probability` and `meta`.
2. **Train/serve skew in the calibrator input (the quantification you asked for).**
   - The calibrator is fitted on backtest pRaw, which comes from daily technical + regime signals, with no learned weights and no mask, pooled with `expectedFamilies [technical, regime]`.
   - It is then applied to live pRaw. Live pRaw adds 15m/1h signals, ML, derivatives, sentiment, macro and fundamentals, applies learned weights, and renormalises for silent families.
   - Measured on 20 assets today:
     - **crypto:** mean |ΔL| = **0.083**, which is **0.56σ** of the training logit distribution (σ = 0.149). corr(L_live, L_bt) = **0.42**.
     - **stocks:** mean |ΔL| = **0.045** (0.31σ), corr 0.96.
   - Live (pRaw, y) pairs were then mixed into the same training set as backtest pairs, so the calibrator was fitted on two different statistics.
   - **Recommended fix (patch N1/E1/D1):** calibrate the backtest-equivalent statistic, and add the unvalidated remainder as a shrunk, capped log-odds offset.
3. **The weight learner learned drift, not skill, and its backtest priors never reached a live signal.**
   - Hedge rewarded "sign(score) = sign(return)". With 57% up-weeks, a no-skill always-bullish signal went to w = **1.94** and an always-bearish one to **0.63**.
   - `seed()` overwrote its priors once per asset, so the last asset won (DIA).
   - Seeding used hit rates polluted by drift, and raw n where it should have used n_eff.
   - Worst of all, the seeded ids were `tech.<sub>.<name>`, while live signals are `tech.1d.<sub>.<name>`. Only **4 of 105** live BTC signals ever received a prior.
   - All of this is fixed.
4. **Stock labels and position expiries ran on calendar days.** A "5-bar" swing label or position lasted **3.0–4.8 trading days** (mean ≈ 3.4), while backtests, ML labels and the calibrator all use 5. Fixed in the data layer and the portfolio; patch N2 covers the engine's `resolveAt`.
5. **Double-counted evidence.** Four sources:
   - `regime.trend.state` correlates **0.75–0.92** with the technical trend view (it uses the same ADX, EMA and slope inputs).
   - 15m/1h indicators supplied **30–60%** of the technical log-odds for a 5-day call, at full "swing" weight.
   - `tech.mtf.alignment` re-aggregates the per-timeframe trend views.
   - An abstaining ML family inflated all other evidence by **×1.12**.

   All four are fixed or patched.

---

## 2. Findings table

Severity reflects the effect on decision accuracy.

**Column key:**
- **Probe:** whether a probe script with concrete inputs reproduced the finding.
- **Fixed:**
  - **yes** — fixed in the working tree, with a regression test.
  - **patch** — the file belongs to the integrator; an exact patch is in §4.
  - **no** — recommendation only.

| # | Sev | Finding | Location | Probe | Fixed |
|---|---|---|---|---|---|
| 0 | critical (deploy) | `.gitignore` pattern `data` also ignores `server/data/` (the entire data layer is untracked; clones and deploys are broken) | `.gitignore:3` | yes (`git check-ignore`) | patch: `data` → `/data` |
| 1 | critical | The isotonic calibrator invents edges and reports in-sample reliability. The v1 pooled pRaw has zero OOF skill. | `learning/calibrator.js` fit/apply (fixed: L150 `oofPredictions`, L247 λ, L277 `reliable`); `decision/ensemble.js:220` (calibInfo uses in-sample ECE) | yes | yes (calibrator) + patch E4 |
| 2 | high | Calibrator train/serve skew: backtest pRaw vs live pRaw, and mixed pair definitions | `engine.js:157` (calibrator applied to full pRaw), `engine.js:204` (live pairs = full pRaw), `ensemble.js:366`, `db.js:99` | yes | patch N1/E1/D1 + index migration |
| 3 | high | Hedge update rewards drift (base rate), not skill | `learning/weights.js:48–66` (fixed), `engine.js:203` | yes | yes + patch N3 (pass `baseRate`) |
| 4 | high | Seeded technical priors never reach live MTF ids (4/105 matched) | `learning/backtest.js:298` (aliases added) | yes | yes |
| 5 | high | `seed()` overwrote per asset (last asset wins); hit rates include drift; shrinkage used n rather than n/ahead | `learning/weights.js:85` (fixed), `engine.js:222` | yes | yes + patch N5 (`clearPriors`) |
| 6 | high | Stock label and expiry horizons in calendar time (3.0–4.8 trading days instead of 5) | `engine.js:187`, `portfolio.js:63` (fixed), `data/stocks.js:65,92` (new helpers) | yes | yes (portfolio) + patch N2 (engine) |
| 7 | high | `regime.trend.state` duplicates the technical trend evidence (corr 0.75–0.92) | `analysis/regime.js:337` | yes | yes |
| 8 | high | 15m/1h technical signals counted as full-weight swing/position evidence (30–60% of technical log-odds) | `analysis/technical.js:597–619` | yes | yes |
| 9 | high | The global `MAX_PAIRS` slice over asset-ordered pairs drops 24 of 50 stocks (AAPL…PG: all of tech, communication and consumer discretionary) | `engine.js:33,53` | yes | patch N4 |
| 10 | medium | Derivatives: 179-day OI change paired with a 12.5-day price change (BTC "OI +8.0%, price +9.2%") | `analysis/derivatives.js:60–88` | yes | yes |
| 11 | medium | Bracket E[τ] approximation 22–26% low, so E[r] understated by ~25–40% and the cost gate is too strict | `decision/risk.js:89` | yes (Monte Carlo) | yes |
| 12 | medium | Kelly used the two-outcome variance W·L, which is 2–3× the true bracket variance, so Kelly was under-sized 2–3× | `decision/risk.js:145` | yes (Monte Carlo) | yes |
| 13 | medium | Forming (partial) bar volume read as a volume collapse (vol_z −1.2…−1.8σ at mid-day, ≈ −5σ early). The ML feature goes out of distribution. | `analysis/indicators.js:561`, `technical.js:105`, `ml.js:731` | yes | yes |
| 14 | medium | Learning samples are also logged on every action change (near-duplicate, fully overlapping, concentrated at the decision boundary). Stocks are logged overnight and at weekends. | `engine.js:184` | no (code reading) | patch N2 |
| 15 | medium | Late resolution (after downtime) labels with the *current* price | `engine.js:196` | yes (patched smoke test) | patch N3 |
| 16 | medium | ML score 2p − 1 includes the training base rate, so a no-skill model votes the drift (double-counted with the calibrator) | `analysis/ml.js:742` | yes | yes |
| 17 | medium | Renormalisation treats an abstaining family (ML at confidence 0) as missing, inflating everything else ×1.12 | `ensemble.js:343` | yes | patch E5 |
| 18 | medium | The v2 `relative` family is not in `FAMILIES`, so it is pooled as "other" at β = 0.1 at every horizon | `ensemble.js:57` | yes | patch E2 |
| 19 | medium | `tech.mtf.alignment` restates the per-timeframe trend signals in its own dedup group | `ensemble.js:95` | no (code reading) | patch E3 |
| 20 | low | ETF correlation prior class mismatch ("etf" vs "stock"): SPY next to AAPL haircut 0.90 instead of 0.75 | `decision/risk.js:128` | yes | yes |
| 21 | low | Fundamentals staleness measured from fetch time (`asOf` = now), so it was always "fresh" | `analysis/fundamental.js:179` | yes | yes |
| 22 | low | Nasdaq intraday includes pre/post-market prints (from 04:00 ET), appended to RTH-only Yahoo history | `data/stocks.js:138,201` | yes | yes |
| 23 | low | Fear & Greed avg7 guessed the array order; on ties (live: 71/71) it averaged the *oldest* week | `analysis/sentiment.js:396` | yes | yes |
| 24 | low | Crypto "52-week" window = 252 daily bars (36 weeks) | `analysis/technical.js:501` | yes | yes |
| 25 | low | `macro.risk.regime` = mean of the VIX and credit stress, both also emitted (partial double count) | `analysis/macro.js:145` | no | no (rec.) |
| 26 | low | VPIN used as a directional signal; RESEARCH §1.8 says dampener only | `analysis/microstructure.js:220` | no | no (rec.) |
| 27 | low | Crypto fundamentals `momentum_30d/1y` and `ath_drawdown` restate price momentum and the 52-week high (cross-family) | `analysis/fundamental.js:429,456` | no | no (rec.) |
| 28 | low | Breakeven stop exists only live (not in backtests or the bracket model); with a positive edge it truncates winners | `portfolio.js:93` | no | no (rec.) |
| 29 | low | Stock decision and label price can be a pre/after-market quote while signals use the last close | `engine.js:137` | yes (quote in Pre-Market) | mitigated by N2 |
| 30 | info | `kalmanTrend` calibrates noise on the whole input (fine today: windows end at bar i). Hazard if the aligned array is ever used historically. | `analysis/indicators.js:529` | no | no |
| 31 | info | Recent trend IC(5d): negative on SPY/AAPL (−0.13), positive on BTC/ETH (+0.07/+0.13). The ×1.3 "trending" multiplier amplifies an anti-predictive stock signal. | `ensemble.js` styleMultiplier | yes | no (v2 report card should gate) |
| 32 | info | Checked and fine: Coinbase maker→aggressor side flip, pagination (0 gaps over 1,000d and 300h), ML purge/embargo, HMM filtered (not smoothed) probabilities, backtest next-open entry, portfolio accounting (long and short round trips reconcile to 0.0035 USD rounding), Nasdaq `/historical` serves only completed sessions | various | yes | n/a |

---

## 3. Details and evidence

### 3.1 Calibrator: spurious edges, in-sample reliability, zero OOF skill (#1)

**Mechanism.**
- The pooled pRaw is persistent: its AR(1) coefficient is about 0.9, because it moves with the trend.
- Labels overlap by `ahead` bars.
- As a result, a PAV block of ~120–300 pairs holds perhaps 10–30 independent outcomes. Tail blocks pick up noise, and PAV monotonises it into an "edge".

**Evidence.**

| Probe | Input | Result |
|---|---|---|
| `p06` | pure noise | isotonic in-sample ECE 0.011–0.017 → ensemble K = 0.98, Kelly reliability 0.95; calibrated outputs span 0.49–0.59 |
| `p15` | AR(1) score, 5-bar overlapping labels, k = 0, n = 15,000 | 9.5% of test bars had \|pUp − base\| ≥ 0.04; OOS Brier 0.24983 vs 0.24910 for the base rate |
| `p19` | real OOF, stocks | 600 "edge" calls hit 55.5% vs a 56.5% base; crypto: 32 calls at 25% vs 47.5% |
| `p18` | real data, after the fix | λ = 0 for both classes, `reliable: false`, OOF Brier skill score 0 |

**Fix (`learning/calibrator.js`).**
- The method schedule by n_eff is unchanged (it is documented in RESEARCH §4).
- Every fitted map is then shrunk toward the base rate: `q' = base + λ·(q − base)`.
- λ ∈ {0, 0.05, …, 1} minimises the log-loss over 5 contiguous out-of-fold folds, purging ±`ahead` training rows around each test fold.
- `reliability()` gains `oof: { brier, logloss, ece, brierBase, bss, lambda, unshrunk }`, plus `lambda` and `base`.
- `reliable` is false when λ = 0.
- λ and base are serialised. Pre-audit JSON loads with λ = 1, so old behaviour is preserved.

**Result on the synthetic probes.**
- Noise: λ = 0–0.2 and 0% spurious edges.
- An informative score (k = 0.15): λ = 0.85, with OOS Brier better than the base rate.

**Integrator patch E4.** `calibInfo` should use `rel.oof.ece` and `rel.oof.bss`. In-sample isotonic ECE is ~0 by construction.

### 3.2 Calibrator train/serve skew (#2): quantified, with a recommended fix

**Probes `p07` and `p08`.** 8 crypto assets and 15 stocks, as of 2026-09-25. I compared, on the same bar:

- **backtest-style pRaw:** `technical.analyze(daily) + regime`, `expectedFamilies [technical, regime]`;
- **live pRaw:** `engine.buildSignals`, pooled with ensemble defaults.

| class | training σ(logit pRaw) | mean \|L_live − L_bt\| | shift in σ | corr(L_live, L_bt) | live pRaw outside calibrator support |
|---|---|---|---|---|---|
| crypto | 0.149 | 0.083 | 0.56σ | 0.42 | 2/8 |
| stock | 0.147 | 0.045 | 0.31σ | 0.96 | 1/15 |

**Decomposition of the crypto shift** (mean |ΔL|, adding one piece at a time):

| Step | Mean \|ΔL\| |
|---|---|
| 15m/1h timeframes + mtf alignment | 0.043 |
| renormalisation for expected-but-silent families (ML at confidence 0 counts as missing) | 0.101 |
| the other live families (derivatives, sentiment, macro, fundamentals) | 0.048 |

For stocks the same steps give 0.040, 0.042 and 0.027. Replacing live `tech.1d.*` with backtest `tech.*` reproduces the backtest pRaw exactly (ΔL = 0.000), which confirms the decomposition.

Learned weights are a further live-only shift, not included above.

**Recommended fix (patches N1, E1, D1, plus the index.js migration).**
- **Calibrator input.** The engine computes `calDecision` from exactly the backtest subset: base-tf technical with ids normalised to `tech.*`, plus regime, unmasked and unweighted, with `expectedFamilies: ["technical", "regime"]`. It passes `calibration: { pRaw, logOdds, extraShrink: 0.5 }` to `ensemble.decide`.
- **Offset.** The ensemble calibrates `pRaw_cal` and adds the un-backtested remainder as a shrunk, capped offset:

  ```
  logit(pUp) = logit(cal(pRaw_cal)) + 0.5 · clamp(L − L_cal, ±0.4)
  ```

  The cap limits the unvalidated families to about ±0.05 in probability. Setting `extraShrink: 0` gives the purist version.
- **Stored pairs.** `db.logDecision` stores `pRawCal` in the `pRaw` column, which only the calibrator uses. Live pairs then match backtest pairs.
- **One-time migration.** Stored pairs and calibrators were fitted on the old definitions (signal definitions changed; see §5), so `index.js` drops them once and re-runs the warm start.

This makes the skew zero by construction for the calibrated part.

### 3.3 Weight learner (#3, #4, #5)

**Drift bias (#3).** Probe `p05`: 3,000 simulated outcomes, P(up) = 0.57, no-skill votes, scale 1/5.

| Signal | Old weight | New weight (with `baseRate`) |
|---|---|---|
| always-bull | 1.94 | ≈ 1 (± 0.15) |
| always-bear | 0.63 | ≈ 1 (± 0.15) |
| coin-flip | 1.02 | not re-run |

- The fix rewards `sign(score)·2·(y − b)`, which is identical to the old rule when b = 0.5.
- The new regression test confirms both no-skill signals stay near 1.

**Dead priors (#4).** Probe `p04`:
- Live BTC produces 105 signal ids (3 timeframes); live AAPL produces 84.
- The backtest produces 28 ids.
- Only the 4 `regime.*` ids overlapped.

`backtest.run` now also publishes each base-tf technical stat under its live id, `tech.<tf>.<sub>.<name>` (field `alias`). `topSignals` in the CLI skips the aliases.

**Seeding (#5).**
- **Before:** each `seed()` call overwrote the previous one. Seeding asset A (n = 2000, 60% hits) and then asset B (n = 200, 45%) gave w = 0.852; the pooled value is 1.406.
- **Now:**
  - counts are pooled across calls;
  - the skill hit rate is `0.5 + (hits − E₀)/n`, where E₀ = the hits a no-skill vote with the same long/short mix would get (from new `nLong`/`yUp` stats emitted by the backtest);
  - shrinkage uses n_eff = n/ahead.
- **Result on real data (`p18`):**
  - `tech.1d.trend.ema_stack` w = 1.06 (skill hit rate 51.5%);
  - `regime.vol.level` w = 0.99.
- `clearPriors()` lets a fresh warm start avoid pooling with stale priors (patch N5).

### 3.4 Stock horizons in calendar time (#6, #14)

**Probe `p10`.** A decision on Mon, Tue, Wed, Thu, Fri or Sat with `resolveAt = now + 5·86400 s` spans 4.77, 3.77, 3.00, 3.00, 3.00 and 3.23 trading days respectively.

**New helpers.**
- `data/stocks.addTradingTime` counts regular-session time, skipping weekends and NYSE holidays.
- `data/stocks.horizonEndMs` uses it: 1 daily bar = 6.5 h of session time.
- `data.horizonEnd` wraps it.

**Examples:**
- Fri 11:00 ET → next Fri 11:00.
- Sat → next Fri close.
- 8 × 15m bars from Thu 15:00 ET → Fri 10:30.

**Where it is applied.**
- `portfolio.js` expiries use it now.
- Patch N2 makes `maybeLog` use it for `resolveAt`. It also logs at a fixed cadence only (no action-change samples) and logs stocks only during regular hours.

### 3.5 Double counting (#7, #8, #17, #19)

- **#7 `regime.trend.state`.** Probe `p11`, daily history, correlation with the technical trend view: BTC 0.87, ETH 0.92, SPY 0.75, AAPL 0.80, MSFT 0.83.
  - The whole regime family correlates 0.61–0.86 with technical.
  - The signal is now context-only (confidence 0). Its score is kept for the UI.
  - The ensemble's regime-conditioned multipliers still use `regime.trend`.
- **#8 multi-timeframe.** Probe `p13`: 15m + 1h supplied 42% (BTC), 34% (ETH), 62% (SOL), 28% (AAPL) and 47% (MSFT) of the technical |log-odds| for a 5-day call.
  - Per-timeframe signals from sub-daily bars are now tagged `"intraday"` for swing and position requests. The ensemble's existing horizon-mismatch factor (×0.6) then applies.
  - Lookbacks are unchanged; only the tag changes.
- **#17 renormalisation.** Probe: the same signals with ML present at confidence 0 give L = 0.1832, versus 0.1632 when ML is not expected. That is ×1.123. Patch E5.
- **#19 mtf alignment.** Patch E3 folds `tech.mtf.alignment` into the trend dedup group.

### 3.6 Risk math (#11, #12, #20)

**Probe `p09`.** Monte Carlo with 40,000 paths and 24 sub-steps per bar.

| Bracket | E[τ], old formula | E[τ], Monte Carlo | E[τ], new exact | W·L | Monte Carlo variance |
|---|---|---|---|---|---|
| 2/3 ATR, H = 5 | 3.65 | 4.67 | 4.60 | 5.4e-3 | 1.83e-3 (×2.96) |
| 3.5/5.5 ATR, H = 20 | 13.68 | 17.91 | 17.61 | ×2.4 of Monte Carlo | — |

- **E[τ].** The new value is the exact driftless E[min(τ, H)]: a method-of-images survival integral with a t = H·u² substitution, costing about 0.15 ms per call.
- **Kelly.** Now `eNet / (σ²·E[τ])` (Wald's second identity). About 80% of trades exit at the time limit, not at the stop or target, so the two-outcome W·L variance was wrong.
- **Tests.** The existing test "Kelly = K·eNet/(W·L)" was updated to the corrected formula; it is the only changed assertion.
- **Expected side effects.** E[r] and the cost-gate pass rate rise by about 25%. Kelly sizes rise 2–3×, but `MAX_POS_FRAC` and the vol target still cap them.
- **#20 ETF correlation prior.** A class-normalisation fix; test added.

### 3.7 Data and analyzers (#10, #13, #16, #21–#24)

- **#10 derivatives window.** Probe `p02`: OKX `rubik` returns 180 daily OI points, but the price change came from 300 hourly candles.
  - OI and price are now measured over the same recent window (default 7 days, configurable), trimmed to what the candles cover.
  - BTC now reads "OI +8.9%, price +10.1%" over Sep 17 → Sep 24 16:00 UTC, which I verified bar by bar.
  - Fixing the unit heuristic: epoch seconds are only assumed for t ∈ [1e9, 1e11).
- **#13 forming bar.** Probe `p03`, at 54% of the UTC day:
  - vol_z_20 for BTC/ETH/SOL/DOGE was −0.79/−1.24/−0.87/−1.41 on the partial bar, vs +0.47/+0.06/+0.96/−0.01 once pro-rated;
  - the training 1% quantile is −2.44.
  - `projectFormingVolume` pro-rates the last bar's volume by its elapsed fraction (floor 0.1). It is used by `technical.analyze` and by ML inference features.
  - Complete histories are unchanged, so backtests are unaffected.
  - Nasdaq daily history has no partial row (checked 12 minutes into the session), so this is crypto-only for daily bars.
- **#16 ML score.** Now `score = 2·(p − b)`, with b = the training base rate; `value.p` and `value.baseRate` are reported. The ML test assertion was updated.
- **#21 fundamentals staleness.** Now measured from `periodEnd` with a 135-day grace period.
- **#22 Nasdaq intraday.** Probe: the raw feed starts at 04:00 ET. The live fetcher now keeps 09:30–16:00 ET only. The parser's default is unchanged, so fixtures still pass.
- **#23 Fear & Greed.** avg7 now uses timestamps to pick the 7 newest observations.
- **#24 crypto 52-week window.** 365 daily bars for crypto, 252 for stocks.

---

## 4. Proposed patches for integrator-owned files

The patch below applies cleanly to the working tree as of this report:

```
cd /home/user/NewPoly && git apply --directory=decision-engine <patch>
```

With it applied to a copy of the tree, `node --test test/*.test.js` passes 287/287 (1 skipped). A live smoke test showed:
- BTC: `pRawCal` 0.5546 vs full `pRaw` 0.5339;
- `pRawCal` is stored in the DB;
- AAPL's label resolves 5 sessions later (Fri → Fri);
- a BTC decision due 3 days ago resolved with the 15m-bar price from 3 days ago, not the current tick.

Hunk summary:

**`ensemble.js`**
- **E1 — calibration input:** `a.calibration = { pRaw, logOdds, extraShrink }`.
- **E2 — relative family:** add `relative` to `FAMILIES`, with β 0.2 / 0.5 / 0.6 (intraday / swing / position); the integrator should tune these. It is not an "expected" family, since it needs cached peers.
- **E3 — mtf dedup:** `tech.mtf.alignment` joins the trend dedup group.
- **E4 — calibrator reliability:** `calibInfo` uses the OOF ECE and BSS.
- **E5 — renormalisation:** families that reported (even at confidence 0) are not missing.

**`engine.js`**
- **N1 — calibration subset:** `calibrationSignals` plus `calDecision`, and `decision.pRawCal`.
- **N2 — sampling:** fixed-cadence sampling, stocks sampled only in regular hours, and `resolveAt` from `data.horizonEnd`.
- **N3 — resolution:** late resolution uses `priceAt(resolveAt)`; Hedge gets `baseRate`; pairs are tagged `{t, a}`.
- **N4 — pair retention:** keep the latest 1,500 pairs per asset, ordered by (asset, time).
- **N5 — warm start:** `learner.clearPriors()`, and warm-start pairs tagged with the asset id.

**`db.js`**
- **D1:** store `pRawCal ?? pRaw` in the `pRaw` column.

**`index.js`**
- **I1:** one-time `calib_schema` migration: clear pairs, calibrators and the `warm_*` flags, so the warm start refits on the new definitions.

```diff
--- a/server/decision/ensemble.js
+++ b/server/decision/ensemble.js
@@ -54,7 +54,7 @@
   HORIZON_MISMATCH: 0.6,
 });
 const BRACKETS = Object.freeze({ intraday: { stop: 2, target: 3 }, swing: { stop: 2, target: 3 }, position: { stop: 3.5, target: 5.5 } });
-const FAMILIES = ["technical", "regime", "fundamental", "sentiment", "macro", "microstructure", "ml", "llm", "derivatives"];
+const FAMILIES = ["technical", "regime", "fundamental", "sentiment", "macro", "microstructure", "ml", "llm", "derivatives", "relative"];
 
 const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
 const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
@@ -65,9 +65,9 @@
 // Base family weights β by horizon (RESEARCH §5.1). `fundamental` is the stock value; crypto uses
 // CRYPTO_FUNDAMENTAL. ML is not boosted: its own signal confidence (OOS-AUC based) scales it.
 const DEFAULT_FAMILY_WEIGHTS = Object.freeze({
-  intraday: { technical: 1, ml: 0.6, regime: 0.3, derivatives: 0.3, microstructure: 0.7, sentiment: 0.3,  macro: 0.1, fundamental: 0,    llm: 0.2 },
-  swing:    { technical: 1, ml: 0.7, regime: 0.4, derivatives: 0.5, microstructure: 0.1, sentiment: 0.3,  macro: 0.3, fundamental: 0.15, llm: 0.3 },
-  position: { technical: 1, ml: 0.5, regime: 0.5, derivatives: 0.5, microstructure: 0,   sentiment: 0.15, macro: 0.5, fundamental: 0.4,  llm: 0.2 },
+  intraday: { technical: 1, ml: 0.6, regime: 0.3, derivatives: 0.3, microstructure: 0.7, sentiment: 0.3,  macro: 0.1, fundamental: 0,    llm: 0.2, relative: 0.2 },
+  swing:    { technical: 1, ml: 0.7, regime: 0.4, derivatives: 0.5, microstructure: 0.1, sentiment: 0.3,  macro: 0.3, fundamental: 0.15, llm: 0.3, relative: 0.5 },
+  position: { technical: 1, ml: 0.5, regime: 0.5, derivatives: 0.5, microstructure: 0,   sentiment: 0.15, macro: 0.5, fundamental: 0.4,  llm: 0.2, relative: 0.6 },
 });
 const CRYPTO_FUNDAMENTAL = Object.freeze({ intraday: 0, swing: 0.1, position: 0.25 });
 
@@ -95,6 +95,7 @@
 function subfamily(id) {
   const t = String(id || "").split(".");
   if (t.length >= 3 && /^\d+(m|h|d|w)$/i.test(t[1])) return t[2];
+  if (t[0] === "tech" && t[1] === "mtf") return "trend";   // audit: alignment re-aggregates the per-tf trend views
   return t[1] || "_";
 }
 const TREND_SUBS = new Set(["trend", "mtf"]);
@@ -217,11 +218,15 @@
   let rel = null;
   try { rel = typeof calibrator.reliability === "function" ? calibrator.reliability() : null; } catch { rel = null; }
   const reliable = rel ? rel.reliable !== false && !(Number(rel.n) < 30) : typeof calibrator === "function";
-  const ece = rel && Number.isFinite(rel.ece) ? rel.ece : null;
+  // Audit: prefer the calibrator's honest out-of-fold numbers — in-sample isotonic ECE is ~0 by
+  // construction, which pinned K and the Kelly reliability near 1 even for a no-skill calibrator.
+  const oof = rel && rel.oof && typeof rel.oof === "object" ? rel.oof : null;
+  const ece = oof && Number.isFinite(oof.ece) ? oof.ece : rel && Number.isFinite(rel.ece) ? rel.ece : null;
+  const bss = oof && Number.isFinite(oof.bss) ? oof.bss : null;
   return {
-    apply, reliable, ece,
+    apply, reliable, ece, bss,
     K: reliable ? clamp(1 - 1.5 * fin(ece, 0.05), 0.75, 1) : PARAMS.UNCAL_RELIABILITY,
-    kelly: reliable ? clamp(1 - 4 * fin(ece, 0.05), 0.25, 1) : PARAMS.UNCAL_KELLY_RELIABILITY,
+    kelly: reliable ? clamp(Math.min(1 - 4 * fin(ece, 0.05), bss != null ? 0.25 + 50 * Math.max(0, bss) : 1), 0.25, 1) : PARAMS.UNCAL_KELLY_RELIABILITY,
   };
 }
 
@@ -338,9 +343,11 @@
   const present = Object.keys(fam).filter(f => fam[f].omega > 0);
   const sumOmega = present.reduce((s, f) => s + fam[f].omega, 0);
   const expected = new Set((Array.isArray(a.expectedFamilies) ? a.expectedFamilies
-    : Object.keys(beta).filter(f => f !== "llm" && f !== "other")).filter(f => fin(beta[f]) > 0));
+    : Object.keys(beta).filter(f => f !== "llm" && f !== "other" && f !== "relative")).filter(f => fin(beta[f]) > 0));
   for (const f of present) expected.add(f);
-  const bPresent = present.reduce((s, f) => s + fam[f].beta, 0);
+  // Audit: a family that REPORTED but abstains (e.g. ML with OOS-AUC confidence 0) is not missing
+  // data; counting it as missing inflated every other family's evidence by ~12% (renorm √(3.4/2.7)).
+  const bPresent = Object.keys(fam).reduce((s, f) => s + (fam[f].n > 0 ? fam[f].beta : 0), 0);
   const bExpected = [...expected].reduce((s, f) => s + fin(beta[f]), 0);
   const renorm = bPresent > 0 ? Math.min(PARAMS.RENORM_MAX, Math.sqrt(Math.max(1, bExpected / bPresent))) : 1;
   const scale = PARAMS.POOL_EXP * renorm;           // extreme vol already halves every β_f
@@ -361,9 +368,23 @@
   // ---- calibration ----
   const cal = calibInfo(a.calibrator);
   let pUp = 0.5 + PARAMS.UNCAL_SHRINK * (pRaw - 0.5);
+  // Audit: calibrate the statistic the calibrator was FITTED on. Warm-start pairs come from
+  // backtest.run (base-tf technical + regime, expectedFamilies [technical, regime], no learned
+  // weights, no mask); live pRaw adds 15m/1h signals, ML, derivatives, sentiment, macro,
+  // fundamentals, learned weights and a renormalisation for silent families (mean |ΔL| 0.083 crypto /
+  // 0.045 stocks vs a training sd of ≈0.15). The engine passes the backtest-equivalent pooled value as
+  // a.calibration = { pRaw, logOdds, extraShrink }; the calibrated probability is then moved by the
+  // remaining, un-backtested evidence, shrunk and capped:
+  //   logit(pUp) = logit(cal(pRaw_cal)) + λ·clamp(L − L_cal, ±EXTRA_CAP),  λ = extraShrink (0.5).
+  const calIn = a.calibration && Number.isFinite(Number(a.calibration.pRaw)) ? a.calibration : null;
   if (!noEvidence && cal.apply) {
     let pc = NaN;
-    try { pc = Number(cal.apply(pRaw)); } catch { pc = NaN; }
+    try { pc = Number(cal.apply(calIn ? Number(calIn.pRaw) : pRaw)); } catch { pc = NaN; }
+    if (Number.isFinite(pc) && calIn && Number.isFinite(Number(calIn.logOdds))) {
+      const lam = clamp(fin(Number(calIn.extraShrink), 0.5), 0, 1);
+      const extra = clamp(L - Number(calIn.logOdds), -0.4, 0.4);
+      pc = sigmoid(logit(clamp(pc, 1e-6, 1 - 1e-6)) + lam * extra);
+    }
     if (Number.isFinite(pc)) pUp = pc;
   }
   // Learned-model override (v2): when the self-improvement loop has promoted a stacked model, it
@@ -490,7 +511,8 @@
     assetId: asset.id || null, symbol: asset.symbol || a.symbol || "?", assetClass: cls === "etf" ? "stock" : cls,
     ts: new Date(fin(nowMs, Date.now())).toISOString(), horizon, horizonLabel: hz.label || horizon,
     price: Number.isFinite(price) ? price : null,
-    action, pUp: round(pUp, 4), pRaw: round(pRaw, 4), confidence: round(confidence, 4), agreement: round(agreement, 4),
+    action, pUp: round(pUp, 4), pRaw: round(pRaw, 4), pRawCal: calIn ? round(Number(calIn.pRaw), 4) : null,
+    confidence: round(confidence, 4), agreement: round(agreement, 4),
     coverage: round(coverage, 4), edge: round(edge, 4), baseRate: round(baseRate, 4), edgeVsBase: round(edgeVsBase, 4), expectedReturn: round(expectedReturn, 5),
     risk: riskPlan, sellIntent, calibrated: cal.reliable,
     regime: regime ? { label: regime.label || regimeText(regime), trend: regime.trend || null, vol: regime.vol || null,
--- a/server/engine.js
+++ b/server/engine.js
@@ -30,7 +30,7 @@
 // ── Learned state ──
 const calibrators = {};               // `${horizon}|${assetClass}` -> Calibrator (+ .baseRate)
 let learner = new WeightLearner();
-const MAX_PAIRS = 20000;
+const MAX_PAIRS_PER_ASSET = 1500;   // audit: was a global slice(-20000) over asset-ordered pairs
 const CLASSES = ["crypto", "stock"];
 const ckey = (h, cls) => `${h}|${cls}`;
 
@@ -50,7 +50,20 @@
 // score distributions. Pairs are kept per class (most recent MAX_PAIRS).
 function refitCalibrator(horizon, cls, newPairs = []) {
   const key = `pairs:${ckey(horizon, cls)}`;
-  const pairs = (db.loadModel(key) || []).concat(newPairs).slice(-MAX_PAIRS);
+  // Keep the most recent pairs PER ASSET (a global slice(-N) of the asset-ordered warm-start list
+  // silently dropped whole assets — with the 50-stock universe, all of tech — once it exceeded N),
+  // ordered by (asset, time) so overlapping labels stay adjacent for the calibrator's purged folds.
+  const byAsset = new Map();
+  for (const p of (db.loadModel(key) || []).concat(newPairs)) {
+    const k = (p && p.a) || "?";
+    if (!byAsset.has(k)) byAsset.set(k, []);
+    byAsset.get(k).push(p);
+  }
+  const pairs = [];
+  for (const k of [...byAsset.keys()].sort()) {
+    const arr = byAsset.get(k).sort((u, v) => (u.t || 0) - (v.t || 0));
+    pairs.push(...arr.slice(-MAX_PAIRS_PER_ASSET));
+  }
   db.saveModel(key, pairs);
   if (pairs.length < 30) return null;
   const c = new Calibrator();
@@ -115,6 +128,20 @@
   return { signals: clean, regime };
 }
 
+// The signals the calibrator was trained on: backtest.run (useML:false) = base-timeframe technical
+// (ids normalised to tech.<sub>.<name>) + regime, unmasked and unweighted.
+function calibrationSignals(signals, tfSec) {
+  const base = data.tfName(tfSec), out = [];
+  for (const s of signals) {
+    if (s.family === "regime") { out.push(s); continue; }
+    if (s.family !== "technical" || s.id === "tech.mtf.alignment") continue;
+    const m = /^tech\.(\d+[mhdw])\.(.+)$/.exec(s.id);
+    if (!m) out.push(s);
+    else if (m[1] === base) out.push({ ...s, id: `tech.${m[2]}` });
+  }
+  return out;
+}
+
 // Full decision for one asset. Never throws.
 async function evaluate(asset, { horizon = currentHorizon(), withLLM = true, forceLLM = false } = {}) {
   const hc = H(horizon);
@@ -145,6 +172,8 @@
   // stores and applies its own mask) and pRaw pooled from that same subset.
   const pit = brain.pitSignals(signals, hc.tf);
   const pitDecision = ensemble.decide({ asset, signals: pit, regime, horizon, price, atr, candles, now: Date.now() });
+  const calDecision = ensemble.decide({ asset, signals: calibrationSignals(signals, hc.tf), regime, horizon, price, atr, candles,
+    now: Date.now(), expectedFamilies: ["technical", "regime"] });
   const row = brain.liveRow(asset, signals, { regime, atrPct, annVol: regime?.annVol ?? null, pRaw: pitDecision.pRaw, tfSec: hc.tf });
   const calC = calibrators[ckey(horizon, asset.assetClass)];
   const preds = brain.predict(horizon, row, { pooledP: calC ? calC.apply(pitDecision.pRaw) : undefined });
@@ -159,8 +188,10 @@
     thresholds: th, dataQuality: g.dataQuality,
     equity: portfolio.equity(), openPositions: db.openPositions(),
     probability: preds.probability, meta: preds.meta, sizeMult: dr ? dr.sizeMult ?? 0.5 : 1,
+    calibration: { pRaw: calDecision.pRaw, logOdds: calDecision.logOdds, extraShrink: 0.5 },
   });
   decision.pRawPIT = pitDecision.pRaw;
+  decision.pRawCal = calDecision.pRaw;
   if (preds.relative) decision.relative = { ...preds.relative, rank: rankOf(asset, horizon) };
   if (preds.targetFirst) decision.targetFirst = preds.targetFirst;
   if (dr) decision.derisk = dr;
@@ -180,11 +211,29 @@
 // scales each update by 1/ahead (docs/RESEARCH.md §5.2 #4).
 const SAMPLE_MS = { intraday: 15 * 60e3, swing: 24 * 3600e3, position: 24 * 3600e3 };
 function maybeLog(decision) {
+  // Audit: learning samples at a FIXED cadence only — logging on every action change added
+  // near-duplicate, fully overlapping samples exactly at the decision boundary (selection bias) — and
+  // for stocks only in regular hours (weekend/overnight rows all resolve on the same close).
+  if (decision.assetClass === "stock" && !data.marketOpen(Date.now())) return null;
   const last = db.lastDecisionTs(decision.assetId, decision.horizon);
-  const due = !last || Date.now() - new Date(last.ts).getTime() >= (SAMPLE_MS[decision.horizon] || 3600e3) || last.action !== decision.action;
+  const due = !last || Date.now() - new Date(last.ts).getTime() >= (SAMPLE_MS[decision.horizon] || 3600e3);
   if (!due || !(decision.price > 0)) return null;
   const hc = H(decision.horizon);
-  return db.logDecision(decision, Date.now() + hc.ahead * hc.tf * 1000);
+  // Label horizon in the asset's trading time: 5 daily stock bars = 5 sessions, not 5 calendar days.
+  return db.logDecision(decision, data.horizonEnd(decision.assetId, Date.now(), hc.ahead, hc.tf));
+}
+
+// Price at a past time (late resolution): close of the latest 15m/1h bar that started at or before t.
+const LATE_MS = 10 * 60e3;
+async function priceAt(asset, tMs) {
+  for (const tf of [900, 3600]) {
+    const cs = await data.candles(asset, tf, 300).catch(() => []);
+    if (!cs.length || cs[0].t > tMs) continue;
+    let bar = null;
+    for (const c of cs) { if (c.t <= tMs) bar = c; else break; }
+    if (bar && tMs - bar.t < 2 * tf * 1000) return bar.c;
+  }
+  return null;
 }
 
 async function resolveDue(nowMs = Date.now()) {
@@ -193,15 +242,24 @@
   const byHorizon = {};
   for (const d of due) {
     const asset = cfg.ASSETS.find(a => a.id === d.assetId) || { id: d.assetId, symbol: d.symbol, assetClass: d.assetClass };
-    let px = portfolio.lastPrice.get(d.assetId);
-    if (!px) { try { px = (await data.quote(asset))?.price; } catch { /* ignore */ } }
+    let px = null;
+    if (nowMs - d.resolveAt > LATE_MS) {
+      // Audit: resolved late (server down / loop stalled) → use the price AT resolveAt, not the
+      // current one (labels were silently stretched to the outage length). Give up after 14 days.
+      px = await priceAt(asset, d.resolveAt);
+      if (!(px > 0)) { if (nowMs - d.resolveAt > 14 * 86400e3) db.resolveDecision(d.id, null, null, null); continue; }
+    } else {
+      px = portfolio.lastPrice.get(d.assetId);
+      if (!px) { try { px = (await data.quote(asset))?.price; } catch { /* ignore */ } }
+    }
     if (!(px > 0) || !(d.price > 0)) continue;
     const r = Math.log(px / d.price);
     const y = r > 0 ? 1 : 0;
     db.resolveDecision(d.id, px, r, y);
     brain.onResolved({ horizon: d.horizon, p: d.pUp, y, decision: d });
-    learner.update(d.votes || [], y, { scale: 1 / H(d.horizon).ahead });
-    (byHorizon[ckey(d.horizon, d.assetClass)] ||= []).push({ p: d.pRaw, y });
+    // Audit: reward skill, not drift (a no-skill always-bullish stock signal drifted to w≈1.9).
+    learner.update(d.votes || [], y, { scale: 1 / H(d.horizon).ahead, baseRate: calibrators[ckey(d.horizon, d.assetClass)]?.baseRate ?? 0.5 });
+    (byHorizon[ckey(d.horizon, d.assetClass)] ||= []).push({ p: d.pRaw, y, t: Date.parse(d.ts) || nowMs, a: d.assetId });
   }
   db.saveModel("weights", learner.toJSON());
   for (const [k, pairs] of Object.entries(byHorizon)) { const [h, cls] = k.split("|"); refitCalibrator(h, cls, pairs); }
@@ -212,13 +270,14 @@
 async function warmStart({ horizon = currentHorizon(), log = console.log } = {}) {
   const { runInWorker } = require("./learning/worker");
   const pairs = { crypto: [], stock: [] };
+  learner.clearPriors?.();          // audit: seed() now pools across assets; start from clean priors
   for (const asset of cfg.ASSETS) {
     try {
       // Technical + regime only (ML has its own purged walk-forward inside ml.signals); regime
       // re-detected every 5 bars to keep this to seconds per asset. Runs in a worker thread.
       const res = await runInWorker({ asset, horizon, opts: { useML: false, regimeEvery: 5 } });
       db.saveBacktest(asset.id, horizon, { ...res, assetId: asset.id, horizon, warm: true, ts: new Date().toISOString() });
-      pairs[asset.assetClass].push(...(res.calibrationPairs || []));
+      pairs[asset.assetClass].push(...(res.calibrationPairs || []).map(p => ({ ...p, a: asset.id })));
       learner.seed(res.signalStats || {});
       log(`[warm] ${asset.symbol} ${horizon}: ${res.metrics?.nTrades ?? 0} trades, hit ${(100 * (res.metrics?.hitRate || 0)).toFixed(1)}%, pairs ${res.calibrationPairs?.length || 0}`);
     } catch (e) { log(`[warm] ${asset.symbol}: ${e.message}`); }
--- a/server/db.js
+++ b/server/db.js
@@ -96,7 +96,8 @@
   const votes = (d.signals || []).map(s => ({ id: s.id, family: s.family, score: +(+s.score).toFixed(4), confidence: +(+s.confidence).toFixed(4) }));
   run(`INSERT INTO decisions (id,ts,assetId,symbol,assetClass,horizon,action,pUp,pRaw,confidence,agreement,price,regime,families,votes,resolveAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
-    [id, d.ts || nowIso(), d.assetId, d.symbol, d.assetClass, d.horizon, d.action, d.pUp, d.pRaw, d.confidence,
+    // audit: the pRaw column feeds the calibrator, so store the backtest-equivalent pRawCal when present
+    [id, d.ts || nowIso(), d.assetId, d.symbol, d.assetClass, d.horizon, d.action, d.pUp, d.pRawCal ?? d.pRaw, d.confidence,
      d.agreement ?? null, d.price, d.regime?.label || null, JSON.stringify(d.families || {}), JSON.stringify(votes), resolveAt]);
   return id;
 }
--- a/server/index.js
+++ b/server/index.js
@@ -217,6 +217,17 @@
 // ── Bootstrap ──
 async function main() {
   await db.initDB();
+  // Audit 2026-09: the calibrator input is now the backtest-equivalent pRaw and several signal
+  // definitions changed (regime.trend.state context-only, crypto 52-week window, forming-bar volume,
+  // MTF horizon tags). Pairs/calibrators fitted under the old definitions are a different statistic:
+  // drop them once and let the warm start refit.
+  if (db.getSetting("calib_schema") !== "audit-2026-09") {
+    for (const h of Object.keys(cfg.HORIZONS)) {
+      db.setSetting(`warm_${h}`, "");
+      for (const cls of ["crypto", "stock"]) { db.saveModel(`pairs:${h}|${cls}`, []); db.saveModel(`calib:${h}|${cls}`, null); }
+    }
+    db.setSetting("calib_schema", "audit-2026-09");
+  }
   engine.loadState();
 
   // Real-time crypto ticks → paper stops/targets + UI price flashes (throttled per symbol).
```

**Anchors.** If the files keep moving, re-apply each hunk by its `-` lines. Every hunk replaces a unique line or block in the current files.

---

## 5. Deployment notes and expected behaviour change

- **Re-warm after merging.** Several signal definitions changed:
  - `regime.trend.state` is now context-only;
  - the crypto 52-week window changed;
  - forming-bar volume is pro-rated;
  - MTF horizon tags changed;
  - ML scores are centred on the base rate.

  Stored pairs and calibrators are therefore a different statistic. Patch I1 does the migration. Without the patch, clear `warm_<h>`, `pairs:*` and `calib:*` by hand.
- **The v1 pooled path will mostly abstain.** With the honest calibrator, λ = 0 on current data for both classes, so pUp equals the base rate and the edge is 0. This is the correct reading of CONTRACT-v2's own finding that the pooled probability does not separate up weeks from down weeks. Trading will come from promoted v2 models (`probability`/`meta` overrides).
- **When a trade does pass, sizing and E[r] are larger:**
  - E[r] is about 25% higher, because of the exact E[τ];
  - Kelly is about 2–3× larger, because of the correct variance;
  - `MAX_POS_FRAC` (10% stocks, 5% crypto) and the vol target still bind.
- **Hedge weights** now stay near 1 unless a signal beats the drift of its asset class.

---

## 6. Recommendations (not implemented)

- **#25–27 residual cross-family double counts:**
  - macro composite: give `macro.risk.regime` confidence 0, or drop it from pooling;
  - crypto fundamental momentum and ATH drawdown restate price momentum and the 52-week high;
  - VPIN should dampen confidence rather than vote a direction.

  All are low-β families today.
- **#28 breakeven stop.** Either model it in `backtest.js` and `risk.bracketExpectation`, or remove it. Today the live bracket differs from the one the edge and Kelly are computed for.
- **#31 trend multiplier.** The ×1.3 "trending" multiplier should be conditioned on the report card's per-class IC. Stock trend IC(5d) has been negative for about 2.5 years on SPY and AAPL.
- **MAX_PAIRS_PER_ASSET.** 1,500 pairs (≈ 6 years of daily labels) keeps the calibration set balanced across the 65-asset universe. Revisit it if the universe grows further.

---

## 7. Test results

`node --test test/*.test.js` on the working tree:

| Tests | Pass | Fail | Skipped |
|---|---|---|---|
| 288 | 287 | 0 | 1 (`STACKER_PERF`-gated perf test) |

- **With the §4 patches applied (scratch copy):** 287/287 pass.
- **Flaky:** one run of the v2 `relative.test.js` timing test (< 10 ms) failed under parallel load. It is not related to these changes and passed on re-run.

**Regression tests added** (all prefixed `audit:`):

| Test file | Topics |
|---|---|
| `test/risk.test.js` | E[τ], Kelly variance, ETF class |
| `test/calibrator.test.js` | noise λ, informative λ, legacy JSON |
| `test/weights.test.js` | drift-neutral update, pooled seed, drift-free seed with n_eff, `clearPriors` |
| `test/backtest.test.js` | mix stats and aliases |
| `test/derivatives.test.js` | common OI/price window |
| `test/regime.test.js` | trend.state context-only |
| `test/technical.test.js` | MTF horizon tags, forming bar, crypto 52-week window |
| `test/ml.test.js` | centred score, forming-bar features |
| `test/fundamental.test.js` | periodEnd staleness |
| `test/sentiment.test.js` | F&G newest-7 |
| `test/data.test.js` | session-time horizons, RTH filter |
| `test/portfolio.test.js` | session-time expiry |

**Existing assertions changed** (both encoded the bugs being fixed):
- `risk.test.js`: Kelly now uses `eNet/variance`.
- `ml.test.js`: score is now `2·(p − baseRate)`.
