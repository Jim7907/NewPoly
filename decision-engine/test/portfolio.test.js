const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const portfolio = require("../server/portfolio");
const cfg = require("../server/config");

const mkDecision = (over = {}) => ({
  assetId: "CRYPTO:BTC", symbol: "BTC", assetClass: "crypto", horizon: "swing", action: "BUY",
  price: 100, pUp: 0.65, confidence: 0.75,
  risk: { direction: "long", stop: 95, target: 110, sizeUsd: 5000 }, ...over,
});

test.before(async () => { await db.initDB({ memory: true }); });
test.beforeEach(() => portfolio.reset(100000));

test("opening a long debits collateral + fees; equity ~unchanged", () => {
  const r = portfolio.onDecision(mkDecision());
  assert.ok(r.opened);
  assert.equal(db.openPositions().length, 1);
  const eq = portfolio.equity();
  assert.ok(eq < 100000 && eq > 99980, `equity ${eq}`);
});

test("long hits target -> profit; hits stop -> loss", () => {
  portfolio.onDecision(mkDecision());
  const closed = portfolio.onPrice("CRYPTO:BTC", 111);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, "target");
  assert.ok(closed[0].pnl > 0);
  portfolio.onDecision(mkDecision());
  const c2 = portfolio.onPrice("CRYPTO:BTC", 94);
  assert.equal(c2[0].reason, "stop");
  assert.ok(c2[0].pnl < 0);
});

test("short profits when price falls", () => {
  portfolio.onDecision(mkDecision({ action: "SELL", risk: { direction: "short", stop: 105, target: 90, sizeUsd: 5000 } }));
  const c = portfolio.onPrice("CRYPTO:BTC", 89);
  assert.equal(c[0].reason, "target");
  assert.ok(c[0].pnl > 0);
  assert.ok(portfolio.equity() > 100000);
});

test("opposite signal closes the position; HOLD does not open", () => {
  portfolio.onDecision(mkDecision());
  const r = portfolio.onDecision(mkDecision({ action: "SELL", price: 101, risk: { direction: null } }));
  assert.ok(r.closed);
  assert.equal(r.closed.reason, "signal-flip");
  assert.equal(r.opened, null);
  const h = portfolio.onDecision(mkDecision({ action: "HOLD", risk: { direction: null } }));
  assert.equal(h.opened, null);
});

test("stocks don't trade while the market is closed", () => {
  const r = portfolio.onDecision(mkDecision({ assetId: "STOCK:AAPL", symbol: "AAPL", assetClass: "stock" }), { marketOpen: false });
  assert.equal(r.opened, null);
});

test("drawdown circuit breaker blocks new entries", () => {
  db.setSetting("peak_equity", (100000 / (1 - cfg.MAX_DRAWDOWN) + 1000).toFixed(2));
  const r = portfolio.onDecision(mkDecision());
  assert.equal(r.opened, null);
});

test("breakeven stop after half-way to target", () => {
  portfolio.onDecision(mkDecision());
  portfolio.onPrice("CRYPTO:BTC", 106);
  assert.equal(db.openPositions()[0].stop, db.openPositions()[0].entry);
});

// ── Audit regressions (2026-09) ──
test("audit: stock positions expire after `ahead` SESSIONS, crypto after calendar time", () => {
  const { horizonEndMs } = require("../server/data/stocks");
  const t0 = Date.now();
  portfolio.onDecision(mkDecision({ assetId: "STOCK:AAPL", symbol: "AAPL", assetClass: "stock" }), { marketOpen: true });
  const p = db.openPositions().find((x) => x.assetId === "STOCK:AAPL");
  const H = cfg.HORIZONS.swing;
  const want = horizonEndMs("stock", t0, H.ahead, H.tf);
  assert.ok(Math.abs(p.expiresAt - want) < 5000, `${new Date(p.expiresAt).toISOString()} vs ${new Date(want).toISOString()}`);
  portfolio.onDecision(mkDecision());
  const c = db.openPositions().find((x) => x.assetId === "CRYPTO:BTC");
  assert.ok(Math.abs(c.expiresAt - (t0 + H.ahead * H.tf * 1000)) < 5000);
});
