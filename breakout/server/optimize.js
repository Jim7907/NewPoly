// Parameter search over the breakout rules, plus a walk-forward split so the winner is judged
// on bars it was not fitted to. A grid best is a hypothesis, not a result — the out-of-sample
// column is what the UI shows next to it.

const backtest = require("./backtest");
const { withDefaults } = require("./strategy");

// The axes that actually change behaviour. Keep the product modest: this runs synchronously.
const GRID = {
  rangeLen: [14, 20, 30],
  breakoutBufferAtr: [0.05, 0.10, 0.20],
  minAdx: [0, 18, 24],
  volMult: [1.0, 1.4, 1.8],
  trailAfterTp: [0, 2],
};

const OBJECTIVES = {
  profitFactor: (s) => (s.profitFactor == null ? -Infinity : s.profitFactor),
  netProfit: (s) => s.netProfitPct,
  expectancy: (s) => s.expectancyR,
  sharpe: (s) => (s.sharpe == null ? -Infinity : s.sharpe),
  // Expectancy scaled by sample size — prefers edges that repeat over lucky one-offs.
  robust: (s) => s.expectancyR * Math.sqrt(s.trades),
};

function combos(grid) {
  const keys = Object.keys(grid);
  return keys.reduce((acc, k) => acc.flatMap(c => grid[k].map(v => ({ ...c, [k]: v }))), [{}]);
}

function scoreOf(stats, objective, minTrades) {
  if (stats.trades < minTrades) return -Infinity;
  const fn = OBJECTIVES[objective] || OBJECTIVES.robust;
  const v = fn(stats);
  return Number.isFinite(v) ? v : -Infinity;
}

const brief = (s) => ({
  trades: s.trades, winRate: s.winRate, profitFactor: s.profitFactor,
  netProfitPct: s.netProfitPct, expectancyR: s.expectancyR,
  maxDrawdownPct: s.maxDrawdownPct, sharpe: s.sharpe,
});

// grid: optional override, e.g. { rangeLen:[20], volMult:[1.2,1.6] }
function run(bars, baseParams = {}, opts = {}) {
  const objective = opts.objective || "robust";
  const minTrades = opts.minTrades ?? 15;
  const splitPct = opts.splitPct ?? 0.7;                  // in-sample fraction
  const grid = { ...GRID, ...(opts.grid || {}) };
  const base = withDefaults(baseParams);

  const split = Math.floor(bars.length * splitPct);
  const inSample = bars.slice(0, split);
  const outSample = bars.slice(Math.max(0, split - 250));  // overlap warms up the indicators

  const results = [];
  for (const c of combos(grid)) {
    const params = { ...base, ...c };
    const res = backtest.run(inSample, params);
    results.push({
      params: c,
      score: scoreOf(res.stats, objective, minTrades),
      inSample: brief(res.stats),
    });
  }
  results.sort((a, b) => b.score - a.score);

  // Validate the top candidates forward, on bars the search never saw.
  const top = results.slice(0, Math.min(10, results.length));
  for (const t of top) {
    if (!Number.isFinite(t.score)) continue;
    const oos = backtest.run(outSample, { ...base, ...t.params });
    t.outOfSample = brief(oos.stats);
    // Degradation: how much of the in-sample expectancy survived out of sample.
    t.holdUp = t.inSample.expectancyR > 0
      ? +(t.outOfSample.expectancyR / t.inSample.expectancyR).toFixed(2) : null;
  }

  const best = top.find(t => Number.isFinite(t.score)) || null;

  // A leaderboard always has a top row. Say plainly when that row is still a losing strategy —
  // "best of 162" is not the same as "good".
  const verdict = !best ? "no_candidates"
    : best.inSample.expectancyR <= 0 ? "no_edge_found"
    : best.outOfSample && best.outOfSample.expectancyR <= 0 ? "did_not_hold_up"
    : "positive_both";

  return {
    objective, minTrades, tested: results.length,
    split: { inSampleBars: inSample.length, outOfSampleBars: outSample.length, splitPct },
    best: best ? { ...best.params } : null,
    verdict,
    leaderboard: top,
    note: {
      no_candidates: `No parameter set produced at least ${minTrades} trades on this data.`,
      no_edge_found: "Every combination lost money in-sample. This market/timeframe offered no "
        + "breakout edge under these rules — the ranking is between losers.",
      did_not_hold_up: "The in-sample winner did not survive out of sample. That is the usual "
        + "signature of curve-fitting, not of an edge.",
      positive_both: "In-sample rows are fitted; out-of-sample rows are not. Prefer a candidate "
        + "whose hold-up is near 1 with a positive out-of-sample expectancy over the top raw score.",
    }[verdict],
  };
}

module.exports = { run, combos, GRID, OBJECTIVES };
