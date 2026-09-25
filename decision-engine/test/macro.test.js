const test = require("node:test");
const assert = require("node:assert");
const { signals } = require("../server/analysis/macro");

const D = 86400000;
const T0 = Date.UTC(2026, 0, 1);
const ser = (n, f) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * D, v: f(i, n) }));
const BTC = { assetClass: "crypto", symbol: "BTC" };
const AAPL = { assetClass: "stock", symbol: "AAPL", etf: false };

const riskOff = {
  vix: ser(60, (i, n) => (i < n - 20 ? 15 : 15 + (i - (n - 20)) * 1.0)),     // 15 → 34, still rising
  hyOas: ser(60, (i, n) => (i < n - 20 ? 3.2 : 3.2 + (i - (n - 20)) * 0.07)), // +133bp
  dgs10: ser(60, () => 4.2),
  dxy: ser(60, (i, n) => (i < n - 20 ? 120 : 120 * (1 + 0.0015 * (i - (n - 20))))),
  t10y2y: ser(60, () => 0.4),
};
const riskOn = {
  vix: ser(60, (i, n) => (i < n - 20 ? 16 : 16 - (i - (n - 20)) * 0.2)),     // 16 → 12.2
  hyOas: ser(60, (i, n) => 3.3 - i * 0.004),
  dgs10: ser(60, (i) => 4.5 - i * 0.005),
  dxy: ser(60, (i) => 120 - i * 0.03),
};

const byId = (sigs) => Object.fromEntries(sigs.map((s) => [s.id, s]));

test("risk-off macro -> negative for risk assets, crypto more negative", () => {
  const c = byId(signals(riskOff, BTC));
  const s = byId(signals(riskOff, AAPL));
  for (const id of ["macro.risk.vix", "macro.risk.credit", "macro.fx.dollar", "macro.risk.regime"]) {
    assert.ok(c[id].score < 0, `${id} crypto ${c[id].score}`);
    assert.ok(s[id].score < 0, `${id} stock ${s[id].score}`);
  }
  assert.ok(c["macro.risk.vix"].score < s["macro.risk.vix"].score);
  assert.equal(c["macro.risk.regime"].value.regime, "risk-off");
  assert.ok(c["macro.fx.dollar"].score < s["macro.fx.dollar"].score);
});

test("risk-on macro -> positive", () => {
  const c = byId(signals(riskOn, BTC));
  assert.ok(c["macro.risk.vix"].score > 0);
  assert.ok(c["macro.risk.credit"].score > 0);
  assert.ok(c["macro.rates.momentum"].score > 0); // falling yields
  assert.ok(c["macro.fx.dollar"].score > 0);
  assert.equal(c["macro.risk.regime"].value.regime, "risk-on");
});

test("VIX spike rolling over is less negative than a rising spike", () => {
  const rolling = { vix: ser(40, (i, n) => (i < n - 10 ? 15 : i === n - 6 ? 42 : i > n - 6 ? 30 : 25)) };
  const rising = { vix: ser(40, (i, n) => (i < n - 10 ? 15 : 25 + (i - (n - 10)) * 1.7)) };
  const a = byId(signals(rolling, AAPL))["macro.risk.vix"];
  const b = byId(signals(rising, AAPL))["macro.risk.vix"];
  assert.equal(a.value.rollingOver, true);
  assert.ok(a.score > b.score);
});

test("inverted curve -> negative at position horizon", () => {
  const s = byId(signals({ t10y2y: ser(80, () => -0.6) }, AAPL))["macro.curve.inversion"];
  assert.ok(s.score < 0);
  assert.equal(s.horizon, "position");
});

test("missing / garbage inputs never produce NaN", () => {
  assert.deepEqual(signals(null, BTC), []);
  assert.deepEqual(signals({}, BTC), []);
  const junk = { vix: [{ t: T0, v: null }, { t: T0 + D, v: "." }, { t: T0 + 2 * D, v: 20 }], dgs10: [{ t: "2026-01-01", v: "4.1" }, { t: "2026-01-02", v: "4.3" }], hyOas: null, dxy: [{ t: T0, v: 0 }, { t: T0 + D, v: 100 }] };
  const sigs = signals(junk, undefined);
  assert.ok(sigs.length >= 1);
  for (const s of sigs) {
    assert.ok(Number.isFinite(s.score) && Number.isFinite(s.confidence), s.id);
    assert.equal(s.family, "macro");
  }
});
