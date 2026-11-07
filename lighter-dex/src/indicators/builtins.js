// Built-in indicators use the exact same script format users import, so they
// double as examples. Each script gets: candles, inputs, ta (see ta-source.js).

export const BUILTINS = [
  {
    id: 'ema',
    name: 'EMA',
    inputs: { fast: 9, slow: 21 },
    code: `return {
  pane: 'overlay',
  plots: [
    { name: 'EMA ' + inputs.fast, values: ta.ema(ta.close(candles), inputs.fast), color: '#f5a524' },
    { name: 'EMA ' + inputs.slow, values: ta.ema(ta.close(candles), inputs.slow), color: '#7c6cff' },
  ],
};`,
  },
  {
    id: 'sma',
    name: 'SMA',
    inputs: { length: 50 },
    code: `return { pane: 'overlay', plots: [{ name: 'SMA ' + inputs.length, values: ta.sma(ta.close(candles), inputs.length), color: '#22b8cf' }] };`,
  },
  {
    id: 'bb',
    name: 'Bollinger Bands',
    inputs: { length: 20, mult: 2 },
    code: `const b = ta.bb(ta.close(candles), inputs.length, inputs.mult);
return {
  pane: 'overlay',
  plots: [
    { name: 'Upper', values: b.upper, color: '#8a93a6' },
    { name: 'Basis', values: b.middle, color: '#f5a524' },
    { name: 'Lower', values: b.lower, color: '#8a93a6' },
  ],
};`,
  },
  {
    id: 'vwap',
    name: 'VWAP (daily)',
    inputs: {},
    code: `return { pane: 'overlay', plots: [{ name: 'VWAP', values: ta.vwap(candles), color: '#e64980' }] };`,
  },
  {
    id: 'rsi',
    name: 'RSI',
    inputs: { length: 14 },
    code: `return { pane: 'separate', levels: [30, 70], plots: [{ name: 'RSI ' + inputs.length, values: ta.rsi(ta.close(candles), inputs.length), color: '#7c6cff' }] };`,
  },
  {
    id: 'macd',
    name: 'MACD',
    inputs: { fast: 12, slow: 26, signal: 9 },
    code: `const m = ta.macd(ta.close(candles), inputs.fast, inputs.slow, inputs.signal);
return {
  pane: 'separate',
  levels: [0],
  plots: [
    { name: 'Histogram', values: m.hist, type: 'histogram' },
    { name: 'MACD', values: m.macd, color: '#22b8cf' },
    { name: 'Signal', values: m.signal, color: '#f5a524' },
  ],
};`,
  },
  {
    id: 'stoch',
    name: 'Stochastic',
    inputs: { length: 14, smoothK: 3, smoothD: 3 },
    code: `const s = ta.stoch(candles, inputs.length, inputs.smoothK, inputs.smoothD);
return { pane: 'separate', levels: [20, 80], plots: [{ name: '%K', values: s.k, color: '#22b8cf' }, { name: '%D', values: s.d, color: '#f5a524' }] };`,
  },
  // ---- strategies: same format plus `signals` (one per candle) for the auto-trader ----
  {
    id: 'ema-cross',
    name: 'Strategy: EMA cross',
    strategy: true,
    inputs: { fast: 9, slow: 21 },
    code: `const close = ta.close(candles);
const fast = ta.ema(close, inputs.fast), slow = ta.ema(close, inputs.slow);
// long when fast crosses above slow, short when it crosses below
const signals = close.map((_, i) => {
  if (i === 0 || fast[i] === null || slow[i] === null || fast[i - 1] === null || slow[i - 1] === null) return null;
  if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) return 'long';
  if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]) return 'short';
  return null;
});
return {
  pane: 'overlay',
  signals,
  plots: [
    { name: 'Fast', values: fast, color: '#f5a524' },
    { name: 'Slow', values: slow, color: '#7c6cff' },
  ],
};`,
  },
  {
    id: 'rsi-revert',
    name: 'Strategy: RSI reversal',
    strategy: true,
    inputs: { length: 14, low: 30, high: 70 },
    code: `const r = ta.rsi(ta.close(candles), inputs.length);
// long when RSI climbs back above "low", short when it drops back below "high",
// exit when RSI crosses 50 against the trade
let side = null;
const signals = r.map((v, i) => {
  const p = r[i - 1];
  if (v === null || p === null || p === undefined) return null;
  if (p < inputs.low && v >= inputs.low) { side = 'long'; return 'long'; }
  if (p > inputs.high && v <= inputs.high) { side = 'short'; return 'short'; }
  if (side === 'long' && p >= 50 && v < 50) { side = null; return 'exit'; }
  if (side === 'short' && p <= 50 && v > 50) { side = null; return 'exit'; }
  return null;
});
return { pane: 'separate', levels: [inputs.low, 50, inputs.high], signals, plots: [{ name: 'RSI', values: r, color: '#7c6cff' }] };`,
  },
  {
    id: 'atr',
    name: 'ATR',
    inputs: { length: 14 },
    code: `return { pane: 'separate', plots: [{ name: 'ATR ' + inputs.length, values: ta.atr(candles, inputs.length), color: '#e64980' }] };`,
  },
];

export const CUSTOM_TEMPLATE = `// @name My indicator
// @input length 20
//
// Available: candles [{ time, open, high, low, close, volume }], inputs, ta
// ta: sma ema rma wma stdev highest lowest change rsi macd bb atr vwap stoch
//     close(candles) open() high() low() volume() hl2() hlc3()
// Return one value per candle (null = nothing drawn).

const close = ta.close(candles);
const basis = ta.sma(close, inputs.length);
const dev = ta.stdev(close, inputs.length);

return {
  pane: 'overlay',            // or 'separate' for its own panel below the chart
  plots: [
    { name: 'Basis', values: basis, color: '#f5a524' },
    { name: 'Upper', values: basis.map((b, i) => b === null ? null : b + 2 * dev[i]) },
  ],
  // levels: [30, 70],         // horizontal lines (separate pane only)
  // Auto-trading: add one entry per candle: 'long' | 'short' | 'exit' | null
  // signals: close.map((c, i) => (c > basis[i] + 2 * dev[i] ? 'short' : null)),
};
`;
