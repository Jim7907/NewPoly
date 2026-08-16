// Pure technical indicators. No I/O — fully unit-testable.
//
// Causality contract: every array this module returns is aligned to the input bars and the
// value at index i is computable from bars[0..i] only. Pivots are the one construct that
// looks forward, so they are returned with an explicit `confirmedAt` index and the strategy
// layer is required to filter on it. Nothing here peeks at the future.
//
// Bar shape: { t, o, h, l, c, v }   (t = unix seconds)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nz = (v, d = 0) => (Number.isFinite(v) ? v : d);

// Simple moving average. null until `len` samples are available.
function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

// Exponential moving average, seeded with the first `len`-bar SMA.
function ema(values, len) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null, sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) { sum += values[i]; continue; }
    if (prev === null) { sum += values[i]; prev = sum / len; }
    else prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing (RMA) — the average used by ATR/ADX/RSI.
function rma(values, len) {
  const out = new Array(values.length).fill(null);
  let prev = null, sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) { sum += values[i]; continue; }
    if (prev === null) { sum += values[i]; prev = sum / len; }
    else prev = (prev * (len - 1) + values[i]) / len;
    out[i] = prev;
  }
  return out;
}

function stdev(values, len) {
  const out = new Array(values.length).fill(null);
  for (let i = len - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - len + 1; j <= i; j++) mean += values[j];
    mean /= len;
    let acc = 0;
    for (let j = i - len + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / len);
  }
  return out;
}

// True range per bar. TR[0] falls back to the bar's own range.
function trueRange(bars) {
  return bars.map((b, i) => (i === 0
    ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

const atr = (bars, len = 14) => rma(trueRange(bars), len);

// Highest/lowest over the `len` bars ending at i-offset. offset=1 excludes the current bar,
// which is what a breakout test needs (a bar cannot break a level it helped define).
function rollingExtreme(bars, len, kind, offset = 1) {
  const out = new Array(bars.length).fill(null);
  const pick = kind === "high" ? (b) => b.h : (b) => b.l;
  const better = kind === "high" ? (a, b) => a > b : (a, b) => a < b;
  for (let i = 0; i < bars.length; i++) {
    const end = i - offset;
    const start = end - len + 1;
    if (start < 0) continue;
    let best = pick(bars[start]), idx = start;
    for (let j = start + 1; j <= end; j++) {
      const v = pick(bars[j]);
      if (better(v, best)) { best = v; idx = j; }
    }
    out[i] = { value: best, index: idx, start, end };
  }
  return out;
}

// Fraction of the last `len` samples that the current sample exceeds, in [0,1].
function percentRank(values, len) {
  const out = new Array(values.length).fill(null);
  for (let i = len; i < values.length; i++) {
    const cur = values[i];
    if (!Number.isFinite(cur)) continue;
    let below = 0, n = 0;
    for (let j = i - len; j < i; j++) {
      if (!Number.isFinite(values[j])) continue;
      n++;
      if (values[j] < cur) below++;
    }
    out[i] = n > 0 ? below / n : null;
  }
  return out;
}

// Wilder ADX with +DI/-DI. Measures trend strength; the flat-market filter keys off it.
function adx(bars, len = 14) {
  const n = bars.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = rma(trueRange(bars), len);
  const pdm = rma(plusDM, len);
  const mdm = rma(minusDM, len);

  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (tr[i] == null || pdm[i] == null || mdm[i] == null || !(tr[i] > 0)) continue;
    plusDI[i] = 100 * (pdm[i] / tr[i]);
    minusDI[i] = 100 * (mdm[i] / tr[i]);
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / sum : 0;
  }
  // rma() needs a dense series; leading nulls become 0 and are masked back out after.
  const dxDense = dx.map(v => nz(v, 0));
  const firstValid = dx.findIndex(v => v != null);
  const smoothed = rma(dxDense, len);
  const adxOut = smoothed.map((v, i) => (firstValid < 0 || i < firstValid + len * 2 ? null : v));
  return { plusDI, minusDI, adx: adxOut };
}

// Fractal pivots. A pivot high at index i needs `left` lower highs before and `right` after,
// so it is only KNOWN at i+right — recorded as `confirmedAt`.
function pivots(bars, left = 5, right = 5) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, confirmedAt: i + right, price: bars[i].h });
    if (isLow) lows.push({ index: i, confirmedAt: i + right, price: bars[i].l });
  }
  return { highs, lows };
}

// Relative volume: v[i] / mean(v[i-len..i-1]). Excludes the current bar so a single huge
// print cannot inflate its own baseline. null while the baseline is short.
function relativeVolume(bars, len = 20) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= len) {
      const base = sum / len;
      out[i] = base > 0 ? bars[i].v / base : null;
    }
    sum += bars[i].v;
    if (i >= len) sum -= bars[i - len].v;
  }
  return out;
}

// Squeeze/compression score in [0,1]: how tight the recent range is versus its own history.
// 1 = tightest coil seen in `histLen` bars, which is the classic pre-breakout state.
function compression(bars, len = 20, histLen = 100) {
  const width = new Array(bars.length).fill(null);
  const hi = rollingExtreme(bars, len, "high", 0);
  const lo = rollingExtreme(bars, len, "low", 0);
  for (let i = 0; i < bars.length; i++) {
    if (!hi[i] || !lo[i] || !(bars[i].c > 0)) continue;
    width[i] = (hi[i].value - lo[i].value) / bars[i].c;
  }
  const dense = width.map(v => nz(v, 0));
  const rank = percentRank(dense, histLen);
  return width.map((w, i) => (w == null || rank[i] == null ? null : 1 - rank[i]));
}

module.exports = {
  clamp, nz, sma, ema, rma, stdev, trueRange, atr, rollingExtreme,
  percentRank, adx, pivots, relativeVolume, compression,
};
