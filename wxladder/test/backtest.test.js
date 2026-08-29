const test = require("node:test");
const assert = require("node:assert");
const bt = require("../server/backtest");
const cfg = require("../server/config");

test("makeBuckets mirrors Polymarket's 11-bucket shape around our own centre", () => {
  const b = bt.makeBuckets(31);
  assert.equal(b.length, 11);
  assert.equal(b[0].type, "tail-low");
  assert.equal(b[10].type, "tail-high");
  assert.equal(b[5].deg, 31, "the modal bucket is the rounded centre");
  assert.ok(b.slice(1, 10).every(x => x.type === "exact"));
  assert.equal(bt.makeBuckets(30.6)[5].deg, 31, "centres on the rounded degree");
});

test("bucketIndexOf places a value, including far outside the ladder", () => {
  const b = bt.makeBuckets(31);
  assert.equal(b[bt.bucketIndexOf(b, 31)].deg, 31);
  assert.equal(bt.bucketIndexOf(b, -40), 0);
  assert.equal(bt.bucketIndexOf(b, 99), 10);
});

// A station with a steady +1.0 offset. Deterministic LCG noise stands in for genuine
// forecast error — without it the series is perfectly predictable and an arbitrarily sharp
// sigma would be correct, which is not the regime any of this has to survive.
function noisyPairs(n = 60, noise = 1.0) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return Array.from({ length: n }, (_, i) => {
    const raw = 30 + Math.sin(i / 3);
    // Box-Muller from the LCG, so the error really is Gaussian.
    const z = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10);
    return { date: d, rawCenter: raw, obs: Math.round(raw + 1 + noise * z) };
  });
}
const pairs = noisyPairs();

test("replay is walk-forward: the fit at each date sees only strictly earlier days", () => {
  const rows = bt.replay(pairs, cfg);
  assert.ok(rows.length > 0);
  // The first scored day cannot appear before MIN_BIAS_SAMPLES prior days exist.
  assert.equal(rows[0].date, pairs[cfg.MIN_BIAS_SAMPLES].date);
  // Corrupting only the FUTURE must not move an earlier day's prediction — that is what
  // "no lookahead" means, and it is the assumption the whole backtest rests on.
  const poisoned = pairs.map((p, i) => (i >= 25 ? { ...p, obs: p.obs + 40 } : p));
  const rows2 = bt.replay(poisoned, cfg);
  const early = rows.filter(r => r.date < pairs[25].date);
  const early2 = rows2.filter(r => r.date < pairs[25].date);
  assert.equal(early.length, early2.length);
  early.forEach((r, i) => assert.ok(Math.abs(r.center - early2[i].center) < 1e-12, `date ${r.date} leaked`));
});

test("replay learns the offset and centres on the corrected value", () => {
  const rows = bt.replay(pairs, cfg);
  const late = rows.slice(-10);
  const meanBias = late.reduce((s, r) => s + r.bias, 0) / late.length;
  assert.ok(meanBias > 0.3 && meanBias < 1.7, `expected ~+1.0, got ${meanBias}`);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.err, 0) / rows.length) < 0.8, "residual error is centred");
  rows.forEach(r => assert.ok(Math.abs(r.probs.reduce((a, b) => a + b, 0) - 1) < 1e-9));
});

test("coverStats reports realized cover, the claim, and the break-even basket cost", () => {
  const rows = bt.replay(pairs, cfg);
  const c3 = bt.coverStats(rows, 3);
  const c4 = bt.coverStats(rows, 4);
  assert.equal(c3.w, 3);
  assert.ok(c3.coverRate >= 0 && c3.coverRate <= 100);
  assert.ok(c4.coverRate >= c3.coverRate, "a wider cluster cannot cover less often");
  // Break-even is the cover rate discounted by the taker fee: pay more and you lose.
  assert.ok(Math.abs(c3.breakEvenCost - (c3.coverRate / 100) / (1 + cfg.FEE_RATE)) < 5e-4, "break-even is the cover rate discounted by the fee (reported to 3dp)");
  assert.ok(c3.breakEvenCost < c3.coverRate / 100, "fees strictly lower what you can pay");
  assert.deepEqual(bt.coverStats([], 3), { w: 3, n: 0, coverRate: null, claimed: null, breakEvenCost: null });
});

test("score uses proper scoring rules and shows the bias correction earning its place", () => {
  const rows = bt.replay(pairs, cfg);
  const s = bt.score(rows);
  assert.ok(s.logloss > 0 && isFinite(s.logloss));
  assert.ok(s.brier >= 0 && s.brier <= 2);
  assert.ok(s.maeCorrected < s.maeRaw, "correcting a +1.0 station offset beats not correcting it");
  assert.ok(s.hitCenter >= 0 && s.hitCenter <= 100);
  assert.equal(bt.score([]).n, 0);
});

test("log-loss punishes both over-confidence and vagueness, so the sweep cannot be gamed", () => {
  // With genuine forecast error present, claiming near-certainty is heavily penalised...
  const sharp = bt.score(bt.replay(pairs, { ...cfg, SIGMA_MULT: 0.15, SD_FLOOR: 0.05 }));
  const sane = bt.score(bt.replay(pairs, { ...cfg, SIGMA_MULT: 1.0 }));
  const vague = bt.score(bt.replay(pairs, { ...cfg, SIGMA_MULT: 6.0 }));
  assert.ok(sharp.logloss > sane.logloss, `over-confident sigma should score worse: ${sharp.logloss} vs ${sane.logloss}`);
  assert.ok(vague.logloss > sane.logloss, `a smeared-out sigma should score worse too: ${vague.logloss} vs ${sane.logloss}`);
});

test("a noiseless station is legitimately allowed a sharp sigma", () => {
  // The mirror image of the test above: when the residual really is ~0, confidence is
  // earned, and a proper scoring rule must reward it rather than punish it on principle.
  const clean = noisyPairs(60, 0);
  const sharp = bt.score(bt.replay(clean, { ...cfg, SIGMA_MULT: 0.15, SD_FLOOR: 0.05 }));
  const sane = bt.score(bt.replay(clean, { ...cfg, SIGMA_MULT: 1.0 }));
  assert.ok(sharp.logloss < sane.logloss);
});
