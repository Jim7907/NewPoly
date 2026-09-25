const test = require("node:test");
const assert = require("node:assert");
const R = require("../server/decision/risk");

const CFG = { KELLY_K: 0.25, MAX_POS_FRAC: 0.10, MAX_POS_FRAC_CRYPTO: 0.05, MAX_GROSS: 1.0, TARGET_VOL: 0.12, MAX_DRAWDOWN: 0.15, STOP_ATR: 2, TARGET_ATR: 3 };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test("normInv inverts normCdf", () => {
  for (const x of [-3, -1.5, -0.2, 0, 0.7, 2.5]) assert.ok(close(R.normInv(R.normCdf(x)), x, 1e-3), `${x}`);
  assert.ok(close(R.normInv(0.975), 1.959964, 1e-5));
});

test("bracketExpectation: no free lunch at pUp = 0.5 despite a 3:2 bracket", () => {
  const b = R.bracketExpectation({ pWin: 0.5, atrPct: 0.02, stopAtr: 2, targetAtr: 3, horizonBars: 5, costFrac: 0.003 });
  assert.ok(close(b.eGross, 0, 1e-12));
  assert.ok(b.eNet <= 0 && close(b.eNet, -0.003));
  assert.ok(close(b.pEff, 2 / 5), `driftless pEff = S/(S+T), got ${b.pEff}`);
  // E[r] increases with pWin and is antisymmetric around 0.5
  let prev = -Infinity;
  for (const p of [0.3, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    const e = R.bracketExpectation({ pWin: p, atrPct: 0.02, horizonBars: 5 }).eGross;
    assert.ok(e > prev); prev = e;
  }
  const up = R.bracketExpectation({ pWin: 0.6, atrPct: 0.02 }).eGross, dn = R.bracketExpectation({ pWin: 0.4, atrPct: 0.02 }).eGross;
  assert.ok(close(up, -dn, 1e-12));
  // expected holding time never exceeds the horizon
  assert.ok(R.bracketExpectation({ pWin: 0.6, atrPct: 0.02, horizonBars: 5 }).expectedBars < 5);
  // garbage → finite
  const g = R.bracketExpectation({ pWin: NaN, atrPct: NaN });
  for (const v of Object.values(g)) assert.ok(Number.isFinite(v));
});

test("positionSize: no edge → 0; Kelly scales with reliability; caps bind with reasons", () => {
  const z = R.positionSize({ pUp: 0.5, riskReward: 1.5, atrPct: 0.02, equity: 100000, cfg: CFG, costFrac: 0.001 });
  assert.strictEqual(z.sizeFrac, 0);
  assert.ok(z.capped.includes("no_edge"));

  const args = { pUp: 0.56, riskReward: 1.5, atrPct: 0.02, annVol: 0.05, equity: 100000, cfg: { ...CFG, MAX_POS_FRAC: 1 }, costFrac: 0.001 };
  const full = R.positionSize(args), half = R.positionSize({ ...args, reliability: 0.5 });
  assert.ok(full.kellyFrac > 0 && close(half.kellyFrac, full.kellyFrac / 2, 1e-12));
  // Kelly = K·eNet/(W·L)
  const br = R.bracketExpectation({ pWin: 0.56, atrPct: 0.02, stopAtr: 2, targetAtr: 3, horizonBars: 5, costFrac: 0.001 });
  assert.ok(close(full.kellyFrac, 0.25 * br.eNet / (br.winFrac * br.lossFrac), 1e-12));

  const stock = R.positionSize({ ...args, pUp: 0.6, cfg: CFG, annVol: 0.2 });
  assert.ok(close(stock.volTargetFrac, 0.6));
  assert.ok(stock.sizeFrac <= 0.10 + 1e-12);
  const crypto = R.positionSize({ ...args, pUp: 0.6, cfg: CFG, annVol: 0.6, assetClass: "crypto" });
  assert.ok(crypto.sizeFrac <= 0.05 + 1e-12);
  assert.ok(crypto.capped.includes("max_pos"), crypto.capped.join());
  const vt = R.positionSize({ ...args, pUp: 0.6, cfg: { ...CFG, MAX_POS_FRAC: 1 }, annVol: 2.4 });
  assert.ok(vt.capped.includes("vol_target") && close(vt.sizeFrac, 0.05));
  assert.ok(close(vt.sizeUsd, vt.sizeFrac * 100000));
});

test("positionSize: correlation haircut, gross cap, drawdown halt", () => {
  const args = { pUp: 0.6, riskReward: 1.5, atrPct: 0.02, annVol: 0.2, equity: 100000, cfg: CFG };
  const base = R.positionSize(args).sizeFrac;
  const corr = R.positionSize({ ...args, correlation: 0.8 });
  assert.ok(close(corr.sizeFrac, base * 0.6) && corr.capped.includes("correlation"));
  const corr2 = R.positionSize({ ...args, openPositions: [{ sizeFrac: 0.1, correlation: 0.5 }] });
  assert.ok(close(corr2.sizeFrac, base * 0.75));
  const gross = R.positionSize({ ...args, openPositions: [{ sizeFrac: 0.5 }, { valueUsd: 48000 }] });
  assert.ok(close(gross.sizeFrac, 0.02) && gross.capped.includes("gross"));
  const halt = R.positionSize({ ...args, drawdown: 0.2 });
  assert.strictEqual(halt.sizeFrac, 0);
  assert.ok(halt.capped.includes("drawdown_halt"));
  const bad = R.positionSize({ pUp: NaN, atrPct: NaN, cfg: CFG });
  assert.strictEqual(bad.sizeFrac, 0);
});

test("var95 / cvar95: historical and parametric", () => {
  const r = Array.from({ length: 101 }, (_, k) => (k - 50) / 1000);  // −5% … +5% uniform
  const v = R.var95(r, 1000);
  assert.ok(close(v.historical, 45, 1e-9), `${v.historical}`);
  const sd = R.sd(r);
  assert.ok(close(v.parametric, 1.6448536 * sd * 1000, 1e-6));
  const cv = R.cvar95(r, 1000);
  assert.ok(cv >= v.historical && close(cv, 47.5, 1e-9), `${cv}`);
  assert.deepStrictEqual(R.var95([], 1), { historical: 0, parametric: 0 });
  assert.strictEqual(R.cvar95([0.01]), 0);
});

test("maxDrawdown, sharpe, sortino, correlation", () => {
  assert.ok(close(R.maxDrawdown([100, 120, 90, 130, 117]), 0.25));
  assert.ok(close(R.maxDrawdown([{ v: 1 }, { v: 2 }, { v: 1.5 }]), 0.25));
  assert.strictEqual(R.maxDrawdown([]), 0);
  const r = [0.01, -0.005, 0.02, 0.0, 0.015, -0.01];
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
  assert.ok(close(R.sharpe(r, 252), (m / sd) * Math.sqrt(252)));
  const dd = Math.sqrt((0.005 ** 2 + 0.01 ** 2) / r.length);
  assert.ok(close(R.sortino(r, 252), (m / dd) * Math.sqrt(252)));
  assert.strictEqual(R.sharpe([0.01, 0.01, 0.01]), 0);
  assert.strictEqual(R.sortino([0.01, 0.02]), 0);
  const a = [1, 2, 3, 4, 5], b = [2, 4, 6, 8, 10];
  assert.ok(close(R.correlation(a, b), 1));
  assert.ok(close(R.correlation(a, b.map(x => -x)), -1));
  assert.strictEqual(R.correlation([1, 1, 1, 1], [1, 2, 3, 4]), 0);
  assert.ok(close(R.correlation([9, 9, 1, 2, 3], [1, 2, 3]), 1), "uses overlapping tails");
  assert.strictEqual(R.correlation([1, NaN], [2]), 0);
});

test("positionSize: db-style open positions (costUsd, assetClass) drive gross cap and class-prior correlation", () => {
  const args = { pUp: 0.6, riskReward: 1.5, atrPct: 0.02, annVol: 0.2, equity: 100000, cfg: CFG, assetClass: "stock" };
  const base = R.positionSize(args).sizeFrac;
  const r = R.positionSize({ ...args, openPositions: [{ assetId: "STOCK:AAPL", assetClass: "stock", costUsd: 20000 }] });
  assert.ok(close(r.sizeFrac, base * 0.75), `${r.sizeFrac} vs ${base}`);
  const c = R.positionSize({ ...args, assetClass: "crypto", openPositions: [{ assetClass: "crypto", costUsd: 5000 }] });
  assert.ok(close(c.sizeFrac, 0.05 * 0.65));
  const g = R.positionSize({ ...args, openPositions: [{ assetClass: "crypto", costUsd: 99000 }] });
  assert.ok(close(g.sizeFrac, 0.01) && g.capped.includes("gross"));
});
