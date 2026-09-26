# Research Basis for the Decision Engine

*Scope:* the evidence behind each analyzer family in `docs/CONTRACT.md`, what accuracy we can realistically expect, how to combine and calibrate signals, and the recommended defaults for `server/config.js` and the ensemble. Citations are given inline as (Author, Year) and listed in full, with links, in §8. *Status:* research recommendation, September 2026. Paper trading only.

---

## 0. Executive summary

1. **Expect small edges.** Studies that hold up out of sample report 51–56% directional accuracy for liquid assets at horizons from minutes to weeks (Fischer & Krauss, 2018; Jaquart et al., 2021; Gu, Kelly & Xiu, 2020). Monthly stock-level R² is below 1% (Gu, Kelly & Xiu, 2020; Noguer i Alonso & Franklin, 2026). A well-calibrated engine will rarely give P(up) outside 0.42–0.58. To trade at a higher hit rate, the engine has to **abstain** most of the time. Making the probabilities more extreme does not help.
2. **What has the most evidence at our horizons:**
   - time-series momentum and trend, in both asset classes (Moskowitz, Ooi & Pedersen, 2012; Hurst, Ooi & Pedersen, 2017; Liu & Tsyvinski, 2021);
   - short-horizon momentum that turns into reversal after about 1 month in crypto (Dobrynskaya, 2023; Liu, Tsyvinski & Wu, 2022);
   - volatility management of risk exposure, used as a risk tool rather than an alpha source (Moreira & Muir, 2017; Harvey et al., 2018; Cederburg et al., 2020);
   - order-flow imbalance for intraday prediction measured in seconds to minutes (Cont, Kukanov & Stoikov, 2014).

   Everything else is weak, decays after publication, or only works for small, illiquid stocks that are not in our universe (McLean & Pontiff, 2016; Martineau, 2022).
3. **Our signals are highly correlated.** Most analyzers read the same price series, so their evidence must be *shrunk*, not extremized (Clemen & Winkler, 1985; Baron et al., 2014). The current κ = 0.9 is roughly 5× too aggressive.
4. **Six issues in the contract as written would inflate backtests or bias decisions.** They are covered in §5.2:
   - overlapping labels without purging;
   - smoothed rather than filtered HMM probabilities;
   - symmetric P(up) applied to an asymmetric 2:3 ATR bracket;
   - Hedge updates on overlapping outcomes;
   - AUC gating with no standard error;
   - intraday crypto trades where fees exceed the edge.

---

## 1. Evidence of predictive power by signal family

### 1.1 Trend and momentum

| Effect | Evidence | Horizon | Relevance to us |
|---|---|---|---|
| **Time-series momentum (TSMOM)** | 12-month TSMOM is significant in all 58 futures markets (equity indices, FX, commodities, bonds). Returns persist for 1–12 months and partly reverse after that. The strategy does best in extreme markets (Moskowitz, Ooi & Pedersen, 2012, *JFE*). The effect holds over a century of data (Hurst, Ooi & Pedersen, 2017, *JPM*). | Position (1m), swing | **Strong.** SPY/QQQ and single stocks through `tech.momentum.tsmom`. |
| **Crypto TSMOM** | For BTC, a 1-SD higher weekly return predicts about 3.2% higher return the next week. Current returns predict returns up to 1–8 weeks ahead. Investor attention (Google searches, Twitter) also predicts returns. Crypto returns have almost no exposure to stock, macro, FX or commodity factors (Liu & Tsyvinski, 2021, *RFS*). | Swing, position | **Strongest crypto signal.** Use 1–4-week lookbacks rather than 12 months. |
| **Crypto cross-sectional momentum** | Three factors (market, size, momentum) explain crypto cross-sectional returns. Momentum is built from weekly returns (Liu, Tsyvinski & Wu, 2022, *JF*). Across 2,000 coins, momentum lasts up to 2–4 weeks and reverses after about 1 month. It is strongest with 2-week formation and holding periods (Dobrynskaya, 2023). Momentum crashes are severe in large-cap, equal-weighted portfolios, and volatility management reduces them (Grobys et al., 2025, *FMPM*). | Swing | Use a relative-strength-vs-BTC signal. Treat returns more than 30 days old as mean-reverting. |
| **Equity cross-sectional momentum (12-1)** | 3–12-month winners beat losers (Jegadeesh & Titman, 1993, *JF*). Momentum crashes in "rebound" states that follow bear markets with high volatility (Daniel & Moskowitz, 2016, *JFE*). Scaling momentum by its own volatility roughly doubles its Sharpe ratio (Barroso & Santa-Clara, 2015, *JFE*). | Position | Useful in a stock universe, but our 7-stock universe is too small for cross-sectional sorting. Use time-series only. |
| **52-week-high effect** | Nearness to the 52-week high predicts returns better than past returns, and does not reverse over the long run (George & Hwang, 2004, *JF*). | Position | `tech.structure.dist_52w`. Moderate weight. |
| **Intraday momentum** | The SPY return over the first half hour (measured from the previous close) predicts the last half hour. The effect is stronger on volatile, high-volume and news days (Gao, Han, Li & Zhou, 2018, *JFE*). A similar effect exists for Bitcoin (Shen, Urquhart & Wang, 2022, *Financial Review*). | Intraday | Narrow window with a small effect. Low priority. |

### 1.2 Short-term reversal and mean reversion

- **Equities.** Weekly and monthly losers outperform (Jegadeesh, 1990, *JF*; Lehmann, 1990, *QJE*). The profit is mostly pay for providing liquidity, and it is larger when VIX is high (Nagel, 2012, *RFS*). It is concentrated in small, illiquid stocks and is much weaker in mega-caps like our universe.
- **Crypto.** Reversal starts after about 4–6 weeks (Dobrynskaya, 2023). At horizons of a week or less, crypto shows momentum, not reversal (Liu & Tsyvinski, 2021).
- **Implication.** Mean-reversion analyzers (%B, z-score, Williams %R) should get *low base weight*. They should get more weight in ranging, high-VIX regimes and less in trends. The contract already requires the trend down-weighting.

### 1.3 Volatility management and volatility targeting

- Scaling exposure by 1/σ² raises Sharpe ratios and alphas in spanning regressions across many factors (Moreira & Muir, 2017, *JF*).
- Real-time versions often *underperform* the unmanaged portfolio because the spanning regressions are unstable (Cederburg, O'Doherty, Wang & Yan, 2020, *JFE*).
- Volatility targeting reliably reduces tail events in every asset class, but raises Sharpe only for "risk assets" (equities, credit) (Harvey et al., 2018, *JPM*, with a 10% target on 60 assets).
- **Implication:** use volatility targeting for **sizing and risk control**, not as a directional signal.

### 1.4 Earnings and fundamentals (US equities only)

| Signal | Evidence | Caveat |
|---|---|---|
| Post-earnings drift | Prices drift in the direction of the earnings surprise for about 60 days (Bernard & Thomas, 1989, *JAR*). | **Gone for large caps since about 2006** (Martineau, 2022, *CFR*). Low value for AAPL/MSFT/NVDA. |
| Piotroski F-score | Within high book-to-market stocks, high-F minus low-F earned about 23% a year (Piotroski, 2000, *JAR*). | Mostly small value stocks. Works as a quality tilt for position horizon only. |
| Gross profitability | Gross profits/assets predicts returns about as strongly as book-to-market (Novy-Marx, 2013, *JFE*). | Horizon is months to years. |
| Quality-minus-junk | High-quality stocks earn significant risk-adjusted returns worldwide (Asness, Frazzini & Pedersen, 2019, *RAST*). | Horizon is months to years. |
| Altman Z / distress | Z-score predicts bankruptcy (Altman, 1968, *JF*). Distressed firms have *lower*, not higher, subsequent returns (Dichev, 1998, *JF*; Campbell, Hilscher & Szilagyi, 2008, *JF*). | Use as a **veto/risk flag** (low Z makes a long less appealing), not as a symmetric signal. Hardly ever active for mega-caps. |
| Decay | Anomaly returns are about 26% lower out of sample and about 58% lower after publication (McLean & Pontiff, 2016, *JF*). | Scale all published effects down by about half. |

Fundamentals carry essentially **no information at intraday or 5-day horizons**. Their weight should be about 0 intraday, small for swing and moderate for position.

### 1.5 Sentiment and news

- High media pessimism predicts falling prices followed by a reversal within about a week (Tetlock, 2007, *JF*).
- Negative-word share predicts earnings and returns (Tetlock, Saar-Tsechansky & Macskassy, 2008, *JF*).
- Generic dictionaries misclassify financial text: about three-quarters of Harvard-IV "negative" words are not negative in 10-Ks (Loughran & McDonald, 2011, *JF*). This supports the planned Loughran–McDonald-style lexicon.
- Sentiment predicts returns mainly in recessions (García, 2013, *JF*).
- GPT-4 headline scores achieve about 90% portfolio-day hit rates on the *non-tradable* initial reaction. They also predict subsequent drift, mainly for small stocks and negative news. Strategy returns fall as adoption rises (Lopez-Lira & Tang, 2023/2025, arXiv:2304.07619). Headline sentiment in liquid mega-caps is therefore priced within minutes, and a Google-News-RSS feed with delay cannot capture that initial reaction.
- **Crypto Fear & Greed.** In 2018–2025 daily data, changes in the index do *not* Granger-cause BTC returns and give no out-of-sample gain. Returns drive the index (*"Do bitcoin returns move sentiment? Evidence from the crypto fear & greed index"*, 2026, ScienceDirect S305070062600006X). Keep only a mild contrarian effect at the extremes (≤10 or ≥90), at low weight.
- **Investor attention** (search volume) does predict crypto returns (Liu & Tsyvinski, 2021). A spike in news volume is a reasonable *attention* feature.

### 1.6 Macro

- **VIX / variance risk premium.** The variance risk premium predicts quarterly equity returns (Bollerslev, Tauchen & Zhou, 2009, *RFS*). High VIX goes with larger reversal profits (Nagel, 2012). Its main use is as a regime conditioner, not a daily directional signal.
- **Credit spreads.** The excess bond premium component of credit spreads predicts economic activity and equity weakness (Gilchrist & Zakrajšek, 2012, *AER*). Rising HY OAS is a reasonable risk-off indicator at position horizon.
- **Dollar.** The dollar factor carries countercyclical risk premia in FX (Lustig, Roussanov & Verdelhan, 2014, *JFE*). Crypto has **no significant exposure** to currency or macro factors in the peer-reviewed evidence (Liu & Tsyvinski, 2021). The widely repeated "strong dollar is bearish for BTC" story lacks robust predictive support, so use low weight.

### 1.7 Crypto derivatives: funding and basis

- **Basis.** The futures basis ("crypto carry") reaches up to 60% a year. It reflects trend-chasing retail demand for leverage combined with scarce arbitrage capital. High carry precedes liquidation cascades and crashes (Schmeling, Schrimpf & Todorov, 2023, BIS WP 1087). A 10% rise in standardised carry predicts about 22% more sell liquidations relative to open interest over the next month (as reported in the CEPR/VoxEU summary).
- **Perpetual deviations** from no-arbitrage prices are large in crypto, move together across coins, and shrink over time (He, Manela, Ross & von Wachter, 2024, arXiv:2212.06888).
- **Implication.** Extreme positive funding or basis is a *contrarian, crash-risk* signal, strongest in the tails. Near-zero funding carries no information. This matches the contract's design.

### 1.8 Microstructure

- **Order-flow imbalance.** Over short intervals, price changes are linear in order-flow imbalance at the best quotes, with slope inversely proportional to depth (Cont, Kukanov & Stoikov, 2014, *JFEc*). On BitMEX XBTUSD, trade-flow imbalance explains price changes better than order-book OFI. Crypto books have thin depth and slow updates (Silantyev, 2019, *Digital Finance*).
- **Contemporaneous, not predictive.** These are *mostly contemporaneous* relationships. Predictive power decays within seconds to minutes. Sampled every 15 s over REST or WebSocket, it adds little beyond a 2-hour horizon.
- **VPIN.** VPIN was proposed as a flow-toxicity measure (Easley, López de Prado & O'Hara, 2012, *RFS*). Once volume and volatility are controlled for, it has **no incremental predictive power** for volatility, and it peaked *after* the Flash Crash (Andersen & Bondarenko, 2014, *JFM*). Use VPIN only as a **confidence dampener** (high toxicity lowers confidence), never as a directional signal.

---

## 2. Realistic accuracy, and why abstention is the lever

### 2.1 Typical effect sizes

| Setting | Out-of-sample result |
|---|---|
| Daily direction of S&P 500 stocks, LSTM, 1992–2015 | About 54% accuracy. Profitability after costs largely disappears after 2010 (Fischer & Krauss, 2018, *EJOR*). |
| BTC, 1–60 minute direction, gradient boosting and RNNs | Accuracy of about 51–56%, rising with horizon (Jaquart, Dann & Weinhardt, 2021, *JFDS*). |
| US stocks, monthly, trees and neural nets | Monthly R² of about 0.4–0.7%, yet economically large gains (Gu, Kelly & Xiu, 2020, *RFS*). |
| Time-series foundation models (Chronos, TimesFM, Moirai), zero-shot, daily equity returns | Skill of about 10⁻³. Only 2 asset-tasks beat a random walk significantly on Diebold-Mariano tests (Noguer i Alonso & Franklin, 2026, arXiv:2606.27100). |

**What these numbers mean for our metrics:**

- A perfectly calibrated forecaster at 55% has a Brier score of 0.2475 against 0.25 for always predicting 50%. That is a Brier skill score of only 1%.
- Log-loss would be about 0.688 against 0.693.
- **Target OOS metrics:** AUC 0.53–0.56 is good, and above 0.60 on daily bars should be treated as a probable leak. ECE should be at most 0.02–0.03. The Brier skill score should be above 0.

### 2.2 Overfitting, snooping and bias

- **Higher t-stat bar.** New factors should clear t > 3.0 rather than 2.0 because of massive multiple testing (Harvey, Liu & Zhu, 2016, *RFS*).
- **Deflated Sharpe ratio.** This corrects a backtest Sharpe for the number of trials, skewness and kurtosis (Bailey & López de Prado, 2014, *JPM*). The probability of backtest overfitting can be estimated with combinatorially symmetric cross-validation (Bailey, Borwein, López de Prado & Zhu, 2017, *J. Comp. Finance*).
- **Other biases:**
  - Survivorship: the current default universe is today's winners, such as NVDA and SOL.
  - Lookahead: fundamentals must be keyed on the SEC *filing* date, not the period end.
  - Parameter sweeps on the same data.
- **Rules for this engine:**
  1. Record the number of configurations tried and report DSR next to Sharpe.
  2. Change a default only if the change beats the old one out of sample on a *held-out* period.
  3. Treat backtests on today's top-7 coins and stocks as optimistic.

### 2.3 Selective prediction

A classifier with a reject option ("abstain") can reach much lower error on the cases it accepts. This is the risk-coverage trade-off (Chow, 1970, *IEEE Trans. IT*; Geifman & El-Yaniv, 2017, *NeurIPS*).

In our setting, accuracy on the top 10–20% most-confident decisions can plausibly reach 56–60%, while overall accuracy is 52–53%. That only holds if the confidence score actually *ranks* outcomes, which should be verified with a risk-coverage curve in the backtest.

The same idea appears as meta-labeling: a secondary model predicts whether the primary signal will be right and sets its size (López de Prado, 2018, *AFML* ch. 3; Joubert, 2022, *JFDS*). Practitioner replications report better precision, Sharpe and drawdowns (Singh & Joubert, 2022, Hudson & Thames).

**Recommendation:** tune thresholds for **coverage**, not accuracy. Aim for 15–30% of eligible bars getting a non-HOLD decision, and check that OOS precision at that coverage is at least 55%.

---

## 3. Ensemble theory

### 3.1 Log-odds pooling, extremizing and shrinking

- **Why log-odds.** Logarithmic (geometric) pooling is the "externally Bayesian" pooling rule (Genest & Zidek, 1986, *Stat. Sci.*). A linear pool of calibrated forecasts is itself *under*-confident and needs recalibration (Ranjan & Gneiting, 2010, *JRSS-B*).
- **When to extremize.** Logit aggregators with an extremizing exponent above 1 win when forecasters hold *diverse, independent* information (Satopää et al., 2014, *IJF*; Baron et al., 2014, *Decision Analysis*). Our analyzers are the opposite case: nearly all of them see the same OHLCV bars, so the shared-information component dominates. **Shrink (exponent < 1); do not extremize.**
- **How much correlation costs.** With pairwise correlation ρ, n experts are worth n/(1+(n−1)ρ) independent ones. This tends to **1/ρ** as n grows, so with ρ = 0.8 an infinite number of experts is worth 1.25 (Clemen & Winkler, 1985, *Oper. Res.*).
  - Trend indicators (EMA stack, supertrend, ADX, Ichimoku, linreg, Kalman) have ρ around 0.7–0.9, so the whole technical-trend group is worth about 1.2–1.4 signals.
  - The contract's diminishing sum (1, .6, .4, .3, .25, …) adds up to about 3.5 for 10 signals, which is too generous.
  - A harmonic sequence 1, 1/2, 1/3, …, capped at 6 terms (sum ≈ 2.45), applied **within subfamilies** (trend / momentum / mean-reversion / volume / structure), keeps the effective count closer to the theory.
- **Equal weights are hard to beat.** Estimated combination weights rarely beat simple averages because of estimation error: the "forecast combination puzzle" (Smith & Wallis, 2009, *OBES*; Timmermann, 2006, *Handbook of Economic Forecasting*). Learned weights must therefore be **shrunk hard toward the prior**.

### 3.2 Hedge and multiplicative weights

- Hedge's regret bound is O(√(T ln N)) with η = √(8 ln N / T) (Freund & Schapire, 1997, *JCSS*). For N ≈ 60 signal ids and T ≈ 1,000 resolved outcomes, η ≈ 0.18. That is an upper bound; noisy 52%-accuracy labels favour a smaller η.
- In non-stationary settings, "fixed-share" mixing toward uniform tracks the best *shifting* expert (Herbster & Warmuth, 1998, *Machine Learning*). The contract's "decay toward 1" is this mechanism. A mixing rate of about 0.5–1% per update gives a memory of about 100–200 outcomes.
- **Critical:** update only on **non-overlapping** resolved outcomes, at most one per asset per horizon length. Otherwise a 5-day label resolved every 15 s scan is counted thousands of times.

### 3.3 Regime conditioning and HMMs

- **Why regimes.** Markov switching between states with different means and variances describes business-cycle and return dynamics (Hamilton, 1989, *Econometrica*). Regime-switching models justify moving to safer allocations in the high-volatility, high-correlation state (Ang & Bekaert, 2002, *RFS*). Regimes are a core stylised fact of markets (Ang & Timmermann, 2012, *Ann. Rev. Fin. Econ.*). Regime-based allocation beats static allocation once transaction costs and a rolling estimation window are used (Nystrup, Hansen, Madsen & Lindström, 2015, *JPM*). Profitability of Markov-switching strategies depends on sensible filtering and parameter choices (Bulla et al., 2011, *J. Asset Mgmt.*).
- **Number of states.** Use 2 states (calm/bull and turbulent/bear) for equity indices. Use 3 for crypto, whose returns have a distinct crash/high-volatility state. More states overfit with fewer than about 1,000 daily observations.
- **Filtered probabilities only.** The contract's `hmmFilter` is the right choice. Smoothed (forward-backward) probabilities use future data and leak lookahead into any backtest.
- **Label switching and hysteresis.** Order states by variance. Switch state only when the filtered probability exceeds 0.65, to avoid flip-flopping.
- **What regimes should change** (sources: Moskowitz, Ooi & Pedersen, 2012; Daniel & Moskowitz, 2016; Nagel, 2012):

  | Regime | Adjustment |
  |---|---|
  | Clear trend | More weight to trend-following. |
  | Ranging, or high VIX | More weight to reversal. |
  | "Bear-market rebound" (trailing 1-year return below 0 and high volatility) | Less weight to momentum, because momentum crashes there. |
  | Extreme volatility | Less weight overall. |

### 3.4 Kelly sizing with estimation error, and volatility targeting

- **Fractional Kelly.** Kelly maximises long-run growth (Kelly, 1956). Scaling by a fraction c keeps a share c(2−c) of the optimal growth rate while variance scales with c². Half-Kelly keeps 75% of growth; quarter-Kelly keeps about 44% at 1/16 of the variance (MacLean, Thorp & Ziemba, 2010, *Quant. Finance*).
- **Estimation error.** When p is estimated, the optimal bet shrinks further toward zero (Baker & McHale, 2013, *Decision Analysis*). With the edge on p around 0.02–0.06 and a standard error of about ±0.03 on OOS calibration, quarter-Kelly *multiplied by calibrator reliability* is appropriate.
- **Volatility targeting** caps tail risk (Harvey et al., 2018). Estimate volatility with EWMA, λ = 0.94 on daily data (J.P. Morgan RiskMetrics, 1996). Annualise with √252 for stocks and √365 for crypto.

### 3.5 Stops and targets

Stop-loss rules add value only when returns are serially correlated, as in momentum regimes. Under a random walk they reduce expected return (Kaminski & Lo, 2014, *JFM*). Stops are therefore a risk-control tool for trend-type entries.

**Geometry of the bracket:**

- The horizon volatility is σ_h = σ_bar·√ahead, and ATR ≈ 1.4–1.6·σ_bar. The Parkinson range result gives E[range] ≈ 1.6σ for continuous paths (Parkinson, 1980, *J. Business*).
- Swing (5 bars): 2·ATR ≈ 1.25σ_h and 3·ATR ≈ 1.9σ_h. By the reflection principle, a driftless path hits the stop within the horizon about 21% of the time and the target only about 6%. **Most trades will exit at the time limit.**
- Position (20 bars): 2·ATR ≈ 0.63σ_h, which gets hit about 53% of the time. That is **far too tight** for a 1-month view.
- **Rule:** stop ≈ 1.0–1.25σ_h and target ≈ 1.5–2.0σ_h. The per-horizon ATR multiples are in §5.

---

## 4. Calibration

- **Platt scaling** fits a logistic curve to the scores (Platt, 1999). **Isotonic regression (PAV)** fits a non-parametric monotone map (Zadrozny & Elkan, 2002, *KDD*).
- **Sample size.** Isotonic overfits small calibration sets. In the benchmark, Platt is better when the calibration set has fewer than about 1,000 points, and isotonic matches or beats it above that (Niculescu-Mizil & Caruana, 2005, *ICML*). Boosted models such as our GBM push probabilities toward 0.5 in a sigmoid pattern, which Platt corrects well (same study).
- **Use n_eff, not n.** With overlapping labels, n_eff ≈ n / ahead. A swing calibrator with 400 daily decisions has n_eff ≈ 80.
- **Recommended schedule:**

  | n_eff | Calibrator | Reliability |
  |---|---|---|
  | < 30 | Identity, shrunk 0.5 toward 0.5 | `reliable: false` |
  | 30–300 | Platt | |
  | 300–1,000 | Platt/isotonic blend, weight on isotonic = (n_eff − 300)/700 | |
  | ≥ 1,000 | Isotonic, with a 5% Platt blend for smoothness | |

- **Metrics.** Brier score (Brier, 1950, *Monthly Weather Review*) and log-loss are strictly proper scoring rules (Gneiting & Raftery, 2007, *JASA*). ECE should use about 10 *equal-mass* bins (Naeini, Cooper & Hauskrecht, 2015, *AAAI*); equal-width bins are nearly empty because our probabilities sit in 0.4–0.6.
- **AUC-based ML confidence.** Compute the AUC standard error (Hanley & McNeil, 1982, *Radiology*) with n_eff, then use the lower confidence bound, AUC − 1.64·SE. With n_eff = 100 the SE is about 0.058, so a raw AUC of 0.55 is noise.
- **Meta-labeling for confidence.** Train a second classifier on the primary decision's features plus the engine's own state: |pUp − 0.5|, agreement, coverage, regime, vol percentile, calibrator ECE. Its target is "the primary call was right." Use its probability as the confidence input, once there are at least 300 non-overlapping resolved decisions (López de Prado, 2018; Joubert, 2022).

---

## 5. Recommended defaults for this engine

### 5.1 Recommended defaults

| Parameter | Current | **Recommended** | Justification |
|---|---|---|---|
| κ (score → evidence) | ≤ 0.9 | **0.30** | Single signals are about 52–56% accurate (§2.1). With κ = 0.3, a score of 1 maps to p = 0.65 (e ≈ 0.62), the most plausible ceiling for one signal. With κ = 0.9, one signal would claim 95% (e = 2.9). |
| Cap on aggregate \|L\| before calibration | none | **\|L\| ≤ logit(0.75) ≈ 1.10** | Guards against piling up correlated evidence (Clemen & Winkler, 1985). No honest daily signal set justifies more than 75%. |
| Within-family diminishing sum | 1, .6, .4, .3, .25 | **Group by subfamily (trend / momentum / meanrev / volume / structure / mtf). Use 1, 1/2, 1/3, …, 1/6 inside each subfamily, then 1, .7, .5, .4, … across subfamilies.** | The effective number of correlated signals is bounded by 1/ρ, which is about 1.2–1.4 for trend indicators (Clemen & Winkler, 1985). The harmonic sequence grows like ln n. |
| Global pooling exponent (β scale) | 1 | **0.6** (shrink, do not extremize) | Shared information calls for shrinking; independent information calls for extremizing (Baron et al., 2014; Satopää et al., 2014). |
| Uncalibrated shrink toward 0.5 | 0.5 | **0.5** (keep) | Humility prior until n_eff ≥ 30. |
| Family base weight β_f: technical | — | **intraday 1.0 · swing 1.0 · position 1.0** | TSMOM/trend has the strongest evidence (MOP 2012; Hurst et al., 2017; Liu & Tsyvinski, 2021). |
| β_f: ml | — | **0.6 · 0.7 · 0.5** | Uses the same inputs as technical (correlated). Monthly R² is below 1% (Gu et al., 2020). The position horizon has too few independent labels. |
| β_f: regime (directional part) | — | **0.3 · 0.4 · 0.5** | Mostly a *conditioner*, with weak directional content. |
| β_f: derivatives (crypto) | — | **0.3 · 0.5 · 0.5** | Informative only at the extremes, as a crash-risk contrarian (Schmeling et al., 2023). |
| β_f: microstructure | — | **0.7 · 0.1 · 0.0** | OFI is mostly contemporaneous (Cont et al., 2014). VPIN is not predictive (Andersen & Bondarenko, 2014). |
| β_f: sentiment (news/social/F&G) | — | **0.3 · 0.3 · 0.15** | Priced fast in mega-caps (Lopez-Lira & Tang). F&G has no OOS power (2026 study). Attention helps somewhat in crypto. |
| β_f: macro | — | **0.1 · 0.3 · 0.5** | Credit/VIX matter at monthly horizons (Gilchrist & Zakrajšek, 2012; Bollerslev et al., 2009). No crypto macro exposure (Liu & Tsyvinski, 2021). |
| β_f: fundamental (stocks) | — | **0.0 · 0.15 · 0.4** | Horizon is months to years. Post-earnings drift is dead for large caps (Martineau, 2022). Anomalies decay about 58% after publication (McLean & Pontiff, 2016). |
| β_f: fundamental (crypto) | — | **0.0 · 0.1 · 0.25** | No peer-reviewed short-horizon evidence. Network adoption matters at long horizons (Liu & Tsyvinski, 2021). |
| β_f: llm | — | **0.2 · 0.3 · 0.2** | Evidence exists for headline reactions, but those are fast and non-tradable (Lopez-Lira & Tang). |
| Regime: trending (ADX > 25 or ER > 0.4, HMM calm) | — | **trend and momentum ×1.3, mean-reversion ×0.4** | MOP 2012. The contract requires mean-reversion to be down-weighted in trends. |
| Regime: range (ADX < 20, ER < 0.25) | — | **trend ×0.6, mean-reversion ×1.3** | Reversal is liquidity provision (Nagel, 2012). |
| Regime: high vol (70th–90th percentile) | — | **trend ×0.8, mean-reversion ×1.1, others ×0.9** | Reversal profits rise with VIX (Nagel, 2012). |
| Regime: extreme vol (> 90th percentile) | — | **all ×0.5, and MIN_CONFIDENCE +0.05** | Crash states (Ang & Bekaert, 2002; Harvey et al., 2018). |
| Momentum-crash guard | — | **If trailing 252-day return < 0 and vol > 70th percentile, trend ×0.5** | Momentum crashes in bear-market rebounds (Daniel & Moskowitz, 2016). |
| MIN_PROB_EDGE | 0.06 | **intraday 0.04 · swing 0.04 · position 0.05**, plus the cost gate below | A calibrated P(up) of 0.56 or more will almost never occur (§2.1). 0.54 is already in the top decile. |
| Cost gate | none | **Require E[r] ≥ 2 × round-trip cost** | Intraday crypto: 2-hour σ_h ≈ 0.9%, and an edge of 0.04 gives E[r] ≈ 6 bps against 30 bps round trip. Without this gate the engine trades a guaranteed loss. |
| MIN_CONFIDENCE | 0.65 | **0.60 initially, then set by coverage** (15–30% non-HOLD at OOS precision ≥ 55%) | Selective prediction (Geifman & El-Yaniv, 2017). |
| MIN_AGREEMENT | 0.55 | **0.60** | Requires a clear majority of *de-duplicated* evidence. |
| STRONG_CONFIDENCE | 0.80 | **0.80** (keep) | Should be rare (under 5% of decisions). |
| STOP_ATR / TARGET_ATR | 2.0 / 3.0 | **intraday 2.0 / 3.0 · swing 2.0 / 3.0 · position 3.5 / 5.5** | Keep stop ≈ 1–1.25σ_h and target ≈ 1.5–2σ_h (§3.5). The current 2·ATR stop is about 0.6σ_h at 20 days. |
| KELLY_K | 0.25 | **0.25 × calibrator reliability (0–1), capped at 0.25** | Fractional Kelly (MacLean et al., 2010) plus shrinkage for parameter uncertainty (Baker & McHale, 2013). |
| TARGET_VOL | 0.15 per position | **Portfolio 0.10–0.12. Per position: TARGET_VOL / √(max concurrent positions).** | Harvey et al. (2018) use 10%. Crypto σ of 60–90% makes MAX_POS_FRAC bind anyway. |
| Vol estimator | — | **EWMA λ = 0.94. Annualise √252 (stocks), √365 (crypto).** | RiskMetrics (1996). |
| MAX_POS_FRAC | 0.10 | **0.10 stocks, 0.05 crypto** | Crypto tail risk and crashes (Schmeling et al., 2023). |
| HMM states | 2–3 | **Equities k = 2, crypto k = 3. Fit on at least 750 daily returns (rolling 1,500). Refit weekly. Filtered probabilities only. Switch when p > 0.65.** | Hamilton (1989); Ang & Bekaert (2002); Nystrup et al. (2015). |
| Walk-forward minTrain / step | 250 / 20 | **daily: 500 / 20 · intraday 15m: 3,000 / 96** | About 20 features with noisy labels need at least 25 samples per feature per class. |
| Purge / embargo | none | **Drop the last `ahead` training rows before each test block, plus a 1% embargo** | Overlapping labels leak (López de Prado, 2018, ch. 7). |
| History loaded | 500 / 400 / 600 | **intraday ≥ 3,500 · swing ≥ 1,000 · position ≥ 1,500** | 600 daily bars at 20-day horizon give only about 30 independent labels, which is statistically meaningless. |
| Label dead-zone | 0.1σ | **daily 0.15σ_h. Intraday: max(0.2σ_h, round-trip cost).** | Drops about 12–16% of near-coin-flip labels. Moves smaller than cost are unprofitable either way. |
| Triple-barrier labels (meta model) | — | **Barriers equal to the live STOP/TARGET; vertical barrier = ahead** | Makes the calibrated probability equal the quantity the risk plan uses (López de Prado, 2018, ch. 3). |
| ML confidence from AUC | AUC ≤ 0.52 → 0 | **conf = clip((AUC_lcb − 0.50)/0.06, 0, 1), where AUC_lcb = AUC − 1.64·SE(n_eff)** | Hanley & McNeil (1982). |
| Hedge η | 0.10 | **0.05** | Well below the theoretical η ≈ 0.18 because labels are very noisy (Freund & Schapire, 1997). |
| Hedge clamp | [0.25, 4] | **[0.5, 2]** | The forecast-combination puzzle calls for shrinking toward equal weights (Smith & Wallis, 2009). |
| Hedge decay toward 1 | "slow" | **Fixed-share α = 0.005 per update (memory of about 200 outcomes). One update per asset per horizon.** | Herbster & Warmuth (1998). Prevents counting the same outcome many times. |
| Calibrator switch | Platt < 200 else blend | **Measured in n_eff: Platt < 300, blend 300–1,000, isotonic ≥ 1,000; unreliable below 30** | Niculescu-Mizil & Caruana (2005). |
| ECE bins | — | **10 equal-mass bins** | Our probabilities are concentrated in 0.4–0.6. |

**ML features** (all computed on bars `0..i`, standardised by rolling volatility; keep 15–25 of them):

- vol-scaled returns over 1, 5, 20 and 60 bars;
- 12-1 momentum on daily bars (skip the most recent 21 days; Jegadeesh & Titman, 1993) and 2–4-week momentum for crypto (Liu & Tsyvinski, 2021);
- 1–5-bar reversal;
- distance to the 52-week high (George & Hwang, 2004);
- realized-vol ratio (5/20) and vol percentile;
- efficiency ratio and ADX;
- RSI(14) and MACD histogram / price;
- %B;
- volume z-score;
- return relative to a benchmark (SPY for stocks, BTC for alt-coins);
- for stocks: overnight vs intraday return split (Lou, Polk & Skouras, 2019, *JFE*);
- for crypto: funding z-score, change in open interest, and weekend flag.

Drop raw price levels. Drop day-of-week (no robust evidence, snooping risk). Use L2 around 1.0 for the logistic model. GBM settings: depth ≤ 2, learning rate 0.05, 150–300 trees, subsample 0.7, min leaf ≥ 50.

### 5.2 Issues to fix in the contract as written

1. **Overlapping labels without purging** in `trainWalkForward`. When a 5-bar label is used, the last 5 training rows overlap the test period, which inflates AUC. Add purge and embargo (López de Prado, 2018).
2. **Expected return with an asymmetric bracket.** `E[r] = pUp·avgWin − (1−pUp)·avgLoss` with 3:2 ATR brackets gives E[r] > 0 at pUp = 0.5. A driftless walk hits +3 before −2 with probability 2/5, not 1/2. There are two fixes:
   - Map pUp to an implied drift, μ = σ_h·Φ⁻¹(pUp), and use the gambler's-ruin hit probability `P(target first) = (1 − e^{−2μb/σ²}) / (1 − e^{−2μ(a+b)/σ²})`, where a = target distance, b = stop distance and μ, σ² are per unit time. Also include the time-limit exit.
   - Or calibrate directly on triple-barrier outcomes.
3. **HMM smoothed probabilities** (forward-backward) must not be used in the backtest or live path. Use the forward filter only.
4. **Repeated Hedge and calibrator updates.** The live loop re-decides every 15–60 s, but the label spans 2 hours to 20 days. Record one decision per asset per horizon-length for learning, or weight each update by 1/overlap.
5. **AUC gate without an error bar.** At n_eff = 100 an AUC of 0.52–0.60 cannot be distinguished from 0.5. Use the lower confidence bound.
6. **Intraday crypto with 10 bps taker fees.** The expected edge is an order of magnitude below cost (see the cost gate above). Default intraday crypto to a maker/limit fee assumption, or make it analysis-only.

---

## 6. Limitations and honest expectations

- **Probabilities stay close to 50%.** After calibration, most P(up) values will fall between 0.45 and 0.55. A "72% confidence" in the UI is a *composite reliability score*, not a 72% hit rate. The UI should show the calibrated pUp and the OOS hit rate at that confidence bucket.
- **Backtests can only test part of the engine.** Only the technical, regime and ml families can be backtested (the others lack history). The live ensemble therefore cannot be fully validated. News, macro, derivative and fundamental weights are evidence-informed *priors*, not fitted values.
- **The universe is biased.** It is small and survivor-selected (mega-cap tech and today's top coins). Backtests will overstate performance; Harvey, Liu & Zhu (2016) and McLean & Pontiff (2016) suggest halving any backtested edge.
- **Too few independent labels at longer horizons.** Swing has about 80–200 independent labels a year across assets; position has about 12 per asset per year. Calibration and Hedge learning for the position horizon will stay statistically unreliable for years. Rely on priors and shrinkage.
- **Regimes change.** Crypto microstructure and the funding-carry trade have changed markedly since spot ETFs (Schmeling et al., 2023). Carry Sharpe collapsed in 2024–2025 (arXiv:2510.14435). Expect decay and monitor rolling Brier skill.
- **Data latency.** Free, delayed data (RSS news, REST snapshots, FRED daily series) removes most of the short-lived information advantage that the microstructure and news literature documents.
- **Realistic target.** A calibrated engine that abstains most of the time, hits about 55–58% on the decisions it does take, has a positive deflated Sharpe after costs, and keeps drawdowns contained through volatility targeting. It will not be a high-accuracy oracle.

---

## 7. Future work

- **Options-implied data.** The variance risk premium (Bollerslev et al., 2009), implied skew, and Deribit crypto IV term structure provide forward-looking risk signals.
- **Alternative data.** Candidates are on-chain flows and search attention (Liu & Tsyvinski, 2021), and earnings-call text.
- **LLM news reasoning.** Scoring headlines with an LLM in real time has documented predictive value on the initial reaction and on drift in small caps and negative news (Lopez-Lira & Tang, 2023/2025). It needs low-latency news and must use only post-training-cutoff headlines in evaluation to avoid lookahead.
- **Time-series foundation models** (Chronos, Ansari et al., 2024, arXiv:2403.07815; TimesFM, Das et al., 2024, *ICML*). Zero-shot return skill is about 10⁻³ (Noguer i Alonso & Franklin, 2026). They are more promising for **volatility** forecasting than for direction, and could feed the sizing layer.
- **Conformal prediction** for distribution-free coverage guarantees on abstention sets.
- **Cross-sectional models** once the universe grows beyond about 50 names, so that 12-1 momentum, QMJ and gross profitability can be used as intended.

---

## 8. References

- Altman, E. (1968). Financial ratios, discriminant analysis and the prediction of corporate bankruptcy. *Journal of Finance* 23(4).
- Andersen, T. & Bondarenko, O. (2014). VPIN and the Flash Crash / Reflecting on the VPIN dispute. *J. Financial Markets* 17. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2305905
- Ang, A. & Bekaert, G. (2002). International asset allocation with regime shifts. *Review of Financial Studies* 15(4).
- Ang, A. & Timmermann, A. (2012). Regime changes and financial markets. *Annual Review of Financial Economics* 4.
- Ansari, A. F. et al. (2024). Chronos: Learning the language of time series. arXiv:2403.07815.
- Asness, C., Frazzini, A. & Pedersen, L. H. (2019). Quality minus junk. *Review of Accounting Studies* 24.
- Bailey, D. & López de Prado, M. (2014). The deflated Sharpe ratio. *JPM* 40(5). https://ssrn.com/abstract=2460551
- Bailey, D., Borwein, J., López de Prado, M. & Zhu, Q. (2017). The probability of backtest overfitting. *J. Computational Finance* 20(4).
- Baker, R. & McHale, I. (2013). Optimal betting under parameter uncertainty: improving the Kelly criterion. *Decision Analysis* 10(3). https://pubsonline.informs.org/doi/pdf/10.1287/deca.2013.0271
- Baron, J., Mellers, B., Tetlock, P., Stone, E. & Ungar, L. (2014). Two reasons to make aggregated probability forecasts more extreme. *Decision Analysis* 11(2).
- Barroso, P. & Santa-Clara, P. (2015). Momentum has its moments. *JFE* 116(1).
- Bernard, V. & Thomas, J. (1989). Post-earnings-announcement drift. *J. Accounting Research* 27.
- Bollerslev, T., Tauchen, G. & Zhou, H. (2009). Expected stock returns and variance risk premia. *RFS* 22(11).
- Brier, G. (1950). Verification of forecasts expressed in terms of probability. *Monthly Weather Review* 78.
- Bulla, J., Mergner, S., Bulla, I., Sesboüé, A. & Chesneau, C. (2011). Markov-switching asset allocation: do profitable strategies exist? *J. Asset Management* 12.
- Campbell, J., Hilscher, J. & Szilagyi, J. (2008). In search of distress risk. *JF* 63(6).
- Cederburg, S., O'Doherty, M., Wang, F. & Yan, X. (2020). On the performance of volatility-managed portfolios. *JFE* 138(1). https://www.lehigh.edu/~xuy219/research/COWY.pdf
- Chow, C. K. (1970). On optimum recognition error and reject tradeoff. *IEEE Trans. Information Theory* 16(1).
- Clemen, R. & Winkler, R. (1985). Limits for the precision and value of information from dependent sources. *Operations Research* 33(2).
- Cont, R., Kukanov, A. & Stoikov, S. (2014). The price impact of order book events. *J. Financial Econometrics* 12(1). https://arxiv.org/abs/1011.6402
- Daniel, K. & Moskowitz, T. (2016). Momentum crashes. *JFE* 122(2).
- Das, A., Kong, W., Sen, R. & Zhou, Y. (2024). A decoder-only foundation model for time-series forecasting (TimesFM). *ICML 2024*.
- Dichev, I. (1998). Is the risk of bankruptcy a systematic risk? *JF* 53(3).
- Dobrynskaya, V. (2023). Cryptocurrency momentum and reversal. *J. Alternative Investments*; SSRN 3913263. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3913263
- Easley, D., López de Prado, M. & O'Hara, M. (2012). Flow toxicity and liquidity in a high-frequency world. *RFS* 25(5).
- Fischer, T. & Krauss, C. (2018). Deep learning with LSTM networks for financial market predictions. *EJOR* 270(2).
- Freund, Y. & Schapire, R. (1997). A decision-theoretic generalization of on-line learning and an application to boosting. *JCSS* 55(1).
- Gao, L., Han, Y., Li, S. & Zhou, G. (2018). Market intraday momentum. *JFE* 129(2). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866
- García, D. (2013). Sentiment during recessions. *JF* 68(3).
- Geifman, Y. & El-Yaniv, R. (2017). Selective classification for deep neural networks. *NeurIPS 2017*.
- Genest, C. & Zidek, J. (1986). Combining probability distributions: a critique and an annotated bibliography. *Statistical Science* 1(1).
- George, T. & Hwang, C.-Y. (2004). The 52-week high and momentum investing. *JF* 59(5).
- Gilchrist, S. & Zakrajšek, E. (2012). Credit spreads and business cycle fluctuations. *AER* 102(4).
- Gneiting, T. & Raftery, A. (2007). Strictly proper scoring rules, prediction, and estimation. *JASA* 102.
- Grobys, K., Kolari, J., Sandretto, D., Shahzad, S. J. H. & Äijö, J. (2025). Cryptocurrency momentum has (not) its moments. *Financial Markets and Portfolio Management* 39. https://link.springer.com/article/10.1007/s11408-025-00474-9
- Gu, S., Kelly, B. & Xiu, D. (2020). Empirical asset pricing via machine learning. *RFS* 33(5). https://dachxiu.chicagobooth.edu/download/ML.pdf
- Hamilton, J. (1989). A new approach to the economic analysis of nonstationary time series and the business cycle. *Econometrica* 57(2).
- Hanley, J. & McNeil, B. (1982). The meaning and use of the area under a ROC curve. *Radiology* 143.
- Harvey, C., Hoyle, E., Korgaonkar, R., Rattray, S., Sargaison, M. & Van Hemert, O. (2018). The impact of volatility targeting. *JPM* 45(1). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3175538
- Harvey, C., Liu, Y. & Zhu, H. (2016). …and the cross-section of expected returns. *RFS* 29(1). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2249314
- He, S., Manela, A., Ross, O. & von Wachter, V. (2024). Fundamentals of perpetual futures. arXiv:2212.06888.
- Herbster, M. & Warmuth, M. (1998). Tracking the best expert. *Machine Learning* 32.
- Hurst, B., Ooi, Y. H. & Pedersen, L. H. (2017). A century of evidence on trend-following investing. *JPM* 44(1).
- Jaquart, P., Dann, D. & Weinhardt, C. (2021). Short-term bitcoin market prediction via machine learning. *J. Finance and Data Science* 7. https://www.sciencedirect.com/science/article/pii/S2405918821000027
- Jegadeesh, N. (1990). Evidence of predictable behavior of security returns. *JF* 45(3).
- Jegadeesh, N. & Titman, S. (1993). Returns to buying winners and selling losers. *JF* 48(1).
- Joubert, J. (2022). Meta-labeling: theory and framework. *J. Financial Data Science* 4(3). https://jfds.pm-research.com/content/early/2022/06/23/jfds.2022.1.098
- J.P. Morgan/Reuters (1996). *RiskMetrics Technical Document*, 4th ed.
- Kaminski, K. & Lo, A. (2014). When do stop-loss rules stop losses? *J. Financial Markets* 18.
- Kelly, J. L. (1956). A new interpretation of information rate. *Bell System Technical Journal* 35.
- Lehmann, B. (1990). Fads, martingales, and market efficiency. *QJE* 105(1).
- Liu, Y. & Tsyvinski, A. (2021). Risks and returns of cryptocurrency. *RFS* 34(6). https://www.nber.org/papers/w24877
- Liu, Y., Tsyvinski, A. & Wu, X. (2022). Common risk factors in cryptocurrency. *JF* 77(2). https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.13119
- Lopez-Lira, A. & Tang, Y. (2023, rev. 2025). Can ChatGPT forecast stock price movements? Return predictability and large language models. arXiv:2304.07619. https://arxiv.org/abs/2304.07619
- López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
- Lou, D., Polk, C. & Skouras, S. (2019). A tug of war: overnight versus intraday expected returns. *JFE* 134(1).
- Loughran, T. & McDonald, B. (2011). When is a liability not a liability? Textual analysis, dictionaries, and 10-Ks. *JF* 66(1).
- Lustig, H., Roussanov, N. & Verdelhan, A. (2014). Countercyclical currency risk premia. *JFE* 111(3).
- MacLean, L., Thorp, E. & Ziemba, W. (2010). Good and bad properties of the Kelly criterion. In *The Kelly Capital Growth Investment Criterion*, World Scientific; see also *Quantitative Finance* 10(7).
- Martineau, C. (2022). Rest in peace post-earnings announcement drift. *Critical Finance Review* 11(3–4). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3111607
- McLean, R. D. & Pontiff, J. (2016). Does academic research destroy stock return predictability? *JF* 71(1). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2156623
- Moreira, A. & Muir, T. (2017). Volatility-managed portfolios. *JF* 72(4). https://www.nber.org/papers/w22208
- Moskowitz, T., Ooi, Y. H. & Pedersen, L. H. (2012). Time series momentum. *JFE* 104(2). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2089463
- Naeini, M. P., Cooper, G. & Hauskrecht, M. (2015). Obtaining well calibrated probabilities using Bayesian binning. *AAAI 2015*.
- Nagel, S. (2012). Evaporating liquidity. *RFS* 25(7).
- Niculescu-Mizil, A. & Caruana, R. (2005). Predicting good probabilities with supervised learning. *ICML 2005*. https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf
- Noguer i Alonso, M. & Franklin, R. P. (2026). Pretrained time-series foundation models for financial return forecasting. arXiv:2606.27100. https://arxiv.org/html/2606.27100
- Novy-Marx, R. (2013). The other side of value: the gross profitability premium. *JFE* 108(1).
- Nystrup, P., Hansen, B. W., Madsen, H. & Lindström, E. (2015). Regime-based versus static asset allocation: letting the data speak. *JPM* 42(1).
- Parkinson, M. (1980). The extreme value method for estimating the variance of the rate of return. *J. Business* 53(1).
- Piotroski, J. (2000). Value investing: the use of historical financial statement information. *J. Accounting Research* 38 (Suppl.).
- Platt, J. (1999). Probabilistic outputs for support vector machines. In *Advances in Large Margin Classifiers*, MIT Press.
- Ranjan, R. & Gneiting, T. (2010). Combining probability forecasts. *JRSS-B* 72(1).
- Satopää, V., Baron, J., Foster, D., Mellers, B., Tetlock, P. & Ungar, L. (2014). Combining multiple probability predictions using a simple logit model. *IJF* 30(2). https://www.sciencedirect.com/science/article/abs/pii/S0169207013001635
- Schmeling, M., Schrimpf, A. & Todorov, K. (2023). Crypto carry. BIS Working Paper 1087. https://www.bis.org/publ/work1087.pdf
- Shen, D., Urquhart, A. & Wang, P. (2022). Bitcoin intraday time series momentum. *Financial Review* 57(2). https://centaur.reading.ac.uk/100181/
- Silantyev, E. (2019). Order flow analysis of cryptocurrency markets. *Digital Finance* 1. https://link.springer.com/article/10.1007/s42521-019-00007-w
- Singh, A. & Joubert, J. (2022). Does meta-labeling add to signal efficacy? Hudson & Thames. https://hudsonthames.org/wp-content/uploads/2022/04/Does-Meta-Labeling-Add-to-Signal-Efficacy.pdf
- Smith, J. & Wallis, K. (2009). A simple explanation of the forecast combination puzzle. *Oxford Bulletin of Economics and Statistics* 71(3).
- Tetlock, P. C. (2007). Giving content to investor sentiment: the role of media in the stock market. *JF* 62(3).
- Tetlock, P. C., Saar-Tsechansky, M. & Macskassy, S. (2008). More than words: quantifying language to measure firms' fundamentals. *JF* 63(3).
- Timmermann, A. (2006). Forecast combinations. *Handbook of Economic Forecasting* vol. 1, Elsevier.
- Zadrozny, B. & Elkan, C. (2002). Transforming classifier scores into accurate multiclass probability estimates. *KDD 2002*.
- *Do bitcoin returns move sentiment? Evidence from the crypto fear & greed index* (2026). ScienceDirect. https://www.sciencedirect.com/science/article/pii/S305070062600006X
- *Cryptocurrency as an investable asset class: coming of age* (2025). arXiv:2510.14435 (reports crypto carry Sharpe falling from 6.45 over 2020–25 to negative in 2025).
