// Paper-trading engine: convert actionable signals into paper trades, and resolve
// expired windows against the Pyth close snapshot (close >= open => Up).
const db = require("./db");
const feeds = require("./feeds");

// Place a paper trade from a built signal if eligible. Returns trade id or null.
function tryEnter(sig) {
  if (db.getSetting("paper_enabled") !== "true" || db.getSetting("scan_active") !== "true") return null;
  if (sig.signal === "—" || !sig.side || !(sig.stake >= 1)) return null;
  if (db.hasOpenTrade(sig.marketId)) return null;
  return db.placeTrade({
    asset: sig.asset, marketId: sig.marketId, upToken: sig.upToken, side: sig.side,
    entryPrice: sig.q, feeFrac: sig.feeFrac, size: sig.stake, pUsed: sig.pUsed, z: sig.z,
    leadBps: sig.leadBps, windowEnd: sig.endDate, sOpen: sig.sOpen, refSource: sig.refSource, mode: sig.mode,
  });
}

// Resolve all open trades whose window has closed.
async function resolveDue(nowMs = Date.now()) {
  const settled = [];
  for (const t of db.getOpenTrades()) {
    const endMs = Date.parse(t.windowEnd);
    if (!(endMs <= nowMs)) continue;
    const closeUnix = Math.floor(endMs / 1000);
    let sClose = await feeds.fetchRefAt(t.asset, closeUnix);
    if (sClose == null) sClose = await feeds.fetchRefNow(t.asset);  // fallback to spot now
    if (sClose == null) {
      // No price available yet. Void only if well past close so we never fabricate.
      if (nowMs - endMs > 10 * 60 * 1000) settled.push(db.settleTrade(t.id, null, null));
      continue;
    }
    const resolvedUp = sClose >= t.sOpen;            // tie (>=) resolves Up, per market rules
    settled.push(db.settleTrade(t.id, resolvedUp, sClose));
  }
  return settled.filter(Boolean);
}

module.exports = { tryEnter, resolveDue };
