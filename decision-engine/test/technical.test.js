const test = require("node:test");
const assert = require("node:assert");
const T = require("../server/analysis/technical");

const DAY = 86400000;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Candles from a close path with deterministic intrabar noise.
function fromCloses(closes, { seed = 1, dt = DAY, vol = () => 1000, wick = 0.004 } = {}) {
  const rnd = mulberry32(seed);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return {
      t: 1.7e12 + i * dt, o, c,
      h: Math.max(o, c) * (1 + wick * rnd()), l: Math.min(o, c) * (1 - wick * rnd()),
      v: vol(i, rnd),
    };
  });
}
function trendPath(n, drift, sigma, seed = 5, p0 = 100) {
  const rnd = mulberry32(seed), p = [p0];
  for (let i = 1; i < n; i++) p.push(p[i - 1] * Math.exp(drift + sigma * gauss(rnd)));
  return p;
}
// Noisy range: 14-bar cycle ±4 around 100 plus noise (low ADX / efficiency ratio).
function rangePath(n, seed = 4) {
  const rnd = mulberry32(seed), p = [];
  for (let i = 0; i < n; i++) p.push(100 + 4 * Math.sin((2 * Math.PI * i) / 14) + 0.8 * gauss(rnd));
  return p;
}
const byId = (sigs) => Object.fromEntries(sigs.map((s) => [s.id, s]));

function assertWellFormed(sigs, prefix = "tech.") {
  assert.ok(sigs.length > 0);
  const seen = new Set();
  for (const s of sigs) {
    assert.ok(s.id.startsWith(prefix), s.id);
    assert.ok(!seen.has(s.id), `duplicate ${s.id}`); seen.add(s.id);
    assert.equal(s.family, "technical");
    assert.ok(Number.isFinite(s.score) && s.score >= -1 && s.score <= 1, `${s.id} score ${s.score}`);
    assert.ok(Number.isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1, `${s.id} conf ${s.confidence}`);
    assert.equal(typeof s.reason, "string"); assert.ok(s.reason.length > 10);
    assert.ok(!/NaN|Infinity|undefined/.test(s.reason), `${s.id} reason: ${s.reason}`);
    assert.ok(s.horizon);
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(s.value)), `${s.id} value`);
  }
}

test("needs >= 60 candles; bad input → []", () => {
  assert.deepStrictEqual(T.analyze(fromCloses(trendPath(59, 0, 0.01))), []);
  assert.deepStrictEqual(T.analyze(null), []);
  assert.deepStrictEqual(T.analyze([]), []);
  assert.ok(T.analyze(fromCloses(trendPath(60, 0, 0.01))).length > 0);
});

test("strong uptrend: trend family bullish, mean-reversion faded", () => {
  const up = fromCloses(trendPath(300, 0.006, 0.01, 9));
  const sigs = T.analyze(up, { horizon: "swing", assetClass: "crypto" });
  assertWellFormed(sigs);
  const s = byId(sigs);
  for (const id of ["tech.trend.ema_stack", "tech.trend.supertrend", "tech.trend.adx_dmi", "tech.trend.linreg",
    "tech.trend.kalman", "tech.trend.ichimoku", "tech.momentum.tsmom", "tech.structure.extremes"]) {
    assert.ok(s[id].score > 0.2, `${id} ${s[id].score} ${s[id].reason}`);
  }
  assert.ok(s["tech.trend.ema_stack"].score > 0.6);
  assert.match(s["tech.trend.ema_stack"].reason, /established uptrend/);
  assert.equal(s["tech.trend.ema_stack"].horizon, "swing");
  // In a strong trend RSI is read as momentum (not "overbought → sell").
  assert.ok(s["tech.momentum.rsi"].score > 0, s["tech.momentum.rsi"].reason);

  // Same stats in a sideways market: mean-reversion confidence must be higher than in the trend.
  const side = fromCloses([...rangePath(299), 106.5]);
  const r = byId(T.analyze(side, { horizon: "swing" }));
  for (const id of ["tech.meanrev.bollinger", "tech.meanrev.zscore", "tech.meanrev.williams_r", "tech.momentum.stochastic"]) {
    // compare the context multiplier: confidence per unit of |score|-driven strength is lower in trend
    assert.ok(r[id].confidence > 0 && s[id].confidence >= 0);
  }
  // Direct context check: the *same* stretched reading is trusted less in a trend.
  const trendMR = s["tech.meanrev.zscore"].confidence / (0.15 + 0.5 * Math.min(1, Math.abs(s["tech.meanrev.zscore"].value.z) / 2.5));
  const rangeMR = r["tech.meanrev.zscore"].confidence / (0.15 + 0.5 * Math.min(1, Math.abs(r["tech.meanrev.zscore"].value.z) / 2.5));
  assert.ok(trendMR < rangeMR - 0.2, `trend ctx ${trendMR} vs range ctx ${rangeMR}`);
  // and trend-following confidence is lower in chop
  assert.ok(r["tech.trend.ema_stack"].confidence < s["tech.trend.ema_stack"].confidence);
});

test("downtrend mirrors uptrend", () => {
  const dn = fromCloses(trendPath(300, -0.006, 0.01, 9));
  const s = byId(T.analyze(dn, { horizon: "swing" }));
  for (const id of ["tech.trend.ema_stack", "tech.trend.supertrend", "tech.trend.adx_dmi", "tech.trend.kalman", "tech.momentum.tsmom"]) {
    assert.ok(s[id].score < -0.2, `${id} ${s[id].score}`);
  }
});

test("range: top of the range is a mean-reversion sell, bottom a buy", () => {
  // Noisy range; the last bar pokes to the top / bottom of the range.
  const base = rangePath(200);
  const top = byId(T.analyze(fromCloses([...base, 106.5]), {}));
  const bot = byId(T.analyze(fromCloses([...base, 93.5]), {}));
  assert.ok(Math.abs(top["tech.trend.ema_stack"].score) < 0.5, top["tech.trend.ema_stack"].reason);
  assert.ok(!/established/.test(top["tech.trend.ema_stack"].reason));
  for (const id of ["tech.meanrev.bollinger", "tech.meanrev.zscore", "tech.meanrev.williams_r"]) {
    assert.ok(top[id].score < -0.3, `top ${id} ${top[id].score} ${top[id].reason}`);
    assert.ok(bot[id].score > 0.3, `bottom ${id} ${bot[id].score} ${bot[id].reason}`);
  }
  assert.ok(top["tech.momentum.rsi"].score < 0, top["tech.momentum.rsi"].reason);
  assert.ok(bot["tech.momentum.rsi"].score > 0, bot["tech.momentum.rsi"].reason);
  assert.equal(top["tech.momentum.rsi"].horizon, "any");
});

test("volume-confirmed breakout vs unconfirmed", () => {
  const base = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.9) * 1.2);
  const closes = [...base, 104.5];
  const loud = fromCloses(closes, { vol: (i) => (i === 100 ? 4000 : 1000) });
  const quiet = fromCloses(closes, { vol: () => 1000 });
  const a = byId(T.analyze(loud))["tech.volume.breakout"];
  const b = byId(T.analyze(quiet))["tech.volume.breakout"];
  assert.ok(a.score > 0.4 && a.confidence > 0.4, JSON.stringify(a));
  assert.match(a.reason, /volume-confirmed/);
  assert.ok(b.score > 0 && b.score < a.score && b.confidence < a.confidence, JSON.stringify(b));
  // breakdown
  const dn = byId(T.analyze(fromCloses([...base, 95.5], { vol: (i) => (i === 100 ? 4000 : 1000) })))["tech.volume.breakout"];
  assert.ok(dn.score < -0.4, JSON.stringify(dn));
  // and the Donchian structure signal sees the new high
  assert.ok(byId(T.analyze(loud))["tech.structure.donchian"].score > 0.4);
});

test("no volume → volume signals omitted, nothing NaN", () => {
  const cs = fromCloses(trendPath(200, 0.001, 0.02, 3), { vol: () => 0 });
  const sigs = T.analyze(cs);
  assertWellFormed(sigs);
  assert.ok(!sigs.some((s) => s.id.startsWith("tech.volume.")));
  // flat price, zero volume: must not blow up
  const flat = Array.from({ length: 120 }, (_, i) => ({ t: i * DAY, o: 50, h: 50, l: 50, c: 50, v: 0 }));
  assertWellFormed(T.analyze(flat));
});

test("bullish RSI divergence on swing lows", () => {
  // Capitulation leg (steep → RSI very low) to low A, relief rally, then a slow grind to a slightly
  // lower low B (RSI higher), then a 4-bar bounce that confirms pivot B.
  const p = [];
  let x = 120;
  for (let i = 0; i < 60; i++) { x += Math.sin(i) * 0.6; p.push(x); }          // noise
  for (let i = 0; i < 8; i++) { x -= 2.5; p.push(x); }                       // crash → A
  const A = x;
  for (let i = 0; i < 8; i++) { x += 1.2; p.push(x); }                       // relief
  for (let i = 0; i < 14; i++) { x -= (i % 3 === 2 ? -0.35 : 0.95); p.push(x); } // grind
  p[p.length - 1] = A - 0.8; x = A - 0.8;                                    // B < A
  for (let i = 0; i < 4; i++) { x += 0.9; p.push(x); }                       // confirm
  const s = byId(T.analyze(fromCloses(p, { wick: 0 })));
  const d = s["tech.divergence.rsi"];
  assert.ok(d.score > 0.3, JSON.stringify(d));
  assert.ok(d.confidence > 0.2);
  assert.match(d.reason, /Bullish RSI divergence/);
  assert.ok(d.value.rsiB > d.value.rsiA && d.value.priceB < d.value.priceA);
  // mirrored price path → bearish divergence
  const m = byId(T.analyze(fromCloses(p.map((v) => 240 - v), { wick: 0 })))["tech.divergence.rsi"];
  assert.ok(m.score < -0.3, JSON.stringify(m));
});

test("squeeze detection: compression after a volatile stretch", () => {
  const rnd = mulberry32(21);
  const p = [100];
  for (let i = 1; i < 160; i++) p.push(p[i - 1] * Math.exp((i < 120 ? 0.03 : 0.002) * gauss(rnd)));
  const sq = byId(T.analyze(fromCloses(p, { wick: 0.001 })))["tech.volatility.squeeze"];
  assert.equal(sq.value.squeezeOn, true, sq.reason);
  assert.ok(sq.value.onBars >= 5);
  assert.ok(sq.value.bandwidthPctile < 0.2);
  assert.ok(Math.abs(sq.score) <= 0.25);
});

test("support/resistance from pivots and 52w extremes", () => {
  const up = byId(T.analyze(fromCloses(trendPath(300, 0.004, 0.012, 2))));
  const ex = up["tech.structure.extremes"];
  assert.ok(ex.value.pos > 0.8 && ex.score > 0.3, JSON.stringify(ex));
  assert.match(ex.reason, /52-week high/);
  const sr = up["tech.structure.support_resistance"];
  assert.ok(sr && Number.isFinite(sr.score));
});

test("time-series momentum scales lookback to history and bar size", () => {
  const d = byId(T.analyze(fromCloses(trendPath(400, 0.002, 0.01, 4))))["tech.momentum.tsmom"];
  assert.equal(d.value.lookback, 252); assert.equal(d.value.skip, 21);
  assert.ok(d.score > 0.3);
  const short = byId(T.analyze(fromCloses(trendPath(120, 0.002, 0.01, 4))))["tech.momentum.tsmom"];
  assert.ok(short.value.lookback <= 118);
  // 15-minute bars: 252 days is far beyond history → uses what exists, never NaN
  const m15 = byId(T.analyze(fromCloses(trendPath(500, 0.0005, 0.003, 4), { dt: 900000 }), { horizon: "intraday" }))["tech.momentum.tsmom"];
  assert.ok(m15.value.lookback <= 498 && Number.isFinite(m15.score));
});

test("multiTimeframe prefixes ids and emits tech.mtf.alignment", () => {
  const d1 = fromCloses(trendPath(300, 0.004, 0.01, 1));
  const h1 = fromCloses(trendPath(300, 0.001, 0.004, 2), { dt: 3600000 });
  const m15 = fromCloses(trendPath(300, 0.0005, 0.002, 3), { dt: 900000 });
  const sigs = T.multiTimeframe({ "1d": d1, "1h": h1, "15m": m15 }, { horizon: "swing" });
  const ids = new Set(sigs.map((s) => s.id));
  assert.ok(ids.has("tech.1h.trend.ema_stack"));
  assert.ok(ids.has("tech.15m.momentum.rsi"));
  assert.ok(ids.has("tech.1d.trend.supertrend"));
  assert.ok(!ids.has("tech.trend.ema_stack"));
  const al = sigs.find((s) => s.id === "tech.mtf.alignment");
  assert.ok(al && al.score > 0.3 && al.confidence > 0.5, JSON.stringify(al));
  assert.match(al.reason, /aligned/);
  assertWellFormed(sigs);
  // conflicting timeframes → low confidence
  const dn = fromCloses(trendPath(300, -0.004, 0.01, 1));
  const c = T.multiTimeframe({ "1d": dn, "1h": h1 }, {}).find((s) => s.id === "tech.mtf.alignment");
  assert.ok(c.confidence < al.confidence, JSON.stringify(c));
  assert.deepStrictEqual(T.multiTimeframe(null), []);
  assert.deepStrictEqual(T.multiTimeframe({ "1h": [] }), []);
  assert.equal(T.tfSeconds("4h"), 14400);
});

test("fuzz: random walks never produce NaN and stay in range", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = mulberry32(seed);
    const n = 60 + Math.floor(rnd() * 500);
    const cs = fromCloses(trendPath(n, (rnd() - 0.5) * 0.01, 0.002 + rnd() * 0.05, seed, 0.05 + rnd() * 1e5),
      { seed, vol: (i, r) => (r() < 0.1 ? 0 : r() * 1e6), wick: rnd() * 0.02 });
    assertWellFormed(T.analyze(cs, { horizon: ["intraday", "swing", "position"][seed % 3] }));
  }
});

test("performance: analyze() on 600 candles is fast", () => {
  const cs = fromCloses(trendPath(600, 0.001, 0.02, 8));
  T.analyze(cs); // warm-up / JIT
  const t0 = performance.now();
  const reps = 5;
  for (let i = 0; i < reps; i++) T.analyze(cs, { horizon: "position" });
  const ms = (performance.now() - t0) / reps;
  assert.ok(ms < 40, `analyze took ${ms.toFixed(1)} ms`);
});

// ── Audit regressions (2026-09) ──
test("audit: multiTimeframe tags sub-daily signals 'intraday' for daily-based horizons", () => {
  const d1 = fromCloses(trendPath(300, 0.004, 0.01, 1));
  const h1 = fromCloses(trendPath(300, 0.001, 0.004, 2), { dt: 3600000 });
  const m15 = fromCloses(trendPath(300, 0.0005, 0.002, 3), { dt: 900000 });
  const swing = T.multiTimeframe({ "1d": d1, "1h": h1, "15m": m15 }, { horizon: "swing" });
  const byTf = (tf) => swing.filter((s) => s.id.startsWith(`tech.${tf}.`));
  assert.ok(byTf("1d").every((s) => s.horizon === "swing"));
  assert.ok(byTf("1h").every((s) => s.horizon === "intraday") && byTf("15m").every((s) => s.horizon === "intraday"));
  // lookbacks are unchanged: only the tag differs from a plain analyze() of the same series
  const plain = T.analyze(h1, { horizon: "swing" });
  for (const s of plain) {
    const m = swing.find((x) => x.id === `tech.1h.${s.id.slice(5)}`);
    assert.ok(m && m.score === s.score && m.confidence === s.confidence, s.id);
  }
  // intraday requests keep "intraday" everywhere; position keeps "position" on daily bars
  const intra = T.multiTimeframe({ "1d": d1, "15m": m15 }, { horizon: "intraday" });
  assert.ok(intra.filter((s) => s.id !== "tech.mtf.alignment").every((s) => s.horizon === "intraday"));
  assert.strictEqual(T.horizonForTf("1d", "position"), "position");
  assert.strictEqual(T.horizonForTf("4h", "swing"), "intraday");
});

test("audit: a still-forming last bar gets its volume pro-rated (volume signals no longer read a fake collapse)", () => {
  const I = require("../server/analysis/indicators");
  const DAY = 86400000;
  const cs = fromCloses(trendPath(300, 0.002, 0.01, 5)).map((c, i) => ({ ...c, t: i * DAY, v: 1000 }));
  const now = cs.at(-1).t + 0.25 * DAY;                         // 25% into the last (forming) bar
  const partial = cs.map((c, i) => (i === cs.length - 1 ? { ...c, v: 250 } : c));
  const proj = I.projectFormingVolume(partial, { now });
  assert.strictEqual(proj.at(-1).v, 1000);
  assert.strictEqual(proj.at(-1).vRaw, 250);
  assert.strictEqual(partial.at(-1).v, 250, "input is not mutated");
  // completed histories (backtests) are returned unchanged
  assert.strictEqual(I.projectFormingVolume(partial, { now: cs.at(-1).t + 2 * DAY }), partial);
  // a partial bar analysed "live" matches the complete-bar volume signals
  const live = T.analyze(partial, { horizon: "swing", now });
  const full = T.analyze(cs, { horizon: "swing", now: cs.at(-1).t + 5 * DAY });
  const pick = (a, id) => a.find((s) => s.id === id);
  for (const id of ["tech.volume.obv", "tech.volume.mfi"]) assert.deepStrictEqual(pick(live, id).score, pick(full, id).score, id);
});

test("audit: the 52-week extremes window is 365 daily bars for crypto, 252 sessions for stocks", () => {
  const cs = fromCloses(trendPath(500, 0.001, 0.01, 9));
  const ex = (cls) => T.analyze(cs, { horizon: "swing", assetClass: cls }).find((s) => s.id === "tech.structure.extremes");
  assert.strictEqual(ex("crypto").value.bars, 365);
  assert.strictEqual(ex("stock").value.bars, 252);
  assert.match(ex("crypto").reason, /52-week/);
});
