const test = require("node:test");
const assert = require("node:assert");
const R = require("../server/analysis/regime");

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

// Two-state Markov regime-switching returns: calm bull vs. volatile bear.
function regimeSwitching(n, seed, { stay = 0.98, mu = [-0.004, 0.003], sd = [0.03, 0.01] } = {}) {
  const rnd = mulberry32(seed);
  const states = [], rets = [];
  let s = 1;
  for (let t = 0; t < n; t++) {
    if (t > 0 && rnd() > stay) s = 1 - s;
    states.push(s);
    rets.push(mu[s] + sd[s] * gauss(rnd));
  }
  return { states, rets };
}
function toCandles(rets, p0 = 100) {
  let p = p0;
  return rets.map((r, i) => {
    const o = p; p = p * Math.exp(r);
    return { t: 1.7e12 + i * DAY, o, c: p, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, v: 1000 };
  });
}

test("fitHMM recovers two regimes' means and vols from synthetic data", () => {
  const { states, rets } = regimeSwitching(1500, 12345);
  const m = R.fitHMM(rets, 2);
  assert.ok(m, "model");
  assert.equal(m.k, 2);
  // sorted bearish → bullish
  assert.ok(m.means[0] < m.means[1]);
  assert.ok(Math.abs(m.vols[0] - 0.03) < 0.005, `bear vol ${m.vols[0]}`);
  assert.ok(Math.abs(m.vols[1] - 0.01) < 0.002, `bull vol ${m.vols[1]}`);
  assert.ok(Math.abs(m.means[0] - -0.004) < 0.003, `bear mean ${m.means[0]}`);
  assert.ok(Math.abs(m.means[1] - 0.003) < 0.0015, `bull mean ${m.means[1]}`);
  // sticky transitions recovered
  assert.ok(m.A[0][0] > 0.9 && m.A[1][1] > 0.9, JSON.stringify(m.A));
  for (const row of m.A) assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(m.pi.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(m.iters <= 50);
  assert.ok(Number.isFinite(m.logLik));

  // Filtering: the argmax filtered state matches the true state most of the time.
  let hits = 0, total = 0;
  for (let t = 100; t < rets.length; t += 25) {
    const f = R.hmmFilter(m, rets.slice(0, t + 1));
    assert.ok(Math.abs(f.probs.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    if (f.state === states[t]) hits++;
    total++;
  }
  assert.ok(hits / total > 0.85, `filter accuracy ${hits}/${total}`);
});

test("fitHMM with k=3 sorts states and is deterministic", () => {
  const { rets } = regimeSwitching(600, 99, { mu: [-0.005, 0.004], sd: [0.035, 0.012] });
  const a = R.fitHMM(rets, 3), b = R.fitHMM(rets, 3);
  assert.deepStrictEqual(a, b, "deterministic init → identical fits");
  assert.equal(a.means.length, 3);
  assert.ok(a.means[0] <= a.means[1] && a.means[1] <= a.means[2]);
  assert.ok(a.vols.every((v) => v > 0 && Number.isFinite(v)));
  // EM never decreases the likelihood: more iterations ≥ fewer.
  const l5 = R.fitHMM(rets, 3, { maxIter: 5 }).logLik, l30 = R.fitHMM(rets, 3, { maxIter: 30 }).logLik;
  assert.ok(l30 >= l5 - 1e-6, `${l30} < ${l5}`);
});

test("fitHMM guards: short, constant, outliers", () => {
  assert.equal(R.fitHMM([0.01, -0.01], 2), null);
  assert.equal(R.fitHMM(new Array(200).fill(0.001), 3), null, "zero variance");
  assert.equal(R.fitHMM(null), null);
  const { rets } = regimeSwitching(300, 5);
  rets[150] = 0.9; // absurd outlier
  rets[151] = NaN; // dropped
  const m = R.fitHMM(rets, 3);
  assert.ok(m && [...m.means, ...m.vars, m.logLik].every(Number.isFinite));
  const floor = 0.01 * (() => { const x = rets.filter(Number.isFinite); const mu = x.reduce((a, b) => a + b, 0) / x.length; return x.reduce((a, b) => a + (b - mu) ** 2, 0) / x.length; })();
  assert.ok(m.vars.every((v) => v >= floor * (1 - 1e-9)), "variance floor respected");
  assert.equal(R.hmmFilter(null, rets), null);
  assert.equal(R.hmmFilter(m, []), null);
});

test("HMM fit on 500 returns is fast (< 200 ms)", () => {
  const { rets } = regimeSwitching(500, 77);
  R.fitHMM(rets, 3); // warm-up
  const t0 = performance.now();
  R.fitHMM(rets.map((r) => r * 1.0001), 3);
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
});

test("detect: short input → neutral", () => {
  const r = R.detect([]);
  assert.equal(r.trend, "range"); assert.equal(r.vol, "normal"); assert.equal(r.hmm, null);
  assert.equal(r.label, "ranging/normal-vol");
  assert.deepStrictEqual(R.detect(null).label, "ranging/normal-vol");
});

test("detect: trending up + calm, then a volatility shock", () => {
  const rnd = mulberry32(8);
  const rets = Array.from({ length: 400 }, () => 0.004 + 0.008 * gauss(rnd));
  const r = R.detect(toCandles(rets));
  assert.equal(r.trend, "up", JSON.stringify(r));
  assert.ok(r.label.startsWith("trending-up/"));
  assert.ok(r.adx > 20 && r.efficiency > 0 && r.hurst !== null);
  assert.ok(r.hmm && r.hmm.probs.length === 3);
  assert.ok(Math.abs(r.hmm.probs.reduce((a, b) => a + b, 0) - 1) < 1e-3);
  assert.ok(r.hmm.state >= 0 && r.hmm.state < 3);

  const down = R.detect(toCandles(rets.map((x) => -x)));
  assert.equal(down.trend, "down");

  // calm range then a crash: vol should read high/extreme, not low
  const calm = Array.from({ length: 300 }, () => 0.006 * gauss(rnd));
  const shock = Array.from({ length: 15 }, () => -0.01 + 0.06 * gauss(rnd));
  const s = R.detect(toCandles([...calm, ...shock]));
  assert.ok(["high", "extreme"].includes(s.vol), s.vol);
  assert.ok(s.volPercentile > 0.9);
  const q = R.detect(toCandles(calm));
  assert.equal(q.trend, "range", JSON.stringify({ adx: q.adx, er: q.efficiency, dir: q.direction }));
  assert.match(q.label, /^ranging\//);
});

test("signals(regime): well-formed and directionally sensible", () => {
  const rnd = mulberry32(8);
  const up = R.detect(toCandles(Array.from({ length: 400 }, () => 0.004 + 0.008 * gauss(rnd))));
  const sigs = R.signals(up);
  const ids = sigs.map((s) => s.id);
  for (const id of ["regime.trend.state", "regime.hmm.state", "regime.vol.level", "regime.hurst.persistence"]) assert.ok(ids.includes(id), id);
  for (const s of sigs) {
    assert.equal(s.family, "regime");
    assert.ok(s.score >= -1 && s.score <= 1 && Number.isFinite(s.score));
    assert.ok(s.confidence >= 0 && s.confidence <= 1 && Number.isFinite(s.confidence));
    assert.ok(typeof s.reason === "string" && !/NaN|undefined/.test(s.reason), s.reason);
  }
  assert.ok(sigs.find((s) => s.id === "regime.trend.state").score > 0.3);
  const vol = R.signals({ ...up, vol: "extreme" }).find((s) => s.id === "regime.vol.level");
  assert.ok(vol.score < 0);
  // neutral regime → only low-information signals, nothing NaN
  const n = R.signals(R.detect([]));
  assert.ok(n.every((s) => Math.abs(s.score) < 0.01));
  assert.deepStrictEqual(R.signals(null), []);
});

// ── Audit regressions (2026-09) ──
test("audit: regime.trend.state is context only (confidence 0) — its evidence duplicates the technical trend signals", () => {
  const rnd = mulberry32(8);
  const up = R.detect(toCandles(Array.from({ length: 400 }, () => 0.004 + 0.008 * gauss(rnd))));
  const s = R.signals(up).find((x) => x.id === "regime.trend.state");
  assert.ok(s.score > 0.3, "direction still reported for the UI");
  assert.strictEqual(s.confidence, 0, "but it carries no weight in pooling");
  // the other regime signals still carry weight
  assert.ok(R.signals(up).some((x) => x.id !== "regime.trend.state" && x.confidence > 0));
});
