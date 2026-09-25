// Technical analysis → Signal[] (family "technical"). Pure: candles in, signals out.
//
// Design notes (how a discretionary + systematic trader would read the tape):
//  * Every score is a smooth squash (tanh) of a NORMALISED distance — ATR units, volatility-scaled
//    returns, or a cubic of an oscillator's excursion so the middle of a range is ~0 and only the
//    extremes carry weight. Hard ±1 is never produced by a continuous indicator.
//  * Context matters. We measure a single `trendStrength` ∈ [0,1] from ADX and Kaufman's
//    efficiency ratio. Trend-following signals are multiplied by a factor that grows with it;
//    mean-reversion signals (Bollinger %B, z-score, Williams %R, stochastic, MFI) are multiplied by
//    one that shrinks with it — fading a strong trend is how accounts die.
//  * RSI is interpreted regime-aware (Cardwell): in a strong trend RSI is a momentum gauge (60–80
//    is healthy in an uptrend), in a range it is an overbought/oversold oscillator.
//  * `confidence` = pattern strength × context × data sufficiency. `reason` is one sentence with
//    the numbers that drove it.

const I = require("./indicators");

const { isNum } = I;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sat = (v) => clamp(v, 0, 1);
const safe = (v, d = 0) => (isNum(v) ? v : d);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (isNum(v) ? Math.round(v * 10000) / 10000 : null);
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const sgnWord = (s, pos = "bullish", neg = "bearish", flat = "neutral") => (s > 0.05 ? pos : s < -0.05 ? neg : flat);
const lastOf = (a) => a[a.length - 1];
const ord = (n) => { const k = Math.round(n), t = k % 100; return `${k}${t >= 11 && t <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] || "th"}`; };
const at = (a, k) => (a.length >= k ? a[a.length - k] : null); // at(a,1) = last

// Price formatter that stays readable for $0.08 DOGE and $100k BTC alike.
function px(v) {
  if (!isNum(v)) return "n/a";
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toFixed(d);
}

// Median bar spacing in ms (robust to weekend gaps).
function barMs(candles) {
  const n = Math.min(candles.length - 1, 60);
  if (n < 1) return 86400000;
  const d = [];
  for (let i = candles.length - n; i < candles.length; i++) d.push(candles[i].t - candles[i - 1].t);
  d.sort((a, b) => a - b);
  const m = d[Math.floor(d.length / 2)];
  return m > 0 ? m : 86400000;
}

// Build a Signal with guards so nothing NaN / out of range can leak.
function mk(id, score, confidence, horizon, value, reason) {
  const s = clamp(safe(score), -1, 1), c = clamp(safe(confidence), 0, 1);
  const v = {};
  for (const k of Object.keys(value || {})) {
    const x = value[k];
    v[k] = typeof x === "number" ? (isNum(x) ? (Math.abs(x) >= 1000 ? Math.round(x * 100) / 100 : r4(x)) : null) : x;
  }
  return { id, family: "technical", score: r4(s), confidence: r4(c), horizon, value: v, reason };
}

// Swing pivots (fractals): a pivot high at j if h[j] is the strict max of [j−L, j+R].
function pivots(series, L, R, kind) {
  const out = [];
  for (let j = L; j < series.length - R; j++) {
    const v = series[j];
    if (!isNum(v)) continue;
    let ok = true;
    // Strict on the left, non-strict on the right: of equal highs/lows the first one is the pivot.
    for (let k = j - L; k <= j + R && ok; k++) {
      if (k === j || !isNum(series[k])) continue;
      const w = series[k];
      if (kind === "high") ok = k < j ? w < v : w <= v;
      else ok = k < j ? w > v : w >= v;
    }
    if (ok) out.push({ i: j, v });
  }
  return out;
}

// OLS slope + R² of an arbitrary series over its last n points.
function olsTail(y, n) {
  const N = y.length;
  if (N < n) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let j = 0; j < n; j++) {
    const v = y[N - n + j];
    if (!isNum(v)) return null;
    sx += j; sy += v; sxx += j * j; sxy += j * v; syy += v * v;
  }
  const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
  if (!(vx > 0)) return null;
  const slope = cov / vx;
  const r2v = vy > 0 ? (cov * cov) / (vx * vy) : 0;
  return { slope, r2: clamp(r2v, 0, 1) };
}

/**
 * analyze(candles, { horizon, assetClass }) -> Signal[]
 * Needs ≥ 60 valid candles, else [].
 */
function analyze(candlesIn, opts = {}) {
  const horizon = opts.horizon || "any";
  if (!Array.isArray(candlesIn)) return [];
  // A still-forming last bar gets its volume pro-rated to a full bar (see I.projectFormingVolume);
  // completed histories (backtests) are unchanged. opts.now defaults to the wall clock.
  const candles = I.projectFormingVolume(
    candlesIn.filter((c) => c && [c.o, c.h, c.l, c.c].every(isNum) && c.c > 0 && c.h >= c.l),
    { now: isNum(opts.now) ? opts.now : Date.now() });
  const N = candles.length;
  if (N < 60) return [];

  const close = candles.map((c) => c.c);
  const vol = candles.map((c) => (isNum(c.v) && c.v > 0 ? c.v : 0));
  const hasVolume = vol.slice(-30).filter((v) => v > 0).length >= 25;
  const c0 = close[N - 1];
  const bms = barMs(candles);
  const barsPerDay = clamp(86400000 / bms, 1 / 7, 1440);
  const isDailyPlus = bms >= 86400000 * 0.9;

  // ---- core indicator set (computed once) -----------------------------------------------------
  const atrA = I.atr(candles, 14);
  const atrV = safe(lastOf(atrA), c0 * 0.02) || c0 * 0.02;
  const lr = I.logReturns(close);
  const rv20 = safe(I.last(I.realizedVol(close, 20)), 0.02) || 0.02;   // per-bar σ of log returns
  const dmi = I.adx(candles, 14);
  const adxV = safe(lastOf(dmi.adx), 15), pdiV = safe(lastOf(dmi.pdi), 20), mdiV = safe(lastOf(dmi.mdi), 20);
  const adxPrev = safe(at(dmi.adx, 6), adxV);
  const erV = safe(lastOf(I.efficiencyRatio(close, 20)), 0.2);
  // Trend strength ∈ [0,1]: ADX 18→32 and ER 0.2→0.5 each map 0→1, averaged.
  const trendStrength = sat(0.5 * sat((adxV - 18) / 14) + 0.5 * sat((erV - 0.2) / 0.3));
  const trendCtx = 0.35 + 0.65 * trendStrength;          // multiplier for trend-following signals
  const mrCtx = 1 - 0.8 * trendStrength;                  // multiplier for mean-reversion signals
  const ctxTxt = `ADX ${adxV.toFixed(0)}, ER ${erV.toFixed(2)}`;

  const e20 = I.ema(close, 20), e50 = I.ema(close, 50);
  const longN = N >= 220 ? 200 : 100;
  const eL = I.ema(close, longN);

  const out = [];
  const add = (...a) => out.push(mk(...a));

  // =============================================================================================
  // TREND
  // =============================================================================================
  {
    const a = lastOf(e20), b = lastOf(e50), c = lastOf(eL);
    if (isNum(a) && isNum(b) && isNum(c)) {
      // Smooth "signs": each ordering counts fully only once the gap is ≳ 1 ATR, so intertwined
      // EMAs in a range contribute ~0 instead of flipping ±1 on noise.
      const sgn = (d) => Math.tanh(d / (0.5 * atrV));
      const raw = [c0 - a, a - b, b - c, c0 - c];
      const pairs = raw.map(sgn);
      const W = [0.2, 0.3, 0.3, 0.2];                                           // EMA gaps weigh most
      const align = pairs.reduce((s, v, i) => s + W[i] * v, 0);                 // −1..1
      const spread = (a - b) / atrV;                                            // EMA20−50 in ATRs
      const score = 0.6 * align + 0.4 * Math.tanh(spread / 2);
      const conf = (0.3 + 0.5 * Math.abs(align)) * trendCtx;
      const allUp = raw.every((d) => d > 0), allDn = raw.every((d) => d < 0);
      const wide = Math.min(Math.abs(raw[1]), Math.abs(raw[2])) >= 0.5 * atrV; // EMAs clearly separated
      const state = allUp && wide ? `EMA20 > EMA50 > EMA${longN}, price above all — established uptrend`
        : allDn && wide ? `EMA20 < EMA50 < EMA${longN}, price below all — established downtrend`
        : allUp ? `EMA20 > EMA50 > EMA${longN} but tightly bunched — weak uptrend`
        : allDn ? `EMA20 < EMA50 < EMA${longN} but tightly bunched — weak downtrend`
        : `EMAs mixed (alignment ${align.toFixed(2)})`;
      add("tech.trend.ema_stack", score, conf, horizon,
        { ema20: a, ema50: b, [`ema${longN}`]: c, spreadAtr: spread },
        `${state}; EMA20−EMA50 = ${spread.toFixed(2)} ATR (${ctxTxt})`);
    }
  }
  {
    const st = I.supertrend(candles, 10, 3);
    const d = lastOf(st.dir), line = lastOf(st.line);
    if (isNum(d) && isNum(line)) {
      let since = 0;
      for (let i = N - 1; i >= 0 && st.dir[i] === d; i--) since++;
      const dist = Math.abs(c0 - line) / atrV;
      const score = d * (0.35 + 0.45 * Math.tanh(dist / 2));
      // A just-flipped supertrend is fresh (high information) but also most likely to whipsaw.
      const fresh = since <= 3 ? 0.9 : 1;
      const conf = (0.35 + 0.35 * sat(since / 20)) * trendCtx * fresh;
      add("tech.trend.supertrend", score, conf, horizon, { line, dir: d, barsSinceFlip: since, distAtr: dist },
        `Supertrend(10,3) ${d > 0 ? "up" : "down"} for ${since} bars, price ${dist.toFixed(1)} ATR ${d > 0 ? "above" : "below"} the line at ${px(line)}`);
    }
  }
  {
    const spread = pdiV - mdiV;
    const strength = sat((adxV - 15) / 20);
    const rising = adxV - adxPrev;
    const score = Math.tanh(spread / 12) * (0.3 + 0.7 * strength);
    const conf = sat(0.2 + 0.6 * strength + (rising > 0 ? 0.1 : -0.05));
    add("tech.trend.adx_dmi", score, conf, horizon, { adx: adxV, pdi: pdiV, mdi: mdiV, adxChange5: rising },
      `ADX ${adxV.toFixed(1)} (${rising >= 0 ? "rising" : "falling"} ${Math.abs(rising).toFixed(1)} over 5 bars), +DI ${pdiV.toFixed(1)} vs −DI ${mdiV.toFixed(1)} — ${adxV < 20 ? "no real trend" : spread > 0 ? "buyers in control" : "sellers in control"}`);
  }
  if (N >= 80) {
    const ich = I.ichimoku(candles);
    const tk = lastOf(ich.tenkan), kj = lastOf(ich.kijun), sa = lastOf(ich.spanA), sb = lastOf(ich.spanB);
    const fa = lastOf(ich.spanALead), fb = lastOf(ich.spanBLead);
    if ([tk, kj, sa, sb, fa, fb].every(isNum)) {
      const top = Math.max(sa, sb), bot = Math.min(sa, sb);
      const cloudPos = c0 > top ? Math.tanh((c0 - top) / atrV) * 0.5 + 0.5
        : c0 < bot ? -(Math.tanh((bot - c0) / atrV) * 0.5 + 0.5) : 0;             // inside the cloud = no view
      const tkkj = Math.tanh((tk - kj) / atrV);
      const future = Math.tanh((fa - fb) / (2 * atrV));
      const score = 0.5 * cloudPos + 0.3 * tkkj + 0.2 * future;
      const where = c0 > top ? "above" : c0 < bot ? "below" : "inside";
      const conf = (where === "inside" ? 0.2 : 0.55) * trendCtx + 0.1;
      add("tech.trend.ichimoku", score, conf, horizon, { tenkan: tk, kijun: kj, spanA: sa, spanB: sb },
        `Price ${where} the Ichimoku cloud (${px(bot)}–${px(top)}), tenkan ${tk >= kj ? "above" : "below"} kijun, future cloud ${fa >= fb ? "green" : "red"}`);
    }
  }
  {
    const n = horizon === "position" ? 50 : horizon === "intraday" ? 20 : 30;
    const reg = olsTail(close.map((v) => Math.log(v)), n);
    if (reg) {
      // Slope t-like stat: total fitted move over the window vs. the noise expected over it.
      const z = (reg.slope * n) / (rv20 * Math.sqrt(n));
      const score = Math.tanh(z / 2) * (0.4 + 0.6 * reg.r2);
      const conf = (0.2 + 0.6 * reg.r2) * trendCtx;
      add("tech.trend.linreg", score, conf, horizon, { slopePerBar: reg.slope, r2: reg.r2, z },
        `${n}-bar log-price regression slope ${pct(reg.slope, 2)}/bar (R² ${reg.r2.toFixed(2)}, ${z.toFixed(1)}σ move) — ${sgnWord(score, "rising channel", "falling channel", "flat")}`);
    }
  }
  {
    const k = I.kalmanTrend(close);
    const s = lastOf(k.slope), se = lastOf(k.slopeSE);
    if (isNum(s) && isNum(se) && se > 0) {
      const t = s / se;
      const score = Math.tanh(t / 2.5);
      const conf = (0.25 + 0.45 * sat(Math.abs(t) / 3)) * trendCtx;
      add("tech.trend.kalman", score, conf, horizon, { slopePerBar: s, slopeSE: se, t },
        `Kalman local-trend slope ${pct(s, 2)}/bar (t = ${t.toFixed(1)}) — ${Math.abs(t) < 1 ? "drift statistically flat" : t > 0 ? "significant upward drift" : "significant downward drift"}`);
    }
  }

  // =============================================================================================
  // MOMENTUM
  // =============================================================================================
  const rsiA = I.rsi(close, 14);
  const rsiV = lastOf(rsiA);
  const trendDir = Math.sign(pdiV - mdiV) || Math.sign(safe(lastOf(e20)) - safe(lastOf(e50)));
  if (isNum(rsiV)) {
    // Range reading: oversold/overbought, cubic so 40–60 ≈ 0.
    const mr = -Math.tanh(((rsiV - 50) / 20) ** 3);
    // Trend reading (Cardwell): RSI measures momentum; in an uptrend 40–50 is a buyable dip and
    // 60–80 is healthy, in a downtrend 50–60 is a sellable rally.
    const mom = Math.tanh((rsiV - 50) / 15);
    const pullback = trendStrength < 0.35 ? 0 : trendDir > 0 && rsiV >= 38 && rsiV <= 52 ? 0.35 : trendDir < 0 && rsiV >= 48 && rsiV <= 62 ? -0.35 : 0;
    const ts = trendStrength;
    const trendRead = pullback ? pullback + 0.2 * mom : mom;
    const score = ts * trendRead + (1 - ts) * mr;
    const extreme = sat(Math.abs(rsiV - 50) / 30);
    const conf = 0.2 + 0.4 * Math.max(extreme, ts * 0.8);
    const regimeTxt = ts >= 0.6 ? `strong ${trendDir > 0 ? "up" : "down"}trend so read as momentum`
      : ts <= 0.35 ? "range-bound so read as overbought/oversold" : "mixed trend/range so momentum and reversion readings are blended";
    const zone = rsiV >= 70 ? "overbought" : rsiV <= 30 ? "oversold" : pullback ? "trend pullback zone" : "neutral zone";
    add("tech.momentum.rsi", score, conf, horizon, { rsi: rsiV, trendStrength: ts },
      `RSI(14) ${rsiV.toFixed(1)} (${zone}); market ${regimeTxt} (${ctxTxt})`);
  }
  {
    const m = I.macd(close);
    const h = lastOf(m.hist), line = lastOf(m.macd), hPrev = at(m.hist, 2);
    if (isNum(h) && isNum(line) && isNum(hPrev)) {
      let since = 0;
      for (let i = N - 1; i > 0 && isNum(m.hist[i]) && isNum(m.hist[i - 1]); i--) {
        if (Math.sign(m.hist[i]) !== Math.sign(m.hist[i - 1])) { since = N - i; break; }
      }
      const s1 = Math.tanh(h / (0.2 * atrV)), s2 = Math.tanh(line / atrV);
      const accel = Math.tanh((h - hPrev) / (0.1 * atrV));
      const score = 0.55 * s1 + 0.3 * s2 + 0.15 * accel;
      const fresh = since > 0 && since <= 3;
      const conf = (0.3 + 0.3 * sat(Math.abs(h) / (0.3 * atrV)) + (fresh ? 0.15 : 0)) * (0.6 + 0.4 * trendCtx);
      const crossTxt = fresh ? `, ${h > 0 ? "bullish" : "bearish"} signal-line cross ${since} bar${since > 1 ? "s" : ""} ago` : "";
      add("tech.momentum.macd", score, conf, horizon, { macd: line, signal: lastOf(m.signal), hist: h, histAtr: h / atrV, barsSinceCross: since || null },
        `MACD(12,26,9) histogram ${(h / atrV).toFixed(2)} ATR and ${h > hPrev ? "rising" : "falling"}, MACD line ${line >= 0 ? "above" : "below"} zero${crossTxt}`);
    }
  }
  {
    const st = I.stochastic(candles, 14, 3);
    const k = lastOf(st.k), d = lastOf(st.d), kp = at(st.k, 2), dp = at(st.d, 2);
    if ([k, d, kp, dp].every(isNum)) {
      const lvl = -Math.tanh(((k - 50) / 30) ** 3);
      const crossUp = kp <= dp && k > d, crossDn = kp >= dp && k < d;
      const trig = crossUp && k < 30 ? 0.35 : crossDn && k > 70 ? -0.35 : 0;
      const score = clamp(0.75 * lvl + trig, -1, 1);
      const conf = (0.2 + 0.35 * sat(Math.abs(k - 50) / 40) + (trig ? 0.15 : 0)) * mrCtx;
      add("tech.momentum.stochastic", score, conf, horizon, { k, d },
        `Stochastic(14,3) %K ${k.toFixed(0)} / %D ${d.toFixed(0)}${trig ? ` with a ${trig > 0 ? "bullish" : "bearish"} %K/%D cross in the ${trig > 0 ? "oversold" : "overbought"} zone` : ""}${trendStrength > 0.5 ? " — faded because the market is trending" : ""}`);
    }
  }
  {
    const n = horizon === "position" ? 20 : horizon === "intraday" ? 12 : 10;
    const r = lastOf(I.roc(close, n));
    if (isNum(r)) {
      const lret = Math.log(1 + r / 100);
      const z = lret / (rv20 * Math.sqrt(n));
      const score = Math.tanh(z / 1.5);
      const conf = (0.25 + 0.35 * sat(Math.abs(z) / 2.5)) * (0.6 + 0.4 * trendCtx);
      add("tech.momentum.roc", score, conf, horizon, { rocPct: r, z, bars: n },
        `${n}-bar rate of change ${r >= 0 ? "+" : ""}${r.toFixed(2)}% (${z.toFixed(1)}σ vs recent volatility)`);
    }
  }
  {
    // Time-series momentum (Moskowitz–Ooi–Pedersen): return from t−L to t−S, skipping the most
    // recent S bars (short-term reversal). Canonical 12-1 on daily bars = 252/21. Scaled to the bar
    // size and capped by available history; blends up to three lookbacks for robustness.
    const perDay = isDailyPlus ? 1 : barsPerDay;
    const specs = [[252, 21], [126, 10], [63, 5]].map(([L, S]) => [Math.round(L * perDay), Math.max(1, Math.round(S * perDay))]);
    const used = [];
    for (let [L, S] of specs) {
      if (L > N - 2) { L = N - 2; S = Math.max(1, Math.round(L / 12)); }
      if (L - S < 20 || used.some((u) => u.L === L)) continue;
      const a = close[N - 1 - L], b = close[N - 1 - S];
      const ret = Math.log(b / a);
      const z = ret / (rv20 * Math.sqrt(L - S));
      used.push({ L, S, ret, z });
    }
    if (used.length) {
      const zAvg = used.reduce((s, u) => s + u.z, 0) / used.length;
      const agree = Math.abs(used.reduce((s, u) => s + Math.sign(u.ret), 0)) / used.length;
      const score = Math.tanh(zAvg / 1.2);
      const conf = (0.25 + 0.3 * sat(Math.abs(zAvg) / 2) + 0.15 * agree) * (horizon === "intraday" ? 0.7 : 1);
      const main = used[0];
      add("tech.momentum.tsmom", score, conf, horizon,
        { lookback: main.L, skip: main.S, ret: main.ret, zAvg, lookbacks: used.length },
        `Time-series momentum ${main.L}-${main.S} bars ${main.ret >= 0 ? "+" : ""}${pct(Math.exp(main.ret) - 1)}; ${used.length} lookback${used.length > 1 ? "s" : ""} avg ${zAvg.toFixed(2)}σ, ${agree === 1 ? "all agree" : "mixed"}`);
    }
  }

  // =============================================================================================
  // MEAN REVERSION (confidence × mrCtx: faded in strong trends)
  // =============================================================================================
  const bb = I.bollinger(close, 20, 2);
  const pB = lastOf(bb.pctB);
  if (isNum(pB)) {
    const u = 2 * (pB - 0.5);                    // −1 at lower band, +1 at upper band
    const score = -Math.tanh(u ** 3);
    const conf = (0.15 + 0.5 * sat(Math.abs(u))) * mrCtx;
    const where = pB > 1 ? "above the upper band" : pB < 0 ? "below the lower band" : pB > 0.8 ? "near the upper band" : pB < 0.2 ? "near the lower band" : "mid-band";
    add("tech.meanrev.bollinger", score, conf, horizon, { pctB: pB, upper: lastOf(bb.upper), lower: lastOf(bb.lower) },
      `Bollinger %B ${pB.toFixed(2)} (${where})${trendStrength > 0.5 ? `, but trend is strong (${ctxTxt}) so reversion odds are poor` : ""}`);
  }
  {
    const z = lastOf(I.zscore(close, 20));
    if (isNum(z)) {
      const score = -Math.tanh((z / 2) ** 3);
      const conf = (0.15 + 0.5 * sat(Math.abs(z) / 2.5)) * mrCtx;
      add("tech.meanrev.zscore", score, conf, horizon, { z },
        `Price ${Math.abs(z).toFixed(2)}σ ${z >= 0 ? "above" : "below"} its 20-bar mean${Math.abs(z) > 2 ? " — stretched" : ""}${trendStrength > 0.5 ? " (trend-faded)" : ""}`);
    }
  }
  {
    const w = lastOf(I.williamsR(candles, 14));
    if (isNum(w)) {
      const u = (w + 50) / 50;                  // −1 at −100 (oversold), +1 at 0 (overbought)
      const score = -Math.tanh((1.25 * u) ** 3);
      const conf = (0.15 + 0.4 * sat(Math.abs(u))) * mrCtx;
      add("tech.meanrev.williams_r", score, conf, horizon, { williamsR: w },
        `Williams %R ${w.toFixed(0)} (${w > -20 ? "overbought" : w < -80 ? "oversold" : "mid-range"})`);
    }
  }

  // =============================================================================================
  // VOLUME
  // =============================================================================================
  const volSma20 = I.sma(vol, 20);
  const avgVolPrev = safe(at(volSma20, 2), 0);
  if (hasVolume) {
    {
      const o = I.obv(candles);
      const n = 20;
      const ro = olsTail(o, n), rp = olsTail(close.map((v) => Math.log(v)), n);
      const avgV = safe(lastOf(volSma20), 0);
      if (ro && rp && avgV > 0) {
        const obvZ = (ro.slope * n) / (avgV * Math.sqrt(n));   // net signed volume vs typical volume
        const pz = (rp.slope * n) / (rv20 * Math.sqrt(n));
        const div = Math.sign(obvZ) !== Math.sign(pz) && Math.abs(obvZ) > 0.5 && Math.abs(pz) > 0.5;
        const score = div ? Math.tanh(obvZ / 2) * 0.8 : Math.tanh(obvZ / 2);
        const conf = 0.2 + 0.3 * sat(Math.abs(obvZ) / 3) + (div ? 0.1 : 0);
        add("tech.volume.obv", score, conf, horizon, { obvSlopeZ: obvZ, priceSlopeZ: pz, divergence: div },
          div ? `OBV ${obvZ > 0 ? "rising" : "falling"} (${obvZ.toFixed(1)}) while price ${pz > 0 ? "rises" : "falls"} — volume ${obvZ > 0 ? "accumulation" : "distribution"} divergence`
            : `OBV trend ${obvZ.toFixed(1)} over 20 bars ${Math.sign(obvZ) === Math.sign(pz) ? "confirms" : "mildly diverges from"} the price move`);
      }
    }
    {
      const m = lastOf(I.mfi(candles, 14));
      if (isNum(m)) {
        const score = -Math.tanh(((m - 50) / 25) ** 3);
        const conf = (0.15 + 0.4 * sat(Math.abs(m - 50) / 35)) * mrCtx;
        add("tech.volume.mfi", score, conf, horizon, { mfi: m },
          `Money Flow Index ${m.toFixed(0)} (${m > 80 ? "overbought" : m < 20 ? "oversold" : "neutral"})`);
      }
    }
    {
      // Volume-confirmed breakout: a close through the prior 20-bar high/low within the last 3 bars
      // on ≥1.5× average volume, and price still beyond the level.
      const dc = I.donchian(candles, 20);
      let found = null;
      for (let k = 1; k <= 3 && !found; k++) {
        const i = N - k;
        const up = dc.upper[i - 1], dn = dc.lower[i - 1], av = volSma20[i - 1];
        if (!isNum(up) || !isNum(dn) || !(av > 0)) continue;
        const vr = vol[i] / av;
        if (close[i] > up && c0 > up) found = { dir: 1, level: up, vr, ago: k - 1 };
        else if (close[i] < dn && c0 < dn) found = { dir: -1, level: dn, vr, ago: k - 1 };
      }
      if (found) {
        const volOk = found.vr >= 1.5;
        const beyond = Math.abs(c0 - found.level) / atrV;
        const score = found.dir * (volOk ? 0.45 + 0.35 * Math.tanh((found.vr - 1.5) / 1.5) : 0.2) * (0.8 + 0.2 * Math.tanh(beyond));
        const conf = (volOk ? 0.45 + 0.2 * sat((found.vr - 1.5) / 2) : 0.2) * (0.7 + 0.3 * trendCtx);
        add("tech.volume.breakout", score, conf, horizon, { level: found.level, volRatio: found.vr, barsAgo: found.ago, beyondAtr: beyond },
          `${found.dir > 0 ? "Break above" : "Break below"} the 20-bar ${found.dir > 0 ? "high" : "low"} ${px(found.level)} ${found.ago ? `${found.ago} bar${found.ago > 1 ? "s" : ""} ago` : "this bar"} on ${found.vr.toFixed(1)}× average volume${volOk ? " — volume-confirmed" : " — unconfirmed by volume"}`);
      } else {
        add("tech.volume.breakout", 0, 0, horizon, { volRatio: avgVolPrev > 0 ? vol[N - 1] / avgVolPrev : null },
          "No 20-bar range breakout in the last 3 bars");
      }
    }
    {
      // Anchored VWAP: current session for intraday bars (UTC day), last 20 bars for daily+.
      let start = N - 20;
      if (!isDailyPlus) {
        const dayStart = Math.floor(candles[N - 1].t / 86400000) * 86400000;
        start = N - 1;
        while (start > 0 && candles[start - 1].t >= dayStart) start--;
        if (N - start < 4) start = Math.max(0, N - Math.round(barsPerDay)); // too early in session: rolling 24h
      }
      const vw = lastOf(I.vwap(candles.slice(Math.max(0, start))));
      if (isNum(vw)) {
        const d = (c0 - vw) / atrV;
        const score = Math.tanh(d / 1.5) * 0.7;
        const conf = 0.2 + 0.2 * sat(Math.abs(d) / 2) + (isDailyPlus ? 0 : 0.1);
        add("tech.volume.vwap", score, conf, horizon, { vwap: vw, distAtr: d },
          `Price ${Math.abs(d).toFixed(2)} ATR ${d >= 0 ? "above" : "below"} the ${isDailyPlus ? "20-bar anchored" : "session"} VWAP ${px(vw)}`);
      }
    }
  }

  // =============================================================================================
  // VOLATILITY
  // =============================================================================================
  {
    const kc = I.keltner(candles, 20, 1.5);
    const on = (i) => isNum(bb.upper[i]) && isNum(kc.upper[i]) && bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i];
    const nowOn = on(N - 1);
    let firedAgo = -1, onBars = 0;
    for (let k = 1; k <= 3; k++) if (!on(N - k) && on(N - k - 1)) { firedAgo = k - 1; break; }
    for (let i = N - 1 - (nowOn ? 0 : Math.max(firedAgo, 0) + 1); i >= 0 && on(i); i--) onBars++;
    const bwRank = lastOf(I.percentileRank(bb.bandwidth, Math.min(120, N - 20)));
    // Squeeze momentum direction: close vs the mid of Donchian/SMA (TTM-style).
    const mid20 = lastOf(bb.mid), dcm = lastOf(I.donchian(candles, 20).mid);
    const momDir = isNum(mid20) && isNum(dcm) ? Math.tanh((c0 - (mid20 + dcm) / 2) / atrV) : 0;
    let score = 0, conf = 0, txt;
    if (firedAgo >= 0) {
      score = Math.sign(momDir) * (0.35 + 0.35 * Math.abs(momDir)) * (0.7 + 0.3 * sat(onBars / 10));
      conf = 0.35 + 0.2 * sat(onBars / 12);
      txt = `Volatility squeeze (BB inside Keltner for ${onBars} bars) fired ${firedAgo ? `${firedAgo} bar${firedAgo > 1 ? "s" : ""} ago` : "this bar"} with ${momDir >= 0 ? "upside" : "downside"} momentum`;
    } else if (nowOn) {
      score = 0.25 * momDir;
      conf = 0.15 + 0.1 * sat(onBars / 12);
      txt = `Volatility squeeze on for ${onBars} bars (bandwidth ${isNum(bwRank) ? `${ord(bwRank * 100)} pct` : "compressed"}) — coiling, lean ${momDir >= 0 ? "up" : "down"}`;
    } else {
      txt = `No squeeze; Bollinger bandwidth at ${isNum(bwRank) ? ord(bwRank * 100) : "n/a"} percentile`;
    }
    add("tech.volatility.squeeze", score, conf, horizon, { squeezeOn: nowOn, firedAgo: firedAgo >= 0 ? firedAgo : null, onBars, bandwidthPctile: bwRank },
      txt);
  }
  {
    const a5 = lastOf(I.atr(candles, 5));
    if (isNum(a5) && atrV > 0) {
      const ratio = a5 / atrV;
      const r5 = Math.log(c0 / close[N - 6]);
      const dirZ = r5 / (rv20 * Math.sqrt(5));
      // Expansion in the direction of the move tends to continue (breakout days); expansion with no
      // net progress is churn. Contraction has no directional content.
      const exp = sat((ratio - 1.1) / 0.6);
      const score = exp * Math.tanh(dirZ / 1.5) * 0.6;
      const conf = exp * (0.2 + 0.2 * sat(Math.abs(dirZ) / 2));
      add("tech.volatility.expansion", score, conf, horizon, { atr5: a5, atr14: atrV, ratio, ret5: r5 },
        `ATR(5)/ATR(14) = ${ratio.toFixed(2)} (${ratio > 1.3 ? "range expansion" : ratio < 0.8 ? "range contraction" : "normal range"}), 5-bar move ${pct(Math.exp(r5) - 1)}`);
    }
  }

  // =============================================================================================
  // STRUCTURE
  // =============================================================================================
  {
    const d20 = I.donchian(candles, 20), d55 = I.donchian(candles, Math.min(55, N - 2));
    const u20 = at(d20.upper, 2), l20 = at(d20.lower, 2), u55 = at(d55.upper, 2), l55 = at(d55.lower, 2);
    if ([u20, l20, u55, l55].every(isNum) && u20 > l20) {
      const pos = (c0 - l20) / (u20 - l20);               // position in the prior 20-bar channel
      const b55 = c0 > u55 ? 1 : c0 < l55 ? -1 : 0, b20 = c0 > u20 ? 1 : c0 < l20 ? -1 : 0;
      const score = clamp(0.45 * Math.tanh(3 * (pos - 0.5)) + 0.3 * b20 + 0.25 * b55, -1, 1) * 0.9;
      const conf = (0.25 + 0.15 * Math.abs(b20) + 0.15 * Math.abs(b55)) * trendCtx;
      const txt = b55 ? `new ${Math.min(55, N - 2)}-bar ${b55 > 0 ? "high" : "low"} (turtle breakout)` : b20 ? `new 20-bar ${b20 > 0 ? "high" : "low"}` : `at ${(pos * 100).toFixed(0)}% of the 20-bar range`;
      add("tech.structure.donchian", score, conf, horizon, { upper20: u20, lower20: l20, upper55: u55, lower55: l55, pos20: pos },
        `Donchian: price ${px(c0)} ${txt} (${px(l20)}–${px(u20)})`);
    }
  }
  {
    // One year of bars: 252 sessions for equities, 365 days for 24/7 crypto (AUDIT 2026-09: crypto
    // used 252 daily bars — 36 weeks — while the reason text called it the 52-week high).
    const yearDays = opts.assetClass === "crypto" ? 365 : 252;
    const L = Math.min(N, Math.round((isDailyPlus ? yearDays : yearDays * barsPerDay)));
    let hi = -Infinity, lo = Infinity;
    for (let i = N - L; i < N; i++) { if (candles[i].h > hi) hi = candles[i].h; if (candles[i].l < lo) lo = candles[i].l; }
    if (hi > lo) {
      const pos = (c0 - lo) / (hi - lo);
      const fromHi = c0 / hi - 1, fromLo = c0 / lo - 1;
      // 52-week-high effect (George & Hwang): proximity to the high predicts continuation;
      // deep drawdowns are mildly negative (anchoring + overhead supply).
      const score = Math.tanh(2.5 * (pos - 0.5)) * 0.6;
      const conf = (0.2 + 0.2 * sat(Math.abs(pos - 0.5) * 2)) * (L >= 200 ? 1 : 0.6);
      const lbl = isDailyPlus && L >= yearDays - 2 ? "52-week" : `${L}-bar`;
      add("tech.structure.extremes", score, conf, horizon, { high: hi, low: lo, pos, fromHigh: fromHi, fromLow: fromLo, bars: L },
        `Price ${pct(-fromHi)} below the ${lbl} high ${px(hi)} and ${pct(fromLo)} above the low ${px(lo)} (${(pos * 100).toFixed(0)}% of range)`);
    }
  }
  const look = Math.min(N, 150);
  const base = N - look;
  const highs = candles.slice(base).map((c) => c.h), lows = candles.slice(base).map((c) => c.l);
  const pvH = pivots(highs, 3, 3, "high").map((p) => ({ i: p.i + base, v: p.v }));
  const pvL = pivots(lows, 3, 3, "low").map((p) => ({ i: p.i + base, v: p.v }));
  {
    // Support/resistance from swing pivots, clustered within 0.5 ATR; each level scored by touches.
    const levels = [];
    for (const p of [...pvH, ...pvL]) {
      const lv = levels.find((l) => Math.abs(l.v - p.v) <= 0.5 * atrV);
      if (lv) { lv.v = (lv.v * lv.n + p.v) / (lv.n + 1); lv.n++; lv.last = Math.max(lv.last, p.i); }
      else levels.push({ v: p.v, n: 1, last: p.i });
    }
    const sup = levels.filter((l) => l.v < c0).sort((a, b) => b.v - a.v)[0];
    const res = levels.filter((l) => l.v > c0).sort((a, b) => a.v - b.v)[0];
    if (sup || res) {
      const dS = sup ? (c0 - sup.v) / atrV : 6, dR = res ? (res.v - c0) / atrV : 6;
      // Asymmetry of room: near support with room above → bullish; pinned under resistance → bearish.
      const room = (dR - dS) / (dR + dS + 1e-9);
      const touches = Math.max(sup && dS < 1.5 ? sup.n : 0, res && dR < 1.5 ? res.n : 0);
      const near = Math.min(dS, dR);
      const score = Math.tanh(1.2 * room) * 0.6 * (near < 2 ? 1 : 0.5);
      const conf = (0.15 + 0.1 * Math.min(touches, 4) + (near < 1 ? 0.1 : 0)) * (0.5 + 0.5 * mrCtx);
      add("tech.structure.support_resistance", score, conf, horizon,
        { support: sup ? sup.v : null, supportTouches: sup ? sup.n : 0, resistance: res ? res.v : null, resistanceTouches: res ? res.n : 0, distSupAtr: sup ? dS : null, distResAtr: res ? dR : null },
        `Support ${sup ? `${px(sup.v)} (${sup.n} touch${sup.n > 1 ? "es" : ""}, ${dS.toFixed(1)} ATR below)` : "none nearby"}, resistance ${res ? `${px(res.v)} (${res.n} touch${res.n > 1 ? "es" : ""}, ${dR.toFixed(1)} ATR above)` : "none — price at highs"}`);
    }
  }
  {
    // RSI/price divergence on the last two swing pivots (pivot must be recent: ≤ 12 bars old incl.
    // the 3-bar confirmation) — regular bullish: lower low in price, higher low in RSI.
    let sig = null;
    const check = (pv, kind) => {
      if (pv.length < 2) return null;
      const b = pv[pv.length - 1], a = pv[pv.length - 2];
      if (N - 1 - b.i > 12 || b.i - a.i < 5 || b.i - a.i > 60) return null;
      const ra = rsiA[a.i], rb = rsiA[b.i];
      if (!isNum(ra) || !isNum(rb)) return null;
      if (kind === "low" && b.v < a.v && rb > ra + 2) return { dir: 1, a, b, ra, rb };
      if (kind === "high" && b.v > a.v && rb < ra - 2) return { dir: -1, a, b, ra, rb };
      return null;
    };
    const bull = check(pvL, "low"), bear = check(pvH, "high");
    sig = bull && bear ? (bull.b.i >= bear.b.i ? bull : bear) : bull || bear;
    if (sig) {
      const rd = Math.abs(sig.rb - sig.ra);
      const extremeStart = sig.dir > 0 ? sig.ra < 35 : sig.ra > 65;
      const score = sig.dir * (0.35 + 0.4 * Math.tanh(rd / 10));
      const conf = (0.3 + 0.15 * sat(rd / 15) + (extremeStart ? 0.15 : 0)) * (1 - 0.5 * trendStrength);
      add("tech.divergence.rsi", score, conf, horizon,
        { priceA: sig.a.v, priceB: sig.b.v, rsiA: sig.ra, rsiB: sig.rb, barsApart: sig.b.i - sig.a.i, barsAgo: N - 1 - sig.b.i },
        `${sig.dir > 0 ? "Bullish" : "Bearish"} RSI divergence: price ${sig.dir > 0 ? "lower low" : "higher high"} ${px(sig.a.v)}→${px(sig.b.v)} while RSI ${sig.dir > 0 ? "rose" : "fell"} ${sig.ra.toFixed(0)}→${sig.rb.toFixed(0)} (${sig.b.i - sig.a.i} bars apart)`);
    } else {
      add("tech.divergence.rsi", 0, 0, horizon, {}, "No fresh RSI/price divergence on recent swing pivots");
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Multi-timeframe
// ---------------------------------------------------------------------------------------------

function tfSeconds(tf) {
  const m = /^(\d+)\s*(m|h|d|w)$/i.exec(String(tf).trim());
  if (!m) return isNum(Number(tf)) ? Number(tf) : null;
  const n = Number(m[1]);
  return n * { m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
}

const TREND_IDS = new Set(["trend.ema_stack", "trend.supertrend", "trend.adx_dmi", "trend.ichimoku",
  "trend.linreg", "trend.kalman", "momentum.macd", "momentum.tsmom", "momentum.roc"]);

// Horizon a timeframe's own signals speak to. AUDIT (2026-09): every per-tf signal used to carry the
// REQUESTED horizon, so 15m/1h indicators counted as full-strength evidence for a 5-day (swing) or
// 20-day (position) call and supplied 30–60% of the live technical log-odds (BTC/ETH/SOL/AAPL/MSFT,
// Sep 2026) — evidence no backtest ever validated. Sub-daily bars are now tagged "intraday" when the
// requested horizon is daily-based, so the ensemble's horizon-mismatch discount (×0.6) applies;
// the requested horizon is kept for daily+ bars, and for every tf when the request is intraday.
function horizonForTf(tf, requested) {
  const sec = tfSeconds(tf);
  if (!requested || requested === "any" || requested === "intraday" || !isNum(sec)) return requested || "any";
  return sec < 86400 ? "intraday" : requested;
}

/**
 * multiTimeframe({ "15m": candles, "1h": candles, "1d": candles }, opts) -> Signal[]
 * Runs analyze() per timeframe, re-ids each signal as tech.<tf>.<sub>.<name>, and adds one
 * tech.mtf.alignment signal: the confidence-weighted directional trend view per timeframe, combined
 * with higher timeframes weighted more (weight ∝ log(tfSeconds)); confidence reflects agreement.
 * Per-tf signals carry horizonForTf(tf, opts.horizon) (sub-daily bars → "intraday" for swing/position).
 */
function multiTimeframe(candlesByTf, opts = {}) {
  if (!candlesByTf || typeof candlesByTf !== "object") return [];
  const horizon = opts.horizon || "any";
  const out = [], per = [];
  const tfs = Object.keys(candlesByTf).sort((a, b) => safe(tfSeconds(a), 0) - safe(tfSeconds(b), 0));
  for (const tf of tfs) {
    const sigs = analyze(candlesByTf[tf], opts);
    const tfH = horizonForTf(tf, horizon);          // only the tag changes; lookbacks follow opts.horizon
    if (!sigs.length) continue;
    let num = 0, den = 0;
    for (const s of sigs) {
      const sub = s.id.slice("tech.".length);
      out.push({ ...s, id: `tech.${tf}.${sub}`, horizon: s.horizon === horizon ? tfH : s.horizon });
      if (TREND_IDS.has(sub)) { num += s.score * s.confidence; den += s.confidence; }
    }
    const view = den > 0 ? num / den : 0;
    const sec = safe(tfSeconds(tf), 3600);
    per.push({ tf, view, w: Math.log(Math.max(sec, 60) / 30), strength: den / Math.max(1, TREND_IDS.size) });
  }
  if (per.length) {
    const W = per.reduce((s, p) => s + p.w, 0);
    const avg = per.reduce((s, p) => s + p.w * p.view, 0) / W;
    const signs = per.map((p) => (Math.abs(p.view) < 0.15 ? 0 : Math.sign(p.view)));
    const same = per.length > 1 ? Math.abs(signs.reduce((a, b) => a + b, 0)) / per.length : 0.5;
    const allAgree = per.length > 1 && signs.every((s) => s !== 0 && s === signs[0]);
    const score = Math.tanh(1.8 * avg) * (0.5 + 0.5 * same);
    // Weakest-link: alignment is only as convincing as the least decisive timeframe.
    const minAbs = Math.min(...per.map((p) => Math.abs(p.view)));
    const conf = clamp((0.2 + 0.5 * same + (allAgree ? 0.15 : 0)) * Math.min(1, per.length / 3 + 0.34) * (0.4 + 0.6 * sat(minAbs / 0.35)), 0, 1);
    const parts = per.map((p) => `${p.tf} ${p.view >= 0.15 ? "up" : p.view <= -0.15 ? "down" : "flat"} (${p.view.toFixed(2)})`).join(", ");
    out.push(mk("tech.mtf.alignment", score, conf, horizon,
      Object.fromEntries(per.map((p) => [p.tf, p.view])),
      `${allAgree ? "All timeframes aligned" : same >= 0.6 ? "Timeframes mostly aligned" : "Timeframes conflict"}: ${parts}`));
  }
  return out;
}

module.exports = { analyze, multiTimeframe, pivots, tfSeconds, horizonForTf };
