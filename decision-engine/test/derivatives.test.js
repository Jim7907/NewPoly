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

// ── Audit regressions (2026-09) ──
test("audit: OI change and price change are measured over the SAME recent window", () => {
  const DAY = 86400e3, t0 = Date.UTC(2026, 2, 29, 16);
  // 180 daily OI points (like OKX rubik): OI doubled over 6 months, flat over the last 10 days
  const oiHistory = Array.from({ length: 180 }, (_, i) => ({ t: t0 + i * DAY, oi: i < 170 ? 1e9 * (1 + i / 170) : 2e9 }));
  const tEnd = oiHistory.at(-1).t;
  // 300 hourly candles (12.5 days) ending at the last OI stamp: price +10% over that span
  const candles = Array.from({ length: 300 }, (_, i) => ({ t: tEnd - (299 - i) * 3600e3, o: 100, h: 101, l: 99, c: 100 * (1 + 0.1 * i / 299), v: 1 }));
  const s = byId(signals({ oiHistory }, { candles }))["deriv.oi.price_confirmation"];
  assert.ok(Math.abs(s.value.oiChange) < 1e-9, `OI change must be the recent (flat) window, got ${s.value.oiChange}`);
  // price change over the same 7 days (≈ 7/12.46 of the 10% ramp), not the whole candle history
  assert.ok(s.value.priceChange > 0.04 && s.value.priceChange < 0.07, `${s.value.priceChange}`);
  // no fragility signal from a 6-month OI build-up
  assert.ok(!byId(signals({ oiHistory, fundingRate: 0.0005 }, { candles }))["deriv.oi.fragility"]);
  // the window is configurable and seconds-epoch timestamps are still understood
  const secs = oiHistory.map(p => ({ t: p.t / 1000, oi: p.oi }));
  const s2 = byId(signals({ oiHistory: secs }, { candles, oiWindowMs: 30 * DAY }))["deriv.oi.price_confirmation"];
  // 30 d requested, but candles only cover 12.5 d → trimmed (untrimmed 30 d would read ≈ +6%)
  assert.ok(Math.abs(s2.value.oiChange) < 0.02, `window trimmed to what candles cover: ${s2.value.oiChange}`);
});
