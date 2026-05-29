// Calibration: turns resolved trades/signals into reliability bins + Brier/log-loss/ECE
// and realized win-rate/EV. Pure given the input rows, so it's unit-testable.

// rows: [{ side:'UP'|'DOWN', pSide:Number, resolvedUp:0|1 }]
function calibration(rows, nBins = 10) {
  const data = rows
    .filter(r => r.pSide != null && r.resolvedUp != null)
    .map(r => ({ p: Math.min(0.999, Math.max(0.001, r.pSide)),
                 win: (r.side === "UP" && r.resolvedUp) || (r.side === "DOWN" && !r.resolvedUp) ? 1 : 0 }));
  const n = data.length;
  const empty = { n: 0, brier: null, logloss: null, ece: null, winRate: null, bins: [] };
  if (!n) return empty;

  const brier = data.reduce((s, d) => s + (d.p - d.win) ** 2, 0) / n;
  const logloss = -data.reduce((s, d) => s + (d.win ? Math.log(d.p) : Math.log(1 - d.p)), 0) / n;
  const wins = data.reduce((s, d) => s + d.win, 0);

  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, wins: 0, sumP: 0 }));
  for (const d of data) {
    const idx = Math.min(nBins - 1, Math.floor(d.p * nBins));
    bins[idx].n++; bins[idx].wins += d.win; bins[idx].sumP += d.p;
  }
  let ece = 0;
  const outBins = bins.filter(b => b.n > 0).map(b => {
    const conf = b.sumP / b.n, acc = b.wins / b.n;
    ece += (b.n / n) * Math.abs(acc - conf);
    return { range: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, n: b.n, confidence: +conf.toFixed(3), accuracy: +acc.toFixed(3) };
  });

  return {
    n, brier: +brier.toFixed(4), logloss: +logloss.toFixed(4), ece: +ece.toFixed(4),
    winRate: +(wins / n * 100).toFixed(1), bins: outBins,
  };
}

// Per-asset realized win-rate from resolved trades.
function perAsset(trades) {
  const by = {};
  for (const t of trades) {
    if (t.status !== "won" && t.status !== "lost") continue;
    (by[t.asset] ||= { n: 0, won: 0, pnl: 0 });
    by[t.asset].n++; if (t.status === "won") by[t.asset].won++; by[t.asset].pnl += t.pnl || 0;
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.n, winRate: +(v.won / v.n * 100).toFixed(1), pnl: +v.pnl.toFixed(2) }]));
}

module.exports = { calibration, perAsset };
