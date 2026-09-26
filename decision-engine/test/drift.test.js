"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { PageHinkley, AdwinLite, DriftMonitor, logLoss, PH_DEFAULTS } = require("../server/learning/drift");

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const SEEDS = 200, CHANGE = 500;

test("PageHinkley documented parameters", () => {
  assert.strictEqual(PH_DEFAULTS.delta, 0.2);
  assert.strictEqual(PH_DEFAULTS.lambda, 25);
  assert.strictEqual(PH_DEFAULTS.burnIn, 50);
});

test("PageHinkley: stationary false-alarm rate is low and a mean shift is detected quickly (measured)", () => {
  // False alarms: 2,000 stationary N(0,1) observations per seed.
  let fa = 0;
  for (let s = 0; s < SEEDS; s++) {
    const r = rng(1000 + s), ph = new PageHinkley();
    for (let i = 0; i < 2000; i++) if (ph.update(gauss(r)).alarm) { fa++; break; }
  }
  // Detection delay: mean shifts by +1σ / +0.5σ after observation 500.
  const delays = {};
  for (const shift of [1, 0.5]) {
    const d = [];
    let missed = 0, early = 0;
    for (let s = 0; s < SEEDS; s++) {
      const r = rng(5000 + s), ph = new PageHinkley();
      let det = -1;
      for (let i = 0; i < 2500; i++) {
        if (ph.update(gauss(r) + (i >= CHANGE ? shift : 0)).alarm) { if (i < CHANGE) early++; else { det = i - CHANGE; break; } }
      }
      if (det < 0) missed++; else d.push(det);
    }
    delays[shift] = { median: median(d), p90: q(d, 0.9), missed, early };
  }
  const faRate = fa / SEEDS;
  console.log(`# PageHinkley δ=0.2σ λ=25σ: false alarms ${fa}/${SEEDS} = ${(100 * faRate).toFixed(1)}% per 2000 stationary obs; ` +
    `+1σ shift: median delay ${delays[1].median} obs (p90 ${delays[1].p90}, missed ${delays[1].missed}); ` +
    `+0.5σ: median ${delays[0.5].median} (p90 ${delays[0.5].p90}, missed ${delays[0.5].missed})`);
  assert.ok(faRate <= 0.05, `false-alarm rate ${faRate}`);
  assert.ok(delays[1].median <= 40 && delays[1].missed === 0, JSON.stringify(delays[1]));
  assert.ok(delays[0.5].median <= 120 && delays[0.5].missed <= 2, JSON.stringify(delays[0.5]));
});

test("PageHinkley ignores decreases (one-sided: only degradation alarms)", () => {
  const r = rng(7), ph = new PageHinkley();
  for (let i = 0; i < 3000; i++) assert.strictEqual(ph.update(gauss(r) - (i >= 300 ? 2 : 0)).alarm, false);
});

function stream(seed, n, change, after) {
  // calibrated model: p ~ U(0.35, 0.70), y ~ Bernoulli(p); after `change` the relation breaks
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const p = 0.35 + 0.35 * r();
    const y = i < change ? (r() < p ? 1 : 0) : after(p, r);
    out.push([p, y]);
  }
  return out;
}

test("DriftMonitor on live-like (p, y) streams: false-alarm rate and detection delay (measured)", () => {
  let fa = 0;
  for (let s = 0; s < SEEDS; s++) {
    const m = new DriftMonitor();
    for (const [p, y] of stream(100 + s, 2000, Infinity)) if (m.update(p, y).drift) { fa++; break; }
  }
  // Regime change: the model's calls turn wrong (y ~ Bernoulli(1 − p)): hit rate ~57% → ~43%,
  // mean log-loss ~0.67 → ~0.73 (≈ 0.3σ per decision — a realistic, small shift).
  const d = [];
  let missed = 0;
  const triggers = {};
  for (let s = 0; s < SEEDS; s++) {
    const m = new DriftMonitor();
    let det = -1;
    const st = stream(9000 + s, 2500, CHANGE, (p, r) => (r() < 1 - p ? 1 : 0));
    for (let i = 0; i < st.length; i++) {
      const u = m.update(st[i][0], st[i][1]);
      if (u.drift && i >= CHANGE) { det = i - CHANGE; for (const t of u.triggers) triggers[t] = (triggers[t] || 0) + 1; break; }
    }
    if (det < 0) missed++; else d.push(det);
  }
  const faRate = fa / SEEDS;
  console.log(`# DriftMonitor (PH loss + PH miss + ADWIN): false alarms ${fa}/${SEEDS} = ${(100 * faRate).toFixed(1)}% per 2000 decisions; ` +
    `calibrated→inverted model: median delay ${median(d)} decisions (p90 ${q(d, 0.9)}), missed ${missed}/${SEEDS} within 2000; first triggers ${JSON.stringify(triggers)}`);
  assert.ok(faRate <= 0.05, `false-alarm rate ${faRate}`);
  assert.ok(median(d) <= 150, `median delay ${median(d)}`);
  assert.ok(missed / SEEDS <= 0.05, `missed ${missed}`);
});

test("DriftMonitor levels go ok → warn → drift, detectors reset after an alarm", () => {
  const m = new DriftMonitor();
  const st = stream(42, 3000, 400, () => 0);   // after 400: always y = 0 while p ≥ 0.35 → large loss increase
  const levels = [];
  let driftAt = -1;
  for (let i = 0; i < st.length; i++) {
    const u = m.update(st[i][0], st[i][1]);
    levels.push(u.level);
    if (u.drift) { driftAt = i; break; }
  }
  assert.ok(driftAt > 400 && driftAt < 480, `drift at ${driftAt}`);
  assert.ok(levels.slice(0, 400).every((l) => l !== "drift"));
  assert.ok(levels.includes("warn"), "passes through warn before drift");
  assert.strictEqual(levels[driftAt], "drift");
  const s = m.stat();
  assert.strictEqual(s.nDrifts, 1);
  assert.ok(s.lastDrift && s.lastDrift.triggers.length >= 1);
  assert.strictEqual(m.phLoss.stat, 0, "change statistic restarts after an alarm");
  // invalid inputs are ignored
  const before = m.n;
  assert.strictEqual(m.update(NaN, 1).skipped, true);
  assert.strictEqual(m.update(0.6, 2).skipped, true);
  assert.strictEqual(m.n, before);
});

test("DriftMonitor toJSON/fromJSON round-trip continues identically", () => {
  const st = stream(77, 1500, 700, (p, r) => (r() < 1 - p ? 1 : 0));
  const a = new DriftMonitor();
  for (let i = 0; i < 600; i++) a.update(st[i][0], st[i][1]);
  const b = DriftMonitor.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  for (let i = 600; i < st.length; i++) {
    const ua = a.update(st[i][0], st[i][1]), ub = b.update(st[i][0], st[i][1]);
    assert.strictEqual(ua.drift, ub.drift);
    assert.strictEqual(ua.level, ub.level);
    assert.strictEqual(ua.stat.phLoss.stat, ub.stat.phLoss.stat);
  }
  assert.strictEqual(DriftMonitor.fromJSON(null).n, 0);
});

test("AdwinLite flags an abrupt increase, drops the stale window, and does not flag an improvement", () => {
  const r = rng(3);
  const up = new AdwinLite();
  let at = -1;
  for (let i = 0; i < 2000; i++) {
    const u = up.update(r() < (i < 500 ? 0.2 : 0.7) ? 1 : 0);
    if (u.drift) { at = i; assert.ok(u.width < 500 + (i - 500) + 1); break; }
  }
  assert.ok(at >= 500 && at < 650, `detected at ${at}`);
  const down = new AdwinLite();
  for (let i = 0; i < 2000; i++) assert.strictEqual(down.update(r() < (i < 500 ? 0.7 : 0.2) ? 1 : 0).drift, false);
  const rt = AdwinLite.fromJSON(JSON.parse(JSON.stringify(up.toJSON())));
  assert.strictEqual(rt.w.length, up.w.length);
});

test("logLoss clips probabilities to [0.01, 0.99]", () => {
  assert.ok(Math.abs(logLoss(0.7, 1) + Math.log(0.7)) < 1e-12);
  assert.ok(Math.abs(logLoss(0.7, 0) + Math.log(0.3)) < 1e-12);
  assert.ok(Math.abs(logLoss(1, 0) + Math.log(0.01)) < 1e-12);
});
