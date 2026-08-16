// Performance statistics for the backtest panel. Pure functions over the trade list.

const YEAR_SEC = 365.25 * 24 * 3600;
const r2 = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);

function empty(equity = 0) {
  return {
    trades: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, profitFactor: null,
    netProfit: 0, netProfitPct: 0, finalEquity: equity, maxDrawdown: 0, maxDrawdownPct: 0,
    avgR: 0, expectancyR: 0, avgWin: 0, avgLoss: 0, payoff: null, grossProfit: 0, grossLoss: 0,
    fees: 0, avgCostR: 0, breakEvenFeeBps: null, cappedTrades: 0, avgBars: 0, avgMfe: 0, avgMae: 0, sharpe: null, cagr: null,
    tpRates: [], long: null, short: null, exitReasons: {}, maxWinStreak: 0, maxLossStreak: 0,
  };
}

// Peak-to-trough on the per-trade equity curve (the curve the chart draws).
function drawdown(curve) {
  let peak = curve.length ? curve[0].equity : 0;
  let maxAbs = 0, maxPct = 0;
  for (const pt of curve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxAbs) maxAbs = dd;
    const pct = peak > 0 ? dd / peak : 0;
    if (pct > maxPct) maxPct = pct;
  }
  return { abs: maxAbs, pct: maxPct * 100 };
}

// Round-trip fee rate (in bps of notional) at which total profit is exactly zero.
// Fees cost `rate x turnover`, so profit = gross - rate*turnover = 0 when rate = gross/turnover.
function breakEvenFee(trades) {
  const gross = trades.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const turnover = trades.reduce((s, t) => s + (t.turnover || 0), 0);
  return turnover > 0 ? (gross / turnover) * 10000 : null;
}

function streaks(trades) {
  let win = 0, loss = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curW++; curL = 0; } else if (t.pnl < 0) { curL++; curW = 0; } else { curW = 0; curL = 0; }
    win = Math.max(win, curW); loss = Math.max(loss, curL);
  }
  return { maxWinStreak: win, maxLossStreak: loss };
}

// Win rate / P&L for one subset (used for the long-vs-short split).
function side(trades) {
  if (!trades.length) return { trades: 0, winRate: 0, netProfit: 0, avgR: 0 };
  const wins = trades.filter(t => t.pnl > 0).length;
  return {
    trades: trades.length,
    winRate: r2((wins / trades.length) * 100, 1),
    netProfit: r2(trades.reduce((s, t) => s + t.pnl, 0)),
    avgR: r2(trades.reduce((s, t) => s + t.r, 0) / trades.length),
  };
}

function summarize(trades, equityCurve, params, bars) {
  if (!trades.length) return empty(params.equity);

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netProfit = grossProfit - grossLoss;
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : params.equity;
  const rs = trades.map(t => t.r);
  const avgR = rs.reduce((s, v) => s + v, 0) / rs.length;
  const dd = drawdown(equityCurve);

  // Per-trade R Sharpe, annualized by the trade frequency actually observed.
  const varR = rs.reduce((s, v) => s + (v - avgR) ** 2, 0) / rs.length;
  const sdR = Math.sqrt(varR);
  const span = bars && bars.length > 1 ? bars[bars.length - 1].t - bars[0].t : 0;
  const tradesPerYear = span > 0 ? (trades.length / span) * YEAR_SEC : 0;
  const sharpe = sdR > 0 && tradesPerYear > 0 ? (avgR / sdR) * Math.sqrt(tradesPerYear) : null;
  // Annualizing a two-week sample produces nonsense, so CAGR is withheld under ~3 months.
  const years = span / YEAR_SEC;
  const cagr = years >= 0.25 && finalEquity > 0 && params.equity > 0
    ? (Math.pow(finalEquity / params.equity, 1 / years) - 1) * 100 : null;

  // Hit rate per take-profit level — GG-Shot's "success rate per TP".
  const nTp = trades[0].tpHits.length;
  const tpRates = Array.from({ length: nTp }, (_, k) => ({
    level: `TP${k + 1}`,
    r: params.tpR[k],
    hits: trades.filter(t => t.tpHits[k]).length,
    rate: r2((trades.filter(t => t.tpHits[k]).length / trades.length) * 100, 1),
  }));

  const exitReasons = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRate: r2((wins.length / trades.length) * 100, 1),
    profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : null,
    netProfit: r2(netProfit),
    netProfitPct: r2(((finalEquity - params.equity) / params.equity) * 100),
    finalEquity: r2(finalEquity),
    maxDrawdown: r2(dd.abs),
    maxDrawdownPct: r2(dd.pct),
    avgR: r2(avgR),
    expectancyR: r2(avgR),                      // expectancy per trade, in R
    avgWin: r2(wins.length ? grossProfit / wins.length : 0),
    avgLoss: r2(losses.length ? grossLoss / losses.length : 0),
    payoff: losses.length && wins.length ? r2((grossProfit / wins.length) / (grossLoss / losses.length)) : null,
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    fees: r2(trades.reduce((s, t) => s + t.fees, 0)),
    // The round-trip fee rate at which this run's profit reaches exactly zero. Fees are linear
    // in notional, so this is gross profit divided by total turnover — an exact break-even,
    // not an estimate. Negative means the run loses before any fee is charged at all.
    breakEvenFeeBps: r2(breakEvenFee(trades), 2),
    // Cost per trade in R, and how often the leverage cap bound. Together these explain the
    // common case where a strategy with a decent target hit rate still loses money.
    avgCostR: r2(trades.reduce((s, t) => s + (t.costR || 0), 0) / trades.length),
    cappedTrades: trades.filter(t => t.sizeCapped).length,
    avgBars: r2(trades.reduce((s, t) => s + t.bars, 0) / trades.length, 1),
    avgMfe: r2(trades.reduce((s, t) => s + t.mfe, 0) / trades.length),
    avgMae: r2(trades.reduce((s, t) => s + t.mae, 0) / trades.length),
    sharpe: r2(sharpe),
    cagr: r2(cagr, 1),
    tpRates,
    long: side(trades.filter(t => t.side === "long")),
    short: side(trades.filter(t => t.side === "short")),
    exitReasons,
    ...streaks(trades),
  };
}

module.exports = { summarize, empty, drawdown, streaks, breakEvenFee };
