const test = require("node:test");
const assert = require("node:assert");
const I = require("../server/analysis/indicators");

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} expected ${b}, got ${a}`);
const C = (h, l, c, v = 1, o = c) => ({ t: 0, o, h, l, c, v });

// Wilder's classic 14-period RSI worksheet data (as reproduced by StockCharts). The exact values
// (TA-Lib agrees) are 70.46, 66.25, 66.48 …; StockCharts' 70.53 comes from rounding intermediate
// averages to two decimals in their spreadsheet.
const RSI_DATA = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
  46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18,
  44.22, 44.57, 43.42, 42.66, 43.13];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

test("sma / wma hand values and null warm-up", () => {
  assert.deepStrictEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  // WMA(3) of [1,2,3] = (1·1 + 2·2 + 3·3)/6 = 14/6
  const w = I.wma([1, 2, 3, 4], 3);
  assert.equal(w[1], null);
  near(w[2], 14 / 6); near(w[3], 20 / 6);
  // a null inside the window nulls the window
  assert.deepStrictEqual(I.sma([1, null, 3, 4, 5], 2), [null, null, null, 3.5, 4.5]);
});

test("ema seeds with SMA then applies alpha = 2/(n+1)", () => {
  // n=3 → alpha 0.5; seed = mean(2,4,6)=4; then 0.5·8+0.5·4=6; 0.5·12+0.5·6=9; 11.5; 10.75
  const e = I.ema([2, 4, 6, 8, 12, 14, 10], 3);
  assert.deepStrictEqual(e, [null, null, 4, 6, 9, 11.5, 10.75]);
  // tolerates leading nulls (as for an EMA of the MACD line)
  assert.deepStrictEqual(I.ema([null, null, 2, 4, 6, 8], 3), [null, null, null, null, 4, 6]);
});

test("stdev population (default) and sample", () => {
  near(I.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7], 2);                 // textbook population example
  near(I.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8, true)[7], Math.sqrt(32 / 7));
});

test("rsi matches Wilder's classic worksheet", () => {
  const r = I.rsi(RSI_DATA, 14);
  for (let i = 0; i < 14; i++) assert.equal(r[i], null);
  near(r[14], 70.46, 0.01, "first RSI");
  near(r[15], 66.25, 0.01);
  near(r[16], 66.48, 0.01);
  near(r[17], 69.35, 0.01);
  near(r[32], 37.79, 0.01, "last RSI");
  // all-up series → 100, flat series → 50
  assert.equal(I.rsi([1, 2, 3, 4, 5, 6], 3)[5], 100);
  assert.equal(I.rsi([5, 5, 5, 5, 5], 3)[4], 50);
  assert.ok(I.rsi([1, 2], 14).every((v) => v === null));
});

test("macd = ema(fast) − ema(slow); signal is EMA of the line; hist = line − signal", () => {
  const x = Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.3);
  const m = I.macd(x, 12, 26, 9);
  const ef = I.ema(x, 12), es = I.ema(x, 26);
  assert.equal(m.macd[24], null);
  near(m.macd[25], ef[25] - es[25], 1e-12);
  assert.equal(m.signal[25 + 7], null);
  const seed = m.macd.slice(25, 34).reduce((a, b) => a + b, 0) / 9;
  near(m.signal[33], seed, 1e-12);
  near(m.hist[40], m.macd[40] - m.signal[40], 1e-12);
});

test("bollinger hand values", () => {
  const b = I.bollinger([1, 2, 3, 4, 5], 5, 2);
  near(b.mid[4], 3);
  near(b.upper[4], 3 + 2 * Math.SQRT2);
  near(b.lower[4], 3 - 2 * Math.SQRT2);
  near(b.pctB[4], (5 - (3 - 2 * Math.SQRT2)) / (4 * Math.SQRT2));
  near(b.bandwidth[4], (4 * Math.SQRT2) / 3);
  // flat window: pctB 0.5, no NaN
  const f = I.bollinger([5, 5, 5], 3);
  assert.equal(f.pctB[2], 0.5);
  assert.equal(f.bandwidth[2], 0);
});

// Hand-worked ATR example (n=3):
//  TR = [2, 2, 2.5, 1.5, 4.5]; ATR[2] = 6.5/3; ATR[3] = (ATR[2]·2+1.5)/3; ATR[4] = (ATR[3]·2+4.5)/3
const ATR_BARS = [C(10, 8, 9), C(11, 9, 10), C(12, 9.5, 11), C(11.5, 10, 10.5), C(15, 14, 14.5)];

test("true range and Wilder ATR", () => {
  assert.deepStrictEqual(I.trueRange(ATR_BARS), [2, 2, 2.5, 1.5, 4.5]);
  const a = I.atr(ATR_BARS, 3);
  assert.equal(a[1], null);
  const a2 = 6.5 / 3, a3 = (a2 * 2 + 1.5) / 3, a4 = (a3 * 2 + 4.5) / 3;
  near(a[2], a2); near(a[3], a3); near(a[4], a4);
  near(a[4], 2.796296, 1e-5);
});

// Independent reference ADX using the AVERAGE form of Wilder smoothing (the module uses the
// running-sum form; the DI ratios must be identical).
function refAdx(cs, n) {
  const N = cs.length, pdi = Array(N).fill(null), mdi = Array(N).fill(null), adx = Array(N).fill(null);
  const tr = [], pd = [], md = [];
  for (let i = 1; i < N; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pd.push(up > dn && up > 0 ? up : 0); md.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  let aT = 0, aP = 0, aM = 0;
  const dx = [];
  for (let j = 0; j < tr.length; j++) {
    if (j < n) { aT += tr[j] / n; aP += pd[j] / n; aM += md[j] / n; if (j < n - 1) continue; }
    else { aT = (aT * (n - 1) + tr[j]) / n; aP = (aP * (n - 1) + pd[j]) / n; aM = (aM * (n - 1) + md[j]) / n; }
    const p = (100 * aP) / aT, m = (100 * aM) / aT;
    pdi[j + 1] = p; mdi[j + 1] = m;
    dx.push({ i: j + 1, v: (100 * Math.abs(p - m)) / (p + m) });
  }
  let a = null;
  dx.forEach((d, k) => {
    if (k < n - 1) return;
    a = k === n - 1 ? dx.slice(0, n).reduce((s, q) => s + q.v, 0) / n : (a * (n - 1) + d.v) / n;
    adx[d.i] = a;
  });
  return { adx, pdi, mdi };
}

test("adx/dmi matches an independent Wilder reference and edge cases", () => {
  const rnd = mulberry32(7);
  let p = 100;
  const cs = [];
  for (let i = 0; i < 120; i++) {
    const o = p; p = p * Math.exp(0.01 * gauss(rnd) + 0.001);
    cs.push({ t: i, o, c: p, h: Math.max(o, p) * (1 + 0.005 * rnd()), l: Math.min(o, p) * (1 - 0.005 * rnd()), v: 1 });
  }
  const got = I.adx(cs, 14), ref = refAdx(cs, 14);
  assert.equal(got.pdi[13], null);
  assert.ok(got.pdi[14] !== null, "DI starts at index n");
  assert.equal(got.adx[26], null);
  assert.ok(got.adx[27] !== null, "ADX starts at index 2n−1");
  for (let i = 0; i < cs.length; i++) {
    if (ref.pdi[i] === null) { assert.equal(got.pdi[i], null); continue; }
    near(got.pdi[i], ref.pdi[i], 1e-9); near(got.mdi[i], ref.mdi[i], 1e-9);
    if (ref.adx[i] !== null) near(got.adx[i], ref.adx[i], 1e-9);
  }
  // A staircase that only ever goes up has −DM ≡ 0 → −DI 0, DX 100, ADX 100.
  const up = Array.from({ length: 40 }, (_, i) => C(10 + i + 1, 10 + i, 10 + i + 0.5));
  const u = I.adx(up, 5);
  near(u.adx[39], 100); near(u.mdi[39], 0); assert.ok(u.pdi[39] > 0);
});

test("stochastic, williams %R, CCI hand values", () => {
  const cs = [C(10, 8, 9), C(12, 9, 11), C(11, 7, 10), C(13, 10, 12)];
  const s = I.stochastic(cs, 3, 2);
  // bar2: HH 12, LL 7, c 10 → 60 ; bar3: HH 13, LL 7, c 12 → 83.33 ; %D(2) at bar3 = 71.67
  near(s.k[2], 60); near(s.k[3], 500 / 6); near(s.d[3], (60 + 500 / 6) / 2);
  assert.equal(s.d[2], null);
  const w = I.williamsR(cs, 3);
  near(w[2], -40); near(w[3], -100 / 6);
  // CCI: typical prices 1,2,3 → sma 2, mean dev 2/3 → (3−2)/(0.015·2/3) = 100
  const cc = I.cci([C(1, 1, 1), C(2, 2, 2), C(3, 3, 3)], 3);
  near(cc[2], 100);
});

test("roc, obv, mfi, vwap hand values", () => {
  assert.deepStrictEqual(I.roc([100, 110, 99], 1).map((v) => v && Math.round(v * 1e9) / 1e9), [null, 10, -10]);
  const cs = [10, 11, 10.5, 10.5, 12].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: (i + 1) * 100 }));
  assert.deepStrictEqual(I.obv(cs), [0, 200, -100, -100, 400]);
  // MFI n=2 with tp = c: flows +11, −20, +12 → mfi[2] = 100 − 100/(1+11/20), mfi[3] = 100 − 100/(1+12/20)
  const m = I.mfi([10, 11, 10, 12].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: [1, 1, 2, 1][i] })), 2);
  assert.equal(m[1], null);
  near(m[2], 100 - 100 / (1 + 11 / 20)); near(m[3], 37.5);
  // VWAP: tp 10 (v 1), tp 20 (v 3) → (10 + 60)/4 = 17.5
  const v = I.vwap([C(10, 10, 10, 1), C(20, 20, 20, 3)]);
  near(v[0], 10); near(v[1], 17.5);
  // zero volume → running mean typical price (no NaN)
  assert.deepStrictEqual(I.vwap([C(10, 10, 10, 0), C(20, 20, 20, 0)]), [10, 15]);
});

test("donchian, keltner, ichimoku, supertrend", () => {
  const cs = Array.from({ length: 80 }, (_, i) => C(100 + i + 1, 100 + i - 1, 100 + i));
  const d = I.donchian(cs, 20);
  assert.equal(d.upper[18], null);
  assert.equal(d.upper[19], 120); assert.equal(d.lower[19], 99); assert.equal(d.mid[19], 109.5);
  const k = I.keltner(cs, 20, 2), e = I.ema(cs.map((c) => c.c), 20), a = I.atr(cs, 20);
  near(k.upper[50], e[50] + 2 * a[50]); near(k.lower[50], e[50] - 2 * a[50]);
  const ich = I.ichimoku(cs);
  // tenkan at 79 = (max h of 71..79 + min l of 71..79)/2 = (180 + 170)/2
  near(ich.tenkan[79], 175);
  near(ich.kijun[79], ((180) + (153)) / 2);
  // spanA at bar i is the lead value computed 26 bars earlier
  near(ich.spanA[79], ich.spanALead[53]);
  assert.equal(ich.spanB[76], null); // lead B first at 51, shifted → 77
  assert.ok(ich.spanB[77] !== null);
  // supertrend: rising → +1; after a crash → −1
  const crash = [...cs, ...Array.from({ length: 10 }, (_, i) => C(150 - i * 5 + 1, 150 - i * 5 - 1, 150 - i * 5))];
  const st = I.supertrend(crash, 10, 3);
  assert.equal(st.dir[79], 1);
  assert.ok(st.line[79] < cs[79].c);
  assert.equal(st.dir[89], -1);
  assert.ok(st.line[89] > crash[89].c);
});

test("returns, realized vol, efficiency ratio, linreg slope, zscore, percentileRank", () => {
  const lr = I.logReturns([1, Math.E, Math.E]);
  assert.equal(lr[0], null); near(lr[1], 1); near(lr[2], 0);
  // alternating ±r log returns → sample stdev over n=2 of (+r, −r) = r·√2
  const r = 0.01, x = [100];
  for (let i = 0; i < 10; i++) x.push(x[i] * Math.exp(i % 2 ? -r : r));
  const rv = I.realizedVol(x, 2);
  assert.equal(rv[1], null);
  near(rv[2], r * Math.SQRT2, 1e-12);
  // ER: straight line = 1, zig-zag with no net progress = 0
  near(I.efficiencyRatio([1, 2, 3, 4, 5], 4)[4], 1);
  near(I.efficiencyRatio([1, 2, 1, 2, 1], 4)[4], 0);
  near(I.efficiencyRatio([1, 2, 1, 2, 3], 4)[4], 2 / 4);
  const g = Array.from({ length: 30 }, (_, i) => 50 * Math.exp(0.01 * i));
  near(I.linregSlope(g, 10)[29], 0.01, 1e-12);
  assert.equal(I.linregSlope(g, 10)[8], null);
  near(I.zscore([1, 2, 3], 3)[2], 1 / Math.sqrt(2 / 3));
  assert.equal(I.zscore([4, 4, 4], 3)[2], 0);
  assert.deepStrictEqual(I.percentileRank([1, 2, 3, 4], 3), [null, null, 1, 1]);
  assert.deepStrictEqual(I.percentileRank([4, 3, 2, 1], 3), [null, null, 0, 0]);
  near(I.percentileRank([1, 3, 2], 3)[2], 0.5);
});

test("hurst: ≈0.5 for a random walk, higher for persistent, lower for anti-persistent", () => {
  assert.equal(I.hurst(Array.from({ length: 40 }, (_, i) => 100 + i)), null, "needs >= 64 points");
  const rnd = mulberry32(42);
  const build = (phi) => {
    const p = [100]; let e = 0;
    for (let i = 0; i < 2000; i++) { e = phi * e + gauss(rnd); p.push(p[i] * Math.exp(0.01 * e)); }
    return p;
  };
  const hRW = I.hurst(build(0)), hP = I.hurst(build(0.7)), hA = I.hurst(build(-0.7));
  assert.ok(Math.abs(hRW - 0.5) < 0.08, `random walk H ${hRW}`);
  assert.ok(hP > hRW + 0.05, `persistent H ${hP}`);
  assert.ok(hA < hRW - 0.05, `anti-persistent H ${hA}`);
  // expected R/S sanity: grows with m
  assert.ok(I.expectedRS(64) > I.expectedRS(16));
});

test("kalmanTrend recovers the drift of a noisy exponential trend", () => {
  const rnd = mulberry32(3);
  const x = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.004 * i + 0.01 * gauss(rnd)));
  const k = I.kalmanTrend(x);
  assert.equal(k.slope[3], null);
  near(k.slope[399], 0.004, 0.0015, "slope");
  assert.ok(k.slopeSE[399] > 0);
  near(k.level[399] / (100 * Math.exp(0.004 * 399)), 1, 0.03, "level (price units)");
  // noise-free exponential: exact slope
  const g = Array.from({ length: 200 }, (_, i) => 10 * Math.exp(0.01 * i));
  near(I.kalmanTrend(g).slope[199], 0.01, 1e-4);
});

test("no NaN/Infinity leaks on degenerate inputs", () => {
  const rnd = mulberry32(11);
  const cs = [];
  let p = 50;
  for (let i = 0; i < 300; i++) {
    if (i > 100 && i < 140) { cs.push({ t: i, o: p, h: p, l: p, c: p, v: 0 }); continue; } // dead flat, no volume
    const o = p; p = Math.max(0.01, p * Math.exp(0.03 * gauss(rnd)));
    cs.push({ t: i, o, c: p, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, v: rnd() < 0.2 ? 0 : 1000 * rnd() });
  }
  const x = cs.map((c) => c.c);
  const outs = [
    I.sma(x, 20), I.ema(x, 20), I.wma(x, 20), I.stdev(x, 20), I.rsi(x), I.macd(x), I.bollinger(x), I.atr(cs),
    I.adx(cs), I.stochastic(cs), I.cci(cs), I.williamsR(cs), I.roc(x, 10), I.obv(cs), I.mfi(cs), I.vwap(cs),
    I.donchian(cs), I.keltner(cs), I.ichimoku(cs), I.supertrend(cs), I.logReturns(x), I.realizedVol(x, 20),
    I.efficiencyRatio(x, 20), I.linregSlope(x, 20), I.zscore(x, 20), I.percentileRank(x, 50), I.kalmanTrend(x),
    [I.hurst(x)],
  ];
  const check = (a) => {
    if (Array.isArray(a)) {
      assert.equal(a.length === 1 || a.length === x.length, true);
      for (const v of a) assert.ok(v === null || Number.isFinite(v), `bad value ${v}`);
    } else for (const k of Object.keys(a)) check(a[k]);
  };
  outs.forEach(check);
  // short / empty inputs
  assert.deepStrictEqual(I.sma([], 5), []);
  assert.deepStrictEqual(I.atr([], 14), []);
  assert.deepStrictEqual(I.adx([C(1, 1, 1)], 14).adx, [null]);
  assert.deepStrictEqual(I.rsi([1], 14), [null]);
  assert.equal(I.hurst([]), null);
  assert.deepStrictEqual(I.logReturns([1, 0, 2, NaN, 3]), [null, null, null, null, null]);
});
