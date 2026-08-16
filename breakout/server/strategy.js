// Breakout signal generation — the GG-Shot core, reimplemented as pure functions.
//
// The idea: consolidations leave a high/low boundary behind them. A close that clears one of
// those boundaries by a volatility-scaled buffer is a breakout. Most such breaks are noise, so
// three filters gate them (volume expansion, non-flat market, optional trend agreement), the
// stop goes at the opposing structure, and four static targets are laid out in R multiples of
// the resulting risk.
//
// Nothing here reads bars[i+1..]. Signals are decided on the close of bar i; the backtest layer
// owns the fill.

const ind = require("./indicators");
const { DEFAULT_PARAMS } = require("./config");

const withDefaults = (p = {}) => {
  const merged = { ...DEFAULT_PARAMS, ...p };
  // Array params must not be half-overridden by a shorter user array.
  merged.tpR = Array.isArray(p.tpR) && p.tpR.length ? p.tpR.map(Number) : DEFAULT_PARAMS.tpR;
  merged.tpAlloc = normalizeAlloc(p.tpAlloc, merged.tpR.length);
  return merged;
};

// Allocations must cover exactly one unit of position and match the target count.
function normalizeAlloc(alloc, n) {
  let a = Array.isArray(alloc) && alloc.length ? alloc.map(Number) : DEFAULT_PARAMS.tpAlloc.slice();
  a = a.slice(0, n).map(v => (Number.isFinite(v) && v > 0 ? v : 0));
  while (a.length < n) a.push(0);
  const sum = a.reduce((s, v) => s + v, 0);
  if (sum <= 0) return new Array(n).fill(1 / n);
  return a.map(v => v / sum);
}

// Indicator series shared by the detector, the backtest and the chart overlays.
function buildSeries(bars, params) {
  const p = withDefaults(params);
  const closes = bars.map(b => b.c);
  const atr = ind.atr(bars, p.atrLen);
  const atrPct = atr.map((v, i) => (v == null || !(bars[i].c > 0) ? 0 : v / bars[i].c));
  return {
    atr,
    atrRank: ind.percentRank(atrPct, 100),
    adx: ind.adx(bars, 14).adx,
    relVol: ind.relativeVolume(bars, p.volLen),
    trendEma: ind.ema(closes, p.trendEmaLen),
    compression: ind.compression(bars, p.rangeLen, 100),
    rangeHigh: ind.rollingExtreme(bars, p.rangeLen, "high", 1),
    rangeLow: ind.rollingExtreme(bars, p.rangeLen, "low", 1),
    pivots: ind.pivots(bars, p.pivotLeft, p.pivotRight),
  };
}

// Snap a Donchian boundary to a nearby *already confirmed* pivot so the drawn level lines up
// with the swing a trader would actually have marked. Display-only: the break test uses the
// Donchian value, which is always the more conservative (further) of the two.
function snapLevel(pivotList, level, atrVal, i, tolAtr) {
  if (!(tolAtr > 0) || !(atrVal > 0)) return { price: level, pivotIndex: null };
  let best = null;
  for (const pv of pivotList) {
    if (pv.confirmedAt > i) break;                       // not yet knowable at bar i
    const d = Math.abs(pv.price - level);
    if (d <= tolAtr * atrVal && (!best || d < best.d)) best = { d, pv };
  }
  return best ? { price: best.pv.price, pivotIndex: best.pv.index } : { price: level, pivotIndex: null };
}

// Stop placement + the four static targets, derived from the realized risk distance.
// ctx = { level, high, low } — the broken boundary and the range it came from.
function buildPlan(side, entry, ctx, atrVal, p) {
  const dir = side === "long" ? 1 : -1;
  const minDist = 0.5 * atrVal;
  let sl;
  if (p.slMode === "atr") {
    sl = entry - dir * p.slAtrMult * atrVal;
  } else {
    // "level": the broken boundary flips role (resistance becomes support) and is the nearest
    // price that invalidates the break. "range": the far side — much wider, much rarer to hit.
    const anchor = p.slMode === "range"
      ? (side === "long" ? ctx.low : ctx.high)
      : ctx.level;
    const structural = anchor - dir * p.slBufferAtr * atrVal;
    // Never let structure produce a stop tighter than half an ATR — that is just noise range.
    sl = side === "long" ? Math.min(structural, entry - minDist) : Math.max(structural, entry + minDist);
  }
  const risk = Math.abs(entry - sl);
  return { sl, risk, tps: p.tpR.map(r => entry + dir * r * risk) };
}

// Scan every bar for a breakout of the trailing range boundary.
// Returns ALL candidates — `accepted:false` ones carry the failed filter names so the chart can
// show what was suppressed and why. That transparency is the point of a visual backtester.
function detectSignals(bars, params, series) {
  const p = withDefaults(params);
  const s = series || buildSeries(bars, p);
  const out = [];
  const lastSignalBar = { long: -Infinity, short: -Infinity };
  const warmup = Math.max(p.rangeLen + 2, p.atrLen + 2, 30);

  for (let i = warmup; i < bars.length; i++) {
    const bar = bars[i];
    const atrVal = s.atr[i - 1];                          // prior-bar ATR: the breakout bar's own
    if (!(atrVal > 0)) continue;                          // expansion must not inflate the buffer
    const rh = s.rangeHigh[i], rl = s.rangeLow[i];
    if (!rh || !rl) continue;

    const width = rh.value - rl.value;
    const buffer = p.breakoutBufferAtr * atrVal;

    let side = null;
    if (rh && (p.closeBeyondLevel ? bar.c : bar.h) > rh.value + buffer) side = "long";
    else if (rl && (p.closeBeyondLevel ? bar.c : bar.l) < rl.value - buffer) side = "short";
    if (!side) continue;
    if (p.direction !== "both" && p.direction !== side) continue;

    const level = side === "long" ? rh.value : rl.value;
    const pivotList = side === "long" ? s.pivots.highs : s.pivots.lows;
    const snapped = snapLevel(pivotList, level, atrVal, i, p.snapToPivotAtr);

    // ── Filters ──
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass, detail });

    add("range_width", width <= p.maxRangeWidthAtr * atrVal && width >= p.minRangeWidthAtr * atrVal,
      `${(width / atrVal).toFixed(2)}atr`);

    // Cooldown is a filter, not a silencer: the raw break still gets reported so the signal
    // audit shows how many breakouts the rules actually saw.
    add("cooldown", i - lastSignalBar[side] >= p.cooldownBars, `${i - lastSignalBar[side]} bars`);

    if (p.volFilter) {
      const rv = s.relVol[i];
      add("volume", rv != null && rv >= p.volMult, rv != null ? `${rv.toFixed(2)}x` : "n/a");
    }
    if (p.flatFilter) {
      const a = s.adx[i], r = s.atrRank[i];
      add("adx", a != null && a >= p.minAdx, a != null ? a.toFixed(1) : "n/a");
      if (p.minAtrRank > 0) add("volatility", r != null && r >= p.minAtrRank, r != null ? r.toFixed(2) : "n/a");
    }
    if (p.trendFilter) {
      const e = s.trendEma[i];
      add("trend", e != null && (side === "long" ? bar.c > e : bar.c < e), e != null ? e.toFixed(2) : "n/a");
    }

    // ── Plan ──
    // Priced off the signal bar's close (or the retest limit), never off the next bar's open:
    // acceptance must be decidable at the moment the signal appears. The backtest recomputes
    // the ladder from the fill it actually gets.
    const refEntry = p.entryMode === "retest" ? level : bar.c;
    const plan = buildPlan(side, refEntry, { level, high: rh.value, low: rl.value }, atrVal, p);
    add("risk_width", plan.risk > 0 && plan.risk <= p.maxRiskAtr * atrVal,
      atrVal > 0 ? `${(plan.risk / atrVal).toFixed(2)}atr` : "n/a");

    const accepted = checks.every(c => c.pass);
    if (accepted) lastSignalBar[side] = i;

    out.push({
      i, t: bar.t, side, accepted,
      level, keyLevel: snapped.price, pivotIndex: snapped.pivotIndex,
      range: { start: rh.start, end: rh.end, high: rh.value, low: rl.value },
      atr: atrVal,
      adx: s.adx[i], relVol: s.relVol[i], atrRank: s.atrRank[i], compression: s.compression[i],
      checks,
      reasons: checks.filter(c => !c.pass).map(c => c.name),
      plan: { entry: refEntry, sl: plan.sl, risk: plan.risk, tps: plan.tps },
    });
  }
  return out;
}

module.exports = { withDefaults, normalizeAlloc, buildSeries, buildPlan, detectSignals, snapLevel };
