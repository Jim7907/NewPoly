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
};
`;
