const test = require("node:test");
const assert = require("node:assert");
const E = require("../server/decision/ensemble");

const mk = (id, family, score, confidence = 0.8, reason) => ({ id, family, score, confidence, horizon: "any", reason: reason || `${id} reason` });
const NVDA = { id: "STOCK:NVDA", symbol: "NVDA", assetClass: "stock", etf: false };
const BTC = { id: "CRYPTO:BTC", symbol: "BTC", assetClass: "crypto" };
const REG = { trend: "up", vol: "normal", label: "trending-up/normal-vol", hmm: { state: 0, probs: [0.9, 0.05, 0.05] } };
const base = (signals, extra = {}) => ({ asset: NVDA, signals, regime: REG, horizon: "swing", price: 125, atr: 2.6, now: 1727222400000, ...extra });

function bullish(s = 0.8, c = 0.8) {
  return [
    mk("tech.trend.ema_stack", "technical", s, c, "EMA20 > EMA50 > EMA200 — established uptrend"),
    mk("tech.trend.supertrend", "technical", s, c, "Supertrend long"),
    mk("tech.momentum.macd", "technical", s, c, "MACD histogram rising"),
    mk("tech.volume.obv", "technical", s * 0.8, c, "OBV confirms"),
    mk("ml.ensemble.pup", "ml", s * 0.6, c),
    mk("regime.trend.state", "regime", s, c),
    mk("sent.news.aggregate", "sentiment", s, c),
    mk("macro.risk.regime", "macro", s, c),
    mk("fund.quality.piotroski", "fundamental", s, c, "Piotroski 8/9"),
  ];
}

function allFinite(o, path = "d") {
  if (typeof o === "number") { assert.ok(Number.isFinite(o), `${path} is ${o}`); return; }
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) allFinite(v, `${path}.${k}`);
}

test("signalLogOdds uses κ=0.30: score ±1 → logit(0.65), 0 → 0, clamps", () => {
  assert.ok(Math.abs(E.signalLogOdds(1) - Math.log(0.65 / 0.35)) < 1e-12);
  assert.strictEqual(E.signalLogOdds(0), 0);
  assert.strictEqual(E.signalLogOdds(5), E.signalLogOdds(1));
  assert.ok(Math.abs(E.signalLogOdds(-1) + E.signalLogOdds(1)) < 1e-12);
  assert.strictEqual(E.signalLogOdds(NaN), 0);
});

test("diminishingSum: harmonic within a subfamily, 1/.7/.5/.4 across, sides kept apart", () => {
  const ten = Array.from({ length: 10 }, () => ({ w: 1, e: 1, group: "trend" }));
  const r = E.diminishingSum(ten);
  const h6 = 1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5 + 1 / 6;
  assert.ok(Math.abs(r.sum - h6) < 1e-12 && Math.abs(r.mass - h6) < 1e-12);
  assert.deepStrictEqual(r.factors.slice(6), [0, 0, 0, 0]);
  const across = E.diminishingSum([{ w: 1, e: 1, group: "a" }, { w: 1, e: 0.9, group: "b" }, { w: 1, e: 0.8, group: "c" }, { w: 1, e: 0.7, group: "d" }]);
  assert.deepStrictEqual(across.factors, [1, 0.7, 0.5, 0.4]);
  // an opposing signal is ranked on its own side: full weight
  const opp = E.diminishingSum([{ w: 1, e: 1, group: "a" }, { w: 1, e: 1, group: "a" }, { w: 1, e: -0.5, group: "a" }]);
  assert.deepStrictEqual(opp.factors, [1, 0.5, 1]);
  assert.deepStrictEqual(E.diminishingSum([]), { sum: 0, mass: 0, factors: [] });
});

test("subfamily parsing handles timeframe-prefixed ids", () => {
  assert.strictEqual(E.subfamily("tech.trend.ema_stack"), "trend");
  assert.strictEqual(E.subfamily("tech.1h.trend.ema_stack"), "trend");
  assert.strictEqual(E.subfamily("tech.15m.meanrev.bollinger"), "meanrev");
  assert.strictEqual(E.styleOf("tech.meanrev.zscore", "technical"), "meanrev");
  assert.strictEqual(E.styleOf("tech.1d.trend.supertrend", "technical"), "trend");
  assert.strictEqual(E.styleOf("sent.news.aggregate", "sentiment"), "other");
});

test("all-bullish consistent signals → BUY with high confidence, long plan, readable summary", () => {
  const d = E.decide(base(bullish()));
  assert.ok(d.action === "BUY" || d.action === "STRONG_BUY", `${d.action}: ${d.abstainReason}`);
  assert.ok(d.pUp > 0.54 && d.pUp < d.pRaw, `pUp ${d.pUp} pRaw ${d.pRaw}`);
  assert.ok(d.confidence >= 0.7, `confidence ${d.confidence}`);
  assert.ok(d.agreement > 0.95);
  assert.strictEqual(d.abstainReason, null);
  assert.strictEqual(d.risk.direction, "long");
  assert.ok(d.risk.stop < 125 && d.risk.target > 125);
  assert.ok(Math.abs(d.risk.stop - (125 - 2 * 2.6)) < 1e-9 && Math.abs(d.risk.target - (125 + 3 * 2.6)) < 1e-9);
  assert.ok(d.risk.sizeFrac > 0 && d.risk.sizeFrac <= 0.10);
  assert.ok(d.expectedReturn > 0);
  assert.match(d.summary, /^(STRONG_)?BUY NVDA — 5d horizon\. P\(up\) \d+% \(raw \d+%, shrunk for calibration\), confidence \d+%\./);
  assert.match(d.summary, /Drivers: EMA20 > EMA50 > EMA200/);
  assert.match(d.summary, /Plan: long — stop 119\.8 \(−4\.2%\), target 132\.8 \(\+6\.2%\), R:R 1\.5/);
  assert.match(d.summary, /Regime: trending-up \/ normal vol\./);
  allFinite({ ...d, signals: undefined, ts: 0 });
});

test("pooling is capped: |logOdds| ≤ 1.10 and uncalibrated pUp stays within 0.5 ± 0.125", () => {
  const many = [];
  for (const f of ["technical", "ml", "regime", "sentiment", "macro", "fundamental", "llm"])
    for (let k = 0; k < 6; k++) many.push(mk(`${f.slice(0, 4)}.s${k}.x`, f, 1, 1));
  const d = E.decide(base(many));
  assert.ok(Math.abs(d.logOdds) <= 1.1 + 1e-9, `${d.logOdds}`);
  assert.ok(d.pUp <= 0.5 + 0.5 * (1 / (1 + Math.exp(-1.1)) - 0.5) + 1e-4);
  const sum = d.signals.reduce((s, x) => s + x.contribution, 0);
  assert.ok(Math.abs(sum - d.logOdds) < 1e-3, `Σ contributions ${sum} vs L ${d.logOdds}`);
});

test("every signal carries its contribution; they sum to the pooled log-odds", () => {
  const d = E.decide(base(bullish().concat([mk("tech.meanrev.bollinger", "technical", -0.5, 0.7, "%B overbought")])));
  for (const s of d.signals) assert.ok(Number.isFinite(s.contribution), s.id);
  const sum = d.signals.reduce((s, x) => s + x.contribution, 0);
  assert.ok(Math.abs(sum - d.logOdds) < 1e-3);
  assert.ok(d.signals.find(s => s.id === "tech.meanrev.bollinger").contribution < 0);
  assert.strictEqual(d.against[0].id, "tech.meanrev.bollinger");
});

test("balanced conflicting families → HOLD with abstainReason and a conflict note", () => {
  const sig = [
    mk("tech.trend.ema_stack", "technical", 0.7, 0.8), mk("tech.momentum.macd", "technical", 0.6, 0.8),
    mk("ml.ensemble.pup", "ml", -0.7, 0.8), mk("ml.gbm.pup", "ml", -0.6, 0.8),
    mk("regime.trend.state", "regime", -0.6, 0.8), mk("sent.news.aggregate", "sentiment", -0.3, 0.6),
    mk("fund.valuation.pe", "fundamental", 0.5, 0.7),
  ];
  const d = E.decide(base(sig, { regime: { trend: "range", vol: "normal" } }));
  assert.strictEqual(d.action, "HOLD");
  assert.ok(typeof d.abstainReason === "string" && d.abstainReason.length > 0);
  assert.ok(d.conflicts.length >= 1);
  assert.ok(d.confidenceTerms.X < 1, "conflict factor applied");
  assert.match(d.summary, /Conflict: technical bullish \(\+0\.\d+\) vs ml bearish \(−0\.\d+\)/);
  assert.match(d.summary, /Abstaining: /);
  assert.strictEqual(d.risk.direction, null);
  assert.strictEqual(d.risk.sizeFrac, 0);
});

test("10 duplicated correlated trend signals do not beat 2–3 independent agreeing families", () => {
  const dup = Array.from({ length: 10 }, (_, k) => mk(`tech.trend.ind${k}`, "technical", 0.8, 0.8));
  const one = [mk("tech.trend.ind0", "technical", 0.8, 0.8)];
  const three = [mk("tech.trend.ema_stack", "technical", 0.8, 0.8), mk("ml.ensemble.pup", "ml", 0.8, 0.8), mk("regime.trend.state", "regime", 0.8, 0.8)];
  const dD = E.decide(base(dup)), d1 = E.decide(base(one)), d3 = E.decide(base(three));
  assert.ok(dD.logOdds <= 1.5 * d1.logOdds, `dup ${dD.logOdds} vs single ${d1.logOdds}`);
  assert.ok(dD.logOdds < d3.logOdds, `dup ${dD.logOdds} vs 3 families ${d3.logOdds}`);
  assert.ok(dD.confidence < d3.confidence, `dup conf ${dD.confidence} vs 3 families ${d3.confidence}`);
  assert.ok(dD.coverage < d3.coverage);
});

test("missing families reduce coverage and confidence but do not flip direction", () => {
  const full = E.decide(base(bullish()));
  const part = E.decide(base(bullish().filter(s => !["sentiment", "macro", "fundamental"].includes(s.family))));
  assert.ok(part.coverage < full.coverage, `${part.coverage} vs ${full.coverage}`);
  assert.ok(part.confidence <= full.confidence);
  assert.ok(part.pUp > 0.5);
  assert.deepStrictEqual(part.missingFamilies.sort(), ["fundamental", "macro", "sentiment"]);
  assert.match(part.summary, /Coverage \d+% \(missing: /);
  // a bearish mirror is exactly symmetric
  const mirror = E.decide(base(bullish().map(s => ({ ...s, score: -s.score }))));
  assert.ok(Math.abs(mirror.pUp - (1 - full.pUp)) < 1e-4);
  assert.ok(Math.abs(mirror.confidence - full.confidence) < 1e-4);
});

// deterministic PRNG for property tests
function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }

test("confidenceScore is monotone in every input (property test)", () => {
  const rnd = lcg(42);
  const keys = ["edge", "agreement", "coverage", "dataQuality", "regimeClarity", "calibReliability"];
  for (let t = 0; t < 2000; t++) {
    const x = { edge: rnd() * 0.3, agreement: rnd(), coverage: rnd(), dataQuality: rnd(), regimeClarity: rnd(), calibReliability: rnd(), conflict: rnd() };
    const c0 = E.confidenceScore(x).confidence;
    assert.ok(c0 >= 0 && c0 <= 1);
    for (const k of keys) {
      const y = { ...x, [k]: x[k] + rnd() * 0.2 };
      assert.ok(E.confidenceScore(y).confidence >= c0 - 1e-12, `${k} increase lowered confidence`);
    }
    assert.ok(E.confidenceScore({ ...x, conflict: x.conflict + rnd() * 0.3 }).confidence <= c0 + 1e-12, "conflict increase raised confidence");
  }
  assert.strictEqual(E.confidenceScore({}).confidence, 0);
});

test("turning dissenters into agreers never lowers confidence or agreement (end-to-end monotonicity)", () => {
  const sig = [
    mk("tech.trend.ema_stack", "technical", 0.7, 0.8), mk("tech.momentum.macd", "technical", 0.6, 0.8),
    mk("ml.ensemble.pup", "ml", 0.5, 0.7), mk("regime.trend.state", "regime", 0.6, 0.7),
    mk("tech.volume.obv", "technical", -0.6, 0.8), mk("sent.news.aggregate", "sentiment", -0.6, 0.7),
    mk("macro.risk.regime", "macro", -0.5, 0.7), mk("fund.valuation.pe", "fundamental", -0.6, 0.7),
  ];
  let prev = E.decide(base(sig));
  for (let k = 4; k < sig.length; k++) {
    sig[k] = { ...sig[k], score: -sig[k].score };
    const d = E.decide(base(sig));
    assert.ok(d.confidence >= prev.confidence - 1e-9, `step ${k}: ${d.confidence} < ${prev.confidence}`);
    assert.ok(d.agreement >= prev.agreement - 1e-9);
    assert.ok(d.pUp >= prev.pUp - 1e-9);
    prev = d;
  }
});

test("empty / garbage signals → HOLD, pUp 0.5, no NaN anywhere", () => {
  for (const signals of [[], undefined, null, [null, 5, { id: "x", family: "technical", score: NaN, confidence: 1 }], [mk("tech.trend.a", "technical", 0.9, 0)]]) {
    const d = E.decide({ asset: BTC, signals, horizon: "swing" });
    assert.strictEqual(d.action, "HOLD");
    assert.strictEqual(d.pUp, 0.5);
    assert.strictEqual(d.confidence, 0);
    assert.ok(d.abstainReason);
    allFinite({ ...d, signals: undefined, ts: 0, price: 0 });
    assert.ok(!/NaN|undefined/.test(d.summary), d.summary);
  }
  const d = E.decide(base([mk("tech.trend.a", "technical", Infinity, NaN), mk("tech.trend.b", "technical", 0.5, 0.5)], { price: NaN, atr: -1 }));
  allFinite({ ...d, signals: undefined, ts: 0, price: 0, risk: { ...d.risk, stop: 0, target: 0, atr: 0, atrPct: 0 } });
});

test("thresholds come from opts.thresholds (any key style) and cfg", () => {
  const d1 = E.decide(base(bullish()), { thresholds: { MIN_CONFIDENCE: 0.99 } });
  assert.strictEqual(d1.action, "HOLD");
  assert.match(d1.abstainReason, /^confidence 0\.\d+ < 0\.99$/);
  const d2 = E.decide(base(bullish(), { thresholds: { min_prob_edge: 0.2 } }));
  assert.match(d2.abstainReason, /edge 0\.\d+ < 0\.2/);
  const d3 = E.decide(base(bullish(), { cfg: { MIN_AGREEMENT: 1.01 } }));
  assert.match(d3.abstainReason, /agreement/);
  const th = E.readThresholds(undefined, {}, "position", { vol: "extreme" });
  assert.strictEqual(th.MIN_PROB_EDGE, 0.05);
  assert.ok(Math.abs(th.MIN_CONFIDENCE - 0.65) < 1e-9);
});

test("cost gate: a move smaller than 2× round-trip cost abstains", () => {
  const d = E.decide(base(bullish(), { asset: BTC, price: 100, atr: 0.3 }));
  assert.strictEqual(d.action, "HOLD");
  assert.match(d.abstainReason, /round-trip cost/);
});

test("SELL: short for a non-held asset, exit for a held one", () => {
  const bear = bullish().map(s => ({ ...s, score: -s.score }));
  const s1 = E.decide(base(bear));
  assert.ok(s1.action.endsWith("SELL"));
  assert.strictEqual(s1.risk.direction, "short");
  assert.strictEqual(s1.sellIntent, "short");
  assert.ok(s1.risk.stop > 125 && s1.risk.target < 125);
  assert.match(s1.summary, /SELL \(short\) NVDA/);
  const s2 = E.decide(base(bear, { held: true }));
  assert.strictEqual(s2.risk.direction, null);
  assert.strictEqual(s2.sellIntent, "exit");
  assert.match(s2.summary, /exit the long position/);
});

test("familyWeights: horizon, asset class and extreme-vol conditioning", () => {
  const sw = E.familyWeights(null, "swing", "stock");
  assert.strictEqual(sw.technical, 1); assert.strictEqual(sw.ml, 0.7); assert.strictEqual(sw.fundamental, 0.15);
  assert.strictEqual(sw.derivatives, 0); assert.strictEqual(sw.microstructure, 0);
  assert.strictEqual(E.familyWeights(null, "swing", { assetClass: "stock", etf: true }).fundamental, 0);
  const cr = E.familyWeights(null, "position", "crypto");
  assert.strictEqual(cr.fundamental, 0.25); assert.strictEqual(cr.derivatives, 0.5); assert.strictEqual(cr.microstructure, 0);
  assert.strictEqual(E.familyWeights(null, "intraday", "crypto").microstructure, 0.7);
  assert.strictEqual(E.familyWeights({ vol: "extreme" }, "swing", "crypto").technical, 0.5);
});

test("regime conditioning: mean-reversion dissent matters less in a trend than in a range", () => {
  const sig = [mk("tech.trend.ema_stack", "technical", 0.7, 0.8), mk("tech.meanrev.bollinger", "technical", -0.7, 0.8)];
  const trend = E.decide(base(sig, { regime: { trend: "up", vol: "normal" } }));
  const range = E.decide(base(sig, { regime: { trend: "range", vol: "normal" } }));
  assert.ok(trend.pUp > 0.5 && range.pUp < 0.5, `trend ${trend.pUp} range ${range.pUp}`);
});

test("momentum-crash guard halves trend signals after a losing year in high vol", () => {
  const candles = Array.from({ length: 400 }, (_, k) => ({ t: k * 86400000, o: 200 - k * 0.3, h: 201 - k * 0.3, l: 199 - k * 0.3, c: 200 - k * 0.3, v: 1 }));
  const sig = [mk("tech.trend.ema_stack", "technical", 0.8, 0.8)];
  const on = E.decide(base(sig, { candles, regime: { trend: "down", vol: "high", volPercentile: 0.85 } }));
  const off = E.decide(base(sig, { candles, regime: { trend: "down", vol: "high", volPercentile: 0.5 } }));
  assert.strictEqual(on.crashGuard, true);
  assert.strictEqual(off.crashGuard, false);
  assert.ok(on.logOdds < off.logOdds);
  assert.match(on.summary, /Momentum-crash guard/);
});

test("reliable calibrator is applied and lifts the K term; learned weights scale signals", () => {
  const cal = { apply: (p) => 0.5 + 0.9 * (p - 0.5), reliability: () => ({ reliable: true, n: 500, ece: 0.02 }) };
  const d = E.decide(base(bullish(), { calibrator: cal }));
  assert.ok(Math.abs(d.pUp - (0.5 + 0.9 * (d.pRaw - 0.5))) < 1e-3);
  assert.strictEqual(d.calibrated, true);
  assert.match(d.summary, /calibrated\)/);
  assert.ok(d.confidenceTerms.K > 0.88);
  const unrel = E.decide(base(bullish(), { calibrator: { apply: (p) => p, reliability: () => ({ reliable: false, n: 5 }) } }));
  assert.strictEqual(unrel.calibrated, false);
  const learner = { get: (id) => (id === "ml.ensemble.pup" ? 2 : 1) };
  const w = E.decide(base(bullish(), { weights: learner }));
  assert.ok(w.families.ml.mass > E.decide(base(bullish())).families.ml.mass);
});

test("dataQuality object (freshness, failed candles) lowers confidence", () => {
  const good = E.decide(base(bullish(), { dataQuality: { freshnessSec: 60, sources: { candles: "ok" } } }));
  const bad = E.decide(base(bullish(), { dataQuality: { freshnessSec: 60, sources: { candles: "fail" } } }));
  const stale = E.decide(base(bullish(), { dataQuality: { freshnessSec: 10 * 86400, marketOpen: true, sources: {} } }));
  assert.ok(bad.confidence < good.confidence);
  assert.ok(stale.confidence < good.confidence);
  assert.strictEqual(E.dataQualityOf(0.5), 0.5);
});

test("summary is deterministic", () => {
  assert.strictEqual(E.decide(base(bullish())).summary, E.decide(base(bullish())).summary);
});

test("an open long paper position on the asset turns SELL into an exit", () => {
  const bear = bullish().map(s => ({ ...s, score: -s.score }));
  const d = E.decide(base(bear, { openPositions: [{ assetId: "STOCK:NVDA", direction: "long", costUsd: 5000, assetClass: "stock" }] }));
  assert.ok(d.action.endsWith("SELL"));
  assert.strictEqual(d.sellIntent, "exit");
  assert.strictEqual(d.risk.direction, null);
});
