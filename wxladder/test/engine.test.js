const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Isolate the database before anything requires config/db.
process.env.DB_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-"));
process.env.PAPER_BALANCE = "1000";
const db = require("../server/db");
const engine = require("../server/engine");

// A funded 3-rung plan: 100 shares of a 0.30 rung, 100 of 0.20, 100 of 0.10.
const plan = (over = {}) => ({
  eventId: over.eventId || "evt1", slug: "s", city: "Singapore", station: "WSSS", kind: "high",
  date: "2026-08-25", leadDays: 1, unit: "C", rawCenter: 30.1, bias: 0.4, center: 30.5,
  sigma: 0.95, ensSd: 1.0, dispRatio: 1.0, regime: "normal", tvd: 0.2, coverProb: 0.78,
  basketCost: 0.63, basketEv: 0.19, fillEv: 0.2, overround: 1.06, budget: 60, outlay: 60,
  signal: "BUY LADDER x3",
  legs: [
    { idx: 4, label: "30°C", deg: 30, type: "exact", marketId: "m30", tokenId: "t30", prob: 0.34, pModel: 0.36, pMarket: 0.31, ask: 0.30, fillAsk: 0.30, qEff: 0.30, feePerShare: 0.015, shares: 100, dollars: 30 },
    { idx: 5, label: "31°C", deg: 31, type: "exact", marketId: "m31", tokenId: "t31", prob: 0.28, pModel: 0.30, pMarket: 0.25, ask: 0.20, fillAsk: 0.20, qEff: 0.20, feePerShare: 0.010, shares: 100, dollars: 20 },
    { idx: 6, label: "32°C or higher", deg: 32, type: "tail-high", marketId: "m32", tokenId: "t32", prob: 0.16, pModel: 0.17, pMarket: 0.15, ask: 0.10, fillAsk: 0.10, qEff: 0.10, feePerShare: 0.005, shares: 100, dollars: 10 },
  ],
  ...over,
});

test("basket lifecycle: place, win on the centre rung, and settle the balance", async () => {
  await db.initDB();
  assert.equal(parseFloat(db.getSetting("paper_balance")), 1000);

  const id = db.placeBasket(plan(), "kelly");
  assert.ok(id);
  assert.equal(parseFloat(db.getSetting("paper_balance")), 940, "the whole outlay is debited up front");
  assert.equal(db.getLegs(id).length, 3);
  assert.ok(db.hasOpenBasket("evt1"));
  assert.equal(db.openExposure(), 60);

  // Station reported 30 -> the 30C rung pays 100 shares = $100.
  const r = db.settleBasket(id, 30, "iem-asos");
  assert.equal(r.status, "won");
  assert.equal(r.winLabel, "30°C");
  assert.equal(r.payout, 100);
  assert.equal(r.pnl, 40);
  assert.equal(parseFloat(db.getSetting("paper_balance")), 1040);
  const legs = db.getLegs(id);
  assert.equal(legs.filter(l => l.won === 1).length, 1, "exactly one rung can win");
});

test("an open tail rung wins for anything at or beyond its degree", async () => {
  const id = db.placeBasket(plan({ eventId: "evt2" }), "kelly");
  const r = db.settleBasket(id, 37, "iem-asos");
  assert.equal(r.status, "won");
  assert.equal(r.winLabel, "32°C or higher");
  assert.equal(r.payout, 100);
});

test("a miss outside the cluster loses the whole outlay and nothing more", async () => {
  const before = parseFloat(db.getSetting("paper_balance"));
  const id = db.placeBasket(plan({ eventId: "evt3" }), "kelly");
  const r = db.settleBasket(id, 27, "iem-asos");
  assert.equal(r.status, "lost");
  assert.equal(r.payout, 0);
  assert.equal(r.pnl, -60);
  assert.equal(parseFloat(db.getSetting("paper_balance")), before - 60);
  assert.ok(db.getLegs(id).every(l => l.won === 0));
});

test("a station that never reports voids and refunds in full", async () => {
  const before = parseFloat(db.getSetting("paper_balance"));
  const id = db.placeBasket(plan({ eventId: "evt4" }), "kelly");
  const r = db.settleBasket(id, null, null);
  assert.equal(r.status, "void");
  assert.equal(parseFloat(db.getSetting("paper_balance")), before, "void is economically a no-op");
});

test("stats aggregate hit rate and ROI over settled baskets", () => {
  const s = db.getStats();
  assert.equal(s.wonBaskets, 2);
  assert.equal(s.lostBaskets, 1);
  assert.equal(s.voidBaskets, 1);
  assert.ok(Math.abs(s.hitRate - 66.7) < 0.2);
  assert.equal(s.openBaskets, 0);
  assert.ok(Math.abs(s.totalPnl - 20) < 1e-6, "two +40 wins and one -60 loss net +20");
  assert.ok(Math.abs(s.staked - 180) < 1e-6, "void is excluded from staked capital");
  assert.ok(Math.abs(s.roi - (20 / 180 * 100)) < 0.01);
});

test("tryEnter honours the paper/scan switches and never doubles up on a market", () => {
  db.setSetting("paper_enabled", "true"); db.setSetting("scan_active", "true");
  assert.equal(engine.tryEnter({ signal: "—", outlay: 0 }), null, "a refusal is not an entry");
  assert.equal(engine.tryEnter(plan({ eventId: "evt5", outlay: 0 })), null);

  const id = engine.tryEnter(plan({ eventId: "evt6" }));
  assert.ok(id);
  assert.equal(engine.tryEnter(plan({ eventId: "evt6" })), null, "already holding this market");

  db.setSetting("scan_active", "false");
  assert.equal(engine.tryEnter(plan({ eventId: "evt7" })), null);
  db.setSetting("scan_active", "true");
  db.setSetting("paper_enabled", "false");
  assert.equal(engine.tryEnter(plan({ eventId: "evt7" })), null);
  db.setSetting("paper_enabled", "true");
});

test("tryEnter refuses a plan with fewer rungs than the ladder minimum", () => {
  const p = plan({ eventId: "evt8" });
  p.legs = [p.legs[0]];
  assert.equal(engine.tryEnter(p), null);
});

test("forecast and observation logs join into the bias training set", () => {
  for (let i = 10; i <= 20; i++) {
    const d = `2026-08-${String(i).padStart(2, "0")}`;
    db.logForecast({ station: "WSSS", kind: "high", marketDate: d, leadDays: 1, rawCenter: 31.5, ensSd: 1.0, ensMean: 31.4, detMean: 31.6, nMembers: 120 });
    db.logObs({ station: "WSSS", kind: "high", date: d, value: 32, source: "iem-asos" });
  }
  const pairs = db.biasPairs("WSSS", "high", 1);
  assert.equal(pairs.length, 11);
  assert.ok(pairs.every(p => p.obs === 32 && p.rawCenter === 31.5));
  assert.equal(db.spreadRows("WSSS", "high", 1).length, 11);
  assert.equal(db.biasPairs("WSSS", "high", 2).length, 0, "leads are fitted separately");
  assert.equal(db.getObs("WSSS", "high", "2026-08-10").value, 32);

  // Re-logging the same day must update rather than duplicate.
  db.logForecast({ station: "WSSS", kind: "high", marketDate: "2026-08-10", leadDays: 1, rawCenter: 31.9, ensSd: 1.1, ensMean: 31.9, detMean: 31.9, nMembers: 120 });
  assert.equal(db.biasPairs("WSSS", "high", 1).length, 11);
  assert.equal(db.biasPairs("WSSS", "high", 1).find(p => p.date === "2026-08-10").rawCenter, 31.9);
});

test("effectiveParams layers stored settings over the static config", () => {
  db.setSetting("min_basket_ev", "0.25");
  db.setSetting("sizing", "equal");
  const p = db.effectiveParams();
  assert.equal(p.MIN_BASKET_EV, 0.25);
  assert.equal(p.SIZING, "equal");
  assert.ok(p.STATIONS.length > 0, "static config still comes through");
  db.setSetting("min_basket_ev", "0.08");
  db.setSetting("sizing", "kelly");
  db.close();
});
