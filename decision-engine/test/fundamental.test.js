const test = require("node:test");
const assert = require("node:assert");
const { stockSignals, cryptoSignals, piotroski, altmanZ, altmanModel } = require("../server/analysis/fundamental");

// A company that passes all 9 Piotroski criteria.
const PERFECT = {
  symbol: "GOOD", asOf: null, price: 50, marketCap: 5000, sharesOut: 100, sharesOutPrev: 102,
  revenueTTM: 1200, revenuePrevTTM: 1000, grossProfitTTM: 480, operatingIncomeTTM: 180,
  netIncomeTTM: 120, netIncomePrevTTM: 90, epsTTM: 1.2, epsPrevTTM: 0.88,
  cfoTTM: 160, capexTTM: -40, fcfTTM: 120, totalAssets: 1000, totalAssetsPrev: 950,
  currentAssets: 500, currentLiabilities: 250, currentRatioPrev: 1.8, totalLiabilities: 500,
  longTermDebt: 200, longTermDebtPrev: 230, equity: 500, retainedEarnings: 300, ebitTTM: 150,
  interestExpenseTTM: 10, grossMarginPrev: 0.38, assetTurnoverPrev: 1.1, roaPrev: 0.10, cash: 100,
  sector: "Industrials", industry: "Machinery", analystTarget: 60, peRatio: null, dividendYield: null,
};

const noNaN = (sigs) => {
  for (const s of sigs) {
    assert.ok(Number.isFinite(s.score) && s.score >= -1 && s.score <= 1, `${s.id} score ${s.score}`);
    assert.ok(Number.isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1, `${s.id} conf ${s.confidence}`);
    assert.equal(s.family, "fundamental");
    assert.ok(typeof s.reason === "string" && s.reason.length > 5);
    assert.match(s.id, /^fund\.[a-z_]+\.[a-z0-9_]+$/);
  }
};

test("piotroski: all 9 criteria satisfied -> 9", () => {
  const p = piotroski(PERFECT);
  assert.equal(p.score, 9);
  assert.equal(p.tested, 9);
  assert.equal(p.complete, true);
});

test("piotroski: mixed company -> exact count", () => {
  const f = { ...PERFECT,
    roaPrev: 0.20,              // ΔROA fails (ROA 120/950 = 0.126 < 0.20)
    cfoTTM: 100,                // CFO>0 passes; accrual fails (CFO 100 < NI 120)
    longTermDebt: 300,          // leverage rose: 300/1000 = .30 > 230/950 = .242 -> fails
    sharesOut: 110,             // equity issued -> fails
  };
  const p = piotroski(f);
  // pass: roa, cfo, deltaLiquid, deltaMargin, deltaTurn = 5
  assert.equal(p.score, 5);
  assert.deepEqual(p.criteria, { roa: 1, cfo: 1, deltaRoa: 0, accrual: 0, deltaLever: 0, deltaLiquid: 1, eqOffer: 0, deltaMargin: 1, deltaTurn: 1 });
});

test("piotroski: all fail -> 0; too little data -> null", () => {
  const bad = { ...PERFECT, netIncomeTTM: -50, cfoTTM: -60, roaPrev: 0.01, longTermDebt: 400, currentAssets: 200,
    sharesOut: 120, grossProfitTTM: 300, revenueTTM: 900 };
  assert.equal(piotroski(bad).score, 0);
  assert.equal(piotroski({ netIncomeTTM: 1, cfoTTM: 2 }), null);
  assert.equal(piotroski(null), null);
});

test("altman Z (1968 manufacturer) known example = 4.155", () => {
  // X1 = .25, X2 = .3, X3 = .15, X4 = 5000/500 = 10, X5 = 1.2
  const a = altmanZ(PERFECT);
  assert.equal(a.model, "Z");
  const expected = 1.2 * 0.25 + 1.4 * 0.3 + 3.3 * 0.15 + 0.6 * 10 + 1.0 * 1.2;
  assert.ok(Math.abs(a.z - expected) < 1e-9);
  assert.equal(a.zone, "safe");
  // Textbook ratio example: X1=.2 X2=.3 X3=.15 X4=3 X5=1.2 -> 4.155
  const f = { totalAssets: 1000, totalLiabilities: 500, currentAssets: 500, currentLiabilities: 300,
    retainedEarnings: 300, ebitTTM: 150, marketCap: 1500, revenueTTM: 1200, sector: "Industrials" };
  assert.ok(Math.abs(altmanZ(f).z - 4.155) < 1e-9);
});

test("altman Z'' for non-manufacturers, null for financials / missing", () => {
  const f = { ...PERFECT, sector: "Technology", industry: "Software" };
  const a = altmanZ(f);
  assert.equal(a.model, "Z''");
  const expected = 6.56 * 0.25 + 3.26 * 0.3 + 6.72 * 0.15 + 1.05 * (500 / 500);
  assert.ok(Math.abs(a.z - expected) < 1e-9);
  assert.equal(altmanModel({ sector: "Finance", industry: "Major Banks" }), null);
  assert.equal(altmanZ({ ...PERFECT, sector: "Finance" }), null);
  assert.equal(altmanZ({ ...PERFECT, retainedEarnings: null }), null);
  // distress example
  const d = altmanZ({ ...f, retainedEarnings: -400, ebitTTM: -50, currentAssets: 200, currentLiabilities: 400, equity: 50 });
  assert.equal(d.zone, "distress");
});

test("stockSignals: healthy company yields bullish quality signals, no NaN", () => {
  const sigs = stockSignals(PERFECT);
  noNaN(sigs);
  const byId = Object.fromEntries(sigs.map((s) => [s.id, s]));
  for (const id of ["fund.value.earnings_yield", "fund.value.fcf_yield", "fund.value.ebit_ev", "fund.quality.piotroski",
    "fund.risk.altman_z", "fund.quality.accruals", "fund.quality.gross_profitability", "fund.growth.revenue",
    "fund.growth.eps", "fund.balance.leverage", "fund.balance.interest_coverage", "fund.capital.share_change", "fund.analyst.target"]) {
    assert.ok(byId[id], `missing ${id}`);
  }
  assert.ok(byId["fund.quality.piotroski"].score > 0.8);
  assert.equal(byId["fund.quality.piotroski"].horizon, "position");
  assert.ok(byId["fund.quality.accruals"].score > 0); // CFO > NI
  assert.ok(byId["fund.capital.share_change"].score > 0); // buyback
  assert.ok(byId["fund.growth.revenue"].score > 0);
});

test("stockSignals: all-null fundamentals -> [] and never NaN", () => {
  const nulls = Object.fromEntries(Object.keys(PERFECT).map((k) => [k, null]));
  assert.deepEqual(stockSignals(nulls), []);
  assert.deepEqual(stockSignals(null), []);
  const partial = { ...nulls, price: 10, epsTTM: -1, revenueTTM: 0, totalAssets: 0, equity: -5, longTermDebt: 10 };
  noNaN(stockSignals(partial));
});

test("stockSignals: ETF -> [] unless analyst/valuation provided", () => {
  assert.deepEqual(stockSignals({ symbol: "SPY", price: 500 }, { asset: { etf: true } }), []);
  const s = stockSignals({ symbol: "SPY", price: 500, peRatio: 22, analystTarget: 560 }, { asset: { etf: true } });
  assert.deepEqual(s.map((x) => x.id).sort(), ["fund.analyst.target", "fund.value.earnings_yield"]);
});

test("stockSignals: confidence is lower for short horizons", () => {
  const pos = stockSignals(PERFECT, { horizon: "position" }).find((s) => s.id === "fund.quality.piotroski");
  const intr = stockSignals(PERFECT, { horizon: "intraday" }).find((s) => s.id === "fund.quality.piotroski");
  assert.ok(intr.confidence < pos.confidence * 0.3);
});

test("cryptoSignals: overhang, drawdown, relative strength", () => {
  const f = { symbol: "SOL", price: 150, marketCap: 70e9, fdv: 88e9, volume24h: 3.5e9, circulatingSupply: 470e6,
    totalSupply: 590e6, maxSupply: null, ath: 260, athChangePct: -42, change7d: 5, change30d: 25, change1y: 80,
    tvl: 9e9, devCommits4w: 150, devStars: 12000, twitterFollowers: null, redditSubscribers: null, sentimentUpPct: 80 };
  const sigs = cryptoSignals(f, { btc: { change30d: 5, change1y: 60 } });
  noNaN(sigs);
  const ids = sigs.map((s) => s.id);
  for (const id of ["fund.crypto.turnover", "fund.crypto.supply_overhang", "fund.crypto.ath_drawdown", "fund.crypto.tvl_ratio",
    "fund.crypto.dev_activity", "fund.crypto.rel_btc_30d", "fund.crypto.rel_btc_1y"]) assert.ok(ids.includes(id), id);
  assert.ok(sigs.find((s) => s.id === "fund.crypto.rel_btc_30d").score > 0);
  assert.ok(sigs.find((s) => s.id === "fund.crypto.supply_overhang").score < 0);
  assert.deepEqual(cryptoSignals({ symbol: "X" }), []);
  // Deep drawdown is negative, near ATH positive
  const dd = (p) => cryptoSignals({ symbol: "X", athChangePct: p })[0].score;
  assert.ok(dd(-90) < 0 && dd(-3) > 0);
});
