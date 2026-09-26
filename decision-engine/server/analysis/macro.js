// Macro regime analysis (contract §2.6). Pure: FRED-style daily series in, Signal[] out.
//
// macro = { vix, dgs10, t10y2y, dxy, hyOas }, each [{t, v}] daily (any may be missing/short).
// asset = { assetClass: "crypto"|"stock", symbol, etf }.
//
// Economic mapping (sign is for RISK assets; every asset we trade is a risk asset):
//   * VIX high / rising        → risk-off → negative. Exception: a VIX spike that is already rolling
//                                 over from a high peak historically precedes above-average equity
//                                 returns (vol mean-reversion), so the penalty is partly reversed.
//   * HY OAS wide / widening   → credit stress leads equity drawdowns (Gilchrist-Zakrajšek 2012).
//   * 10y yield rising fast    → discount-rate shock → negative for long-duration assets
//                                 (growth equities, crypto).
//   * Broad dollar strength    → tighter global USD liquidity → negative for crypto and for
//                                 multinationals' translated earnings.
//   * Curve inversion (10y-2y) → recession risk over 6–18m → mild negative at the position horizon;
//                                 the re-steepening out of inversion is historically the more
//                                 dangerous phase.
// Beta: crypto has ~1.5× the risk-on/off sensitivity of equities (and more to USD liquidity).

const FAMILY = "macro";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const squash = (x) => (isNum(x) ? Math.tanh(x) : 0);

function makeSignal(id, score, confidence, horizon, value, reason) {
  return {
    id, family: FAMILY,
    score: round(isNum(score) ? clamp(score, -1, 1) : 0),
    confidence: round(isNum(confidence) ? clamp(confidence, 0, 1) : 0),
    horizon, value, reason,
  };
}

// Clean a series: finite values, ascending time. Accepts {t,v} or {t,value}.
function clean(series) {
  if (!Array.isArray(series)) return [];
  const out = [];
  for (const p of series) {
    if (!p) continue;
    const v = typeof p.v === "string" ? Number(p.v) : p.v != null ? p.v : typeof p.value === "string" ? Number(p.value) : p.value;
    if (!isNum(v)) continue;
    const t = typeof p.t === "number" ? p.t : Date.parse(p.t);
    out.push({ t: isNum(t) ? t : out.length, v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const last = (s) => (s.length ? s[s.length - 1].v : null);
const ago = (s, n) => (s.length > n ? s[s.length - 1 - n].v : null);
const maxLast = (s, n) => (s.length ? Math.max(...s.slice(-n).map((p) => p.v)) : null);
const minLast = (s, n) => (s.length ? Math.min(...s.slice(-n).map((p) => p.v)) : null);
const lenConf = (s, need) => clamp(s.length / need, 0, 1);

function betas(asset) {
  const cls = asset && asset.assetClass;
  if (cls === "crypto") return { risk: 1.5, rates: 1.1, dollar: 1.0, curve: 1.2, label: "crypto (β≈1.5)" };
  return { risk: 1.0, rates: 0.8, dollar: 0.5, curve: 1.0, label: asset && asset.etf ? "equity ETF" : "equity" };
}

function signals(macro, asset, opts = {}) {
  if (!macro || typeof macro !== "object") return [];
  const b = betas(asset);
  const out = [];
  const stress = []; // components for the composite regime

  // ---- VIX ----
  const vix = clean(macro.vix);
  if (vix.length >= 2) {
    const v = last(vix);
    const v20 = ago(vix, Math.min(20, vix.length - 1));
    const chg = v20 > 0 ? v / v20 - 1 : 0;
    const level = squash((v - 20) / 8);        // 12 → −0.76, 20 → 0, 30 → +0.85
    const trend = squash(chg / 0.3);
    let s = level * 0.6 + trend * 0.4;          // stress in [-1, 1]
    const peak = maxLast(vix, 15);
    const rollingOver = peak >= 30 && v < 0.85 * peak;
    let score = -b.risk * 0.55 * s;
    if (rollingOver) score += 0.3;              // spike fading: historically a good entry
    stress.push(s);
    out.push(makeSignal("macro.risk.vix", score, (0.3 + 0.3 * Math.abs(s)) * lenConf(vix, 21), "swing",
      { vix: round(v, 2), chg20d: round(chg), peak15d: round(peak, 2), rollingOver },
      `VIX ${v.toFixed(1)} (${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(0)}% over ~20d)${rollingOver ? `, rolling over from ${peak.toFixed(1)} peak` : ""} → ${s > 0.25 ? "risk-off" : s < -0.25 ? "risk-on" : "neutral"} for ${b.label}`));
  }

  // ---- HY credit spreads (FRED BAMLH0A0HYM2, percent) ----
  const hy = clean(macro.hyOas);
  if (hy.length >= 2) {
    const v = last(hy);
    const v20 = ago(hy, Math.min(20, hy.length - 1));
    const chg = v - v20;                         // percentage points
    const s = 0.4 * squash((v - 4.5) / 1.5) + 0.6 * squash(chg / 0.4);
    stress.push(s);
    out.push(makeSignal("macro.risk.credit", -b.risk * 0.55 * s, (0.3 + 0.3 * Math.abs(s)) * lenConf(hy, 21), "swing",
      { hyOas: round(v, 3), chg20d: round(chg, 3) },
      `HY OAS ${v.toFixed(2)}% (${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(0)}bp over ~20d) → credit ${s > 0.2 ? "stress widening" : s < -0.2 ? "benign/tightening" : "stable"}`));
  }

  // ---- 10y yield momentum ----
  const y10 = clean(macro.dgs10);
  if (y10.length >= 2) {
    const v = last(y10);
    const v20 = ago(y10, Math.min(20, y10.length - 1));
    const chg = v - v20;                         // pp
    const s = squash(chg / 0.3);                 // +30bp in a month ≈ meaningful shock
    out.push(makeSignal("macro.rates.momentum", -b.rates * 0.4 * s, (0.2 + 0.25 * Math.abs(s)) * lenConf(y10, 21), "swing",
      { dgs10: round(v, 3), chg20d: round(chg, 3) },
      `10y yield ${v.toFixed(2)}% (${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(0)}bp over ~20d) → ${chg > 0.1 ? "discount-rate headwind" : chg < -0.1 ? "falling-rate tailwind" : "rates steady"}`));
  }

  // ---- Broad dollar (DTWEXBGS) ----
  const dxy = clean(macro.dxy);
  if (dxy.length >= 2) {
    const v = last(dxy);
    const v20 = ago(dxy, Math.min(20, dxy.length - 1));
    const chg = v20 > 0 ? v / v20 - 1 : 0;
    const s = squash(chg / 0.02);                // 2% monthly move in the broad dollar is large
    out.push(makeSignal("macro.fx.dollar", -b.dollar * 0.45 * s, (0.2 + 0.25 * Math.abs(s)) * lenConf(dxy, 21), "swing",
      { dxy: round(v, 3), chg20d: round(chg) },
      `Broad dollar ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}% over ~20d → ${chg > 0.005 ? "USD strength headwind" : chg < -0.005 ? "USD weakness tailwind" : "neutral"}`));
  }

  // ---- Yield curve (10y − 2y) ----
  const curve = clean(macro.t10y2y);
  if (curve.length >= 2) {
    const v = last(curve);
    const minRecent = minLast(curve, 250);
    const v60 = ago(curve, Math.min(60, curve.length - 1));
    const steepening = v - v60;
    let score = 0, phase;
    if (v < 0) { score = -0.25 * squash(-v / 0.5); phase = "inverted"; }
    else if (minRecent < -0.25 && steepening > 0.3) { score = -0.3 * squash(steepening / 0.5); phase = "bull-steepening out of inversion"; }
    else { score = 0.1 * squash(v / 1.0); phase = "normal"; }
    score *= b.curve;
    out.push(makeSignal("macro.curve.inversion", score, 0.25 * lenConf(curve, 60), "position",
      { t10y2y: round(v, 3), min250d: round(minRecent, 3), chg60d: round(steepening, 3), phase },
      `10y-2y spread ${(v * 100).toFixed(0)}bp (${phase}; 60d change ${(steepening * 100).toFixed(0)}bp)`));
  }

  // ---- Composite risk regime (from VIX + credit) ----
  if (stress.length) {
    const s = stress.reduce((a, x) => a + x, 0) / stress.length;
    const regime = s > 0.25 ? "risk-off" : s < -0.25 ? "risk-on" : "neutral";
    out.push(makeSignal("macro.risk.regime", -b.risk * 0.5 * s, 0.2 + 0.25 * Math.abs(s) * (stress.length / 2), "swing",
      { stress: round(s, 3), regime, inputs: stress.length },
      `Macro regime ${regime} (stress ${s.toFixed(2)} from ${stress.length === 2 ? "VIX + credit" : "one input"}); ${b.label}`));
  }
  return out;
}

module.exports = { signals, _clean: clean };
