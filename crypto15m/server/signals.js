// Decision layer. `evaluate()` is pure (unit-tested); `buildLiveSignal()` gathers live
// data from feeds + poly and manages per-window open-price snapshots.
const cfg = require("./config");
const feeds = require("./feeds");
const poly = require("./poly");
const { leadZ, pUp, shrinkWeight, blend, takerFeeFrac, netEdge, evPerDollar, kellyFraction, clamp } = require("./math");

// Pure evaluation of one asset's window state. All thresholds come from `p` (defaults cfg)
// so the backtester can sweep them.
function evaluate(input, p = cfg) {
  const { sOpen, ref, nowMs, endDateMs, poly: pm, micro: mc, bankroll = 1000, openExposure = 0 } = input;
  const reasons = [];
  const out = { asset: input.asset, name: input.name, signal: "—", side: null, stake: 0, reasons };

  if (sOpen == null || ref == null || !(ref.price > 0)) { reasons.push("no-ref"); return out; }
  const tauSec = (endDateMs - nowMs) / 1000;
  out.secsLeft = Math.max(0, Math.round(tauSec));
  out.sOpen = sOpen; out.ref = ref.price; out.sigmaPerSec = ref.sigmaPerSec;

  const L = Math.log(ref.price / sOpen);
  out.lead = L; out.leadBps = +(L * 1e4).toFixed(2);

  // Optional microstructure drift (probit-additive z); OFF by default.
  let zDrift = 0;
  if (p.DRIFT_ENABLED && mc && !mc.wsStale) {
    zDrift = p.W_OFI * (mc.obi || 0) + p.W_CVD * (mc.cvdSlope || 0) + p.W_OBI * (mc.obi || 0) + p.W_MOM * (mc.momZ || 0);
  }
  const z = leadZ(L, ref.sigmaPerSec, tauSec) + zDrift;
  out.z = +z.toFixed(3); out.zDrift = +zDrift.toFixed(3);

  const pModel = pUp(z);
  out.pModel = +pModel.toFixed(4);

  // Market probability for "Up" from the Up-token mid.
  const pMarketUp = pm && pm.mid != null ? clamp(pm.mid, 0.01, 0.99) : null;
  if (pMarketUp == null) { reasons.push("no-poly-price"); return out; }
  const w = shrinkWeight(tauSec, p.WINDOW_SEC);
  const pUsed = blend(pModel, pMarketUp, w);
  out.pMarketUp = +pMarketUp.toFixed(4); out.w = +w.toFixed(3); out.pUsed = +pUsed.toFixed(4);

  // Choose the favored side and its effective taker entry price.
  const side = pUsed >= 0.5 ? "UP" : "DOWN";
  const pSide = side === "UP" ? pUsed : 1 - pUsed;
  // Up book only: buy Up at ask; buy Down ~ at (1 - Up bid).
  const qUp = pm.ask != null ? pm.ask : pm.mid;
  const q = side === "UP" ? qUp : (pm.bid != null ? 1 - pm.bid : 1 - pm.mid);
  out.side = side; out.q = +q.toFixed(4); out.pSide = +pSide.toFixed(4);

  const rawEdge = pSide - q;
  const feeFrac = takerFeeFrac(q, p.TAKER_FEE_K);
  const net = netEdge(pSide, q, p.TAKER_FEE_K, p.SLIP);
  const ev = evPerDollar(pSide, q, p.TAKER_FEE_K, p.SLIP);
  out.rawEdge = +rawEdge.toFixed(4); out.feeFrac = +feeFrac.toFixed(4);
  out.netEdge = +net.toFixed(4); out.ev = +ev.toFixed(4);

  // ── Gates (collect every failure for transparency) ──
  const mode = tauSec <= p.LATE_WINDOW_S ? "A" : (p.MODE_B ? "B" : "idle");
  out.mode = mode;
  const vpinHot = mc && mc.vpin > 0.7;
  const edgeFloor = (mode === "B" ? 0.13 : p.MIN_EDGE) + (vpinHot ? 0.05 : 0);
  out.edgeFloor = +edgeFloor.toFixed(3);

  if (ref.stale) reasons.push("ref-stale");
  if (mode === "idle") reasons.push("too-early");
  if (Math.abs(z) < p.MIN_Z) reasons.push("low-z");
  if (Math.abs(L) < p.BASIS_BPS / 1e4) reasons.push("within-basis");
  if (pSide < p.MIN_P) reasons.push("not-favorite");
  if (rawEdge < edgeFloor) reasons.push("edge<floor");
  if (net <= 0) reasons.push("net<=0");
  if (pm.spreadC != null && pm.spreadC > p.MAX_SPREAD_C) reasons.push("spread-wide");
  const depth = side === "UP" ? pm.depthBuyUsd : pm.depthSellUsd;
  if (depth != null && depth < p.MIN_DEPTH_USD) reasons.push("thin-book");
  if (tauSec <= p.NO_TAKER_LAST_S) reasons.push("too-late-taker");

  if (reasons.length === 0) {
    let stake = kellyFraction(pSide, q, p.KELLY_K, p.F_MAX) * bankroll;
    const room = Math.max(0, p.AGG_CAP * bankroll - openExposure);
    stake = Math.min(stake, room);
    out.stake = +stake.toFixed(2);
    if (stake >= 1) out.signal = side === "UP" ? "BUY UP" : "BUY DOWN";
    else reasons.push("stake<1");
  }
  return out;
}

// ── Live orchestration ──────────────────────────────────────────
const openCache = {}; // marketId -> { sOpen, refSource }

function priceNear(sym, ts) {
  const ring = feeds.state[sym]?.prices || [];
  let best = null, bd = Infinity;
  for (const x of ring) { const d = Math.abs(x.t - ts); if (d < bd) { bd = d; best = x.p; } }
  return best;
}

// Build the live signal for a single discovered window.
function buildLiveSignal(win, ctx) {
  const ref = feeds.getRef(win.asset);
  // Snapshot the window-open reference price once per window.
  if (!openCache[win.marketId]) {
    const snap = priceNear(win.asset, win.windowOpenMs) ?? ref.price;
    if (snap != null) openCache[win.marketId] = { sOpen: snap, refSource: ref.source };
  }
  const oc = openCache[win.marketId];
  const result = evaluate({
    asset: win.asset, name: win.name,
    sOpen: oc ? oc.sOpen : null,
    ref, nowMs: ctx.nowMs, endDateMs: win.endDateMs,
    poly: ctx.poly, micro: feeds.micro(win.asset),
    bankroll: ctx.bankroll, openExposure: ctx.openExposure,
  });
  return { ...result, marketId: win.marketId, upToken: win.upToken, downToken: win.downToken,
           question: win.question, endDate: win.endDate, refSource: oc ? oc.refSource : ref.source };
}

function clearOpenCache(keepMarketIds) {
  const keep = new Set(keepMarketIds);
  for (const k of Object.keys(openCache)) if (!keep.has(k)) delete openCache[k];
}

module.exports = { evaluate, buildLiveSignal, clearOpenCache, openCache, priceNear };
