const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Isolate the database before anything requires config/db.
process.env.DB_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-"));
process.env.PAPER_BALANCE = "1000";
const db = require("../server/db");
const cfg = require("../server/config");
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
  assert.equal(db.getBalance(cfg.SIZING), 1000);

  const id = db.placeBasket(plan(), "kelly");
  assert.ok(id);
  assert.equal(db.getBalance(cfg.SIZING), 940, "the whole outlay is debited up front");
  assert.equal(db.getLegs(id).length, 3);
  assert.ok(db.hasOpenBasket("evt1"));
  assert.equal(db.openExposure(), 60);

  // Station reported 30 -> the 30C rung pays 100 shares = $100.
  const r = db.settleBasket(id, 30, "iem-asos");
  assert.equal(r.status, "won");
  assert.equal(r.winLabel, "30°C");
  assert.equal(r.payout, 100);
  assert.equal(r.pnl, 40);
  assert.equal(db.getBalance(cfg.SIZING), 1040);
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
  const before = db.getBalance(cfg.SIZING);
  const id = db.placeBasket(plan({ eventId: "evt3" }), "kelly");
  const r = db.settleBasket(id, 27, "iem-asos");
  assert.equal(r.status, "lost");
  assert.equal(r.payout, 0);
  assert.equal(r.pnl, -60);
  assert.equal(db.getBalance(cfg.SIZING), before - 60);
  assert.ok(db.getLegs(id).every(l => l.won === 0));
});

test("a station that never reports voids and refunds in full", async () => {
  const before = db.getBalance(cfg.SIZING);
  const id = db.placeBasket(plan({ eventId: "evt4" }), "kelly");
  const r = db.settleBasket(id, null, null);
  assert.equal(r.status, "void");
  assert.equal(db.getBalance(cfg.SIZING), before, "void is economically a no-op");
});

test("stats aggregate hit rate and ROI over settled baskets", () => {
  const s = db.getStats(cfg.SIZING);
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

test("a floor-rule basket settles on the containing range, not the nearest degree", () => {
  // Hong Kong: HKO publishes 31.6 and Polymarket resolves it to "31°C", NOT "32°C".
  // Getting this backwards would pay out the wrong rung on roughly two days in three.
  const hk = plan({ eventId: "hk1", city: "Hong Kong", station: "HKO", bucketRule: "floor" });
  hk.legs = [
    { idx: 4, label: "30°C", deg: 30, type: "exact", marketId: "h30", tokenId: "x30", prob: 0.3, ask: 0.30, fillAsk: 0.30, qEff: 0.30, shares: 100, dollars: 30 },
    { idx: 5, label: "31°C", deg: 31, type: "exact", marketId: "h31", tokenId: "x31", prob: 0.3, ask: 0.20, fillAsk: 0.20, qEff: 0.20, shares: 100, dollars: 20 },
    { idx: 6, label: "32°C", deg: 32, type: "exact", marketId: "h32", tokenId: "x32", prob: 0.2, ask: 0.10, fillAsk: 0.10, qEff: 0.10, shares: 100, dollars: 10 },
  ];
  const id = db.placeBasket(hk, "kelly");
  const r = db.settleBasket(id, 31.6, "hko-daily-extract");
  assert.equal(r.winLabel, "31°C", "floor(31.6) = 31");
  assert.equal(r.payout, 100);

  // The same reading under the METAR round rule settles one bucket higher.
  const metar = plan({ eventId: "m1" });
  metar.legs = hk.legs.map(l => ({ ...l }));
  const id2 = db.placeBasket(metar, "kelly");   // plan() carries no bucketRule => "round"
  assert.equal(db.settleBasket(id2, 31.6, "iem-asos").winLabel, "32°C", "round(31.6) = 32");
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


test("a COVERED outcome can still lose money, and the stats say so", () => {
  // Reproduces the Lucknow case seen live: centre 31.4, rungs 30/31/32, station read 30.
  // The outcome landed on the OUTER rung, which holds the smallest allocation, so the basket
  // covered and still lost. Kelly does this deliberately — the wing is insurance, not a
  // winner — but reporting cover as if it were a win rate makes it look like a bug.
  const b = plan({
    eventId: "lucknow", city: "Lucknow", station: "VILK", center: 31.4, outlay: 29.99,
    legs: [
      // outer rung: small allocation, expensive => pays back less than the basket cost
      { idx: 1, label: "30°C", deg: 30, type: "exact", marketId: "l30", tokenId: "x30", prob: 0.22, ask: 0.42, fillAsk: 0.42, qEff: 0.44, shares: 15.17, dollars: 6.67 },
      { idx: 2, label: "31°C", deg: 31, type: "exact", marketId: "l31", tokenId: "x31", prob: 0.44, ask: 0.30, fillAsk: 0.30, qEff: 0.32, shares: 55.0, dollars: 17.60 },
      { idx: 3, label: "32°C", deg: 32, type: "exact", marketId: "l32", tokenId: "x32", prob: 0.24, ask: 0.14, fillAsk: 0.14, qEff: 0.15, shares: 38.13, dollars: 5.72 },
    ],
  });
  const id = db.placeBasket(b, "kelly");
  const r = db.settleBasket(id, 30, "iem-asos");

  assert.equal(r.winLabel, "30°C");
  assert.equal(r.status, "won", "the outcome DID land inside the cluster");
  assert.ok(r.pnl < 0, `covered but lost: pnl ${r.pnl}`);
  assert.ok(Math.abs(r.pnl - (15.17 - 29.99)) < 0.01, "loss is basket cost minus the outer rung's payout");

  const stats = db.getStats(cfg.SIZING);
  assert.ok(stats.coverRate > 0, "cover rate counts it as covered");
  assert.ok(stats.coveredLosses >= 1, "and it is flagged as a covered loss");
  assert.ok(stats.profitRate < stats.coverRate, "profit rate must be able to sit BELOW cover rate");
});

test("each sizing policy keeps its own book, and both may hold the same market", () => {
  // The comparison is only meaningful if the policies do not compete for one bankroll and
  // are not blocked by each other's open positions.
  const kellyBefore = db.getBalance("kelly");
  const equalBefore = db.getBalance("equal");

  const p = plan({ eventId: "paired-evt", city: "Paris", station: "LFPB" });
  const idK = db.placeBasket(p, "kelly");
  // Same market, different policy: must NOT be blocked, and must debit the OTHER book.
  assert.equal(db.hasOpenBasket("paired-evt", "kelly"), true);
  assert.equal(db.hasOpenBasket("paired-evt", "equal"), false, "the equal book is still free to take it");
  const idE = db.placeBasket({ ...p, legs: p.legs.map(l => ({ ...l, shares: 50, dollars: l.qEff * 50 })) }, "equal");
  assert.ok(idK && idE && idK !== idE);

  assert.ok(db.getBalance("kelly") < kellyBefore, "kelly book debited");
  assert.ok(db.getBalance("equal") < equalBefore, "equal book debited");
  assert.equal(db.getBalance("kelly"), +(kellyBefore - 60).toFixed(4), "kelly debit is its own outlay only");

  // Settling one book must not move the other.
  const equalMid = db.getBalance("equal");
  db.settleBasket(idK, 30, "iem-asos");
  assert.equal(db.getBalance("equal"), equalMid, "settling kelly leaves the equal book untouched");

  // Exposure and stats are reported per policy. (Earlier tests in this file leave their own
  // kelly baskets open, so compare against the combined figure rather than assuming zero.)
  assert.ok(db.openExposure("equal") > 0, "equal book carries its open basket");
  assert.equal(
    +(db.openExposure("kelly") + db.openExposure("equal")).toFixed(4),
    +db.openExposure().toFixed(4),
    "per-policy exposure partitions the total"
  );
  const both = db.getStats();
  assert.ok(both.byMode.kelly && both.byMode.equal, "stats expose every policy");
  assert.equal(both.byMode.kelly.sizing, "kelly");
});
