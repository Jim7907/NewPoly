// The brain: fuses ~60 noisy, heavily-correlated signals into one calibrated, confidence-gated
// Decision (contract §2.10; parameters from docs/RESEARCH.md §5.1). Pure and deterministic — no
// I/O; `now` only stamps `ts`.
//
// ───────────────────────────── METHOD ─────────────────────────────
// 1. Evidence per signal:  e_i = logit(0.5 + 0.5·κ·s_i),  κ = 0.30  (|e| ≤ logit(0.65) ≈ 0.62:
//    no single indicator is allowed to claim more than ~65%).
//    Weight per signal:    w_i = learned(id) · confidence_i · style_i · horizonMatch_i
//      style_i : regime conditioning (RESEARCH §5.1) — trending: trend ×1.3, mean-reversion ×0.4;
//                range: trend ×0.6, MR ×1.3; high vol: trend ×0.8, MR ×1.1, others ×0.9;
//                momentum-crash guard (trailing 1y return < 0 and vol percentile > 0.7): trend ×0.5.
//      horizonMatch_i : 0.6 when the signal declares a different horizon (not "any").
// 2. Correlated-evidence de-duplication inside each family, two levels, per side (bullish,
//    bearish and neutral evidence are ranked separately — an independent dissent is not a
//    "duplicate" of the majority):
//      within a subfamily (id tech.<sub>.* or tech.<tf>.<sub>.*): harmonic 1, 1/2, …, 1/6 (then 0)
//      across subfamilies (ranked by |subtotal|): 1, .7, .5, .4, then ×0.8 each
//    family mass     m_f = Σ D_i·w_i          (effective de-duplicated confidence)
//    family evidence ē_f = Σ D_i·w_i·e_i / m_f (mean log-odds, |ē| ≤ 0.62)
// 3. Pooling across families, β_f = familyWeights(regime, horizon, assetClass):
//      ω_f  = β_f · sat(m_f),   sat(m) = 1 − e^(−2m)   (a family with little mass counts little)
//      R    = min(1.5, sqrt(B_expected / B_present))    (partial renormalisation for missing families:
//             absence never biases direction and only partly shrinks magnitude; it DOES cut coverage)
//      L    = clamp(0.6 · R · Σ_f ω_f·ē_f, ±1.10)   pooling exponent 0.6 (<1: shrink, since our
//             analyzers share the same price data); in extreme vol every β_f is halved; the cap
//             |L| ≤ logit(0.75) guards against piled-up correlated evidence.      pRaw = σ(L)
// 4. Calibration: pUp = calibrator.apply(pRaw) if given, else pUp = 0.5 + 0.5·(pRaw − 0.5).
// 5. Confidence: see confidenceScore() below for the exact formula.
// 6. Gating: act only if confidence ≥ MIN_CONFIDENCE (+0.05 in extreme vol), edge ≥ MIN_PROB_EDGE
//    (≥ 0.05 at position horizon), agreement ≥ MIN_AGREEMENT, and the cost gate: gross expected
//    bracket return ≥ 2 × round-trip cost. STRONG_* if confidence ≥ STRONG_CONFIDENCE.
// 7. Risk plan: ATR bracket per horizon (2/3, 2/3, 3.5/5.5), fee-aware expected return from
//    risk.bracketExpectation (exactly −costs at pUp = 0.5), size via risk.positionSize with
//    Kelly scaled by calibrator reliability. SELL on a non-held asset = short; on a held one = exit.
// 8. Explanation: drivers (top 5 for), against (top 3), family breakdown, conflicts, summary.

const baseCfg = require("../config");
const risk = require("./risk");

const PARAMS = Object.freeze({
  KAPPA: 0.30,              // score → evidence squash
  L_CAP: 1.10,              // |L| cap before calibration (= logit 0.75)
  POOL_EXP: 0.6,            // global pooling exponent (<1 = shrink correlated evidence)
  UNCAL_SHRINK: 0.5,        // pUp = 0.5 + 0.5·(pRaw − 0.5) without a calibrator
  WITHIN_TERMS: 6,          // harmonic 1..1/6 within a subfamily
  ACROSS: [1, 0.7, 0.5, 0.4], ACROSS_DECAY: 0.8,
  SAT_RATE: 2,              // sat(m) = 1 − e^(−2m)
  RENORM_MAX: 1.5,
  EXTREME_VOL_SCALE: 0.5, EXTREME_CONF_BUMP: 0.05, POSITION_MIN_EDGE: 0.05,
  EDGE_SCALE: 0.04,         // E = 1 − e^(−edge/0.04)
  UNCAL_RELIABILITY: 0.88,  // confidence K-term when no reliable calibrator
  UNCAL_KELLY_RELIABILITY: 0.5,
  COST_GATE_MULT: 2,
  HORIZON_MISMATCH: 0.6,
});
const BRACKETS = Object.freeze({ intraday: { stop: 2, target: 3 }, swing: { stop: 2, target: 3 }, position: { stop: 3.5, target: 5.5 } });
const FAMILIES = ["technical", "regime", "fundamental", "sentiment", "macro", "microstructure", "ml", "llm", "derivatives", "relative"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const round = (x, d) => { const m = 10 ** d; return Math.round(fin(x) * m) / m; };

// Base family weights β by horizon (RESEARCH §5.1). `fundamental` is the stock value; crypto uses
// CRYPTO_FUNDAMENTAL. ML is not boosted: its own signal confidence (OOS-AUC based) scales it.
const DEFAULT_FAMILY_WEIGHTS = Object.freeze({
  intraday: { technical: 1, ml: 0.6, regime: 0.3, derivatives: 0.3, microstructure: 0.7, sentiment: 0.3,  macro: 0.1, fundamental: 0,    llm: 0.2, relative: 0.2 },
  swing:    { technical: 1, ml: 0.7, regime: 0.2, derivatives: 0.5, microstructure: 0.1, sentiment: 0.3,  macro: 0.3, fundamental: 0.15, llm: 0.3, relative: 0.5 },
  position: { technical: 1, ml: 0.5, regime: 0.2, derivatives: 0.5, microstructure: 0,   sentiment: 0.15, macro: 0.5, fundamental: 0.4,  llm: 0.2, relative: 0.6 },
});
const CRYPTO_FUNDAMENTAL = Object.freeze({ intraday: 0, swing: 0.1, position: 0.25 });

function classOf(x) {
  if (x && typeof x === "object") return x.etf ? "etf" : (x.assetClass || "stock");
  return x || "stock";
}

// β_f conditioned on horizon and asset class. Regime acts per signal (style multipliers) and
// globally (extreme-vol scale), not on β — see method notes. `regime` is accepted for API
// symmetry and for the extreme-vol case where every family is halved (reported in the table).
function familyWeights(regime, horizon, assetClass) {
  const h = DEFAULT_FAMILY_WEIGHTS[horizon] ? horizon : "swing";
  const w = { ...DEFAULT_FAMILY_WEIGHTS[h] };
  const cls = classOf(assetClass);
  if (cls === "crypto") w.fundamental = CRYPTO_FUNDAMENTAL[h];
  else { w.derivatives = 0; w.microstructure = 0; }            // no perp / live book data for stocks
  if (cls === "etf") w.fundamental = 0;                        // ETFs have no fundamentals
  if (regime && regime.vol === "extreme") for (const k of Object.keys(w)) w[k] *= PARAMS.EXTREME_VOL_SCALE;
  for (const k of Object.keys(w)) w[k] = round(w[k], 4);
  return w;
}

// Subfamily of a signal id: "tech.trend.ema_stack" → "trend"; "tech.1h.trend.x" → "trend".
function subfamily(id) {
  const t = String(id || "").split(".");
  if (t.length >= 3 && /^\d+(m|h|d|w)$/i.test(t[1])) return t[2];
  if (t[0] === "tech" && t[1] === "mtf") return "trend";   // audit: alignment re-aggregates the per-tf trend views
  return t[1] || "_";
}
const TREND_SUBS = new Set(["trend", "mtf"]);
const TREND_IDS = /(^|[._])(tsmom|macd|roc|donchian|breakout|supertrend|ema_stack|ichimoku|trend)([._]|$)/i;
const MR_IDS = /(^|[._])(meanrev|mean_reversion|reversion|bollinger|zscore|williams_r|williamsr|stochastic|cci)([._]|$)/i;
function styleOf(id, family) {
  if (family && family !== "technical" && family !== "ml") return "other";
  const sub = subfamily(id);
  if (sub === "meanrev" || MR_IDS.test(id)) return "meanrev";
  if (TREND_SUBS.has(sub) || (sub === "momentum" && TREND_IDS.test(id)) || (sub === "structure" && /donchian/.test(id))) return "trend";
  return "other";
}

// Regime-conditioned multiplier for an individual signal (RESEARCH §5.1).
// ctx.crashGuard: trailing 1y return < 0 and vol percentile > 0.7.
function styleMultiplier(id, regime, family, ctx = {}) {
  const style = styleOf(id, family);
  let m = 1;
  const t = regime && regime.trend;
  if (t === "up" || t === "down") m *= style === "trend" ? 1.3 : style === "meanrev" ? 0.4 : 1;
  else if (t === "range") m *= style === "trend" ? 0.6 : style === "meanrev" ? 1.3 : 1;
  if (regime && regime.vol === "high") m *= style === "trend" ? 0.8 : style === "meanrev" ? 1.1 : 0.9;
  if (ctx.crashGuard && style === "trend") m *= 0.5;
  return m;
}

// Evidence of one signal in log-odds (κ keeps it modest and finite).
const signalLogOdds = (score, kappa = PARAMS.KAPPA) => logit(0.5 + 0.5 * clamp(fin(score), -1, 1) * clamp(fin(kappa), 0, 0.99));

const withinFactor = (k) => (k < PARAMS.WITHIN_TERMS ? 1 / (k + 1) : 0);
const acrossFactor = (j) => (j < PARAMS.ACROSS.length ? PARAMS.ACROSS[j] : PARAMS.ACROSS[PARAMS.ACROSS.length - 1] * PARAMS.ACROSS_DECAY ** (j - PARAMS.ACROSS.length + 1));

// Two-level diminishing sum. items: [{ w, e, group }] (or plain numbers = w·e with w=1, one group).
// → { sum: Σ D_i·w_i·e_i, mass: Σ D_i·w_i, factors: D_i per item }.
function diminishingSum(items) {
  const arr = (items || []).map((it, idx) => (typeof it === "number"
    ? { w: 1, e: fin(it), g: "_", idx } : { w: Math.max(0, fin(it.w)), e: fin(it.e), g: it.group == null ? "_" : String(it.group), idx }));
  const factors = new Array(arr.length).fill(0);
  let sum = 0, mass = 0;
  for (const side of [1, -1, 0]) {
    const groups = new Map();
    for (const x of arr) if (x.w > 0 && Math.sign(x.e) === side) { if (!groups.has(x.g)) groups.set(x.g, []); groups.get(x.g).push(x); }
    const subs = [];
    for (const [g, xs] of groups) {
      xs.sort((a, b) => Math.abs(b.w * b.e) - Math.abs(a.w * a.e) || b.w - a.w || a.idx - b.idx);
      let s = 0, m = 0;
      xs.forEach((x, k) => { x.dw = withinFactor(k); s += x.dw * x.w * x.e; m += x.dw * x.w; });
      subs.push({ g, xs, s, m });
    }
    subs.sort((a, b) => Math.abs(b.s) - Math.abs(a.s) || b.m - a.m || (a.g < b.g ? -1 : 1));
    subs.forEach((sub, j) => {
      const A = acrossFactor(j);
      for (const x of sub.xs) { factors[x.idx] = A * x.dw; sum += factors[x.idx] * x.w * x.e; mass += factors[x.idx] * x.w; }
    });
  }
  return { sum, mass, factors };
}

const sat = (m) => 1 - Math.exp(-PARAMS.SAT_RATE * Math.max(0, fin(m)));

// ───────────────────────────── CONFIDENCE ─────────────────────────────
// confidence = K · X · E^0.35 · G^0.25 · C^0.20 · Q^0.10 · R^0.10          ∈ [0, 1]
//   E = 1 − exp(−edge / 0.04)               edge = |pUp − 0.5|       (0.04 → 0.63, 0.08 → 0.86)
//   G = sqrt(clamp(2·agreement − 1, 0, 1))  agreement = share of |contribution| on the chosen side
//   C = coverage                            β-weighted, mass-saturated share of expected families
//   Q = dataQuality                         freshness/source quality × (1 − 0.5·invalid-signal share)
//   R = regimeClarity                       vol term (low/normal 1, high .85, extreme .6) × (0.85 + 0.15·HMM clarity)
//   K = calibrator reliability              reliable: clamp(1 − 1.5·ECE, 0.75, 1); none/unreliable: 0.88
//   X = conflict factor                     1 − 0.5·clamp((severity − 0.2)/0.5, 0, 1)
// The weighted-geometric core (exponents sum to 1) makes each input a hard requirement (any 0 → 0);
// confidence is monotone non-decreasing in edge, agreement, coverage, quality, clarity and
// reliability, and non-increasing in conflict severity.
function confidenceScore({ edge = 0, agreement = 0, coverage = 0, dataQuality = 1, regimeClarity = 1,
  calibReliability = PARAMS.UNCAL_RELIABILITY, conflict = 0 } = {}) {
  const E = 1 - Math.exp(-Math.max(0, fin(edge)) / PARAMS.EDGE_SCALE);
  const G = Math.sqrt(clamp(2 * fin(agreement) - 1, 0, 1));
  const C = clamp(fin(coverage), 0, 1), Q = clamp(fin(dataQuality, 1), 0, 1), R = clamp(fin(regimeClarity, 1), 0, 1);
  const K = clamp(fin(calibReliability, PARAMS.UNCAL_RELIABILITY), 0, 1);
  const X = 1 - 0.5 * clamp((fin(conflict) - 0.2) / 0.5, 0, 1);
  const core = (E > 0 && G > 0 && C > 0 && Q > 0 && R > 0)
    ? Math.exp(0.35 * Math.log(E) + 0.25 * Math.log(G) + 0.2 * Math.log(C) + 0.1 * Math.log(Q) + 0.1 * Math.log(R)) : 0;
  return { confidence: clamp(K * X * core, 0, 1), terms: { E, G, C, Q, R, K, X } };
}

function regimeClarity(regime) {
  if (!regime) return 0.9;
  const volTerm = { low: 1, normal: 1, high: 0.85, extreme: 0.6 }[regime.vol] ?? 0.95;
  let clar = 0.95;
  const probs = regime.hmm && Array.isArray(regime.hmm.probs) ? regime.hmm.probs.map(Number).filter(Number.isFinite) : null;
  if (probs && probs.length > 1) {
    const k = probs.length, mx = Math.max(...probs);
    clar = 0.85 + 0.15 * clamp((mx - 1 / k) / (1 - 1 / k), 0, 1);
  }
  return volTerm * clar;
}

// Data quality from a number or the engine's { freshnessSec, marketOpen, sources } object.
function dataQualityOf(dq, tfSec) {
  if (dq == null) return 1;
  if (typeof dq === "number") return clamp(fin(dq, 1), 0, 1);
  if (typeof dq !== "object") return 1;
  let q = 1;
  const f = Number(dq.freshnessSec);
  if (dq.freshnessSec == null || !Number.isFinite(f)) q *= 0.85;
  else {
    const allowed = dq.marketOpen === false ? 3.5 * 86400 : Math.max(600, 0.25 * fin(tfSec, 86400));
    if (f > allowed) q *= Math.sqrt(clamp(allowed / f, 0.16, 1));
  }
  const src = dq.sources || {};
  if (src.candles === "fail" || src.gather === "fail" || src.asset === "fail") q *= 0.4;
  if (src.quote === "fail") q *= 0.95;
  return clamp(q, 0, 1);
}

function calibInfo(calibrator) {
  const none = { apply: null, reliable: false, K: PARAMS.UNCAL_RELIABILITY, kelly: PARAMS.UNCAL_KELLY_RELIABILITY, ece: null };
  if (!calibrator) return none;
  const apply = typeof calibrator === "function" ? calibrator : (typeof calibrator.apply === "function" ? (p) => calibrator.apply(p) : null);
  if (!apply) return none;
  let rel = null;
  try { rel = typeof calibrator.reliability === "function" ? calibrator.reliability() : null; } catch { rel = null; }
  const reliable = rel ? rel.reliable !== false && !(Number(rel.n) < 30) : typeof calibrator === "function";
  // Audit: prefer the calibrator's honest out-of-fold numbers — in-sample isotonic ECE is ~0 by
  // construction, which pinned K and the Kelly reliability near 1 even for a no-skill calibrator.
  const oof = rel && rel.oof && typeof rel.oof === "object" ? rel.oof : null;
  const ece = oof && Number.isFinite(oof.ece) ? oof.ece : rel && Number.isFinite(rel.ece) ? rel.ece : null;
  const bss = oof && Number.isFinite(oof.bss) ? oof.bss : null;
  return {
    apply, reliable, ece, bss,
    K: reliable ? clamp(1 - 1.5 * fin(ece, 0.05), 0.75, 1) : PARAMS.UNCAL_RELIABILITY,
    kelly: reliable ? clamp(Math.min(1 - 4 * fin(ece, 0.05), bss != null ? 0.25 + 50 * Math.max(0, bss) : 1), 0.25, 1) : PARAMS.UNCAL_KELLY_RELIABILITY,
  };
}

function learnedWeight(weights, id) {
  if (!weights) return 1;
  let w;
  try {
    if (typeof weights === "function") w = weights(id);
    else if (typeof weights.get === "function") w = weights.get(id);
    else w = weights[id];
  } catch { w = 1; }
  return Number.isFinite(w) && w >= 0 ? w : 1;
}

// Effective gating thresholds: override (UPPER, camelCase or snake_case keys) > cfg; position
// horizon floors MIN_PROB_EDGE at 0.05 unless overridden; extreme vol adds +0.05 confidence.
function readThresholds(cfg = baseCfg, over = {}, horizon, regime) {
  const o = over || {};
  const has = (K, c, s) => [o[K], o[c], o[s]].some(v => v != null && v !== "" && Number.isFinite(Number(v)));
  const pick = (K, c, s) => { const v = [o[K], o[c], o[s]].find(x => x != null && x !== "" && Number.isFinite(Number(x))); return v != null ? Number(v) : fin(cfg[K], baseCfg[K]); };
  const th = {
    MIN_CONFIDENCE: pick("MIN_CONFIDENCE", "minConfidence", "min_confidence"),
    MIN_PROB_EDGE: pick("MIN_PROB_EDGE", "minProbEdge", "min_prob_edge"),
    MIN_AGREEMENT: pick("MIN_AGREEMENT", "minAgreement", "min_agreement"),
    STRONG_CONFIDENCE: pick("STRONG_CONFIDENCE", "strongConfidence", "strong_confidence"),
  };
  if (horizon === "position" && !has("MIN_PROB_EDGE", "minProbEdge", "min_prob_edge")) th.MIN_PROB_EDGE = Math.max(th.MIN_PROB_EDGE, PARAMS.POSITION_MIN_EDGE);
  if (regime && regime.vol === "extreme") th.MIN_CONFIDENCE = round(th.MIN_CONFIDENCE + PARAMS.EXTREME_CONF_BUMP, 4);
  return th;
}

function periodsPerYear(tfSec, cls) {
  const tf = fin(tfSec, 86400);
  if (cls === "crypto") return 365 * 86400 / tf;
  return tf >= 86400 ? 252 * 86400 / tf : 252 * 6.5 * 3600 / tf;
}

// Trailing ~1y return from daily candles (or regime.ret1y if supplied); null if unknown.
function trailingYearReturn(candles, cls, tfSec, regime) {
  if (regime && Number.isFinite(regime.ret1y)) return regime.ret1y;
  if (!Array.isArray(candles) || candles.length < 120 || fin(tfSec, 86400) < 86400) return null;
  const n = candles.length, look = Math.min(n - 1, cls === "crypto" ? 365 : 252);
  const a = Number(candles[n - 1 - look] && candles[n - 1 - look].c), b = Number(candles[n - 1] && candles[n - 1].c);
  return a > 0 && b > 0 ? b / a - 1 : null;
}

// ───────────────────────────── text helpers ─────────────────────────────
const pct0 = (x) => `${Math.round(x * 100)}%`;
const sgnPct = (x, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
const sgnNum = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
function fmtPrice(p) {
  if (!Number.isFinite(p)) return "?";
  const a = Math.abs(p);
  return a >= 100 ? p.toFixed(1) : a >= 1 ? p.toFixed(2) : p.toPrecision(4);
}
function shortReason(s) {
  let r = String((s && (s.reason || s.id)) || "").split(/ — | – |; /)[0].trim();
  if (r.length > 72) r = r.slice(0, 69).replace(/\s+\S*$/, "") + "…";
  return r || String(s && s.id);
}
function regimeText(regime) {
  if (!regime) return "unknown";
  const t = { up: "trending-up", down: "trending-down", range: "ranging" }[regime.trend] || regime.trend || "?";
  return `${t} / ${regime.vol || "?"} vol`;
}

// ───────────────────────────── decide ─────────────────────────────
// decide({ asset, signals, regime, horizon, price, atr, weights, calibrator, now,
//          candles?, thresholds?, dataQuality?, equity?, openPositions?, correlation?, drawdown?,
//          held?|position?, expectedFamilies?, feeBps?, annVol?, cfg? }, opts?) -> Decision
// `opts` is merged over the first argument (so decide(input, { thresholds }) works too).
function decide(input = {}, opts = {}) {
  const a = { ...(input || {}), ...(opts || {}) };
  const cfg = { ...baseCfg, ...(a.cfg || {}) };
  const asset = a.asset || {};
  const cls = classOf(asset.assetClass ? asset : a.assetClass);
  const horizon = a.horizon || cfg.HORIZON || "swing";
  const hz = (cfg.HORIZONS && cfg.HORIZONS[horizon]) || { tf: 86400, ahead: 5, label: horizon };
  const regime = a.regime || null;
  const th = readThresholds(cfg, a.thresholds || {}, horizon, regime);
  const beta = { ...familyWeights(regime, horizon, cls), other: 0.1 };
  const ret1y = trailingYearReturn(a.candles, cls, hz.tf, regime);
  const crashGuard = ret1y != null && ret1y < 0 && regime && fin(regime.volPercentile, 0) > 0.7;

  // ---- sanitize ----
  const raw = Array.isArray(a.signals) ? a.signals : [];
  let invalid = 0;
  const sigs = [];
  for (const s of raw) {
    if (!s || typeof s !== "object" || !Number.isFinite(Number(s.score))) { invalid++; continue; }
    sigs.push({ ...s, id: String(s.id || "unknown"), family: FAMILIES.includes(s.family) ? s.family : "other",
      score: clamp(Number(s.score), -1, 1), confidence: clamp(fin(Number(s.confidence), 0), 0, 1) });
  }

  // ---- per-signal evidence & weight ----
  const items = sigs.map(s => {
    const hMatch = s.horizon && s.horizon !== "any" && s.horizon !== horizon ? PARAMS.HORIZON_MISMATCH : 1;
    const w = learnedWeight(a.weights, s.id) * s.confidence * styleMultiplier(s.id, regime, s.family, { crashGuard }) * hMatch;
    return { s, e: signalLogOdds(s.score), w: fin(w), contribution: 0, d: 0 };
  });

  // ---- per-family de-duplicated evidence ----
  const fam = {};
  for (const f of Object.keys(beta)) {
    const its = items.filter(x => x.s.family === f);
    if (!its.length) continue;
    const ds = diminishingSum(its.map(x => ({ w: x.w, e: x.e, group: subfamily(x.s.id) })));
    its.forEach((x, k) => { x.d = ds.factors[k]; });
    const m = ds.mass;
    fam[f] = { items: its, mass: m, ebar: m > 0 ? ds.sum / m : 0,
      score: m > 0 ? its.reduce((acc, x) => acc + x.d * x.w * x.s.score, 0) / m : 0,
      omega: fin(beta[f]) * sat(m), beta: fin(beta[f]), n: its.length, logodds: 0 };
  }
  const present = Object.keys(fam).filter(f => fam[f].omega > 0);
  const sumOmega = present.reduce((s, f) => s + fam[f].omega, 0);
  const expected = new Set((Array.isArray(a.expectedFamilies) ? a.expectedFamilies
    : Object.keys(beta).filter(f => f !== "llm" && f !== "other" && f !== "relative")).filter(f => fin(beta[f]) > 0));
  for (const f of present) expected.add(f);
  // Audit: a family that REPORTED but abstains (e.g. ML with OOS-AUC confidence 0) is not missing
  // data; counting it as missing inflated every other family's evidence by ~12% (renorm √(3.4/2.7)).
  const bPresent = Object.keys(fam).reduce((s, f) => s + (fam[f].n > 0 ? fam[f].beta : 0), 0);
  const bExpected = [...expected].reduce((s, f) => s + fin(beta[f]), 0);
  const renorm = bPresent > 0 ? Math.min(PARAMS.RENORM_MAX, Math.sqrt(Math.max(1, bExpected / bPresent))) : 1;
  const scale = PARAMS.POOL_EXP * renorm;           // extreme vol already halves every β_f
  const Lpre = scale * present.reduce((s, f) => s + fam[f].omega * fam[f].ebar, 0);
  const L = clamp(fin(Lpre), -PARAMS.L_CAP, PARAMS.L_CAP);
  const capRatio = Math.abs(Lpre) > 1e-12 ? L / Lpre : 1;
  for (const f of present) {
    const F = fam[f];
    for (const x of F.items) x.contribution = fin(F.mass > 0 ? scale * capRatio * F.omega * (x.d * x.w * x.e) / F.mass : 0);
    F.logodds = scale * capRatio * F.omega * F.ebar;
  }
  // Every signal carries its signed pooled log-odds contribution (Σ contributions = L) and its
  // de-duplication factor, for the UI's signal table.
  for (const x of items) { x.s.contribution = round(x.contribution, 5); x.s.dedupFactor = round(x.d, 4); }
  const noEvidence = present.length === 0 || !(sumOmega > 0);
  const pRaw = noEvidence ? 0.5 : sigmoid(L);

  // ---- calibration ----
  const cal = calibInfo(a.calibrator);
  let pUp = 0.5 + PARAMS.UNCAL_SHRINK * (pRaw - 0.5);
  // Audit: calibrate the statistic the calibrator was FITTED on. Warm-start pairs come from
  // backtest.run (base-tf technical + regime, expectedFamilies [technical, regime], no learned
  // weights, no mask); live pRaw adds 15m/1h signals, ML, derivatives, sentiment, macro,
  // fundamentals, learned weights and a renormalisation for silent families (mean |ΔL| 0.083 crypto /
  // 0.045 stocks vs a training sd of ≈0.15). The engine passes the backtest-equivalent pooled value as
  // a.calibration = { pRaw, logOdds, extraShrink }; the calibrated probability is then moved by the
  // remaining, un-backtested evidence, shrunk and capped:
  //   logit(pUp) = logit(cal(pRaw_cal)) + λ·clamp(L − L_cal, ±EXTRA_CAP),  λ = extraShrink (0.5).
  const calIn = a.calibration && Number.isFinite(Number(a.calibration.pRaw)) ? a.calibration : null;
  if (!noEvidence && cal.apply) {
    let pc = NaN;
    try { pc = Number(cal.apply(calIn ? Number(calIn.pRaw) : pRaw)); } catch { pc = NaN; }
    if (Number.isFinite(pc) && calIn && Number.isFinite(Number(calIn.logOdds))) {
      const lam = clamp(fin(Number(calIn.extraShrink), 0.5), 0, 1);
      const extra = clamp(L - Number(calIn.logOdds), -0.4, 0.4);
      pc = sigmoid(logit(clamp(pc, 1e-6, 1 - 1e-6)) + lam * extra);
    }
    if (Number.isFinite(pc)) pUp = pc;
  }
  // Learned-model override (v2): when the self-improvement loop has promoted a stacked model, it
  // supplies an already-calibrated P(up) (and its own base rate); pooling still drives the
  // explanation (drivers / agreement) and stays as the fallback.
  const prob = a.probability && Number.isFinite(Number(a.probability.pUp)) ? a.probability : null;
  if (prob && !noEvidence) pUp = Number(prob.pUp);
  pUp = noEvidence ? 0.5 : clamp(pUp, 0.001, 0.999);
  const side = pUp > 0.5 ? 1 : pUp < 0.5 ? -1 : (L >= 0 ? 1 : -1);
  // Informational edge. A calibrator fitted on a period where the asset class mostly rose learns
  // that drift (e.g. 56% of weeks up) and would call everything a BUY. The edge that gates and
  // scores a call is therefore the smaller of |pUp − 0.5| (is the bet +EV at all?) and the
  // distance from the class base rate on the traded side (do the signals add anything beyond
  // drift?). Without a base rate (no calibrator) this is plain |pUp − 0.5|.
  const baseIn = prob && Number.isFinite(Number(prob.baseRate)) ? prob.baseRate : cal.apply ? a.baseRate : null;
  const baseRate = Number.isFinite(Number(baseIn)) && baseIn !== null ? clamp(Number(baseIn), 0.3, 0.7) : 0.5;
  const edgeVsBase = side > 0 ? pUp - baseRate : baseRate - pUp;
  const edge = Math.max(0, Math.min(Math.abs(pUp - 0.5), edgeVsBase));

  // ---- agreement, coverage, conflicts ----
  let pro = 0, tot = 0;
  for (const x of items) { const c = Math.abs(x.contribution); tot += c; if (Math.sign(x.contribution) === side) pro += c; }
  const agreement = tot > 0 ? pro / tot : 0;
  let covNum = 0;
  for (const f of expected) covNum += fin(beta[f]) * (fam[f] ? sat(fam[f].mass) : 0);
  const coverage = bExpected > 0 ? clamp(covNum / bExpected, 0, 1) : 0;
  const missing = [...expected].filter(f => !fam[f] || !(fam[f].mass > 0));

  const conflicts = [];
  for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
    const A = fam[present[i]], B = fam[present[j]];
    if (A.omega / sumOmega < 0.12 || B.omega / sumOmega < 0.12 || Math.sign(A.score) * Math.sign(B.score) >= 0) continue;
    const sev = Math.min(Math.abs(A.score), Math.abs(B.score));
    if (sev >= 0.3) conflicts.push({ a: present[i], b: present[j], scoreA: round(A.score, 3), scoreB: round(B.score, 3), severity: round(sev, 3) });
  }
  conflicts.sort((x, y) => y.severity - x.severity);

  const dq = dataQualityOf(a.dataQuality, hz.tf) * (1 - 0.5 * (raw.length ? invalid / raw.length : 0));
  const { confidence: conf0, terms } = confidenceScore({ edge, agreement, coverage, dataQuality: dq,
    regimeClarity: regimeClarity(regime), calibReliability: cal.K, conflict: conflicts.length ? conflicts[0].severity : 0 });
  // Meta-label override (v2, López de Prado): when a promoted meta-labeler is available, confidence
  // IS its out-of-sample-trained probability that this side's bracket trade ends net-profitable,
  // lightly discounted for data quality; its own threshold replaces MIN_CONFIDENCE.
  const meta = a.meta && Number.isFinite(Number(a.meta.pSuccess)) ? { pSuccess: clamp(Number(a.meta.pSuccess), 0, 1),
    threshold: clamp(fin(Number(a.meta.threshold), 0.55), 0.5, 0.9), version: a.meta.version ?? null } : null;
  const confidence = noEvidence ? 0 : meta ? clamp(meta.pSuccess * Math.pow(clamp(dq, 0, 1), 0.1), 0, 1) : conf0;
  if (meta) { th.MIN_CONFIDENCE = meta.threshold + fin(a.thresholds && a.thresholds.DERISK_BUMP, 0); th.STRONG_CONFIDENCE = Math.max(th.STRONG_CONFIDENCE, meta.threshold + 0.1); }

  // ---- risk geometry (for the leaning side) ----
  // Held = explicit flag / position, or an open LONG paper position on this asset (db rows).
  const heldOpen = Array.isArray(a.openPositions) && asset.id != null
    && a.openPositions.some(p => p && p.assetId === asset.id && (p.direction == null || p.direction === "long") && p.status !== "closed");
  const held = !!(a.held || heldOpen || (a.position && typeof a.position === "object" && fin(Number(a.position.qty ?? a.position.size ?? 1)) !== 0));
  const price = fin(Number(a.price), NaN);
  const atr = fin(Number(a.atr), NaN) > 0 ? Number(a.atr) : null;
  const br0 = BRACKETS[horizon] || BRACKETS.swing;
  const stopAtr = fin(cfg[`STOP_ATR_${String(horizon).toUpperCase()}`], br0.stop);
  const tgtAtr = fin(cfg[`TARGET_ATR_${String(horizon).toUpperCase()}`], br0.target);
  const feeBps = fin(a.feeBps, cls === "crypto" ? fin(cfg.FEE_BPS_CRYPTO, 10) : fin(cfg.FEE_BPS_STOCK, 1));
  const costFrac = 2 * (feeBps + fin(cfg.SLIPPAGE_BPS, 5)) / 1e4;     // round trip
  const H = fin(hz.ahead, 5), ppy = periodsPerYear(hz.tf, cls);
  const lean = side;                                                  // +1 long, −1 short
  const pWin = lean > 0 ? pUp : 1 - pUp;
  const atrPct = price > 0 && atr ? atr / price : null;
  const br = atrPct ? risk.bracketExpectation({ pWin, atrPct, stopAtr, targetAtr: tgtAtr, horizonBars: H, costFrac }) : null;

  // ---- gating ----
  const fails = [];
  if (noEvidence) fails.push(sigs.length ? "no usable evidence (all signals zero-confidence)" : "no signals");
  else {
    if (confidence < th.MIN_CONFIDENCE) fails.push(`confidence ${confidence.toFixed(2)} < ${th.MIN_CONFIDENCE}`);
    if (edge < th.MIN_PROB_EDGE) fails.push(`edge ${edge.toFixed(3)} < ${th.MIN_PROB_EDGE}`);
    if (agreement < th.MIN_AGREEMENT) fails.push(`agreement ${agreement.toFixed(2)} < ${th.MIN_AGREEMENT}`);
    const isExit = lean < 0 && held;
    if (!fails.length && br && !isExit && br.eGross < PARAMS.COST_GATE_MULT * costFrac)
      fails.push(`expected move ${(br.eGross * 100).toFixed(2)}% < ${(PARAMS.COST_GATE_MULT * costFrac * 100).toFixed(2)}% (${PARAMS.COST_GATE_MULT}× round-trip cost ${(costFrac * 100).toFixed(2)}%)`);
  }
  let action = "HOLD";
  if (!fails.length) {
    const strong = confidence >= th.STRONG_CONFIDENCE;
    action = side > 0 ? (strong ? "STRONG_BUY" : "BUY") : (strong ? "STRONG_SELL" : "SELL");
  }
  const isSell = action === "SELL" || action === "STRONG_SELL", isBuy = action === "BUY" || action === "STRONG_BUY";
  const direction = isBuy ? "long" : isSell && !held ? "short" : null;
  const sellIntent = isSell ? (held ? "exit" : "short") : null;

  // ---- risk plan ----
  let riskPlan = { direction, stop: null, target: null, atr, atrPct, riskReward: tgtAtr / stopAtr, stopAtr, targetAtr: tgtAtr,
    sizeFrac: 0, sizeUsd: 0, var95: 0, maxLossUsd: 0, expectedReturnGross: br ? br.eGross : 0, costFrac, pWin,
    kellyFrac: 0, volTargetFrac: 0, capped: [] };
  if (price > 0 && atr) {
    const pl = direction === "short" ? -1 : direction === "long" ? 1 : lean;
    const annVol = fin(a.annVol, 0) > 0 ? a.annVol : fin(regime && regime.annVol, 0) > 0 ? regime.annVol : (atrPct / 1.5) * Math.sqrt(ppy);
    const equity = fin(Number(a.equity), fin(cfg.PAPER_BALANCE, 100000));
    let sz = { sizeFrac: 0, sizeUsd: 0, kellyFrac: 0, volTargetFrac: 0, capped: [isSell ? "exit" : "abstain"] };
    if (direction) sz = risk.positionSize({ pUp: pWin, riskReward: tgtAtr / stopAtr, atrPct, annVol, equity, cfg, assetClass: cls,
      openPositions: a.openPositions || [], correlation: a.correlation, stopAtr, horizonBars: H, costFrac,
      periodsPerYear: ppy, drawdown: a.drawdown,
      reliability: cal.kelly * (meta ? clamp((meta.pSuccess - 0.5) / 0.2, 0, 1) : 1) * clamp(fin(Number(a.sizeMult), 1), 0, 1) });
    const sigmaH = (atrPct / 1.5) * Math.sqrt(H);
    riskPlan = { ...riskPlan, stop: price - pl * stopAtr * atr, target: price + pl * tgtAtr * atr,
      sizeFrac: sz.sizeFrac, sizeUsd: sz.sizeUsd, kellyFrac: sz.kellyFrac, volTargetFrac: sz.volTargetFrac, capped: sz.capped,
      var95: sz.sizeUsd * Math.max(0, 1.6448536 * sigmaH - Math.max(0, br.eGross)), maxLossUsd: sz.sizeUsd * br.lossFrac, annVol };
  }
  const expectedReturn = br ? br.eNet : 0;

  // ---- explanation ----
  const view = (x) => ({ id: x.s.id, family: x.s.family, score: x.s.score, confidence: x.s.confidence,
    contribution: round(x.contribution, 5), reason: x.s.reason || "" });
  const ranked = items.filter(x => Math.abs(x.contribution) > 1e-9)
    .sort((p, q) => Math.abs(q.contribution) - Math.abs(p.contribution) || (p.s.id < q.s.id ? -1 : 1));
  const dirSign = isSell ? -1 : isBuy ? 1 : side;
  const drivers = ranked.filter(x => Math.sign(x.contribution) === dirSign).slice(0, 5).map(view);
  const against = ranked.filter(x => Math.sign(x.contribution) === -dirSign).slice(0, 3).map(view);
  const families = {};
  for (const f of Object.keys(fam)) {
    const F = fam[f];
    families[f] = { score: round(F.score, 3), weight: round(sumOmega > 0 ? F.omega / sumOmega : 0, 3), beta: F.beta,
      logodds: round(F.logodds, 4), mass: round(F.mass, 3), n: F.n };
  }
  const nowMs = typeof a.now === "number" ? a.now : a.now ? Date.parse(a.now) : Date.now();

  const decision = {
    assetId: asset.id || null, symbol: asset.symbol || a.symbol || "?", assetClass: cls === "etf" ? "stock" : cls,
    ts: new Date(fin(nowMs, Date.now())).toISOString(), horizon, horizonLabel: hz.label || horizon,
    price: Number.isFinite(price) ? price : null,
    action, pUp: round(pUp, 4), pRaw: round(pRaw, 4), pRawCal: calIn ? round(Number(calIn.pRaw), 4) : null,
    confidence: round(confidence, 4), agreement: round(agreement, 4),
    coverage: round(coverage, 4), edge: round(edge, 4), baseRate: round(baseRate, 4), edgeVsBase: round(edgeVsBase, 4), expectedReturn: round(expectedReturn, 5),
    risk: riskPlan, sellIntent, calibrated: cal.reliable,
    regime: regime ? { label: regime.label || regimeText(regime), trend: regime.trend || null, vol: regime.vol || null,
      hmmState: regime.hmm ? (regime.hmm.state ?? null) : null } : null,
    families, conflicts, missingFamilies: missing, thresholds: th, crashGuard: !!crashGuard,
    confidenceTerms: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, round(v, 4)])),
    model: prob ? { kind: prob.source || "stacker", version: prob.version ?? null, pooledPUp: round(0.5 + PARAMS.UNCAL_SHRINK * (pRaw - 0.5), 4) } : { kind: "pooled", version: null },
    meta: meta ? { pSuccess: round(meta.pSuccess, 4), threshold: meta.threshold, version: meta.version } : null,
    logOdds: round(L, 4), drivers, against, signals: sigs, abstainReason: fails.length ? fails.join("; ") : null,
  };
  decision.summary = buildSummary(decision, cal);
  return decision;
}

function buildSummary(d, cal) {
  const parts = [];
  const dirWord = d.sellIntent === "short" ? " (short)" : d.sellIntent === "exit" ? " (exit long)" : "";
  parts.push(`${d.action}${dirWord} ${d.symbol} — ${d.horizonLabel} horizon. P(up) ${pct0(d.pUp)} (raw ${pct0(d.pRaw)}, ${cal.reliable ? "calibrated" : "shrunk for calibration"}), confidence ${pct0(d.confidence)}.`);
  const list = (xs) => xs.map(shortReason).join("; ");
  if (d.action === "HOLD") {
    parts.push(`Abstaining: ${d.abstainReason}.`);
    if (d.drivers.length) parts.push(`Leaning ${d.pUp >= 0.5 ? "up" : "down"} on: ${list(d.drivers.slice(0, 3))}.`);
    if (d.against.length) parts.push(`Other side: ${list(d.against.slice(0, 2))}.`);
  } else {
    if (d.drivers.length) parts.push(`Drivers: ${list(d.drivers.slice(0, 3))}.`);
    if (d.against.length) parts.push(`Against: ${list(d.against.slice(0, 2))}.`);
  }
  if (d.conflicts.length) {
    const c = d.conflicts[0], w = (s) => (s > 0 ? "bullish" : "bearish");
    parts.push(`Conflict: ${c.a} ${w(c.scoreA)} (${sgnNum(c.scoreA)}) vs ${c.b} ${w(c.scoreB)} (${sgnNum(c.scoreB)}) — confidence reduced.`);
  }
  if (d.coverage < 0.95 && d.missingFamilies.length) parts.push(`Coverage ${pct0(d.coverage)} (missing: ${d.missingFamilies.join(", ")}).`);
  if (d.crashGuard) parts.push("Momentum-crash guard on (1y return < 0, high vol): trend signals halved.");
  parts.push(`Regime: ${d.regime ? regimeText(d.regime) : "unknown"}.`);
  const r = d.risk;
  if (d.sellIntent === "exit") parts.push("Plan: exit the long position.");
  else if (r.direction && r.stop != null && d.price) {
    parts.push(`Plan: ${r.direction} — stop ${fmtPrice(r.stop)} (${sgnPct((r.stop - d.price) / d.price)}), target ${fmtPrice(r.target)} (${sgnPct((r.target - d.price) / d.price)}), R:R ${r.riskReward.toFixed(1)}, E[r] ${sgnPct(d.expectedReturn, 2)} after costs, size ${(r.sizeFrac * 100).toFixed(1)}% of equity.`);
  } else if (r.direction && !r.atr) parts.push("Plan: no ATR available — size 0 until volatility is known.");
  return parts.join(" ");
}

module.exports = {
  decide, familyWeights, DEFAULT_FAMILY_WEIGHTS, CRYPTO_FUNDAMENTAL, PARAMS, BRACKETS, FAMILIES,
  signalLogOdds, diminishingSum, confidenceScore, styleMultiplier, styleOf, subfamily, regimeClarity,
  dataQualityOf, readThresholds, calibInfo,
};
