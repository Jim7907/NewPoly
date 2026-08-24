const test = require("node:test");
const assert = require("node:assert");
const m = require("../server/math");

test("normCdf known values", () => {
  assert.ok(Math.abs(m.normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(m.normCdf(1) - 0.8413) < 1e-3);
  assert.ok(Math.abs(m.normCdf(-1) - 0.1587) < 1e-3);
});

test("bucketProb uses the +/-0.5 rounding boundaries the METAR resolution implies", () => {
  // The station reports whole degrees, so bucket 31 is the event round(T)==31.
  const exact = m.bucketProb({ lo: 31, hi: 31 }, 31, 1);
  const manual = m.normCdf(0.5) - m.normCdf(-0.5);
  assert.ok(Math.abs(exact - manual) < 1e-9);
  // Centered on the bucket, that band is ~38% of the mass at sigma=1.
  assert.ok(exact > 0.38 && exact < 0.39);
});

test("bucketProb handles both open tails", () => {
  const low = m.bucketProb({ lo: -Infinity, hi: 25 }, 30, 1.5);
  const high = m.bucketProb({ lo: 35, hi: Infinity }, 30, 1.5);
  assert.ok(low > 0 && low < 0.01);
  assert.ok(high > 0 && high < 0.01);
  assert.ok(Math.abs(m.bucketProb({ lo: -Infinity, hi: 40 }, 30, 1.5) - 1) < 1e-6);
});

test("bucketProbs over a full ladder sum to 1", () => {
  const bk = [{ lo: -Infinity, hi: 25 }];
  for (let k = 26; k <= 34; k++) bk.push({ lo: k, hi: k });
  bk.push({ lo: 35, hi: Infinity });
  for (const [mu, sd] of [[30, 1], [31.4, 2.2], [25, 0.6], [36, 1.1]]) {
    const p = m.bucketProbs(bk, mu, sd);
    assert.ok(Math.abs(m.sum(p) - 1) < 1e-9, `sum for mu=${mu} sd=${sd}`);
    assert.ok(p.every(x => x >= 0));
  }
});

test("empiricalBucketProbs bins members and smooths unseen buckets", () => {
  const bk = [{ lo: -Infinity, hi: 28 }, { lo: 29, hi: 29 }, { lo: 30, hi: 30 }, { lo: 31, hi: Infinity }];
  const p = m.empiricalBucketProbs(bk, [29.4, 29.6, 30.2, 30.4, 30.1]);
  assert.ok(Math.abs(m.sum(p) - 1) < 1e-9);
  assert.ok(p[2] > p[1], "30 seen more often than 29");
  assert.ok(p[0] > 0, "unseen bucket is not called impossible");
});

test("weather taker fee is a flat share of stake below 0.5 and cheap at the top", () => {
  // feeSchedule {rate:0.05, exponent:1} => fee/share = 0.05*min(q,1-q).
  assert.ok(Math.abs(m.feePerShare(0.02, 0.05, 1) - 0.001) < 1e-12);
  // As a fraction of capital that is 5% for ANY cheap rung — a ladder's wings are not
  // cheap in relative terms, which is the point the article's "cheap insurance" misses.
  for (const q of [0.02, 0.10, 0.30, 0.50]) {
    assert.ok(Math.abs(m.feePerShare(q, 0.05, 1) / q - 0.05) < 1e-9, `flat 5% at q=${q}`);
  }
  assert.ok(m.feePerShare(0.9, 0.05, 1) / 0.9 < 0.01, "cheap for a heavy favourite");
});

test("effCost and legEv are fee- and slippage-aware", () => {
  const q = m.effCost(0.2, 0.05, 1, 0.002);
  assert.ok(Math.abs(q - (0.2 + 0.01 + 0.002)) < 1e-9);
  assert.ok(m.legEv(0.30, q) > 0);
  assert.ok(m.legEv(0.20, q) < 0, "paying fees on a fairly-priced rung is negative EV");
});

test("impliedProbs de-vigs and tvd measures disagreement", () => {
  const p = m.impliedProbs([0.30, 0.40, 0.36]);   // sums to 1.06
  assert.ok(Math.abs(m.sum(p) - 1) < 1e-9);
  assert.ok(p[1] > p[2] && p[2] > p[0]);
  assert.equal(m.tvd(p, p), 0);
  assert.ok(Math.abs(m.tvd([1, 0], [0, 1]) - 1) < 1e-9);
});

test("kellyAllocate matches the closed form and holds cash when there is no edge", () => {
  const legs = [{ prob: 0.12, qEff: 0.06 }, { prob: 0.45, qEff: 0.30 }, { prob: 0.28, qEff: 0.35 }];
  const f = m.kellyAllocate(legs, 1);
  // b* = (1 - sum p)/(1 - sum q) over the included set; f_i = p_i - q_i*b*.
  const b = (1 - 0.85) / (1 - 0.71);
  assert.ok(Math.abs(f[0] - (0.12 - 0.06 * b)) < 1e-9);
  assert.ok(Math.abs(f[1] - (0.45 - 0.30 * b)) < 1e-9);
  assert.ok(m.sum(f) < 1, "always keeps a cash reserve");
  assert.deepEqual(m.kellyAllocate([{ prob: 0.2, qEff: 0.5 }], 1), [0]);
  assert.deepEqual(m.kellyAllocate([{ prob: 0.3, qEff: 0.3 }], 1), [0], "no edge => no bet");
});

test("kellyAllocate scales linearly with the fractional-Kelly knob", () => {
  const legs = [{ prob: 0.5, qEff: 0.3 }, { prob: 0.3, qEff: 0.25 }];
  const full = m.kellyAllocate(legs, 1);
  const quarter = m.kellyAllocate(legs, 0.25);
  full.forEach((x, i) => assert.ok(Math.abs(quarter[i] - x * 0.25) < 1e-12));
});

test("basketMetrics: equal-share basket EV is coverProb/cost - 1", () => {
  const legs = [{ prob: 0.30, price: 0.25, qEff: 0.27 }, { prob: 0.25, price: 0.20, qEff: 0.22 }];
  const r = m.basketMetrics(legs);
  assert.ok(Math.abs(r.coverProb - 0.55) < 1e-9);
  assert.ok(Math.abs(r.basketCost - 0.49) < 1e-9);
  assert.ok(Math.abs(r.ev - (0.55 / 0.49 - 1)) < 1e-4);
  assert.ok(Math.abs(r.grossCost - 0.45) < 1e-9, "gross cost excludes fees");
});

test("dispersion ratio, regime and predictive sigma", () => {
  const hist = Array.from({ length: 20 }, () => 1.0);
  assert.equal(m.dispersionRatio(0.5, hist, 10), 0.5);
  assert.equal(m.dispersionRatio(0.5, hist.slice(0, 3), 10), null, "needs enough history");
  assert.equal(m.dispersionRegime(0.5), "tight");
  assert.equal(m.dispersionRegime(1.9), "wide");
  assert.equal(m.dispersionRegime(1.0), "normal");
  assert.equal(m.dispersionRegime(null), "unknown");

  // A tighter-than-usual ensemble shrinks sigma; gamma controls how much.
  const wide = m.predictiveSigma({ rmse: 1.2, dispRatio: 1.6, gamma: 0.5, floor: 0.3 });
  const tight = m.predictiveSigma({ rmse: 1.2, dispRatio: 0.5, gamma: 0.5, floor: 0.3 });
  assert.ok(tight < 1.2 && 1.2 < wide);
  assert.equal(m.predictiveSigma({ rmse: 1.2, dispRatio: 0.5, gamma: 0, floor: 0.3 }), 1.2, "gamma=0 ignores spread");
  assert.equal(m.predictiveSigma({ rmse: 0.1, dispRatio: null, floor: 0.6 }), 0.6, "floor binds");
  assert.equal(m.predictiveSigma({ rmse: null, dispRatio: null, floor: 0.3, fallback: 1.6 }), 1.6);
  assert.ok(Math.abs(m.predictiveSigma({ rmse: 1, dispRatio: null, floor: 0.1, mult: 1.5 }) - 1.5) < 1e-9);
});

test("stdev / median / quantile", () => {
  assert.equal(m.median([3, 1, 2]), 2);
  assert.equal(m.stdev([5]), 0);
  assert.ok(Math.abs(m.stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 1e-4);
  assert.equal(m.quantile([1, 2, 3, 4], 0), 1);
  assert.equal(m.quantile([1, 2, 3, 4], 1), 4);
});
