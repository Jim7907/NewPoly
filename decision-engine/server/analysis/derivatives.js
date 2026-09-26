// Crypto derivatives positioning (contract §2.7). Pure: OKX-style funding / OI data in, Signal[] out.
//
// d = { fundingRate, fundingHistory:[{t,rate}], openInterest, oiHistory:[{t,oi}], basisBps?,
//       priceChange? }  — priceChange (fraction) over the OI window is optional; alternatively pass
// opts.candles (Candle[]) and the price change over the OI-history time span is derived from them.
//
// Evidence / conventions:
//   * Perp funding is paid every 8h; the "neutral" OKX/Binance rate is +0.01%/8h (≈11% annualized:
//     interest component). Persistently high positive funding = crowded, leveraged longs; such
//     crowding precedes negative returns / long-liquidation cascades (e.g. He, Manela, Ross & von
//     Wachter 2022 on perpetual-futures premia; BIS WP 1087 "Crypto carry"). Deeply negative
//     funding = crowded shorts → contrarian bullish.
//   * Negative funding while price rises = shorts paying to hold losing positions → squeeze fuel.
//   * OI/price quadrants (classic futures-positioning reading): OI↑ price↑ = new longs, trend
//     confirmed; OI↑ price↓ = new shorts, bearish trend confirmed; OI↓ price↑ = short covering
//     (weak rally); OI↓ price↓ = long liquidation (selling exhaustion).
//   * Fragility: OI surging without price progress = leverage building up; the side that funding
//     says is crowded is the one at risk.

const FAMILY = "derivatives";
const NEUTRAL_FUNDING = 0.0001; // +0.01% per 8h
// OI/price quadrants are read over a common recent window. AUDIT (2026-09): OKX rubik
// open-interest-volume returns ~180 DAILY points, and the whole history was used for the OI change
// while the price change came from 300 hourly candles (12.5 days) — e.g. BTC "OI +8.0% (179 d),
// price +9.2% (12.5 d)". Both are now measured over the same window (default 7 days, opts.oiWindowMs),
// trimmed to what the price candles cover, with the price change taken between the candles that
// bracket the first and last OI observations.
const OI_WINDOW_MS = 7 * 86400000;
// Epoch seconds (≈1.7e9 today) → ms; ms epochs (≈1.7e12) and small synthetic ms offsets pass through.
const toMs = (t) => (t >= 1e9 && t < 1e11 ? t * 1000 : t);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (typeof x === "string" && x.trim() !== "" ? Number(x) : x);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (x, d = 6) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const squash = (x) => (isNum(x) ? Math.tanh(x) : 0);
const bp = (r) => `${(r * 100).toFixed(4)}%`;

function makeSignal(id, score, confidence, horizon, value, reason) {
  return {
    id, family: FAMILY,
    score: round(isNum(score) ? clamp(score, -1, 1) : 0, 4),
    confidence: round(isNum(confidence) ? clamp(confidence, 0, 1) : 0, 4),
    horizon, value, reason,
  };
}

function series(arr, key) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({ t: num(p && p.t), v: num(p && p[key]) }))
    .filter((p) => isNum(p.v))
    .sort((a, b) => (isNum(a.t) && isNum(b.t) ? a.t - b.t : 0));
}

function candlesOf(opts) {
  return opts && Array.isArray(opts.candles) ? opts.candles.filter((k) => k && isNum(k.c) && k.c > 0 && isNum(k.t)).sort((a, b) => a.t - b.t) : [];
}

// Recent OI window (see OI_WINDOW_MS), trimmed so the price candles cover its start.
function oiWindow(oiSeries, opts, c) {
  if (oiSeries.length < 2 || !oiSeries.every((p) => isNum(p.t))) return oiSeries;
  const win = opts && isNum(opts.oiWindowMs) ? opts.oiWindowMs : OI_WINDOW_MS;
  const tEnd = toMs(oiSeries[oiSeries.length - 1].t);
  let w = oiSeries.filter((p) => toMs(p.t) >= tEnd - win);
  if (c.length && w.length && toMs(w[0].t) < c[0].t) w = w.filter((p) => toMs(p.t) >= c[0].t);
  return w;
}

function priceChangeFrom(d, opts, oiSeries, c = candlesOf(opts)) {
  if (isNum(num(d.priceChange))) return num(d.priceChange);
  if (c.length < 2) return null;
  let start = c[0], end = c[c.length - 1];
  if (oiSeries.length >= 2 && isNum(oiSeries[0].t)) {
    const t0 = toMs(oiSeries[0].t), t1 = toMs(oiSeries[oiSeries.length - 1].t);
    const found = c.find((k) => k.t >= t0);
    if (found) start = found;
    for (let i = c.length - 1; i >= 0; i--) if (c[i].t <= t1) { end = c[i]; break; }
  } else if (c.length > 24) start = c[c.length - 25];
  return start === end || end.t <= start.t ? null : end.c / start.c - 1;
}

function signals(d, opts = {}) {
  if (!d || typeof d !== "object") return [];
  const out = [];
  const funding = num(d.fundingRate);
  const fh = series(d.fundingHistory, "rate");
  const cs = candlesOf(opts);
  const oiH = oiWindow(series(d.oiHistory, "oi"), opts, cs);
  const pc = priceChangeFrom(d, opts, oiH, cs);

  // ---- Funding crowding ----
  if (isNum(funding)) {
    const x = (funding - NEUTRAL_FUNDING) / 0.0003;
    // Cubic term = flat near neutral, steep at extremes.
    const score = -0.65 * squash(0.4 * x + 0.3 * x * x * x);
    let conf = 0.25 + 0.3 * Math.abs(squash(x));
    let z = null, avg3 = null;
    if (fh.length >= 10) {
      const vals = fh.map((p) => p.v);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      z = sd > 0 ? (funding - mean) / sd : 0;
      const last3 = vals.slice(-3);
      avg3 = last3.reduce((a, b) => a + b, 0) / last3.length;
      // Persistence: a crowded trade that has paid for several periods is more reliable.
      if (Math.sign(avg3 - NEUTRAL_FUNDING) === Math.sign(funding - NEUTRAL_FUNDING) && Math.abs(avg3 - NEUTRAL_FUNDING) > 0.0002) conf += 0.1;
      if (Math.abs(z) > 2) conf += 0.05;
    }
    const ann = funding * 3 * 365;
    const label = x > 1 ? "crowded longs (contrarian bearish)" : x < -1 ? "crowded shorts (contrarian bullish)" : "near neutral";
    out.push(makeSignal("deriv.funding.crowding", score, conf, "swing",
      { fundingRate: funding, annualized: round(ann, 4), z: round(z, 2), avg3: round(avg3) },
      `Funding ${bp(funding)}/8h (${(ann * 100).toFixed(1)}% annualized${isNum(z) ? `, z=${z.toFixed(1)} vs history` : ""}) — ${label}`));
  }

  // ---- Squeeze / cascade: funding sign against price direction ----
  if (isNum(funding) && isNum(pc)) {
    let score = 0, reason = null;
    if (funding < 0 && pc > 0) {
      score = 0.7 * squash(-funding / 0.0002) * squash(pc / 0.03);
      reason = `Negative funding ${bp(funding)} while price +${(pc * 100).toFixed(1)}% — shorts paying into a rally (squeeze fuel)`;
    } else if (funding > 2 * NEUTRAL_FUNDING && pc < 0) {
      score = -0.6 * squash((funding - NEUTRAL_FUNDING) / 0.0002) * squash(-pc / 0.03);
      reason = `Elevated funding ${bp(funding)} while price ${(pc * 100).toFixed(1)}% — trapped longs, liquidation-cascade risk`;
    }
    if (reason) {
      out.push(makeSignal("deriv.funding.squeeze", score, 0.25 + 0.3 * Math.abs(score), "intraday",
        { fundingRate: funding, priceChange: round(pc, 4) }, reason));
    }
  }

  // ---- OI / price quadrants ----
  let oiChg = null;
  if (oiH.length >= 2 && oiH[0].v > 0) oiChg = oiH[oiH.length - 1].v / oiH[0].v - 1;
  if (isNum(oiChg) && isNum(pc)) {
    const mag = squash(Math.abs(oiChg) / 0.08) * squash(pc / 0.04);
    const score = 0.6 * (oiChg > 0 ? mag : -0.4 * mag);
    const quad = oiChg >= 0
      ? (pc >= 0 ? "OI↑ price↑: new longs, uptrend confirmed" : "OI↑ price↓: new shorts, downtrend confirmed")
      : (pc >= 0 ? "OI↓ price↑: short-covering rally (weak)" : "OI↓ price↓: long liquidation (selling exhaustion)");
    out.push(makeSignal("deriv.oi.price_confirmation", score, 0.2 + 0.3 * Math.abs(mag) * clamp(oiH.length / 12, 0, 1), "swing",
      { oiChange: round(oiChg, 4), priceChange: round(pc, 4), openInterest: isNum(num(d.openInterest)) ? num(d.openInterest) : oiH[oiH.length - 1].v },
      `${quad} (OI ${oiChg >= 0 ? "+" : ""}${(oiChg * 100).toFixed(1)}%, price ${pc >= 0 ? "+" : ""}${(pc * 100).toFixed(1)}%)`));
  }

  // ---- Fragility: leverage build-up without price progress ----
  if (isNum(oiChg) && oiChg > 0.05 && isNum(funding)) {
    const stall = 1 - squash(Math.abs(isNum(pc) ? pc : 0) / 0.03);
    const crowdDir = Math.sign(funding - NEUTRAL_FUNDING);
    const lev = squash(oiChg / 0.15);
    const score = -crowdDir * 0.5 * lev * stall;
    if (crowdDir !== 0 && Math.abs(score) > 0.02) {
      out.push(makeSignal("deriv.oi.fragility", score, 0.2 + 0.25 * lev * stall, "swing",
        { oiChange: round(oiChg, 4), priceChange: round(pc, 4), fundingRate: funding },
        `OI +${(oiChg * 100).toFixed(1)}% with ${isNum(pc) ? `price ${(pc * 100).toFixed(1)}%` : "unknown price move"} — leverage building while ${crowdDir > 0 ? "longs" : "shorts"} pay funding (${crowdDir > 0 ? "long" : "short"}-side fragile)`));
    }
  }

  // ---- Basis / premium ----
  const basis = num(d.basisBps);
  if (isNum(basis)) {
    const score = -0.4 * squash((basis - 5) / 30);
    out.push(makeSignal("deriv.basis.premium", score, 0.15 + 0.2 * Math.abs(squash((basis - 5) / 30)), "swing",
      { basisBps: basis }, `Perp/futures basis ${basis.toFixed(1)}bp — ${basis > 35 ? "rich premium, froth" : basis < -25 ? "discount, bearish positioning (contrarian bullish)" : "normal"}`));
  }
  return out;
}

module.exports = { signals, NEUTRAL_FUNDING };
