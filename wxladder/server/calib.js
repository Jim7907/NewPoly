// Calibration — turns settled baskets and their rungs into the numbers that say whether the
// model is any good: reliability of the per-rung probabilities, whether the cluster covers
// the outcome as often as it claims, and the per-station bias/error still outstanding.
// Pure given its input rows.

// rows: [{ p, win }] -> reliability bins + Brier / log-loss / ECE.
function reliability(rows, nBins = 10) {
  const data = (rows || [])
    .filter(r => r && r.p != null && r.win != null)
    .map(r => ({ p: Math.min(0.999, Math.max(0.001, Number(r.p))), win: r.win ? 1 : 0 }));
  const n = data.length;
  if (!n) return { n: 0, brier: null, logloss: null, ece: null, rate: null, bins: [] };

  const brier = data.reduce((s, d) => s + (d.p - d.win) ** 2, 0) / n;
  const logloss = -data.reduce((s, d) => s + (d.win ? Math.log(d.p) : Math.log(1 - d.p)), 0) / n;
  const wins = data.reduce((s, d) => s + d.win, 0);

  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, wins: 0, sumP: 0 }));
  for (const d of data) {
    const i = Math.min(nBins - 1, Math.floor(d.p * nBins));
    bins[i].n++; bins[i].wins += d.win; bins[i].sumP += d.p;
  }
  let ece = 0;
  const outBins = bins.filter(b => b.n > 0).map(b => {
    const conf = b.sumP / b.n, acc = b.wins / b.n;
    ece += (b.n / n) * Math.abs(acc - conf);
    return { range: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, n: b.n, confidence: +conf.toFixed(3), accuracy: +acc.toFixed(3) };
  });

  return {
    n, brier: +brier.toFixed(4), logloss: +logloss.toFixed(4), ece: +ece.toFixed(4),
    rate: +(wins / n * 100).toFixed(1), bins: outBins,
  };
}

// Per-rung calibration across every settled basket: does a rung we called 30% win 30%?
function legCalibration(baskets) {
  const rows = [];
  for (const b of baskets) {
    if (b.status !== "won" && b.status !== "lost") continue;
    for (const l of (b.legs || [])) if (l.won != null) rows.push({ p: l.prob, win: l.won });
  }
  return reliability(rows);
}

// Basket-level: the ladder's central claim is "the outcome lands somewhere in my cluster".
// coverProb is the claim; hitRate is what happened.
function coverCalibration(baskets) {
  const rows = [];
  for (const b of baskets) {
    if (b.status !== "won" && b.status !== "lost") continue;
    rows.push({ p: b.coverProb, win: b.status === "won" ? 1 : 0 });
  }
  const rel = reliability(rows, 5);
  const claimed = rows.length ? rows.reduce((s, r) => s + r.p, 0) / rows.length : null;
  return { ...rel, claimedCover: claimed == null ? null : +claimed.toFixed(4), realizedCover: rel.rate };
}

// How far the settled outcome sat from where we centered the ladder. A non-zero mean here
// is residual bias the correction has not caught yet.
function centerError(baskets) {
  const errs = baskets
    .filter(b => b.obsValue != null && b.center != null)
    .map(b => b.obsValue - b.center);
  if (!errs.length) return { n: 0, meanErr: null, mae: null, rmse: null, withinHalf: null, within1: null };
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  const mae = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
  const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  return {
    n: errs.length,
    meanErr: +mean.toFixed(3), mae: +mae.toFixed(3), rmse: +rmse.toFixed(3),
    withinHalf: +(errs.filter(e => Math.abs(e) <= 0.5).length / errs.length * 100).toFixed(1),
    within1: +(errs.filter(e => Math.abs(e) <= 1).length / errs.length * 100).toFixed(1),
  };
}

// Realized economics grouped by a key — station, regime, lead, whatever the caller passes.
function groupBy(baskets, keyFn) {
  const by = {};
  for (const b of baskets) {
    if (b.status !== "won" && b.status !== "lost") continue;
    const k = keyFn(b);
    if (k == null) continue;
    (by[k] ||= { n: 0, won: 0, pnl: 0, staked: 0, claimed: 0 });
    by[k].n++; by[k].pnl += b.pnl || 0; by[k].staked += b.outlay || 0;
    by[k].claimed += b.coverProb || 0;
    if (b.status === "won") by[k].won++;
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, {
    n: v.n,
    hitRate: +(v.won / v.n * 100).toFixed(1),
    claimedCover: +(v.claimed / v.n * 100).toFixed(1),
    pnl: +v.pnl.toFixed(2),
    roi: v.staked > 0 ? +(v.pnl / v.staked * 100).toFixed(2) : 0,
  }]));
}

module.exports = { reliability, legCalibration, coverCalibration, centerError, groupBy };
