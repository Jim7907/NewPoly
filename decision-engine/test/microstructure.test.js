const test = require("node:test");
const assert = require("node:assert");
const { signals, ofi, vpin, bandImbalance } = require("../server/analysis/microstructure");

const MID = 100;
const book = (bidSz, askSz) => ({
  bids: Array.from({ length: 20 }, (_, i) => [MID - 0.01 - i * 0.02, bidSz]),
  asks: Array.from({ length: 20 }, (_, i) => [MID + 0.01 + i * 0.02, askSz]),
});
const trades = (n, pBuy, t0 = 1.7e12) => Array.from({ length: n }, (_, i) => ({
  t: t0 + i * 1000, side: (i * 7919) % 100 < pBuy * 100 ? "buy" : "sell", size: 1, price: MID + i * 0.001,
}));
const byId = (sigs) => Object.fromEntries(sigs.map((s) => [s.id, s]));

test("book imbalance sign follows depth", () => {
  const bid = byId(signals({ book: book(10, 2) }))["micro.book.imbalance"];
  const ask = byId(signals({ book: book(2, 10) }))["micro.book.imbalance"];
  const bal = byId(signals({ book: book(5, 5) }))["micro.book.imbalance"];
  assert.ok(bid.score > 0.3, `bid ${bid.score}`);
  assert.ok(ask.score < -0.3);
  assert.ok(Math.abs(bal.score) < 0.05);
  assert.equal(bid.family, "microstructure");
  assert.equal(bid.horizon, "intraday");
  assert.ok(bandImbalance(book(10, 2), MID, 10) > 0);
});

test("confidence low for swing/position horizons", () => {
  const i = byId(signals({ book: book(10, 2) }, { horizon: "intraday" }))["micro.book.imbalance"];
  const s = byId(signals({ book: book(10, 2) }, { horizon: "swing" }))["micro.book.imbalance"];
  const p = byId(signals({ book: book(10, 2) }, { horizon: "position" }))["micro.book.imbalance"];
  assert.ok(i.confidence > s.confidence && s.confidence > p.confidence);
  assert.ok(p.confidence < 0.1);
});

test("spread in bps and wide-spread discount", () => {
  const sp = byId(signals({ book: book(5, 5) }))["micro.book.spread"];
  assert.ok(Math.abs(sp.value.spreadBps - 2) < 0.01);
  assert.equal(sp.confidence, 0);
  const wide = { bids: [[99.9, 10], [99.8, 10]], asks: [[100.1, 2], [100.2, 2]] }; // 20bp spread
  const w = byId(signals({ book: wide }))["micro.book.imbalance"];
  const n = byId(signals({ book: { bids: [[99.99, 10], [99.89, 10]], asks: [[100.01, 2], [100.11, 2]] } }))["micro.book.imbalance"];
  assert.ok(w.confidence < n.confidence);
});

test("trade-flow imbalance and CVD slope follow aggressor side", () => {
  const buyers = byId(signals({ trades: trades(200, 0.8) }));
  const sellers = byId(signals({ trades: trades(200, 0.2) }));
  assert.ok(buyers["micro.flow.imbalance"].score > 0.3);
  assert.ok(sellers["micro.flow.imbalance"].score < -0.3);
  assert.ok(buyers["micro.flow.cvd_slope"].score > 0);
  assert.ok(sellers["micro.flow.cvd_slope"].score < 0);
});

test("VPIN: one-sided flow is toxic, balanced flow is not", () => {
  const alt = Array.from({ length: 400 }, (_, i) => ({ t: i, side: i % 2 ? "buy" : "sell", size: 1 }));
  assert.ok(vpin(alt).vpin < 0.05);
  const oneSided = Array.from({ length: 400 }, (_, i) => ({ t: i, side: i % 10 ? "buy" : "sell", size: 1 }));
  const v = vpin(oneSided);
  assert.ok(Math.abs(v.vpin - 0.8) < 0.05);
  const s = byId(signals({ trades: oneSided }))["micro.toxicity.vpin"];
  assert.ok(s.score > 0.3);
  assert.equal(vpin([{ t: 1, side: "buy", size: 1 }]), null);
});

test("CKS OFI: bid size growing at same price -> positive", () => {
  const tops = Array.from({ length: 10 }, (_, i) => ({ bidPx: 100, bidSz: 5 + i, askPx: 100.02, askSz: 5 }));
  assert.ok(ofi(tops).ofi > 0);
  const s = byId(signals({ bookHistory: tops }))["micro.flow.ofi"];
  assert.ok(s.score > 0);
  const down = Array.from({ length: 10 }, (_, i) => ({ bidPx: 100, bidSz: 5, askPx: 100.02, askSz: 5 + i }));
  assert.ok(ofi(down).ofi < 0);
});

test("empty / malformed input never NaN", () => {
  assert.deepEqual(signals(null), []);
  assert.deepEqual(signals({}), []);
  const sigs = signals({ book: { bids: [["x", 1], [100, 0]], asks: [] }, trades: [{ side: "buy", size: "nope" }], mid: NaN });
  assert.deepEqual(sigs, []);
  for (const s of signals({ book: { bids: [["99.9", "3"]], asks: [["100.1", "1"]] }, trades: trades(12, 0.5) })) {
    assert.ok(Number.isFinite(s.score) && Number.isFinite(s.confidence), s.id);
  }
});
