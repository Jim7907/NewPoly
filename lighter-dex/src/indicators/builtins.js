// Built-in indicators, written in Pine Script (the same format users import).
// "Copy as custom" in the UI gives users these as a starting point.

const pine = (strs, ...vals) => String.raw(strs, ...vals).replace(/^\n/, '');

export const BUILTINS = [
  {
    id: 'ema',
    code: pine`
//@version=5
indicator("EMA", overlay=true)
fast = input.int(9, "Fast length", minval=1)
slow = input.int(21, "Slow length", minval=1)
plot(ta.ema(close, fast), "EMA fast", color=#f5a524)
plot(ta.ema(close, slow), "EMA slow", color=#7c6cff)`,
  },
  {
    id: 'sma',
    code: pine`
//@version=5
indicator("SMA", overlay=true)
length = input.int(50, "Length", minval=1)
src = input.source(close, "Source")
plot(ta.sma(src, length), "SMA", color=#22b8cf)`,
  },
  {
    id: 'bb',
    code: pine`
//@version=5
indicator("Bollinger Bands", overlay=true)
length = input.int(20, "Length", minval=1)
mult = input.float(2.0, "StdDev")
[basis, upper, lower] = ta.bb(close, length, mult)
plot(upper, "Upper", color=#8a93a6)
plot(basis, "Basis", color=#f5a524)
plot(lower, "Lower", color=#8a93a6)`,
  },
  {
    id: 'vwap',
    code: pine`
//@version=5
indicator("VWAP (daily)", overlay=true)
plot(ta.vwap(hlc3), "VWAP", color=#e64980)`,
  },
  {
    id: 'supertrend',
    code: pine`
//@version=5
indicator("Supertrend", overlay=true)
factor = input.float(3.0, "Factor")
atrPeriod = input.int(10, "ATR length")
[st, direction] = ta.supertrend(factor, atrPeriod)
plot(direction < 0 ? st : na, "Up trend", color=#2ebd85)
plot(direction > 0 ? st : na, "Down trend", color=#f0465a)`,
  },
  {
    id: 'rsi',
    code: pine`
//@version=5
indicator("RSI")
length = input.int(14, "Length", minval=1)
plot(ta.rsi(close, length), "RSI", color=#7c6cff)
hline(70)
hline(30)`,
  },
  {
    id: 'macd',
    code: pine`
//@version=5
indicator("MACD")
fast = input.int(12, "Fast")
slow = input.int(26, "Slow")
signal = input.int(9, "Signal")
[m, s, h] = ta.macd(close, fast, slow, signal)
plot(h, "Histogram", style=plot.style_histogram)
plot(m, "MACD", color=#22b8cf)
plot(s, "Signal", color=#f5a524)
hline(0)`,
  },
  {
    id: 'stoch',
    code: pine`
//@version=5
indicator("Stochastic")
length = input.int(14, "%K length")
smoothK = input.int(3, "%K smoothing")
smoothD = input.int(3, "%D smoothing")
k = ta.sma(ta.stoch(close, high, low, length), smoothK)
d = ta.sma(k, smoothD)
plot(k, "%K", color=#22b8cf)
plot(d, "%D", color=#f5a524)
hline(80)
hline(20)`,
  },
  {
    id: 'atr',
    code: pine`
//@version=5
indicator("ATR")
length = input.int(14, "Length")
plot(ta.atr(length), "ATR", color=#e64980)`,
  },
  // ---- strategies: drive the auto-trader via strategy.entry / strategy.close ----
  {
    id: 'ema-cross',
    strategy: true,
    code: pine`
//@version=5
strategy("Strategy: EMA cross", overlay=true)
fast = input.int(9, "Fast length")
slow = input.int(21, "Slow length")
f = ta.ema(close, fast)
s = ta.ema(close, slow)
if ta.crossover(f, s)
    strategy.entry("Long", strategy.long)
if ta.crossunder(f, s)
    strategy.entry("Short", strategy.short)
plot(f, "Fast", color=#f5a524)
plot(s, "Slow", color=#7c6cff)`,
  },
  {
    id: 'rsi-revert',
    strategy: true,
    code: pine`
//@version=5
strategy("Strategy: RSI reversal")
length = input.int(14, "RSI length")
oversold = input.int(30, "Oversold")
overbought = input.int(70, "Overbought")
r = ta.rsi(close, length)
// long when RSI climbs back above oversold, short when it drops back below overbought,
// exit when RSI crosses 50 against the trade
var int side = 0
if ta.crossover(r, oversold)
    strategy.entry("Long", strategy.long)
    side := 1
else if ta.crossunder(r, overbought)
    strategy.entry("Short", strategy.short)
    side := -1
else if side == 1 and ta.crossunder(r, 50)
    strategy.close_all()
    side := 0
else if side == -1 and ta.crossover(r, 50)
    strategy.close_all()
    side := 0
plot(r, "RSI", color=#7c6cff)
hline(overbought)
hline(50)
hline(oversold)`,
  },
];

export const CUSTOM_TEMPLATE = `//@version=5
// Paste any TradingView Pine Script indicator or strategy here.
// To let the auto-trader use it, call strategy.entry() / strategy.close(),
// or add alertcondition(cond, "Buy") / alertcondition(cond, "Sell").
strategy("My strategy", overlay=true)
length = input.int(20, "Length")
mult = input.float(2.0, "Band width")
basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
plot(basis, "Basis", color=color.orange)
plot(basis + dev, "Upper")
plot(basis - dev, "Lower")
if ta.crossover(close, basis - dev)
    strategy.entry("Long", strategy.long)
if ta.crossunder(close, basis + dev)
    strategy.entry("Short", strategy.short)
`;
