import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPine, pineMeta } from '../src/indicators/pine/runtime.js';
import { looksLikePine, parsePine } from '../src/indicators/pine/parser.js';

const mk = (closes) => closes.map((c, i) => ({ time: 1700000000 + i * 900, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }));
const C = mk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const vals = (r, i = 0) => r.plots[i].values;
const close = (a, b, eps = 1e-9) => a.every((x, i) => (x === null && b[i] === null) || Math.abs(x - b[i]) < eps);

test('sma/ema/rma match hand calculations', () => {
  const r = runPine(`//@version=5
indicator("MAs")
plot(ta.sma(close, 3))
plot(ta.ema(close, 3))
plot(ta.rma(close, 3))`, C);
  assert.equal(r.title, 'MAs');
  assert.deepEqual(vals(r, 0).slice(0, 4), [null, null, 2, 3]);
  // ema seeds with the first value (TradingView behaviour), alpha 0.5
  assert.deepEqual(vals(r, 1).slice(0, 3), [1, 1.5, 2.25]);
  // rma seeds with sma(3) at bar 2 = 2, then (2*2+4)/3
  assert.ok(close(vals(r, 2).slice(0, 4), [null, null, 2, (2 * 2 + 4) / 3]));
});

test('var, :=, history and nz', () => {
  const r = runPine(`indicator("count")
var int n = 0
n := n + 1
x = 0.0
x := nz(x[1]) + close
plot(n, "n")
plot(x, "x")
plot(close[2], "c2")`, C);
  assert.deepEqual(vals(r, 0).slice(0, 4), [1, 2, 3, 4]);
  assert.deepEqual(vals(r, 1).slice(0, 4), [1, 3, 6, 10]);
  assert.deepEqual(vals(r, 2).slice(0, 4), [null, null, 1, 2]);
});

test('if / else if / else, ternary and if-as-expression', () => {
  const r = runPine(`indicator("t")
float v = na
if close > 7
    v := 2
else if close > 4
    v := 1
else
    v := 0
w = close % 2 == 0 ? 10 : 20
z = if close > 5
    100
else
    -100
plot(v)
plot(w)
plot(z)`, C);
  assert.deepEqual(vals(r, 0), [0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual(vals(r, 1).slice(0, 3), [20, 10, 20]);
  assert.deepEqual(vals(r, 2).slice(4, 7), [-100, 100, 100]);
});

test('user functions (single line, block, tuple return) keep separate ta state per call', () => {
  const r = runPine(`indicator("f")
dbl(x) => x * 2
band(src, len) =>
    m = ta.sma(src, len)
    [m, m + 1]
[a, b] = band(close, 2)
c = ta.sma(close, 4)
plot(dbl(close))
plot(a)
plot(b)
plot(c)`, C);
  assert.deepEqual(vals(r, 0).slice(0, 3), [2, 4, 6]);
  assert.deepEqual(vals(r, 1).slice(0, 3), [null, 1.5, 2.5]);
  assert.deepEqual(vals(r, 2).slice(1, 3), [2.5, 3.5]);
  assert.deepEqual(vals(r, 3).slice(2, 5), [null, 2.5, 3.5]);
});

test('for loop, while, switch and multi-line continuation', () => {
  const r = runPine(`indicator("loops")
s = 0.0
for i = 0 to 2
    s += close[i]
k = 0
while k < 3
    k += 1
mode = input.string("double", "Mode", options=["double", "triple"])
m = switch mode
    "double" => close * 2
    "triple" => close * 3
    => close
long_expr = close +
     1
plot(s)
plot(k)
plot(m)
plot(long_expr)`, C);
  assert.deepEqual(vals(r, 0).slice(2, 4), [6, 9]);
  assert.equal(vals(r, 1)[0], 3);
  assert.equal(vals(r, 2)[1], 4);
  assert.equal(vals(r, 3)[0], 2);
  const r3 = runPine(`indicator("loops")
mode = input.string("double", "Mode", options=["double", "triple"])
m = switch mode
    "double" => close * 2
    "triple" => close * 3
plot(m)`, C, { mode: 'triple' });
  assert.equal(vals(r3, 0)[1], 6);
});

test('inputs: metadata and overrides', () => {
  const src = `//@version=5
indicator("RSI test", overlay=false)
len = input.int(14, "Length", minval=1)
src = input.source(close, "Source")
show = input.bool(true, "Show")
plot(show ? ta.rsi(src, len) : na, "RSI")
hline(70)
hline(30)`;
  const meta = pineMeta(src);
  assert.equal(meta.title, 'RSI test');
  assert.deepEqual(meta.inputs.map((i) => [i.name, i.type, i.default]), [['len', 'int', 14], ['src', 'source', 'close'], ['show', 'bool', true]]);
  assert.equal(meta.inputs[0].min, 1);
  const r = runPine(src, C, { len: 2 });
  assert.equal(r.pane, 'separate');
  assert.deepEqual(r.levels, [70, 30]);
  assert.equal(vals(r)[3], 100); // strictly rising -> RSI 100
  const off = runPine(src, C, { show: false });
  assert.ok(vals(off).every((v) => v === null));
});

test('ta.crossover + strategy.entry/close produce signals; position_size lags one bar', () => {
  const closes = [5, 4, 3, 4, 5, 6, 5, 4, 3, 4];
  const r = runPine(`strategy("x", overlay=true)
fast = ta.sma(close, 1)
slow = ta.sma(close, 3)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("L")
plot(strategy.position_size, "pos")`, mk(closes));
  assert.equal(r.pane, 'overlay');
  assert.ok(r.signals);
  const longIdx = r.signals.indexOf('long');
  const exitIdx = r.signals.indexOf('exit');
  assert.ok(longIdx > 0 && exitIdx > longIdx, JSON.stringify(r.signals));
  assert.equal(r.plots[0].values[longIdx], 0);
  assert.equal(r.plots[0].values[longIdx + 1], 1);
});

test('alertcondition / plotshape titles become signals in indicator() scripts', () => {
  const r = runPine(`indicator("sig", overlay=true)
up = close > close[1] and close[1] <= close[2]
dn = close < close[1] and close[1] >= close[2]
alertcondition(up, title="Buy signal", message="go long")
plotshape(dn, title="Sell", style=shape.triangledown, location=location.abovebar, color=color.red)`, mk([5, 4, 3, 4, 5, 6, 5, 4]));
  assert.deepEqual(r.signals, [null, null, null, 'long', null, null, 'short', null]);
});

test('macd / bb tuples, atr, supertrend run without errors', () => {
  const candles = Array.from({ length: 120 }, (_, i) => {
    const p = 100 + Math.sin(i / 6) * 5;
    return { time: i * 900, open: p - 0.3, high: p + 1, low: p - 1, close: p, volume: 5 };
  });
  const r = runPine(`indicator("all")
[m, s, h] = ta.macd(close, 12, 26, 9)
[mid, up, lo] = ta.bb(close, 20, 2)
[st, dir] = ta.supertrend(3, 10)
[dp, dm, adx] = ta.dmi(14, 14)
plot(h, style=plot.style_histogram, color=color.new(color.green, 50))
plot(up - lo)
plot(ta.atr(14))
plot(st)
plot(adx)
plot(ta.cci(close, 20))
plot(ta.stoch(close, high, low, 14))
plot(ta.vwap)
plot(ta.hma(close, 9))
plot(ta.linreg(close, 10, 0))
plot(ta.pivothigh(2, 2))
bgcolor(color.new(color.blue, 90))
label.new(bar_index, high, "x")`, candles);
  assert.equal(r.plots.length, 11);
  assert.equal(r.plots[0].type, 'histogram');
  assert.match(r.plots[0].color, /^rgba\(/);
  for (const p of r.plots.slice(0, 10)) assert.ok(p.values.slice(60).every((v) => v !== null && Number.isFinite(v)), p.name);
  const widths = r.plots[1].values.slice(19);
  assert.ok(widths.every((w) => w > 0));
});

test('useful errors with line numbers', () => {
  assert.throws(() => runPine('indicator("e")\nx = request.security(syminfo.tickerid, "D", close)\nplot(x)', C), /Line 2: request\.security\(\) is not supported/);
  assert.throws(() => runPine('indicator("e")\nplot(foo)', C), /Line 2: Unknown variable "foo"/);
  assert.throws(() => runPine('indicator("e")\nx := 1', C), /Line 2: "x" is not declared/);
  assert.throws(() => parsePine('indicator("e")\nplot(close'), /Expected/);
  assert.throws(() => runPine('indicator("e")\nwhile true\n    x = 1', C), /Loop runs too many times/);
  assert.throws(() => parsePine('import TradingView/ta/5 as tav'), /Line 1: Libraries/);
});

test('looksLikePine', () => {
  assert.ok(looksLikePine('//@version=5\nindicator("x")'));
  assert.ok(looksLikePine('strategy("x")\nplot(close)'));
  assert.ok(!looksLikePine('return { pane: "overlay", plots: [] };'));
});

test('v4-style study() and input() still work', () => {
  const r = runPine(`//@version=4
study("old", overlay=true)
len = input(3, title="Len")
plot(sma(close, len))`.replace('sma(', 'ta.sma('), C, {});
  assert.equal(r.pane, 'overlay');
  assert.equal(vals(r)[2], 2);
});

test('named title= in indicator() and loop errors caught at import', () => {
  assert.equal(pineMeta('//@version=5\nindicator(title="UT Bot Alerts", overlay=true)\nplot(close)').title, 'UT Bot Alerts');
  assert.equal(pineMeta('strategy(shorttitle="x", title="Long name")\nplot(close)').title, 'Long name');
  assert.throws(() => pineMeta('indicator("h")\nx = 0\nwhile true\n    x += 1\nplot(x)'), /Loop runs too many times/);
});

test('large Pine scripts (100 KB+) are accepted, absurd ones rejected', async () => {
  const { describeScript, MAX_CODE } = await import('../src/indicators/useIndicators.js');
  const body = Array.from({ length: 6000 }, (_, i) => `v${i} = ta.sma(close, ${(i % 50) + 1})`).join('\n');
  const code = `//@version=5\nindicator("Big one", overlay=true)\n${body}\nplot(v0)\n`;
  assert.ok(code.length > 100 * 1024, `test script is ${code.length} chars`);
  assert.equal(describeScript(code).name, 'Big one');
  assert.throws(() => describeScript('x'.repeat(MAX_CODE + 1)), /too long/);
});
