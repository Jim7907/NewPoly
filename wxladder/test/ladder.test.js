const test = require("node:test");
const assert = require("node:assert");
const L = require("../server/ladder");
const cfg = require("../server/config");
const { makeLadder, forecast, biasFit, spreadHist } = require("./fixtures");

const build = (opts = {}, params = {}) => L.buildLadder({
  lad: opts.lad || makeLadder(),
  forecast: opts.forecast || forecast(30.5),
  biasFit: opts.biasFit === undefined ? biasFit(0.4, 0.95) : opts.biasFit,
  spreadHist: opts.spreadHist || spreadHist(),
  books: opts.books || {},
  bankroll: opts.bankroll === undefined ? 1000 : opts.bankroll,
  openExposure: opts.openExposure || 0,
}, { ...cfg, ...params });

test("windowsAround enumerates contiguous windows containing the centre, clipped to the ends", () => {
  assert.deepEqual(L.windowsAround(5, 11, 3), [[3, 4, 5], [4, 5, 6], [5, 6, 7]]);
  assert.deepEqual(L.windowsAround(0, 11, 3), [[0, 1, 2]]);
  assert.deepEqual(L.windowsAround(10, 11, 4), [[7, 8, 9, 10]]);
  assert.deepEqual(L.windowsAround(0, 2, 3), []);
});

test("a calibrated model with a small edge builds a 3-rung ladder", () => {
  const o = build();
  assert.equal(o.reasons.length, 0, `unexpected refusal: ${o.reasons}`);
  assert.ok(o.signal.startsWith("BUY LADDER"));
  assert.equal(o.legs.filter(l => l.shares > 0).length, 3);
  assert.ok(o.center > o.rawCenter, "the bias shifts the centre");
  assert.ok(o.basketCost <= cfg.MAX_BASKET_COST);
  assert.ok(o.outlay > 0 && o.outlay <= o.budget + 0.01);
  // The rungs are adjacent, which is what makes it a ladder rather than a scatter.
  const idx = o.legs.map(l => l.idx);
  for (let i = 1; i < idx.length; i++) assert.equal(idx[i], idx[i - 1] + 1);
});

test("refuses a station whose bias is not yet calibrated", () => {
  const o = build({ biasFit: { ready: false, n: 2 } });
  assert.ok(o.reasons.includes("bias-uncalibrated"));
  assert.equal(o.signal, "—");
  assert.equal(o.bias, 0, "an unready fit never shifts the centre");
});

test("refuses a station the market does not resolve by METAR", () => {
  const lad = makeLadder();
  const o = build({ lad: { ...lad, unsupported: true } });
  assert.deepEqual(o.reasons, ["station-unsupported"]);
});

test("refuses when the model has no edge over the de-vigged book", () => {
  // Feed the model exactly the market's own centre and spread against a real overround.
  const lad = makeLadder({ overround: 1.06 });
  const o = build({ lad, forecast: forecast(30.55, 1.05), biasFit: biasFit(0, 1.05) });
  assert.ok(o.reasons.includes("ev<min"), `expected ev<min, got ${o.reasons}`);
  assert.equal(o.signal, "—");
});

test("refuses when the cluster costs more than the cap", () => {
  const o = build({}, { MAX_BASKET_COST: 0.05 });
  assert.equal(o.signal, "—");
  assert.ok(o.reasons.includes("cost>cap"));
  assert.ok(o.cheapestCost > 0.05, "reports how close the cheapest window got");
});

test("refuses when model and market describe different worlds", () => {
  // A 3 C disagreement is a broken model far more often than a free lunch.
  const o = build({ forecast: forecast(34.5, 1.05) });
  assert.ok(o.reasons.includes("model-vs-market-divergent") || o.reasons.includes("ev-implausible"),
    `expected a circuit breaker, got ${o.reasons}`);
  assert.equal(o.signal, "—");
  assert.ok(o.tvd > cfg.MAX_TVD);
});

test("underdispersion presses and overdispersion backs off", () => {
  const hist = spreadHist(20, 1.0);
  const tight = build({ forecast: forecast(30.5, 0.55), spreadHist: hist });
  const norm = build({ forecast: forecast(30.5, 1.0), spreadHist: hist });
  const wide = build({ forecast: forecast(30.5, 1.9), spreadHist: hist });

  assert.equal(tight.regime, "tight");
  assert.equal(norm.regime, "normal");
  assert.equal(wide.regime, "wide");
  assert.ok(tight.sigma < norm.sigma && norm.sigma < wide.sigma, "spread-skill scaling");
  assert.ok(tight.budget > norm.budget && norm.budget > wide.budget, "budget follows conviction");
  assert.ok(tight.coverProb > wide.coverProb);
  assert.ok(wide.width >= norm.width, "a wide ensemble buys more cover");
});

test("the dispersion filter stays off until it has enough spread history", () => {
  const o = build({ spreadHist: spreadHist(3) });
  assert.equal(o.dispRatio, null);
  assert.equal(o.regime, "unknown");
  assert.equal(o.budgetMult, 1, "an unknown regime is treated as normal, not as conviction");
});

test("the filter falls back to the seedable multi-model track when live spread is thin", () => {
  // Historical ensemble members are unavailable, so a freshly-seeded station has a long
  // multi-model track and almost no ensemble track. The filter should still work.
  const detTrack = Array.from({ length: 20 }, () => 0.8);
  const fc = { ...forecast(30.5, 1.0), detSd: 0.4 };     // today's models agree unusually well

  const seeded = build({ forecast: fc, spreadHist: { ens: spreadHist(2), det: detTrack } });
  assert.equal(seeded.dispSource, "multi-model");
  assert.equal(seeded.dispRatio, 0.5);
  assert.equal(seeded.regime, "tight", "a seeded station can press from day one");
  assert.equal(seeded.detSpreadSamples, 20);

  // Once enough live ensemble spread exists, the ensemble track takes precedence.
  const mature = build({ forecast: fc, spreadHist: { ens: spreadHist(20, 1.0), det: detTrack } });
  assert.equal(mature.dispSource, "ensemble");
  assert.ok(Math.abs(mature.dispRatio - 1.0) < 0.15, "measured against the ensemble median, not the model one");

  // Neither track long enough => no regime, and no conviction bonus.
  const cold = build({ forecast: fc, spreadHist: { ens: spreadHist(2), det: [0.8, 0.9] } });
  assert.equal(cold.dispSource, null);
  assert.equal(cold.regime, "unknown");
});

test("a plain array of spreads is still accepted as the ensemble track", () => {
  const o = build({ spreadHist: spreadHist(20) });
  assert.equal(o.dispSource, "ensemble");
  assert.ok(o.dispRatio != null);
});

test("SKIP_WHEN_WIDE sits the day out entirely", () => {
  const o = build({ forecast: forecast(30.5, 1.9) }, { SKIP_WHEN_WIDE: true });
  assert.ok(o.reasons.includes("ensemble-wide"));
  assert.equal(o.signal, "—");
});

test("all three sizing modes fund the same rungs with different weights", () => {
  const kelly = build({}, { SIZING: "kelly" });
  const prob = build({}, { SIZING: "prob" });
  const equal = build({}, { SIZING: "equal" });
  for (const o of [kelly, prob, equal]) assert.ok(o.legs.filter(l => l.shares > 0).length >= 3, o.reasons);
  // Equal SHARES means every rung returns the same dollar amount if it hits.
  const sh = equal.legs.filter(l => l.shares > 0).map(l => l.shares);
  assert.ok(Math.max(...sh) - Math.min(...sh) < 0.02, "equal mode buys equal shares");
  // Probability weighting puts the most money on the most likely rung (article §7).
  const funded = prob.legs.filter(l => l.shares > 0);
  const heaviest = funded.reduce((a, b) => (a.dollars > b.dollars ? a : b));
  const likeliest = funded.reduce((a, b) => (a.prob > b.prob ? a : b));
  assert.equal(heaviest.label, likeliest.label);
  assert.ok(kelly.kellyFrac > 0, "kelly reports the fraction of bankroll it wants");
});

test("respects the venue minimum order size instead of rounding a rung up", () => {
  const o = build({ bankroll: 30 }, { MIN_ORDER_SHARES: 5000 });
  assert.ok(o.legs.every(l => l.shares === 0));
  assert.ok(o.reasons.includes("no-fundable-rung") || o.reasons.includes("rungs<3"));
});

test("aggregate exposure cap throttles the budget and then blocks", () => {
  const capped = build({ openExposure: cfg.AGG_CAP * 1000 });
  assert.equal(capped.budget, 0);
  assert.ok(capped.reasons.includes("no-budget"));
});

test("a real order book re-prices the fill and can veto a thin rung", () => {
  const lad = makeLadder();
  const deep = {}, thin = {};
  for (const b of lad.buckets) {
    deep[b.yesToken] = { bid: b.bid, ask: b.ask, mid: (b.bid + b.ask) / 2, spreadC: 2,
      askDepthUsd: 5000, askDepthShares: 50000, asks: [{ price: b.ask, size: 50000 }] };
    thin[b.yesToken] = { bid: b.bid, ask: b.ask, mid: (b.bid + b.ask) / 2, spreadC: 2,
      askDepthUsd: 1, askDepthShares: 2, asks: [{ price: b.ask, size: 2 }] };
  }
  const ok = build({ lad, books: deep });
  assert.equal(ok.signal !== "—", true, ok.reasons);
  assert.ok(ok.legs.every(l => l.shares === 0 || l.fillAsk != null));

  const bad = build({ lad, books: thin });
  assert.equal(bad.signal, "—");
  assert.ok(bad.reasons.some(r => r.startsWith("thin:") || r === "book-too-thin-to-fill"),
    `expected a liquidity refusal, got ${bad.reasons}`);
});

test("never spends more than the budget, even when the fill walks up a thin book", () => {
  // Regression: sizing happens at the TOUCH price, then each rung is re-priced at its real
  // walked fill. Without trimming the share count back, a rung that eats several levels
  // costs more than it was allocated and the basket blows through its per-market budget.
  const lad = makeLadder();
  const books = {};
  for (const b of lad.buckets) {
    books[b.yesToken] = {
      bid: b.bid, ask: b.ask, mid: (b.bid + b.ask) / 2, spreadC: 2,
      askDepthUsd: 5000, askDepthShares: 100000,
      // A thin touch level, then progressively worse prices — a real ladder book.
      asks: [{ price: b.ask, size: 5 }, { price: b.ask * 2, size: 100 },
             { price: b.ask * 4, size: 100000 }],
    };
  }
  const o = build({ lad, books });
  assert.ok(o.legs.some(l => l.fillAsk > l.ask), "the fill really did walk past the touch");
  assert.ok(o.outlay <= o.budget + 0.01, `outlay ${o.outlay} must stay inside budget ${o.budget}`);
  for (const l of o.legs) {
    // dollars is reported to 2dp and fillQEff to 4dp, so allow for both roundings.
    const tol = l.shares * 1e-4 + 0.011;
    assert.ok(Math.abs(l.dollars - l.shares * l.fillQEff) <= tol, `rung ${l.label} priced at its fill`);
  }
});

test("every refusal names its reasons and never leaves a funded plan behind", () => {
  for (const o of [build({ biasFit: { ready: false, n: 0 } }), build({}, { MIN_BASKET_EV: 5 }), build({ bankroll: 0 })]) {
    assert.equal(o.signal, "—");
    assert.ok(o.reasons.length > 0);
  }
});

test("the distribution reports model, market and blended probability per bucket", () => {
  const o = build();
  assert.equal(o.distribution.length, 11);
  const sumUsed = o.distribution.reduce((s, d) => s + d.prob, 0);
  assert.ok(Math.abs(sumUsed - 1) < 1e-3, "the blended distribution is a distribution");
  const d = o.distribution.find(x => x.pModel > 0.1);
  assert.ok(d.prob >= Math.min(d.pModel, d.pMarket) - 1e-9 && d.prob <= Math.max(d.pModel, d.pMarket) + 1e-9,
    "the blend sits between its two inputs");
});

test("W_MODEL=0 reproduces the market and cannot find an edge", () => {
  const o = build({}, { W_MODEL: 0 });
  assert.equal(o.signal, "—");
  assert.ok(o.reasons.includes("ev<min"), `deferring entirely to the book should find nothing: ${o.reasons}`);
});

test("admission is sizing-independent so policies can be compared on the same market", () => {
  // Kelly raises its OWN fill EV by starving the weaker rungs. Gating on that figure admits
  // Kelly to markets it then declines to fund evenly, and gates equal-share out of markets
  // whose neighbourhood edge is identical — which makes a paired comparison impossible.
  const base = { MIN_BASKET_EV: 0.08, EV_GATE_BASIS: "basket" };
  const kelly = build({}, { ...base, SIZING: "kelly" });
  const equal = build({}, { ...base, SIZING: "equal" });
  const evGate = (o) => (o.reasons || []).includes("ev<min");
  assert.equal(evGate(kelly), evGate(equal),
    "under a sizing-independent gate both policies reach the same admission verdict");

  // And the basis is switchable, so the old behaviour is still reachable.
  const fillGated = build({}, { ...base, EV_GATE_BASIS: "fill", SIZING: "kelly" });
  assert.ok(Array.isArray(fillGated.reasons));
});

test("equal-share sizing cannot cover an outcome and still lose", () => {
  // Every rung holds the same number of shares, so any covered outcome pays the same amount.
  // That amount beats the outlay whenever the basket cost is under $1 — which the cost cap
  // already guarantees. This is the structural difference from Kelly.
  const o = build({}, { SIZING: "equal" });
  const funded = (o.legs || []).filter(l => l.shares > 0);
  if (funded.length >= 2 && o.outlay > 0) {
    const shares = funded.map(l => l.shares);
    assert.ok(Math.max(...shares) - Math.min(...shares) < 0.02, "equal SHARES across rungs");
    assert.equal(o.canLoseWhileCovered, false);
    assert.ok(o.worstCoveredReturn >= 0, `worst covered return ${o.worstCoveredReturn} must not be negative`);
    assert.ok(Math.abs(o.worstCoveredReturn - o.bestCoveredReturn) < 1e-6, "every covered outcome pays alike");
  }
});
