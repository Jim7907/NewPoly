const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Isolate the DB before requiring config/db.
process.env.DB_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "c15m-"));
process.env.PAPER_BALANCE = "1000";
const db = require("../server/db");

test("paper trade lifecycle: place, win, lose, void", async () => {
  await db.initDB();
  assert.equal(parseFloat(db.getSetting("paper_balance")), 1000);

  // WIN: BUY UP @0.8, $40. fee = 0.036*(1-0.8)*40 = 0.288.
  const id1 = db.placeTrade({ asset: "BTC", marketId: "m1", upToken: "u", side: "UP", entryPrice: 0.8, feeFrac: 0.036 * 0.2, size: 40, pUsed: 0.85, z: 1.5, leadBps: 20, windowEnd: new Date().toISOString(), sOpen: 100, refSource: "pyth", mode: "A" });
  assert.ok(Math.abs(parseFloat(db.getSetting("paper_balance")) - (1000 - 40 - 0.288)) < 1e-3);
  const w = db.settleTrade(id1, true, 100.5);  // close >= open => Up => UP wins
  assert.equal(w.status, "won");
  // shares = 50; balance = 959.712 + 50
  assert.ok(Math.abs(parseFloat(db.getSetting("paper_balance")) - (1000 - 40 - 0.288 + 50)) < 1e-3);
  assert.ok(Math.abs(w.pnl - (50 - 40 - 0.288)) < 1e-3);

  // LOSE: BUY DOWN @0.7, $30 but window resolves Up.
  const balBefore = parseFloat(db.getSetting("paper_balance"));
  const id2 = db.placeTrade({ asset: "ETH", marketId: "m2", upToken: "u", side: "DOWN", entryPrice: 0.7, feeFrac: 0.036 * 0.3, size: 30, pUsed: 0.8, z: -1.2, leadBps: -15, windowEnd: new Date().toISOString(), sOpen: 50, refSource: "pyth", mode: "A" });
  const l = db.settleTrade(id2, true, 51); // Up => DOWN loses
  assert.equal(l.status, "lost");
  assert.ok(Math.abs(parseFloat(db.getSetting("paper_balance")) - (balBefore - 30 - 0.324)) < 1e-3);

  // VOID: refund stake + fee.
  const balV = parseFloat(db.getSetting("paper_balance"));
  const id3 = db.placeTrade({ asset: "SOL", marketId: "m3", upToken: "u", side: "UP", entryPrice: 0.6, feeFrac: 0.036 * 0.4, size: 10, pUsed: 0.8, z: 1, leadBps: 10, windowEnd: new Date().toISOString(), sOpen: 1, refSource: "pyth", mode: "A" });
  db.settleTrade(id3, null, null);
  assert.ok(Math.abs(parseFloat(db.getSetting("paper_balance")) - balV) < 1e-3, "void refunds stake+fee");

  const stats = db.getStats();
  assert.equal(stats.wonTrades, 1);
  assert.equal(stats.lostTrades, 1);
  assert.equal(stats.voidTrades, 1);
  assert.equal(stats.winRate, 50);
  db.close();
});

test("hasOpenTrade + openExposure", async () => {
  // fresh db state from previous test persists in-process; just sanity-check helpers exist
  assert.equal(typeof db.hasOpenTrade("nope"), "boolean");
  assert.equal(typeof db.openExposure(), "number");
});
