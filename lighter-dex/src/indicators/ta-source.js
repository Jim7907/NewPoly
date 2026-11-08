// Technical-analysis helpers available to every indicator script as `ta`.
// Kept as source text because it runs inside the isolated indicator worker.
// All functions take/return plain arrays aligned with the candles; `null` = no value yet.
export const TA_SOURCE = String.raw`
const ta = (() => {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const field = (candles, key) => candles.map((c) => c[key]);

  function sma(values, length) {
    const out = new Array(values.length).fill(null);
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isNum(v)) { sum += v; count++; }
      if (i >= length) { const old = values[i - length]; if (isNum(old)) { sum -= old; count--; } }
      if (i >= length - 1 && count === length) out[i] = sum / length;
    }
    return out;
  }

  function ema(values, length) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (length + 1);
    let prev = null, seed = [], started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (!started) {
        seed.push(v);
        if (seed.length === length) { prev = seed.reduce((a, b) => a + b, 0) / length; out[i] = prev; started = true; }
      } else { prev = v * k + prev * (1 - k); out[i] = prev; }
    }
    return out;
  }

  // Wilder's smoothing (used by RSI / ATR)
  function rma(values, length) {
    const out = new Array(values.length).fill(null);
    let prev = null, seed = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (prev === null) {
        seed.push(v);
        if (seed.length === length) { prev = seed.reduce((a, b) => a + b, 0) / length; out[i] = prev; }
      } else { prev = (prev * (length - 1) + v) / length; out[i] = prev; }
    }
    return out;
  }

  function wma(values, length) {
    const out = new Array(values.length).fill(null);
    const denom = (length * (length + 1)) / 2;
    for (let i = length - 1; i < values.length; i++) {
      let s = 0, ok = true;
      for (let j = 0; j < length; j++) { const v = values[i - j]; if (!isNum(v)) { ok = false; break; } s += v * (length - j); }
      if (ok) out[i] = s / denom;
    }
    return out;
  }

  function stdev(values, length) {
    const mean = sma(values, length);
    return values.map((_, i) => {
      if (mean[i] === null) return null;
      let s = 0;
      for (let j = 0; j < length; j++) s += (values[i - j] - mean[i]) ** 2;
      return Math.sqrt(s / length);
    });
  }

  function highest(values, length) {
    return values.map((_, i) => (i < length - 1 ? null : Math.max(...values.slice(i - length + 1, i + 1))));
  }
  function lowest(values, length) {
    return values.map((_, i) => (i < length - 1 ? null : Math.min(...values.slice(i - length + 1, i + 1))));
  }
  function change(values, length = 1) {
    return values.map((v, i) => (i < length || !isNum(v) || !isNum(values[i - length]) ? null : v - values[i - length]));
  }

  function rsi(values, length = 14) {
    const ch = change(values, 1);
    const gains = rma(ch.map((c) => (c === null ? null : Math.max(c, 0))), length);
    const losses = rma(ch.map((c) => (c === null ? null : Math.max(-c, 0))), length);
    return values.map((_, i) => {
      if (gains[i] === null || losses[i] === null) return null;
      if (losses[i] === 0) return 100;
      return 100 - 100 / (1 + gains[i] / losses[i]);
    });
  }

  function macd(values, fast = 12, slow = 26, signal = 9) {
    const f = ema(values, fast), s = ema(values, slow);
    const line = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i] - s[i]));
    const sig = ema(line, signal);
    const hist = line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]));
    return { macd: line, signal: sig, hist };
  }

  function bb(values, length = 20, mult = 2) {
    const mid = sma(values, length), sd = stdev(values, length);
    return {
      middle: mid,
      upper: mid.map((m, i) => (m === null ? null : m + mult * sd[i])),
      lower: mid.map((m, i) => (m === null ? null : m - mult * sd[i])),
    };
  }

  function tr(candles) {
    return candles.map((c, i) => (i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  }
  function atr(candles, length = 14) { return rma(tr(candles), length); }

  // VWAP anchored to each UTC day
  function vwap(candles) {
    let day = null, pv = 0, vol = 0;
    return candles.map((c) => {
      const d = Math.floor(c.time / 86400);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const typical = (c.high + c.low + c.close) / 3;
      pv += typical * c.volume; vol += c.volume;
      return vol ? pv / vol : null;
    });
  }

  function stoch(candles, length = 14, smoothK = 3, smoothD = 3) {
    const hi = highest(field(candles, 'high'), length), lo = lowest(field(candles, 'low'), length);
    const raw = candles.map((c, i) => (hi[i] === null ? null : hi[i] === lo[i] ? 50 : ((c.close - lo[i]) / (hi[i] - lo[i])) * 100));
    const k = sma(raw, smoothK);
    return { k, d: sma(k, smoothD) };
  }

  return {
    sma, ema, rma, wma, stdev, highest, lowest, change, rsi, macd, bb, tr, atr, vwap, stoch,
    close: (c) => field(c, 'close'), open: (c) => field(c, 'open'), high: (c) => field(c, 'high'),
    low: (c) => field(c, 'low'), volume: (c) => field(c, 'volume'),
    hl2: (c) => c.map((x) => (x.high + x.low) / 2), hlc3: (c) => c.map((x) => (x.high + x.low + x.close) / 3),
  };
})();
`;
