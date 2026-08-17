// Bar-by-bar backtest engine. Pure: (bars, params) -> trades, equity curve, stats.
//
// Fill model, stated plainly because it is where backtests usually lie:
//   • Entry is the next bar's open by default (the signal is only known at the signal bar's
//     close). "close" mode fills at the signal close; "retest" places a limit at the level.
//   • Within a bar we only know O/H/L/C, not the path. With `pessimisticFills` (default) a bar
//     that touches both the stop and a target is resolved as stop-first.
//   • Gaps fill at the open when the open is already through the order's price.
//   • Stop exits are market orders and pay slippage; target exits are limits and do not.
//   • Fees are charged on the full entry notional and on every partial exit.

const { withDefaults, buildSeries, buildPlan, detectSignals } = require("./strategy");
const stats = require("./stats");

const bps = (x) => x / 10000;

// Simulate one accepted signal end-to-end. Returns a trade record, or null if it never filled.
function simulateTrade(bars, series, sig, p, equityAtEntry) {
  const dir = sig.side === "long" ? 1 : -1;
  const slip = bps(p.slipBps);
  const feeTaker = bps(p.feeBpsTaker);
  const feeMaker = bps(p.feeBpsMaker);
  // A retest entry rests a limit order at the level; every other entry mode crosses the spread.
  const entryIsMaker = p.entryMode === "retest";
  // Targets are limit orders; stops, breakeven/trail stops and time exits are market orders.
  const exitFeeRate = (reason) => (reason.startsWith("tp") ? feeMaker : feeTaker);

  // ── Fill ──
  let entryIndex = null, entryPrice = null, scanFrom = null;
  if (p.entryMode === "close") {
    entryIndex = sig.i;
    entryPrice = bars[sig.i].c * (1 + dir * slip);
    scanFrom = sig.i + 1;                       // entered on the close; this bar is done
  } else if (p.entryMode === "retest") {
    const limit = sig.level;
    for (let j = sig.i + 1; j <= Math.min(sig.i + p.retestBars, bars.length - 1); j++) {
      const touched = dir === 1 ? bars[j].l <= limit : bars[j].h >= limit;
      if (touched) {
        // A limit fills at its price, or better if the bar opened through it.
        entryPrice = dir === 1 ? Math.min(limit, bars[j].o) : Math.max(limit, bars[j].o);
        entryIndex = j;
        scanFrom = j;
        break;
      }
    }
    if (entryIndex == null) return null;        // no retest inside the window — setup expired
  } else {
    if (sig.i + 1 >= bars.length) return null;
    entryIndex = sig.i + 1;
    entryPrice = bars[entryIndex].o * (1 + dir * slip);
    scanFrom = entryIndex;
  }

  // ── Plan off the ACTUAL fill, so R is measured against risk really taken ──
  const plan = buildPlan(sig.side, entryPrice, { level: sig.level, high: sig.range.high, low: sig.range.low }, sig.atr, p);
  if (!(plan.risk > 0) || plan.risk > p.maxRiskAtr * sig.atr) return null;

  const riskAmount = equityAtEntry * (p.riskPct / 100);
  let qty = riskAmount / plan.risk;
  const maxQty = (equityAtEntry * p.maxLeverage) / entryPrice;
  const sizeCapped = qty > maxQty;
  if (sizeCapped) qty = maxQty;
  if (!(qty > 0) || !Number.isFinite(qty)) return null;

  // ── Walk forward ──
  const tps = plan.tps;
  const alloc = p.tpAlloc;
  const tpHits = new Array(tps.length).fill(false);
  const exits = [];
  let stop = plan.sl;
  let stopKind = "stop";
  let remaining = 1;
  let extreme = entryPrice;                     // best price seen, for the ATR trail
  let mfe = 0, mae = 0;
  let exitIndex = entryIndex;

  const closeOut = (j, price, portion, reason) => {
    exits.push({ index: j, t: bars[j].t, price, portion, reason });
    remaining = Math.max(0, remaining - portion);
    exitIndex = j;
  };

  for (let j = scanFrom; j < bars.length && remaining > 1e-9; j++) {
    const bar = bars[j];
    mfe = Math.max(mfe, (dir * ((dir === 1 ? bar.h : bar.l) - entryPrice)) / plan.risk);
    mae = Math.min(mae, (dir * ((dir === 1 ? bar.l : bar.h) - entryPrice)) / plan.risk);

    const hitStop = () => (dir === 1 ? bar.l <= stop : bar.h >= stop);
    const takeStop = () => {
      const raw = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      closeOut(j, raw * (1 - dir * slip), remaining, stopKind);
    };
    const takeTargets = () => {
      for (let k = 0; k < tps.length && remaining > 1e-9; k++) {
        if (tpHits[k]) continue;
        const reached = dir === 1 ? bar.h >= tps[k] : bar.l <= tps[k];
        if (!reached) break;                    // targets are ordered; stop at the first miss
        tpHits[k] = true;
        const price = dir === 1 ? Math.max(tps[k], bar.o) : Math.min(tps[k], bar.o);
        closeOut(j, price, Math.min(alloc[k], remaining), `tp${k + 1}`);
        if (k === 0 && p.beAfterTp1) {
          stop = dir === 1 ? Math.max(stop, entryPrice) : Math.min(stop, entryPrice);
          stopKind = "breakeven";
        }
      }
    };

    if (p.pessimisticFills) {
      if (hitStop()) takeStop(); else takeTargets();
    } else {
      takeTargets();
      if (remaining > 1e-9 && hitStop()) takeStop();
    }
    if (remaining <= 1e-9) break;

    // ── Dynamic exit: once `trailAfterTp` targets are banked, the runner trails by ATR.
    // Computed from bars up to and including j, and only effective from bar j+1 onward.
    // trailAtrMult of 0 turns the trail off; trailAfterTp of 0 arms it from entry, which is
    // how a no-target trend configuration exits.
    const hits = tpHits.filter(Boolean).length;
    extreme = dir === 1 ? Math.max(extreme, bar.h) : Math.min(extreme, bar.l);
    if (p.trailAtrMult > 0 && hits >= p.trailAfterTp) {
      const a = series.atr[j] || sig.atr;
      const trail = extreme - dir * p.trailAtrMult * a;
      if (dir === 1 ? trail > stop : trail < stop) { stop = trail; stopKind = "trail"; }
    }

    if (j - entryIndex >= p.maxBars) { closeOut(j, bar.c * (1 - dir * slip), remaining, "time"); break; }
    if (j === bars.length - 1) { closeOut(j, bar.c * (1 - dir * slip), remaining, "eod"); break; }
  }
  if (!exits.length) return null;

  // ── Accounting ──
  const grossPnl = exits.reduce((s, e) => s + qty * e.portion * (e.price - entryPrice) * dir, 0);
  const fees = qty * entryPrice * (entryIsMaker ? feeMaker : feeTaker)
    + exits.reduce((s, e) => s + qty * e.portion * e.price * exitFeeRate(e.reason), 0);
  // Total notional transacted. Fees scale linearly with it, so gross/turnover is exactly the
  // round-trip fee rate at which this trade breaks even.
  const turnover = qty * entryPrice + exits.reduce((s, e) => s + qty * e.portion * e.price, 0);
  const pnl = grossPnl - fees;
  const avgExit = exits.reduce((s, e) => s + e.price * e.portion, 0) / exits.reduce((s, e) => s + e.portion, 0);

  return {
    id: `${sig.side}-${sig.i}`,
    side: sig.side,
    signalIndex: sig.i,
    entryIndex, entryTime: bars[entryIndex].t, entryPrice,
    exitIndex, exitTime: bars[exitIndex].t, exitPrice: avgExit, exitReason: exits[exits.length - 1].reason,
    sl: plan.sl, tps, risk: plan.risk, qty, sizeCapped,
    level: sig.level, keyLevel: sig.keyLevel, range: sig.range, atr: sig.atr,
    exits, tpHits,
    bars: exitIndex - entryIndex,
    grossPnl, fees, turnover, entryIsMaker, pnl,
    pnlPct: (pnl / equityAtEntry) * 100,
    r: pnl / (qty * plan.risk),
    // Trading costs expressed in R. When the stop is a small % of price, risk-based sizing
    // implies a large notional and this number can rival the risk unit itself.
    costR: fees / (qty * plan.risk),
    mfe, mae,
    status: pnl > 0 ? "win" : pnl < 0 ? "loss" : "be",
  };
}

// Full run over a bar series. One position at a time (plus a cooldown), compounding equity.
function run(bars, params = {}) {
  const p = withDefaults(params);
  if (!Array.isArray(bars) || bars.length < 60) {
    return { params: p, barCount: bars?.length || 0, signals: [], trades: [], equityCurve: [], stats: stats.empty(p.equity) };
  }

  const series = buildSeries(bars, p);
  const signals = detectSignals(bars, p, series);

  const trades = [];
  const equityCurve = [{ index: 0, t: bars[0].t, equity: p.equity }];
  let equity = p.equity;
  let blockedUntil = -1;

  for (const sig of signals) {
    if (!sig.accepted) continue;
    if (sig.i <= blockedUntil) { sig.skipped = "in_position"; continue; }
    const trade = simulateTrade(bars, series, sig, p, equity);
    if (!trade) { sig.skipped = "no_fill"; continue; }
    equity += trade.pnl;
    trade.equityAfter = equity;
    trades.push(trade);
    equityCurve.push({ index: trade.exitIndex, t: trade.exitTime, equity });
    blockedUntil = trade.exitIndex + p.cooldownBars;
    if (equity <= 0) break;                     // account blown; stop simulating
  }

  return {
    params: p,
    barCount: bars.length,                        // not `bars`: the API merges this with the bar array
    from: bars[0].t, to: bars[bars.length - 1].t,
    signals, trades, equityCurve,
    series: {
      atr: series.atr, adx: series.adx, trendEma: series.trendEma,
      relVol: series.relVol, compression: series.compression,
      rangeHigh: series.rangeHigh.map(v => (v ? v.value : null)),
      rangeLow: series.rangeLow.map(v => (v ? v.value : null)),
      pivots: series.pivots,
    },
    stats: stats.summarize(trades, equityCurve, p, bars),
  };
}

module.exports = { run, simulateTrade };
