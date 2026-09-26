# Diagnostics: what the point-in-time panel says (round 2, September 2026)

*Scope:* an empirical study of every signal the engine can reproduce historically, measured on the
real research universe with `server/research/dataset.js` (point-in-time panel, contract v2 §1) and
`server/research/signalEval.js` (report card, §2). It answers questions (a)–(e) of the round-2
brief. All numbers are out-of-the-box, with no tuning to this data. *Status:* measurement only; no
weights were changed.

---

## 0. Summary

1. **At the daily horizons nothing survives multiple-testing control.**
   - Swing (5d) and position (20d), 65 assets over five years: **0 of ~40 signals** are significant after Benjamini–Hochberg (q = 0.10), for all three targets (`ret`, `exRet`, `tbLong`).
   - The same holds per asset class, with a doubled Newey–West lag, and within each half of the sample.
   - The v1 pooled probability `pRaw` has a timing IC of +0.015 (t 1.07) at swing and −0.002 (t −0.08) at position. v1's "no edge" verdict is confirmed.
2. **The only coherent pattern at daily horizons is cross-sectional momentum on the relative target.**
   - For `exRet` at swing, six momentum/trend signals all have positive Fama–MacBeth IC of +0.017 to +0.026 (t 1.7–2.2):
     - `tech.momentum.tsmom`
     - `tech.structure.extremes`
     - `rel.rs.12_1`
     - `rel.btc_lead`
     - `tech.trend.ema_stack`
     - `regime.hmm.state`
   - The IC sign is the same in both halves and positive in 5 of 6 calendar years. Individually none clears FDR (q ≈ 0.5). It is a weak, theory-consistent effect (Jegadeesh–Titman), not a proven one.
3. **Intraday crypto (15m bars, 2h ahead) has real cross-sectional structure, but it is smaller than costs.**
   - 15 of 34 signals are FDR-significant for `exRet`; all 15 survive the doubled lag, and 27 of 34 keep their sign across halves.
   - The pattern is short-term cross-sectional reversal: mean-reversion oscillators have IC +0.017 to +0.030; momentum/breakout signals have IC −0.018 to −0.029.
   - It also includes a BTC→alt lead: `rel.btc_lead` has IC +0.035, t 6.8.
   - The economic size is 0.3–6 bp of excess return per 2h between long and short signals, against a 30 bp round trip at taker fees. Intraday crypto is **analysis-only** unless fills are at maker fees.
4. **A methodological trap was found and fixed.**
   - Measuring time-series IC after ranking signal and target over each asset's *full* sample is biased negative for any signal built from trailing returns (a Stambaugh-type bias of about −√(k·ahead)/T).
   - On pure random walks it "finds" 12-month momentum at t ≈ −4.3 in 12 of 12 seeds.
   - My first pass of this study, using that estimator, reported four "significant invert-candidates" at swing. All four were this artifact.
   - The report card now uses a point-in-time timing IC, which is unbiased (§2.2).
   - A second artifact came from the cost-shifted `tbLong` target on intraday crypto: fear & greed at t = +15. The fix adds back the round-trip cost, a known constant, for the timing IC (§2.3).
5. **Recommendations** (details in §5):
   - Train the swing stacker on **`yEx`**. Keep swing as the default daily horizon.
   - Do **not** apply a verdict-based mask when nothing passes FDR; use `signalMask(report, { requireEvidence: true })`.
   - Reduce the directional weight of the regime family, set the fear & greed contrarian to zero, and do not raise macro.
   - At intraday, weight mean-reversion over trend in the cross-section.

---

## 1. Data

| | swing | position | intraday |
|---|---|---|---|
| file | `data/research/swing.json.gz` (20.0 MB) | `data/research/position.json.gz` (20.0 MB) | `data/research/intraday.json.gz` (23.9 MB) |
| bars / label | daily, 5 ahead | daily, 20 ahead | 15m, 8 ahead (2h) |
| universe | 65 assets (50 stocks incl. SPY, QQQ, IWM, DIA; 15 crypto) | same | 15 crypto |
| history fetched | 1,600 bars per asset | 1,600 | 8,000 bars per asset |
| rows / labeled | 85,740 / 85,415 | 85,740 / 84,440 | 116,085 / 115,965 |
| dates | 2021-05-25 → 2026-09-24 (stocks); crypto from 2023-01 | same | 2026-07-06 → 2026-09-25 |
| signals | 44 | 44 | 43 |
| build (3 worker threads) | 155 s | 136 s | 188 s |

- **Families (point-in-time):**
  - technical (base timeframe), regime, relative (`server/analysis/relative.js`), macro (FRED, value dated ≤ t − 1 day), and fear & greed (crypto).
  - News, fundamentals, derivatives, microstructure and ML are excluded: they have no point-in-time history.
- **Code fingerprint:** all three files carry `meta.codeHash = f6b38ae165de2fe6`, a hash of the analyzer, ensemble and dataset sources. The analyzers were being edited while this study ran; see §6.
- **Timing requirement (65 assets × 1,000 daily bars, swing):**
  - Compute: 47,980 rows in **91 s** with 3 worker threads (about 220 s of CPU, so ≈ 3.7 min single-threaded).
  - Fetch: 65 × 1,600 bars from Nasdaq and Coinbase plus the FRED and fear & greed history took 43 s.
  - Total ≈ 2.3 min, against a budget of ≈ 8 min.
- **Incremental update (5 new daily bars × 65 assets):** 325 new rows and 325 matured labels in **2.0 s**. The result is bit-identical to a full rebuild: 0 of 85,740 rows differ.
- **Report card:** about 30 s per target on 85k rows with all breakdowns.

**Labels and base rates.** The table covers the swing horizon; position figures are in brackets.

| | P(ret>0) | P(exRet>0) | long bracket: target / timeout / stop | mean net long-bracket return |
|---|---|---|---|---|
| stocks | 0.534 (0.553) | 0.484 (0.480) | 7.0% / 74.6% / 18.3% | +15 bp (+79 bp) |
| crypto | 0.479 (0.463) | 0.381 (0.353) | 8.1% / 76.7% / 15.2% | −17 bp (+3 bp) |
| crypto 15m | 0.506 | 0.460 | 13.1% / 61.6% / 25.3% | −27 bp |

- **Most swing brackets end at the vertical barrier (≈ 75%),** as `RESEARCH.md` §3.5 predicted. At swing, `tbLong` is therefore mostly a relabeled `ret`.
- **Alts lagged BTC** over the sample: P(exRet > 0) = 0.38 for crypto.

---

## 2. Method

### 2.1 Report card

- **Signal value:** x = score · confidence, as the ensemble uses it.
- **Targets:** `ret`; `exRet` (benchmark rows excluded); `tbLong`, measured on the realized net bracket return.
- **Two ICs are computed for every signal:**
  - **xs** (the contract's definition): Fama–MacBeth. Spearman across assets per date, within asset class, averaged over dates. This is the headline IC for `exRet`.
  - **ts:** a point-in-time *timing* IC (§2.2). This is the headline IC for `ret` and `tbLong`. For an absolute target, the cross-sectional IC within a class is the same ranking as for `exRet` and says nothing about direction.
- **Standard errors:**
  - Newey–West with lag = max(ahead, label span in date steps). That gives 7 at swing (a 5-trading-day stock label spans 7 calendar-day grid steps), 28 at position and 8 at intraday.
  - The ts IC uses Driscoll–Kraay: per-date sums, then NW, which is robust to same-day cross-correlation.
  - `nEff` = 1/SE².
- **Multiple testing and verdicts:**
  - Benjamini–Hochberg at q = 0.10 across all signals.
  - Stability: the IC has the same sign in both halves of the sample.
  - Verdicts follow contract §2. A non-significant IC indistinguishable from 0 is classed "weak", so every stable signal gets exactly one verdict.
- **Robustness runs:**
  - lag × 2.
  - Stock-only and crypto-only report cards, each with its own FDR.
  - Per-calendar-year ICs.
  - Per-regime cells.
- **Size check on synthetic data (test suite):**
  - Asset-level persistent noise: 4.4–5.0% of p-values fall below 0.05.
  - *Market-wide* persistent noise, such as macro: ≈ 11%.
  - Bartlett weights under-correct overlap for persistent common regressors. Treat market-wide signals' t-stats as roughly 10–15% inflated.

### 2.2 The in-sample-centring bias (the legacy "tsfull" estimator)

Ranking x and y within each asset over its whole sample makes the implied mean of y depend on
returns that overlap the signal's own lookback. For x = the trailing k-bar return and y = the next
h-bar return on a random walk, E[x̄·ȳ] > 0, so the centred covariance is biased by about −√(k·h)/T
in correlation units.

**Simulation.** 30 random-walk assets × 600 days with drift and a common factor; 12 seeds.

| signal | legacy full-sample IC | mean t | seeds with \|t\| > 1.96 | point-in-time IC | seeds with \|t\| > 1.96 |
|---|---|---|---|---|---|
| 20-day momentum | −0.032 | −1.43 | 2/12 | −0.009 | 0/12 |
| 60-day | −0.055 | −2.54 | 8/12 | −0.011 | 0/12 |
| 120-day | −0.074 | −3.49 | 11/12 | −0.016 | 0/12 |
| 250-day | −0.094 | −4.32 | 12/12 | −0.014 | 2/12 |

A 24-seed follow-up put the point-in-time IC within ±1 SE of zero with no drift, with drift, and with a market factor.

**Real-data fingerprint.**

- **Swing `ret`, legacy estimator, final dataset:**
  - `regime.hmm.state` −0.045 (t −3.29), `rel.rs.12_1` −0.030 (t −2.71), `rel.rs.6m` −0.031 (t −2.62) and `tech.structure.extremes` −0.047 (t −2.52).
  - One of them passes FDR and would be an "invert-candidate". In my first pass, on the pre-rebuild analyzer version, all four did.
  - Within single calendar years the same estimator gives ICs of −0.07 to −0.23 for extremes, EMA stack and tsmom, **negative in all 6 years**. That is the 1/T growth the bias predicts.
- **Point-in-time timing IC:** the same four signals score −0.001 to +0.012 (|t| ≤ 0.65), and 0 of 42 signals are significant.

**The estimator used now (`mode: "ts"`):**

- z = the rank of x_t against the asset's own *past* values only, scaled to unit variance.
- ỹ = y / (ATR% · √ahead), left uncentred.
- IC = Σz·ỹ / √(Σz²·Σỹ²).

z_t depends only on data up to t, and ỹ only on returns after t, so the IC is unbiased when returns are unpredictable. `mode: "tsfull"` (with `legacyTs: true`) keeps the old estimator for comparison. `test/signalEval.test.js` pins both behaviours.

**Lesson for every offline evaluation in this repo** (stacker screens, feature importance, anything that standardizes over a sample and then correlates with overlapping forward returns): standardize with data up to t only, or measure cross-sectionally.

### 2.3 The cost-shifted target

- **The failure:** the timing IC needs a target whose true mean is about 0. A net bracket return is shifted by the round-trip cost: 30 bp for crypto, which is about ½σ of a 2h move.
- **The consequence:** any signal that merely trends through an 80-day sample earned E[z]·(−cost).
- **What it produced:** fear & greed showed IC +0.30 (t 15) and the broad dollar −0.24 (t −11) on 2h crypto brackets.
- **The fix:** the timing IC for `tbLong` uses the gross bracket return (from `ds.meta.costsBps`). After the fix the same signals score −0.034 (t −1.8) and 0 of 41 are significant. Hit rates and conditional means still use net returns.

---

## 3. Results

Mean |t| under the null ≈ 0.80, and ≈ 5% of |t| values exceed 2.

| horizon / target (headline mode) | BH-significant | lag×2 | stock only | crypto only | mean \|t\| | #\|t\|>2 | pooled `pRaw` IC (t) |
|---|---|---|---|---|---|---|---|
| swing `ret` (ts) | 0/42 | 0 | 0/40 | 0/41 | 0.77 | 0 | +0.015 (1.07) |
| swing `exRet` (xs) | 0/35 | 0 | 0/34 | 0/34 | 0.81 | 2 | +0.007 (0.62) |
| swing `tbLong` (ts) | 0/42 | 0 | 0/40 | 0/41 | 0.73 | 1 | +0.005 (0.33) |
| position `ret` (ts) | 0/42 | 0 | 0/40 | 0/41 | 0.58 | 0 | −0.002 (−0.08) |
| position `exRet` (xs) | 0/35 | 0 | 0/34 | 0/34 | 0.62 | 0 | +0.018 (0.96) |
| position `tbLong` (ts) | 0/42 | 0 | 0/40 | 0/41 | 0.69 | 0 | −0.001 (−0.04) |
| intraday `ret` (ts) | 0/41 | 0 | – | 0/41 | 0.84 | 0 | +0.022 (1.69) |
| intraday **`exRet` (xs)** | **15/34** | **15** | – | 15/34 | **2.09** | **15** | +0.000 (0.02) |
| intraday `tbLong` (ts) | 0/41 | 0 | – | 0/41 | 0.98 | 3 | +0.017 (1.45) |

### 3.1 Top signals by |t|

Entries give IC and (t). "Stable" means the same sign in both halves.

**Swing, `ret`, timing IC.** No signal is FDR-significant; the smallest q is 0.86.

| signal | IC (t) | stable | stock / crypto IC |
|---|---|---|---|
| `macro.risk.regime` | +0.035 (1.67) | yes | +0.031 / +0.052 |
| `macro.risk.credit` | +0.049 (1.66) | yes | +0.041 / +0.070 |
| `tech.volatility.squeeze` | +0.013 (1.65) | yes | +0.004 / +0.039 |
| `sent.feargreed.contrarian` | −0.057 (−1.39) | yes | – / −0.057 |
| `tech.volume.obv` | +0.020 (1.37) | yes | +0.013 / +0.044 |

**Swing, `exRet`, cross-sectional Fama–MacBeth IC.** No signal is FDR-significant; the smallest q is 0.50.

| signal | IC (t) | stable | stock / crypto IC (t) | years with positive IC |
|---|---|---|---|---|
| `tech.momentum.tsmom` | +0.026 (2.24) | yes | +0.028 (1.9) / +0.022 (1.3) | 5/6 |
| `tech.structure.extremes` | +0.026 (2.19) | yes | +0.020 (1.4) / +0.040 (2.4) | 5/6 |
| `rel.rs.12_1` | +0.022 (1.86) | yes | +0.029 (1.9) / +0.015 (0.9) | 5/6 |
| `rel.btc_lead` | +0.019 (1.84) | yes | – / +0.019 (1.9) | 3/4 |
| `tech.trend.ema_stack` | +0.020 (1.71) | yes | +0.022 (1.6) / +0.018 (1.1) | 5/6 |
| `regime.hmm.state` | +0.017 (1.70) | yes | +0.011 / +0.024 | 5/6 |

- Family ICs: regime +0.017 (1.85), relative +0.011 (0.93), technical +0.007 (0.63), pooled `pRaw` +0.007 (0.62).
- In the crypto-only card, `rel.xs.ivol_rank` has IC +0.044 (t 2.7): the low-volatility anomaly among coins. It is −0.010 for stocks.

**Swing, `tbLong`, timing IC.** No signal is significant.

- `tech.volatility.squeeze` +0.017 (t 2.18)
- `macro.risk.regime` +0.037 (t 1.77)
- `macro.risk.credit` +0.049 (t 1.67)

**Position.** No signal is significant for any target.

- `ret`: fear & greed −0.113 (t −1.41), credit +0.065 (t 1.29), dollar −0.053 (t −1.20).
- `exRet`: `tech.structure.extremes` +0.039 (t 1.92), `regime.hmm.state` +0.022 (t 1.26), `rel.rs.12_1` +0.024 (t 1.13) and `tech.momentum.tsmom` +0.024 (t 1.12). This is the same momentum cluster as at swing, weaker. The lag is 28, so there are about a quarter as many independent labels.

**Intraday crypto, `exRet`, cross-sectional IC.** 15 signals are FDR-significant (q ≤ 0.023) and all survive lag × 2.

| verdict | signal | IC | t | lag×2 t | halves | long−short exRet (bp per 2h) |
|---|---|---|---|---|---|---|
| keep | `rel.btc_lead` | +0.035 | 6.79 | 6.61 | +0.026 / +0.045 | −3.6 (ranks, not signs, carry it) |
| keep | `tech.meanrev.zscore` | +0.030 | 4.61 | 4.26 | +0.035 / +0.025 | +2.2 |
| keep | `tech.meanrev.bollinger` | +0.030 | 4.57 | 4.23 | +0.035 / +0.025 | +2.2 |
| keep | `tech.meanrev.williams_r` | +0.024 | 3.80 | 3.50 | +0.027 / +0.021 | +2.7 |
| keep | `tech.momentum.stochastic` | +0.022 | 3.52 | 3.25 | +0.027 / +0.018 | +2.6 |
| keep | `tech.volume.mfi` | +0.017 | 2.62 | 2.44 | +0.017 / +0.017 | +0.5 |
| invert-candidate | `tech.volume.breakout` | −0.027 | −4.23 | −3.97 | −0.027 / −0.028 | −6.4 |
| invert-candidate | `tech.momentum.macd` | −0.029 | −4.14 | −3.84 | −0.023 / −0.035 | −2.8 |
| invert-candidate | `tech.momentum.roc` | −0.027 | −4.04 | −3.74 | −0.023 / −0.032 | −1.8 |
| invert-candidate | `tech.structure.donchian` | −0.025 | −3.57 | −3.28 | −0.025 / −0.024 | −1.7 |
| invert-candidate | `tech.trend.linreg` | −0.020 | −2.71 | −2.52 | | |
| invert-candidate | `tech.trend.kalman` | −0.020 | −2.69 | −2.47 | | |
| invert-candidate | `tech.volume.vwap` | −0.018 | −2.61 | −2.38 | | |
| invert-candidate | `tech.volatility.expansion` | −0.018 | −2.58 | −2.51 | | |
| invert-candidate | `rel.xs.mom_rank` | −0.019 | −2.57 | −2.35 | | |

- The same signals have cross-sectional |t| of 3–5 on the bracket target (`tbLong`).
- Their *timing* ICs on `ret` and `tbLong` are not significant.
- The structure is **relative**: which coin does better over the next 2h, not whether crypto rises.

### 3.2 Regimes

Regime cells are one IC per signal per label, 12 labels.

- **Swing `ret`:** 8 of 504 cells have |t| ≥ 3.
  - They are concentrated in `trending-down/high-vol`: MACD −0.124, ROC −0.130, VWAP −0.134, OBV −0.137, MFI +0.145. That is short-term reversal in sell-offs, consistent with Nagel (2012) and Daniel & Moskowitz (2016).
  - Credit has +0.15 in `trending-up` normal and high vol.
- **Intraday `ret`:** trend signals are +0.13 to +0.15 (t 3.1–4.0) in `trending-up/normal-vol`.
- **Position `exRet`:** 19 of 404 cells, mostly from `trending-up/extreme-vol` with n = 220 rows. Those cells cover a handful of dates and are not credible.
- **Caution for all regime cells:** they are correlated (signals, overlapping labels, regime persistence) and 400–500 were tested. Treat them as hypotheses to re-test on fresh data, not findings.

---

## 4. Answers

**(a) Which signals and families have significant IC after FDR, for which targets, regimes and classes?**

- **Daily horizons:** none, for `ret`, `exRet` or `tbLong`. This holds pooled, stock-only and crypto-only, and with the doubled lag.
  - The strongest *consistent* effect is cross-sectional momentum on `exRet` (IC ≈ +0.02, t ≈ 2), with the six signals listed in §3.1. It appears in both classes and is strongest for crypto 52-week extremes (+0.040, t 2.4).
  - The market-wide macro risk signals (credit, VIX, risk regime) lead the timing tables at t ≈ 1.7, positive in 6 of 6 years. Market-wide t-stats are about 10–15% inflated (§2.1) and represent essentially one time series.
- **Intraday crypto:** 15 significant for `exRet` (cross-sectional short-term reversal and the BTC lead). None for `ret` or `tbLong` as timing signals.
- **Regime-specific effects:** none survive a family-wise view. The best candidate is reversal of momentum/volume signals in `trending-down/high-vol` at swing.

**(b) Is cross-sectional/relative prediction (exRet) more predictable than absolute direction (ret)?**

- **Intraday: yes, clearly.**
  - Cross-sectional `exRet`: mean |t| 2.09, 15 of 34 significant.
  - Timing `ret`: mean |t| 0.84, none significant.
- **Daily: marginally, and only in sign coherence, not significance.**
  - Swing: `exRet` mean |t| 0.81 vs 0.77 for `ret`. The top `exRet` signals form one theory-consistent cluster with stable sign (5 of 6 years positive).
  - The top `ret` signals are a mixed bag: macro, squeeze, OBV.
  - Position: 0.62 vs 0.58.
- **Neither beats noise at the FDR level at 5d or 20d.**

**(c) Which horizon has the most signal?**

- **Statistically:** intraday (15m, 2h), and only cross-sectionally among crypto. Its effect is about 2–6 bp per 2h, an order of magnitude below the 30 bp taker round trip.
- **Among daily horizons:** swing. Its |t| values are larger than position's for the same cluster, and it has about 4× the independent labels (lag 7 vs 28). Position IC magnitudes are not larger (extremes +0.039 vs +0.026), so the extra overlap costs more than the horizon gains.

**(d) Is the sign of the ICs stable over time?**

- **At daily horizons, mostly not.** Only 16 of 42 (swing `ret`) and 17 of 35 (swing `exRet`) signals keep their sign across halves, which is the coin-flip rate. Per-year ICs of the timing signals change sign from year to year.
- **The exceptions:**
  - The swing cross-sectional momentum cluster: positive in 5 of 6 years for tsmom, extremes, 12-1 relative strength, EMA stack and HMM state.
  - The macro risk signals in the timing IC: positive in 6 of 6 years, but each year |t| < 1.5.
- **Intraday cross-sectional ICs are stable:** 27 of 34 keep their sign across halves, and the significant ones have nearly equal halves (e.g. z-score +0.035 / +0.025). However, the sample is only 80 days.

---

## 5. Recommendations (e)

1. **Masks and the drop list.**
   - Under the contract's verdict rules, the swing report card marks about 28 of 42 signals "drop" (unstable sign, or IC ≤ 0 with p < 0.2). Here that is noise fitting in the opposite direction.
   - Use `signalMask(report, { requireEvidence: true })` for swing and position: every signal gets the neutral 0.8 until at least one signal passes FDR. Let the champion/challenger out-of-sample test decide any mask.
   - Signals with no evidence of value anywhere, whose zero weight costs nothing:
     - `sent.feargreed.contrarian`: wrong sign at all horizons (−0.057 swing, −0.113 position, −0.034 intraday on `ret`), none significant. This matches the 2026 study cited in `RESEARCH.md`.
     - `regime.trend.state`: now confidence 0 by design.
     - `rel.beta`: context only.
     - `tech.divergence.rsi` and `tech.volatility.expansion`: sign flips, no significance.
   - **Do not invert anything.**
     - The intraday momentum/breakout invert-candidates (MACD, ROC, Donchian, breakout, linreg, Kalman, VWAP, expansion, `rel.xs.mom_rank`) are a stable, theory-consistent short-term reversal. They are still one 80-day sample.
     - Re-validate on the next 2–3 months of data (`updateDataset` then `reportCard`) before any sign change, per the contract.
2. **Default target: `exRet` (`yEx`) for the swing stacker.**
   - It is the only daily target with a coherent cluster: cross-sectional momentum plus the regime HMM, which matches Jegadeesh–Titman and Liu–Tsyvinski–Wu.
   - `y` (absolute direction) has nothing: pooled IC +0.015, no signal above t ≈ 1.7.
   - `tbLong` at swing is 75% vertical-barrier exits, so it is mostly `ret` with extra noise. Use it for meta-labeling (sizing), not as the primary target.
   - Honest expectation: a `yEx` stacker's out-of-sample AUC will sit around 0.51–0.52. The Diebold–Mariano promotion gate should usually *refuse* it. That is the gate working, not a bug.
3. **Default horizon: swing** for daily decisions.
   - Position has a quarter of the independent labels and no larger ICs.
   - Keep intraday crypto analysis-only (or maker-fee only). If it is ever traded, the cross-sectional reversal/BTC-lead ranking is the thing to trade, not direction.
4. **Family weights (ensemble β for pooled pUp).**
   - **Regime** as directional evidence: timing IC +0.006 (swing), +0.009 (position), +0.003 (intraday), none significant. Cut β_regime from 0.4/0.5 to about 0.2 and keep regime as a *conditioner*. Its cross-sectional value (+0.017 to +0.023) belongs in the `yEx` stacker.
   - **Sentiment (fear & greed)** for daily horizons: from 0.3/0.15 to **0**.
   - **Macro:** leave at 0.3 (swing) and 0.5 (position); do not raise it. The positive 6-of-6-years sign is encouraging but amounts to one time series with inflated t.
   - **Technical:** timing IC +0.019 (t 1.2) at swing; no case to raise or cut.
     - At **intraday**, the ensemble's trending-regime mean-reversion multiplier (×0.4) works against the only measured intraday effect.
     - For intraday, weight mean-reversion ≥ trend, or skip the multiplier.
   - **Relative:** cross-sectional value only (+0.011 swing, +0.020 position family IC). Feed the `yEx` stacker; keep it out of pUp pooling (it pools as "other" at β 0.1 today).
5. **Evaluation hygiene for everyone.**
   - Never standardize over a full sample and then correlate with overlapping forward returns (§2.2).
   - Check market-wide signals with `lagMult: 2`.
   - Demand t > 3 for any *new* signal (Harvey, Liu & Zhu, 2016).

---

## 6. Caveats

- **Survivorship:** the universe is today's large caps and top coins. LIN only has history since 2023-03, PLTR since 2020-09, XRP since its 2023 Coinbase relisting and NEAR since 2022-09. Any edge would be overstated, not understated.
- **Sample:** stocks cover 2021-05 → 2026-09; crypto daily covers 2022-05 onward, with rows from about 2023-01 after warm-up. That is one full cycle (the 2022 bear market and the recovery). The intraday sample is **80 days**.
- **Inputs:**
  - HY OAS on FRED only goes back to 2023-09 (licence), so `macro.risk.credit` rows start then.
  - Fear & greed is daily.
  - Regimes are refitted every 5 daily or 4 intraday bars, so labels can be up to 4 bars stale. This is point-in-time, but it slightly blurs regime-conditional results.
- **Concurrent code changes:**
  - Analyzers were being audited and edited while this ran. For example, `regime.trend.state` confidence went to 0, and crypto 52-week extremes changed from 252 to 365 bars.
  - The saved datasets were rebuilt after the last such change; `meta.codeHash = f6b38ae165de2fe6`.
  - If the analyzers change again, `updateDataset` sets `meta.lastUpdate.codeChanged` and a note; rebuild then.
- **HAC under-correction:** Newey–West with lag = ahead under-corrects persistent market-wide predictors (≈ 11% size at 5%); see `lagMult`.

---

## 7. Reproduce

```js
const D = require("./server/research/dataset"), E = require("./server/research/signalEval");
const ds = D.loadDataset("swing.json.gz");                   // or await D.buildDataset({ horizon: "swing" })
const rep = E.reportCard(ds, { target: "exRet" });           // "ret" | "exRet" | "tbLong"; lagMult: 2 for robustness
E.rankSignals(rep).slice(0, 10);                             // signals by |t|
E.signalMask(rep, { requireEvidence: true });                // neutral until something passes FDR
await D.updateDataset(ds); D.saveDataset(ds, "swing.json.gz"); // incremental refresh
```

- Build commands used here: `buildDataset({ horizon, candlesByAsset: <1,600 daily / 8,000 15m bars>, … })` with default `lookback` (520 daily, 600 intraday), `warmup` 260, `regimeEvery` (5 daily, 4 intraday), `stride` 1 and 3 worker threads.
- Tests: `node --test test/dataset.test.js test/signalEval.test.js`.
