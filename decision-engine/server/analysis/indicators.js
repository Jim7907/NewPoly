// Pure indicator math — arrays in, arrays out. No I/O, no dependencies.
//
// Conventions (binding, see docs/CONTRACT.md §2.1):
//  * Every array output is aligned to the input length; warm-up positions are `null`.
//  * No NaN / Infinity ever leaks out: invalid inputs (null, NaN, non-positive prices where a log
//    is needed) produce `null` at that position, and a window containing an invalid value is
//    `null` too. Series functions tolerate leading nulls (e.g. an EMA of a MACD line).
//  * `candles` are `{ t, o, h, l, c, v }` in ascending time order.
//  * Smoothing follows the textbook definitions: EMA is seeded with the SMA of its first n
//    values; RSI / ATR / ADX use Wilder's smoothing (alpha = 1/n) seeded with simple averages.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fin = (v) => (isNum(v) ? v : null);
const nulls = (n) => new Array(n).fill(null);
const col = (candles, k) => candles.map((c) => (c && isNum(c[k]) ? c[k] : null));
const closes = (candles) => col(candles, "c");

// ---------------------------------------------------------------------------------------------
// Moving averages / dispersion
// ---------------------------------------------------------------------------------------------

// Simple moving average over the last n values; null while the window holds any invalid value.
function sma(x, n) {
  const N = x.length, out = nulls(N);
  if (!(n >= 1)) return out;
  let sum = 0, bad = 0;
  for (let i = 0; i < N; i++) {
    if (isNum(x[i])) sum += x[i]; else bad++;
    if (i >= n) { const o = x[i - n]; if (isNum(o)) sum -= o; else bad--; }
    if (i >= n - 1 && bad === 0) out[i] = fin(sum / n);
  }
  // Re-sum periodically would be more exact; the drift of a running sum over a few thousand bars
  // is ~1e-12 relative and irrelevant here.
  return out;
}

// Exponential moving average, alpha = 2/(n+1), seeded with the SMA of the first n valid values.
// If the series has a gap (invalid value) the EMA restarts (re-seeds) after it.
function emaAlpha(x, n, alpha) {
  const N = x.length, out = nulls(N);
  if (!(n >= 1)) return out;
  let prev = null, seedSum = 0, seedCnt = 0;
  for (let i = 0; i < N; i++) {
    const v = x[i];
    if (!isNum(v)) { prev = null; seedSum = 0; seedCnt = 0; continue; }
    if (prev === null) {
      seedSum += v; seedCnt++;
      if (seedCnt === n) { prev = seedSum / n; out[i] = fin(prev); }
    } else {
      prev = prev + alpha * (v - prev);
      out[i] = fin(prev);
    }
  }
  return out;
}
const ema = (x, n) => emaAlpha(x, n, 2 / (n + 1));
// Wilder's smoothing (RMA): alpha = 1/n, seeded with SMA.
const rma = (x, n) => emaAlpha(x, n, 1 / n);

// Linearly weighted moving average (weights 1..n, newest heaviest).
function wma(x, n) {
  const N = x.length, out = nulls(N);
  if (!(n >= 1)) return out;
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < N; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) {
      const v = x[i - n + 1 + j];
      if (!isNum(v)) { ok = false; break; }
      s += v * (j + 1);
    }
    if (ok) out[i] = fin(s / denom);
  }
  return out;
}

// Rolling standard deviation. Population (divide by n) by default — the Bollinger convention;
// pass sample=true for the unbiased (n-1) estimator.
function stdev(x, n, sample = false) {
  const N = x.length, out = nulls(N);
  if (!(n >= 2)) return out;
  for (let i = n - 1; i < N; i++) {
    let s = 0, ok = true;
    for (let j = i - n + 1; j <= i; j++) { if (!isNum(x[j])) { ok = false; break; } s += x[j]; }
    if (!ok) continue;
    const m = s / n;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = x[j] - m; ss += d * d; }
    out[i] = fin(Math.sqrt(ss / (sample ? n - 1 : n)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------------------------

// Wilder's RSI. First value at index n (needs n price changes), seeded with simple averages of
// gains/losses, then avg = (avg*(n-1) + cur)/n.
function rsi(x, n = 14) {
  const N = x.length, out = nulls(N);
  let ag = 0, al = 0, cnt = 0, seeded = false;
  for (let i = 1; i < N; i++) {
    if (!isNum(x[i]) || !isNum(x[i - 1])) { ag = 0; al = 0; cnt = 0; seeded = false; continue; }
    const d = x[i] - x[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (!seeded) {
      ag += g; al += l; cnt++;
      if (cnt === n) { ag /= n; al /= n; seeded = true; } else continue;
    } else {
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
    }
    out[i] = al === 0 ? (ag === 0 ? 50 : 100) : fin(100 - 100 / (1 + ag / al));
  }
  return out;
}

function macd(x, fast = 12, slow = 26, signal = 9) {
  const ef = ema(x, fast), es = ema(x, slow);
  const line = x.map((_, i) => (ef[i] !== null && es[i] !== null ? fin(ef[i] - es[i]) : null));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v !== null && sig[i] !== null ? fin(v - sig[i]) : null));
  return { macd: line, signal: sig, hist };
}

function bollinger(x, n = 20, k = 2) {
  const mid = sma(x, n), sd = stdev(x, n);
  const N = x.length;
  const upper = nulls(N), lower = nulls(N), pctB = nulls(N), bandwidth = nulls(N);
  for (let i = 0; i < N; i++) {
    if (mid[i] === null || sd[i] === null) continue;
    upper[i] = mid[i] + k * sd[i];
    lower[i] = mid[i] - k * sd[i];
    const w = upper[i] - lower[i];
    pctB[i] = w > 0 ? fin((x[i] - lower[i]) / w) : 0.5;
    bandwidth[i] = mid[i] !== 0 ? fin(w / mid[i]) : null;
  }
  return { mid, upper, lower, pctB, bandwidth };
}

// True range: bar 0 uses h-l; afterwards max(h-l, |h-prevC|, |l-prevC|).
function trueRange(candles) {
  return candles.map((c, i) => {
    if (!c || !isNum(c.h) || !isNum(c.l)) return null;
    const hl = c.h - c.l;
    const p = i > 0 && candles[i - 1] ? candles[i - 1].c : null;
    if (!isNum(p)) return hl;
    return Math.max(hl, Math.abs(c.h - p), Math.abs(c.l - p));
  });
}

// Wilder ATR: first value at index n-1 = mean of the first n true ranges, then RMA.
const atr = (candles, n = 14) => rma(trueRange(candles), n);

// Wilder's ADX / DMI.
//  +DM/-DM and TR from bar 1; Wilder-smoothed (running-sum form, first sum over n bars → index n);
//  +DI/-DI = 100·sDM/sTR; DX = 100·|+DI − −DI|/(+DI + −DI); ADX = Wilder average of DX, first
//  value (simple mean of n DX values) at index 2n−1.
function adx(candles, n = 14) {
  const N = candles.length;
  const pdi = nulls(N), mdi = nulls(N), out = nulls(N);
  if (N < n + 1) return { adx: out, pdi, mdi };
  let sTR = 0, sP = 0, sM = 0, cnt = 0;
  let adxPrev = null, dxSum = 0, dxCnt = 0;
  for (let i = 1; i < N; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!c || !p || ![c.h, c.l, p.h, p.l, p.c].every(isNum)) {
      sTR = sP = sM = 0; cnt = 0; adxPrev = null; dxSum = 0; dxCnt = 0; continue;
    }
    const up = c.h - p.h, dn = p.l - c.l;
    const pDM = up > dn && up > 0 ? up : 0;
    const mDM = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    if (cnt < n) {
      sTR += tr; sP += pDM; sM += mDM; cnt++;
      if (cnt < n) continue;
    } else {
      sTR = sTR - sTR / n + tr;
      sP = sP - sP / n + pDM;
      sM = sM - sM / n + mDM;
    }
    const pd = sTR > 0 ? (100 * sP) / sTR : 0;
    const md = sTR > 0 ? (100 * sM) / sTR : 0;
    pdi[i] = fin(pd); mdi[i] = fin(md);
    const dx = pd + md > 0 ? (100 * Math.abs(pd - md)) / (pd + md) : 0;
    if (adxPrev === null) {
      dxSum += dx; dxCnt++;
      if (dxCnt === n) { adxPrev = dxSum / n; out[i] = fin(adxPrev); }
    } else {
      adxPrev = (adxPrev * (n - 1) + dx) / n;
      out[i] = fin(adxPrev);
    }
  }
  return { adx: out, pdi, mdi };
}

// Rolling highest high / lowest low over the last n bars (inclusive of the current bar).
function highestLowest(candles, n) {
  const N = candles.length, hh = nulls(N), ll = nulls(N);
  // Monotonic deques → O(N).
  const qh = [], ql = [];
  let qhHead = 0, qlHead = 0, lastBad = -1;
  for (let i = 0; i < N; i++) {
    const c = candles[i];
    if (!c || !isNum(c.h) || !isNum(c.l)) { lastBad = i; continue; }
    while (qh.length > qhHead && candles[qh[qh.length - 1]].h <= c.h) qh.pop();
    qh.push(i);
    while (ql.length > qlHead && candles[ql[ql.length - 1]].l >= c.l) ql.pop();
    ql.push(i);
    while (qh[qhHead] <= i - n) qhHead++;
    while (ql[qlHead] <= i - n) qlHead++;
    if (i >= n - 1 && lastBad <= i - n) {
      hh[i] = candles[qh[qhHead]].h;
      ll[i] = candles[ql[qlHead]].l;
    }
  }
  return { hh, ll };
}

// Stochastic oscillator: %K = 100·(c − LL)/(HH − LL) over k bars, %D = SMA(%K, d).
function stochastic(candles, k = 14, d = 3) {
  const { hh, ll } = highestLowest(candles, k);
  const K = candles.map((c, i) => {
    if (hh[i] === null || !isNum(c.c)) return null;
    const r = hh[i] - ll[i];
    return r > 0 ? fin((100 * (c.c - ll[i])) / r) : 50;
  });
  return { k: K, d: sma(K, d) };
}

// Commodity Channel Index: (TP − SMA(TP)) / (0.015 · meanDeviation).
function cci(candles, n = 20) {
  const tp = candles.map((c) => (c && [c.h, c.l, c.c].every(isNum) ? (c.h + c.l + c.c) / 3 : null));
  const m = sma(tp, n), N = candles.length, out = nulls(N);
  for (let i = n - 1; i < N; i++) {
    if (m[i] === null) continue;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n;
    out[i] = md > 0 ? fin((tp[i] - m[i]) / (0.015 * md)) : 0;
  }
  return out;
}

// Williams %R in [-100, 0]: −100·(HH − c)/(HH − LL).
function williamsR(candles, n = 14) {
  const { hh, ll } = highestLowest(candles, n);
  return candles.map((c, i) => {
    if (hh[i] === null || !isNum(c.c)) return null;
    const r = hh[i] - ll[i];
    return r > 0 ? fin((-100 * (hh[i] - c.c)) / r) : -50;
  });
}

// Rate of change in PERCENT: 100·(x[i]/x[i−n] − 1).
function roc(x, n) {
  return x.map((v, i) => (i >= n && isNum(v) && isNum(x[i - n]) && x[i - n] !== 0
    ? fin(100 * (v / x[i - n] - 1)) : null));
}

// On-balance volume (starts at 0 on bar 0).
function obv(candles) {
  const N = candles.length, out = nulls(N);
  if (!N) return out;
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < N; i++) {
    const c = candles[i], p = candles[i - 1];
    const v = c && isNum(c.v) ? c.v : 0;
    if (c && p && isNum(c.c) && isNum(p.c)) {
      if (c.c > p.c) acc += v; else if (c.c < p.c) acc -= v;
    }
    out[i] = fin(acc);
  }
  return out;
}

// Money Flow Index: volume-weighted RSI on typical price. First value at index n.
function mfi(candles, n = 14) {
  const N = candles.length, out = nulls(N);
  const tp = candles.map((c) => (c && [c.h, c.l, c.c].every(isNum) ? (c.h + c.l + c.c) / 3 : null));
  const pos = nulls(N), neg = nulls(N);
  for (let i = 1; i < N; i++) {
    if (tp[i] === null || tp[i - 1] === null) continue;
    const mf = tp[i] * (isNum(candles[i].v) ? candles[i].v : 0);
    pos[i] = tp[i] > tp[i - 1] ? mf : 0;
    neg[i] = tp[i] < tp[i - 1] ? mf : 0;
  }
  for (let i = n; i < N; i++) {
    let p = 0, m = 0, ok = true;
    for (let j = i - n + 1; j <= i; j++) { if (pos[j] === null) { ok = false; break; } p += pos[j]; m += neg[j]; }
    if (!ok) continue;
    out[i] = m === 0 ? (p === 0 ? 50 : 100) : fin(100 - 100 / (1 + p / m));
  }
  return out;
}

// Cumulative VWAP over the whole input (session-agnostic: slice the candles to anchor it).
// With zero cumulative volume it falls back to the running mean typical price.
function vwap(candles) {
  const N = candles.length, out = nulls(N);
  let pv = 0, vv = 0, tps = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    const c = candles[i];
    if (!c || ![c.h, c.l, c.c].every(isNum)) { out[i] = i > 0 ? out[i - 1] : null; continue; }
    const tp = (c.h + c.l + c.c) / 3, v = isNum(c.v) && c.v > 0 ? c.v : 0;
    pv += tp * v; vv += v; tps += tp; cnt++;
    out[i] = fin(vv > 0 ? pv / vv : tps / cnt);
  }
  return out;
}

// Donchian channel over the last n bars (inclusive). For a breakout test compare the close with
// the PREVIOUS bar's channel.
function donchian(candles, n = 20) {
  const { hh, ll } = highestLowest(candles, n);
  return { upper: hh, lower: ll, mid: hh.map((h, i) => (h !== null ? (h + ll[i]) / 2 : null)) };
}

// Keltner channel: EMA(close, n) ± mult·ATR(n).
function keltner(candles, n = 20, mult = 2) {
  const mid = ema(closes(candles), n), a = atr(candles, n);
  return {
    mid,
    upper: mid.map((m, i) => (m !== null && a[i] !== null ? m + mult * a[i] : null)),
    lower: mid.map((m, i) => (m !== null && a[i] !== null ? m - mult * a[i] : null)),
  };
}

// Ichimoku. tenkan/kijun are the 9/26-bar midpoints. `spanA`/`spanB` are the cloud AS IT STANDS
// AT BAR i (i.e. the senkou values computed `displacement` bars earlier) so price[i] can be compared
// with spanA[i]/spanB[i] directly. `spanALead`/`spanBLead` are the un-shifted values computed at bar
// i, which form the cloud `displacement` bars into the future (the "future cloud" colour).
function ichimoku(candles, { tenkan = 9, kijun = 26, senkou = 52, displacement = 26 } = {}) {
  const mid = (n) => {
    const { hh, ll } = highestLowest(candles, n);
    return hh.map((h, i) => (h !== null ? (h + ll[i]) / 2 : null));
  };
  const tk = mid(tenkan), kj = mid(kijun), sb = mid(senkou);
  const spanALead = tk.map((t, i) => (t !== null && kj[i] !== null ? (t + kj[i]) / 2 : null));
  const spanBLead = sb;
  const shift = (a) => a.map((_, i) => (i >= displacement ? a[i - displacement] : null));
  return { tenkan: tk, kijun: kj, spanA: shift(spanALead), spanB: shift(spanBLead), spanALead, spanBLead };
}

// Supertrend on hl2 ± mult·ATR (Wilder). dir = +1 (line below price, uptrend) / −1.
function supertrend(candles, n = 10, mult = 3) {
  const N = candles.length, line = nulls(N), dir = nulls(N);
  const a = atr(candles, n);
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < N; i++) {
    const c = candles[i];
    if (a[i] === null || !c || ![c.h, c.l, c.c].every(isNum)) continue;
    const hl2 = (c.h + c.l) / 2;
    const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    const pc = i > 0 && candles[i - 1] && isNum(candles[i - 1].c) ? candles[i - 1].c : c.c;
    if (fu === null) {
      fu = bu; fl = bl; d = c.c >= hl2 ? 1 : -1;
    } else {
      const nfu = bu < fu || pc > fu ? bu : fu;
      const nfl = bl > fl || pc < fl ? bl : fl;
      if (d === 1 && c.c < nfl) d = -1;
      else if (d === -1 && c.c > nfu) d = 1;
      fu = nfu; fl = nfl;
    }
    line[i] = fin(d === 1 ? fl : fu);
    dir[i] = d;
  }
  return { line, dir };
}

// ---------------------------------------------------------------------------------------------
// Returns / statistics
// ---------------------------------------------------------------------------------------------

// Log returns aligned to prices: r[0] = null, r[i] = ln(x[i]/x[i−1]).
function logReturns(x) {
  return x.map((v, i) => (i > 0 && isNum(v) && isNum(x[i - 1]) && v > 0 && x[i - 1] > 0
    ? fin(Math.log(v / x[i - 1])) : null));
}

// Rolling per-bar realized volatility: sample stdev of the last n log returns of PRICES x.
// First value at index n.
const realizedVol = (x, n) => stdev(logReturns(x), n, true);

// log Γ(z) — Lanczos approximation (g=7, n=9), |rel err| < 1e-13 for z > 0.5.
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
  z -= 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Anis–Lloyd–Peters expected R/S of an i.i.d. series of length m (small-sample bias correction).
function expectedRS(m) {
  let s = 0;
  for (let i = 1; i < m; i++) s += Math.sqrt((m - i) / i);
  const g = m <= 340
    ? Math.exp(lgamma((m - 1) / 2) - lgamma(m / 2)) / Math.sqrt(Math.PI)
    : 1 / Math.sqrt((m * Math.PI) / 2);
  return ((m - 0.5) / m) * g * s;
}

// Hurst exponent of PRICE series x via rescaled-range (R/S) on its log returns, with the
// Anis–Lloyd–Peters correction so an i.i.d. random walk scores ≈ 0.5:
//   H = 0.5 + slope(log R/S vs log m) − slope(log E[R/S] vs log m).
// H > 0.5 → persistent/trending, H < 0.5 → mean-reverting. Needs ≥ 64 prices, else null.
function hurst(x) {
  const r = logReturns(x).filter(isNum);
  if (r.length < 63) return null;
  const N = r.length;
  const sizes = [];
  for (let m = 8; m <= Math.floor(N / 2); m = Math.floor(m * 1.5)) sizes.push(m);
  if (sizes.length < 3) return null;
  const lx = [], ly = [], le = [];
  for (const m of sizes) {
    const chunks = Math.floor(N / m);
    let acc = 0, used = 0;
    for (let c = 0; c < chunks; c++) {
      const off = N - (c + 1) * m;          // align chunks to the most recent data
      let mean = 0;
      for (let j = 0; j < m; j++) mean += r[off + j];
      mean /= m;
      let cum = 0, mx = -Infinity, mn = Infinity, ss = 0;
      for (let j = 0; j < m; j++) {
        const d = r[off + j] - mean;
        cum += d; ss += d * d;
        if (cum > mx) mx = cum;
        if (cum < mn) mn = cum;
      }
      const sd = Math.sqrt(ss / m);
      if (sd > 0) { acc += (mx - mn) / sd; used++; }
    }
    if (!used) continue;
    lx.push(Math.log(m)); ly.push(Math.log(acc / used)); le.push(Math.log(expectedRS(m)));
  }
  if (lx.length < 3) return null;
  const slope = (xs, ys) => {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    return sxx > 0 ? sxy / sxx : 0;
  };
  const H = 0.5 + slope(lx, ly) - slope(lx, le);
  return isNum(H) ? Math.min(1, Math.max(0, H)) : null;
}

// Kaufman efficiency ratio: |x[i] − x[i−n]| / Σ|Δx| over the window. 0 = pure noise, 1 = straight line.
function efficiencyRatio(x, n) {
  const N = x.length, out = nulls(N);
  for (let i = n; i < N; i++) {
    let path = 0, ok = isNum(x[i]) && isNum(x[i - n]);
    for (let j = i - n + 1; ok && j <= i; j++) {
      if (!isNum(x[j]) || !isNum(x[j - 1])) { ok = false; break; }
      path += Math.abs(x[j] - x[j - 1]);
    }
    if (!ok) continue;
    out[i] = path > 0 ? fin(Math.abs(x[i] - x[i - n]) / path) : 0;
  }
  return out;
}

// OLS slope of ln(price) over the last n bars (log-return per bar). First value at index n−1.
function linregSlope(x, n) {
  const N = x.length, out = nulls(N);
  if (!(n >= 2)) return out;
  const xm = (n - 1) / 2;
  let sxx = 0;
  for (let j = 0; j < n; j++) sxx += (j - xm) ** 2;
  for (let i = n - 1; i < N; i++) {
    let sy = 0, sxy = 0, ok = true;
    for (let j = 0; j < n; j++) {
      const v = x[i - n + 1 + j];
      if (!isNum(v) || v <= 0) { ok = false; break; }
      const y = Math.log(v);
      sy += y; sxy += (j - xm) * y;
    }
    if (ok) out[i] = fin(sxy / sxx); // Σ(j−x̄)(y−ȳ) = Σ(j−x̄)y since Σ(j−x̄)=0
  }
  return out;
}

// Rolling z-score of x vs its n-bar mean / population stdev (0 when the window is flat).
function zscore(x, n) {
  const m = sma(x, n), sd = stdev(x, n);
  return x.map((v, i) => (m[i] === null || sd[i] === null || !isNum(v) ? null
    : sd[i] > 0 ? fin((v - m[i]) / sd[i]) : 0));
}

// Percentile rank of x[i] among the n values of its window (inclusive), in [0, 1]:
// (count below + ½·ties excluding itself) / (n − 1). First value at index n−1.
function percentileRank(x, n) {
  const N = x.length, out = nulls(N);
  if (!(n >= 2)) return out;
  for (let i = n - 1; i < N; i++) {
    const v = x[i];
    if (!isNum(v)) continue;
    let below = 0, eq = 0, ok = true;
    for (let j = i - n + 1; j < i; j++) {
      const w = x[j];
      if (!isNum(w)) { ok = false; break; }
      if (w < v) below++; else if (w === v) eq++;
    }
    if (ok) out[i] = fin((below + 0.5 * eq) / (n - 1));
  }
  return out;
}

// Local-linear-trend Kalman filter on log price.
//   state s = [level, slope];  s_t = F s_{t−1} + w,  F = [[1,1],[0,1]],  Q = diag(qLevel, q)
//   obs   y_t = ln(x_t) = level + v,  R = r
// Defaults scale to the data: r = var(1-bar log returns), q = r·1e-3, qLevel = r·0.1.
// Returns aligned arrays: `level` (in PRICE units, exp of filtered log level), `slope` (log return
// per bar) and `slopeSE` (its posterior stdev, for t-stats). First 5 bars are warm-up (null).
function kalmanTrend(x, opts = {}) {
  const N = x.length, level = nulls(N), slope = nulls(N), slopeSE = nulls(N);
  const lr = logReturns(x).filter(isNum);
  let vr = 0;
  if (lr.length > 1) {
    const m = lr.reduce((a, b) => a + b, 0) / lr.length;
    vr = lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1);
  }
  if (!(vr > 0)) vr = 1e-6;
  const r = isNum(opts.r) && opts.r > 0 ? opts.r : vr;
  const q = isNum(opts.q) && opts.q > 0 ? opts.q : vr * 1e-3;
  const qL = isNum(opts.qLevel) && opts.qLevel > 0 ? opts.qLevel : vr * 0.1;
  let L = null, S = 0, P00 = 0, P01 = 0, P11 = 0, seen = 0;
  for (let i = 0; i < N; i++) {
    if (!isNum(x[i]) || x[i] <= 0) continue;
    const y = Math.log(x[i]);
    if (L === null) { L = y; S = 0; P00 = r; P01 = 0; P11 = vr * 4; seen = 1; continue; }
    // Predict.
    const Lp = L + S, Sp = S;
    const p00 = P00 + 2 * P01 + P11 + qL, p01 = P01 + P11, p11 = P11 + q;
    // Update.
    const Sy = p00 + r, K0 = p00 / Sy, K1 = p01 / Sy, e = y - Lp;
    L = Lp + K0 * e; S = Sp + K1 * e;
    P00 = (1 - K0) * p00; P01 = (1 - K0) * p01; P11 = p11 - K1 * p01;
    seen++;
    if (seen > 5) {
      level[i] = fin(Math.exp(L)); slope[i] = fin(S); slopeSE[i] = fin(Math.sqrt(Math.max(P11, 0)));
    }
  }
  return { level, slope, slopeSE };
}

// Helpers exported for sibling modules.
const last = (a) => {
  for (let i = a.length - 1; i >= 0; i--) if (isNum(a[i])) return a[i];
  return null;
};

module.exports = {
  sma, ema, wma, stdev, rsi, macd, bollinger, atr, adx, stochastic, cci, williamsR, roc, obv, mfi,
  vwap, donchian, keltner, ichimoku, supertrend, logReturns, realizedVol, hurst, efficiencyRatio,
  linregSlope, zscore, percentileRank, kalmanTrend,
  // extras (not part of the contract surface, but handy and tested)
  rma, trueRange, highestLowest, lgamma, expectedRS, isNum, last, closes,
};
