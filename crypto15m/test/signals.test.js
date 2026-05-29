const test = require("node:test");
const assert = require("node:assert");
const cfg = require("../server/config");
const { evaluate } = require("../server/signals");

const base = (over = {}) => ({
  asset: "BTC", name: "Bitcoin", nowMs: 1_000_000,
  endDateMs: 1_000_000 + 120_000,                 // 120s to close
  sOpen: 100, ref: { price: 100.2, sigmaPerSec: 0.0001216, stale: false, source: "pyth" },
  poly: { mid: 0.62, ask: 0.65, bid: 0.60, spreadC: 2, depthBuyUsd: 200, depthSellUsd: 200 },
  micro: { wsStale: true },
  bankroll: 1000, openExposure: 0,
  ...over,
});
const P = { ...cfg }; // default thresholds

test("late-window favorite => BUY UP", () => {
  const r = evaluate(base(), P);
  assert.equal(r.reasons.length, 0, "no gate failures: " + r.reasons.join(","));
  assert.equal(r.signal, "BUY UP");
  assert.equal(r.side, "UP");
  assert.ok(r.stake >= 1);
  assert.ok(r.pSide >= P.MIN_P);
});

test("no reference => no-ref", () => {
  const r = evaluate(base({ ref: { price: null } }), P);
  assert.equal(r.signal, "—");
  assert.ok(r.reasons.includes("no-ref"));
});

test("too early (tau beyond late window, mode B off) => too-early", () => {
  const r = evaluate(base({ endDateMs: 1_000_000 + 800_000 }), P);
  assert.ok(r.reasons.includes("too-early"));
  assert.equal(r.signal, "—");
});

test("lead within oracle basis buffer => within-basis", () => {
  const r = evaluate(base({ ref: { price: 100.001, sigmaPerSec: 0.0001216, stale: false } }), P);
  assert.ok(r.reasons.includes("within-basis"));
});

test("no taker entries in final seconds", () => {
  const r = evaluate(base({ endDateMs: 1_000_000 + 30_000 }), P); // 30s left < NO_TAKER_LAST_S
  assert.ok(r.reasons.includes("too-late-taker"));
});

test("downside lead => DOWN side chosen", () => {
  const r = evaluate(base({ ref: { price: 99.8, sigmaPerSec: 0.0001216, stale: false }, poly: { mid: 0.38, ask: 0.41, bid: 0.36, spreadC: 2, depthBuyUsd: 200, depthSellUsd: 200 } }), P);
  assert.equal(r.side, "DOWN");
});

test("wide spread blocks trade", () => {
  const r = evaluate(base({ poly: { mid: 0.62, ask: 0.65, bid: 0.60, spreadC: 9, depthBuyUsd: 200, depthSellUsd: 200 } }), P);
  assert.ok(r.reasons.includes("spread-wide"));
});
