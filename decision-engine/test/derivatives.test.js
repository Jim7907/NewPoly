const test = require("node:test");
const assert = require("node:assert");
const { signals } = require("../server/analysis/derivatives");

const H8 = 8 * 3600 * 1000;
const hist = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i * H8, rate: f(i) }));
const oi = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i * 3600e3, oi: f(i) }));
const byId = (sigs) => Object.fromEntries(sigs.map((s) => [s.id, s]));

test("extreme positive funding = crowded longs -> contrarian bearish", () => {
  const s = byId(signals({ fundingRate: 0.0008, fundingHistory: hist(30, (i) => (i < 25 ? 0.0001 : 0.0007)) }))["deriv.funding.crowding"];
  assert.ok(s.score < -0.5, `score ${s.score}`);
  assert.ok(s.confidence > 0.5);
  assert.equal(s.family, "derivatives");
});

test("deeply negative funding -> contrarian bullish; neutral funding ~ 0", () => {
  const neg = byId(signals({ fundingRate: -0.0005 }))["deriv.funding.crowding"];
  assert.ok(neg.score > 0.4);
  const neu = byId(signals({ fundingRate: 0.0001 }))["deriv.funding.crowding"];
  assert.ok(Math.abs(neu.score) < 0.01);
  const mild = byId(signals({ fundingRate: 0.00015 }))["deriv.funding.crowding"];
  assert.ok(Math.abs(mild.score) < 0.15);
  // string inputs (OKX returns strings)
  assert.ok(byId(signals({ fundingRate: "0.0008" }))["deriv.funding.crowding"].score < -0.5);
});

test("negative funding + rising price = squeeze fuel (bullish)", () => {
  const s = byId(signals({ fundingRate: -0.0003, priceChange: 0.05 }))["deriv.funding.squeeze"];
  assert.ok(s.score > 0.3);
  const c = byId(signals({ fundingRate: 0.0006, priceChange: -0.05 }))["deriv.funding.squeeze"];
  assert.ok(c.score < -0.3);
});

test("OI rising with price confirms; OI rising against price bearish", () => {
  const up = byId(signals({ oiHistory: oi(24, (i) => 100 + i * 1), priceChange: 0.06 }))["deriv.oi.price_confirmation"];
  assert.ok(up.score > 0.2);
  const dn = byId(signals({ oiHistory: oi(24, (i) => 100 + i * 1), priceChange: -0.06 }))["deriv.oi.price_confirmation"];
  assert.ok(dn.score < -0.2);
  const cover = byId(signals({ oiHistory: oi(24, (i) => 130 - i), priceChange: 0.06 }))["deriv.oi.price_confirmation"];
  assert.ok(cover.score < 0 && Math.abs(cover.score) < Math.abs(up.score));
});

test("price change derived from candles over the OI window", () => {
  const candles = Array.from({ length: 48 }, (_, i) => ({ t: i * 3600e3, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }));
  const s = byId(signals({ oiHistory: oi(24, (i) => 100 + i) }, { candles }))["deriv.oi.price_confirmation"];
  assert.ok(s.value.priceChange > 0 && s.score > 0);
});

test("fragility: OI surge with stalled price and crowded longs -> bearish", () => {
  const s = byId(signals({ fundingRate: 0.0005, oiHistory: oi(24, (i) => 100 + i * 1.5), priceChange: 0.002 }))["deriv.oi.fragility"];
  assert.ok(s && s.score < -0.2);
});

test("basis premium and missing inputs", () => {
  assert.ok(byId(signals({ basisBps: 80 }))["deriv.basis.premium"].score < -0.3);
  assert.deepEqual(signals(null), []);
  assert.deepEqual(signals({ fundingRate: null, fundingHistory: null, openInterest: null, oiHistory: null }), []);
  for (const s of signals({ fundingRate: NaN, oiHistory: [{ t: 1, oi: 0 }, { t: 2, oi: 5 }], priceChange: 0.01 })) {
    assert.ok(Number.isFinite(s.score) && Number.isFinite(s.confidence));
  }
});
