const test = require("node:test");
const assert = require("node:assert");
const { selectLiveWindows, toCandidate } = require("../server/poly");

test("selectLiveWindows picks nearest future window per asset", () => {
  const now = 1_000_000_000_000;
  const cand = [
    { asset: "BTC", endDateMs: now - 5000 },          // already closed -> excluded
    { asset: "BTC", endDateMs: now + 120_000 },        // live -> chosen
    { asset: "BTC", endDateMs: now + 800_000 },        // beyond window -> excluded
    { asset: "ETH", endDateMs: now + 300_000 },
  ];
  const live = selectLiveWindows(cand, now);
  assert.equal(live.BTC.endDateMs, now + 120_000);
  assert.equal(live.ETH.endDateMs, now + 300_000);
});

test("toCandidate parses clobTokenIds and series", () => {
  const cfg = require("../server/config");
  const asset = cfg.ASSETS[0]; // first configured (BTC by default)
  const end = new Date(Date.now() + 120000).toISOString();
  const c = toCandidate({
    id: "evt1", title: `${asset.name} Up or Down`,
    series: [{ slug: asset.series }],
    markets: [{ conditionId: "0xabc", endDate: end, clobTokenIds: '["111","222"]', question: "q" }],
  });
  assert.ok(c);
  assert.equal(c.asset, asset.symbol);
  assert.equal(c.upToken, "111");
  assert.equal(c.downToken, "222");
  assert.ok(c.windowOpenMs < c.endDateMs);
});

test("toCandidate rejects non-up-down series", () => {
  assert.equal(toCandidate({ series: [{ slug: "random-market" }], markets: [{ endDate: "x", clobTokenIds: "[]" }] }), null);
});
