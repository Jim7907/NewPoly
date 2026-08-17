const test = require("node:test");
const assert = require("node:assert");
const ind = require("../server/indicators");

const bar = (o, h, l, c, v = 100, t = 0) => ({ t, o, h, l, c, v });
const flat = (n, price = 100, v = 100) =>
  Array.from({ length: n }, (_, i) => bar(price, price + 1, price - 1, price, v, i * 60));

test("sma is null until the window fills, then correct", () => {
  const s = ind.sma([1, 2, 3, 4, 5], 3);
  assert.equal(s[0], null);
  assert.equal(s[1], null);
  assert.equal(s[2], 2);
  assert.equal(s[4], 4);
});

test("ema seeds on the first full window and tracks a constant series", () => {
  const e = ind.ema(new Array(20).fill(10), 5);
  assert.equal(e[3], null);
  assert.ok(Math.abs(e[19] - 10) < 1e-9);
});

test("rma is Wilder smoothing, slower than ema", () => {
  const v = [...new Array(10).fill(1), ...new Array(10).fill(2)];
  const r = ind.rma(v, 5);
  const e = ind.ema(v, 5);
  assert.ok(r[19] < e[19], "Wilder averages react more slowly");
  assert.ok(r[19] > 1 && r[19] < 2);
});

test("trueRange uses the previous close on gaps", () => {
  const bars = [bar(10, 11, 9, 10), bar(20, 21, 19, 20)];
  const tr = ind.trueRange(bars);
  assert.equal(tr[0], 2);
  assert.equal(tr[1], 11);            // 21 - 10, the gap dominates the bar's own range
});

test("atr is positive and matches the range on a constant-range series", () => {
  const a = ind.atr(flat(40), 14);
  assert.ok(Math.abs(a[39] - 2) < 1e-9);
});

test("rollingExtreme with offset 1 excludes the current bar", () => {
  const bars = [...flat(5, 100), bar(100, 130, 99, 129, 100, 300)];
  const hi = ind.rollingExtreme(bars, 5, "high", 1);
  assert.equal(hi[5].value, 101, "the breakout bar must not define its own level");
  const hi0 = ind.rollingExtreme(bars, 5, "high", 0);
  assert.equal(hi0[5].value, 130);
});

test("percentRank is bounded and ranks a new high at 1", () => {
  const v = Array.from({ length: 60 }, (_, i) => (i === 59 ? 999 : i % 10));
  const pr = ind.percentRank(v, 50);
  assert.equal(pr[59], 1);
  assert.ok(pr.every(x => x == null || (x >= 0 && x <= 1)));
});

test("pivots are only confirmed `right` bars after the extreme", () => {
  const bars = [...flat(6, 100), bar(100, 120, 99, 110, 100, 600), ...flat(6, 100)];
  const { highs } = ind.pivots(bars, 3, 3);
  assert.equal(highs.length, 1);
  assert.equal(highs[0].index, 6);
  assert.equal(highs[0].confirmedAt, 9);
  assert.equal(highs[0].price, 120);
});

test("relativeVolume compares against a baseline that excludes the current bar", () => {
  const bars = [...flat(20, 100, 100), bar(100, 101, 99, 100, 300, 1200)];
  const rv = ind.relativeVolume(bars, 20);
  assert.equal(rv[19], null, "baseline not yet complete");
  assert.ok(Math.abs(rv[20] - 3) < 1e-9);
});

test("adx rises in a clean trend and stays low in a range", () => {
  const trend = Array.from({ length: 120 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 100.8 + i, 100, i * 60));
  const range = Array.from({ length: 120 }, (_, i) => bar(100, 101, 99, i % 2 ? 100.4 : 99.6, 100, i * 60));
  const at = ind.adx(trend, 14).adx.filter(v => v != null).pop();
  const ar = ind.adx(range, 14).adx.filter(v => v != null).pop();
  assert.ok(at > 40, `trend adx ${at}`);
  assert.ok(ar < 25, `range adx ${ar}`);
});

test("compression scores a tight coil near 1", () => {
  const wide = Array.from({ length: 140 }, (_, i) => bar(100, 100 + (i % 7) * 3, 100 - (i % 7) * 3, 100, 100, i * 60));
  const bars = [...wide, ...flat(20, 100)];
  const comp = ind.compression(bars, 20, 100).pop();
  assert.ok(comp > 0.8, `expected a tight coil, got ${comp}`);
});
