const test = require("node:test");
const assert = require("node:assert");
const p = require("../server/poly");
const { gammaEvent } = require("./fixtures");

test("parseBucketLabel handles every shape the live markets use", () => {
  assert.deepEqual(p.parseBucketLabel("25°C or below"), { lo: -Infinity, hi: 25, deg: 25, type: "tail-low", unit: "C", label: "25°C or below" });
  assert.deepEqual(p.parseBucketLabel("31°C"), { lo: 31, hi: 31, deg: 31, type: "exact", unit: "C", label: "31°C" });
  assert.deepEqual(p.parseBucketLabel("35°C or higher"), { lo: 35, hi: Infinity, deg: 35, type: "tail-high", unit: "C", label: "35°C or higher" });
  assert.equal(p.parseBucketLabel("88°F").unit, "F");
  assert.equal(p.parseBucketLabel("-3°C or below").deg, -3);
  assert.equal(p.parseBucketLabel("12°C or above").type, "tail-high");
  assert.equal(p.parseBucketLabel("no number here"), null);
  assert.equal(p.parseBucketLabel(null), null);
});

test("parseEventTitle picks out kind and city", () => {
  assert.deepEqual(p.parseEventTitle("Highest temperature in Singapore on August 24?"), { kind: "high", city: "Singapore" });
  assert.deepEqual(p.parseEventTitle("Lowest temperature in Seoul (Incheon) on August 24?"), { kind: "low", city: "Seoul (Incheon)" });
  assert.equal(p.parseEventTitle("Where will it rain on August 23?"), null);
});

test("parseEventDate prefers the slug's unambiguous year", () => {
  assert.equal(p.parseEventDate("highest-temperature-in-singapore-on-august-24-2026", "2026-08-24T12:00:00Z"), "2026-08-24");
  assert.equal(p.parseEventDate("lowest-temperature-in-milan-on-january-3-2027", null), "2027-01-03");
  assert.equal(p.parseEventDate("no-date-here", "2026-08-24T12:00:00Z"), "2026-08-24");
  assert.equal(p.parseEventDate(null, null), null);
});

test("localToday and leadDays work in the station's own timezone, not UTC", () => {
  // 2026-08-24T02:45Z is still Aug 23 in New York but already Aug 24 in Singapore.
  const t = Date.parse("2026-08-24T02:45:00Z");
  assert.equal(p.localToday("Asia/Singapore", t), "2026-08-24");
  assert.equal(p.localToday("America/New_York", t), "2026-08-23");
  assert.equal(p.leadDays("2026-08-24", "2026-08-25"), 1);
  assert.equal(p.leadDays("2026-08-31", "2026-09-01"), 1, "month boundary");
});

test("toLadder normalizes a Gamma event into a sorted, priced ladder", () => {
  const lad = p.toLadder(gammaEvent({ city: "Singapore", peakDeg: 30 }));
  assert.ok(lad);
  assert.equal(lad.city, "Singapore");
  assert.equal(lad.kind, "high");
  assert.equal(lad.station.icao, "WSSS");
  assert.equal(lad.date, "2026-08-25");
  assert.equal(lad.buckets.length, 11);
  assert.equal(lad.buckets[0].type, "tail-low");
  assert.equal(lad.buckets[10].type, "tail-high");
  for (let i = 1; i < lad.buckets.length; i++) assert.ok(lad.buckets[i].deg > lad.buckets[i - 1].deg, "sorted cold->hot");
  assert.ok(lad.overround > 1, "a live ladder quotes an overround");
  assert.equal(lad.buckets[3].fee.rate, 0.05, "fee schedule read off the market");
});

test("toLadder rejects non-temperature and unknown-city events", () => {
  assert.equal(p.toLadder({ title: "Where will it rain on August 23?", markets: [] }), null);
  const e = gammaEvent({ city: "Singapore" });
  e.title = "Highest temperature in Atlantis on August 25?";
  assert.equal(p.toLadder(e), null, "no resolution station => not tradable");
});

test("feeParams honours the market's own schedule and a fees-off market", () => {
  assert.deepEqual(p.feeParams({ feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 } }), { rate: 0.05, exp: 1, source: "market" });
  assert.equal(p.feeParams({ feesEnabled: false }).rate, 0);
  assert.equal(p.feeParams({}).source, "config");
});

test("selectTradable filters by horizon, kind and station timezone", () => {
  const lad = p.toLadder(gammaEvent({ city: "Singapore" }));       // market date 2026-08-25
  const at = (iso) => p.selectTradable([lad], { nowMs: Date.parse(iso), minLead: 1, maxLead: 2, kinds: ["high", "low"] });
  assert.equal(at("2026-08-24T02:00:00Z").length, 1, "D+1 is in range");
  assert.equal(at("2026-08-24T02:00:00Z")[0].leadDays, 1);
  assert.equal(at("2026-08-25T02:00:00Z").length, 0, "D+0 is outside the configured horizon");
  assert.equal(at("2026-08-20T02:00:00Z").length, 0, "D+5 is too far out");
  assert.equal(p.selectTradable([lad], { nowMs: Date.parse("2026-08-24T02:00:00Z"), minLead: 1, maxLead: 2, kinds: ["low"] }).length, 0);
});

test("selectTradable honours a narrowed CITIES universe", () => {
  // Regression: the scan discovered every city on Polymarket regardless of CITIES, and then
  // burned forecast API calls on stations it had no intention of ever trading.
  const sg = p.toLadder(gammaEvent({ city: "Singapore" }));
  const ldn = p.toLadder(gammaEvent({ city: "London" }));
  const opts = { nowMs: Date.parse("2026-08-24T02:00:00Z"), minLead: 1, maxLead: 2, kinds: ["high"] };
  assert.equal(p.selectTradable([sg, ldn], opts).length, 2);
  assert.deepEqual(p.selectTradable([sg, ldn], { ...opts, cities: ["London"] }).map(x => x.city), ["London"]);
  assert.equal(p.selectTradable([sg, ldn], { ...opts, cities: [] }).length, 2, "an empty list means no restriction");
});

test("parseBook normalizes touch and depth regardless of incoming sort order", () => {
  const b = p.parseBook({
    bids: [{ price: "0.10", size: "5" }, { price: "0.12", size: "20" }],
    asks: [{ price: "0.20", size: "8" }, { price: "0.14", size: "10" }],
  });
  assert.equal(b.bid, 0.12);
  assert.equal(b.ask, 0.14);
  assert.equal(b.spreadC, 2);
  assert.equal(b.mid, 0.13);
  assert.ok(Math.abs(b.askDepthUsd - 10 * 0.14) < 1e-9, "only levels within 3c of touch count");
  assert.equal(p.parseBook({ bids: [], asks: [] }), null);
});

test("walkAsks prices a real fill and refuses when the book is too thin", () => {
  const asks = [{ price: 0.10, size: 3 }, { price: 0.12, size: 10 }];
  assert.ok(Math.abs(p.walkAsks(asks, 5) - (3 * 0.10 + 2 * 0.12) / 5) < 1e-9);
  assert.equal(p.walkAsks(asks, 100), null);
  assert.equal(p.walkAsks([], 1), null);
});
