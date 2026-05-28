// Express API + fast scan loop + WebSocket push for the 15m crypto imbalance bot.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const cfg = require("./config");
const db = require("./db");
const feeds = require("./feeds");
const poly = require("./poly");
const signals = require("./signals");
const engine = require("./engine");
const calib = require("./calib");
const backtest = require("./backtest");

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Live cache (served to clients; refreshed by the scan loop) ──
let liveCache = { assets: [], ts: null, lastScan: null };
let scanning = false;

async function scanOnce() {
  if (scanning) return;
  scanning = true;
  try {
    const nowMs = Date.now();
    await engine.resolveDue(nowMs);

    const windows = await poly.getLiveWindows(nowMs);
    const list = Object.values(windows);
    signals.clearOpenCache(list.map(w => w.marketId));

    const bankroll = parseFloat(db.getSetting("paper_balance") || "0");
    const openExposure = db.openExposure();

    const polyData = await Promise.all(list.map(async (w) => {
      try { return await poly.getPolyUp(w); } catch { return null; }
    }));

    const assets = [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const sig = signals.buildLiveSignal(w, { nowMs, poly: polyData[i] || {}, bankroll, openExposure });
      db.logSignal(sig);
      const tradeId = engine.tryEnter(sig);
      if (tradeId) sig.placed = tradeId;
      assets.push(sig);
    }
    // Stable ordering by configured universe.
    assets.sort((a, b) => cfg.ASSET_KEYS.indexOf(a.asset) - cfg.ASSET_KEYS.indexOf(b.asset));
    liveCache = { assets, ts: new Date().toISOString(), lastScan: new Date().toISOString() };
    broadcast({ type: "live", assets, stats: safe(() => db.getStats(), null), ts: liveCache.ts });
  } catch (e) {
    console.error("[scan]", e.message);
  } finally {
    scanning = false;
  }
}
const safe = (fn, d) => { try { return fn(); } catch { return d; } };

// ── WebSocket push ──
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "live", assets: liveCache.assets, stats: safe(() => db.getStats(), null), ts: liveCache.ts }));
});
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// ── Routes ──
app.get("/api/health", (req, res) => res.json({
  status: "ok", uptime: process.uptime(), assets: cfg.ASSET_KEYS,
  wsClients: clients.size, driftEnabled: cfg.DRIFT_ENABLED, ts: new Date().toISOString(),
}));

app.get("/api/live", (req, res) => res.json({ ...liveCache, stats: safe(() => db.getStats(), null), settings: db.getAllSettings() }));
app.get("/api/trades", (req, res) => res.json({ trades: db.getRecentTrades(parseInt(req.query.limit) || 200) }));
app.get("/api/stats", (req, res) => res.json(db.getStats()));

app.get("/api/calibration", (req, res) => {
  res.json({
    calibration: calib.calibration(db.getResolvedSignals()),
    perAsset: calib.perAsset(db.getRecentTrades(10000)),
    ts: new Date().toISOString(),
  });
});

app.get("/api/backtest", (req, res) => res.json(db.getLatestBacktest() || { note: "No backtest run yet. POST /api/backtest to run." }));
app.post("/api/backtest", async (req, res) => {
  try {
    const result = await backtest.run({
      targetWr: req.body?.targetWr, minTrades: req.body?.minTrades, limitPerAsset: req.body?.limitPerAsset,
    });
    db.saveBacktest({ targetWr: result.target, minTrades: result.minTrades }, result);
    if (req.body?.apply !== false && result.best) {     // write tuned thresholds back to settings
      db.setSetting("min_p", result.best.MIN_P);
      db.setSetting("min_z", result.best.MIN_Z);
      db.setSetting("late_window_s", result.best.LATE_WINDOW_S);
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual paper trade from the current live signal (or explicit fields).
app.post("/api/paper-trade", (req, res) => {
  try {
    const { marketId } = req.body || {};
    const sig = liveCache.assets.find(a => a.marketId === marketId);
    if (!sig || !sig.side || sig.q == null) return res.status(400).json({ error: "No tradeable live signal for that market" });
    if (db.hasOpenTrade(marketId)) return res.status(400).json({ error: "Already have an open position in this window" });
    const size = Math.max(1, Math.min(req.body?.size || sig.stake || 10, parseFloat(db.getSetting("paper_balance"))));
    const id = db.placeTrade({
      asset: sig.asset, marketId, upToken: sig.upToken, side: sig.side, entryPrice: sig.q,
      feeFrac: sig.feeFrac, size, pUsed: sig.pUsed, z: sig.z, leadBps: sig.leadBps,
      windowEnd: sig.endDate, sOpen: sig.sOpen, refSource: sig.refSource, mode: sig.mode,
    });
    res.json({ success: true, tradeId: id, stats: db.getStats() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/settings", (req, res) => {
  const allowed = ["paper_enabled", "scan_active", "min_edge", "min_p", "min_z", "late_window_s", "drift_enabled"];
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.includes(k)) db.setSetting(k, v);
  res.json({ success: true, settings: db.getAllSettings() });
});

app.post("/api/reset-paper", (req, res) => {
  const amount = parseFloat(req.body?.amount) || cfg.PAPER_BALANCE;
  db.setSetting("paper_balance", amount.toFixed(2));
  res.json({ success: true, newBalance: amount });
});

// Serve built frontend in production.
if (process.env.NODE_ENV === "production") {
  const dist = path.join(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ── Bootstrap ──
db.initDB().then(() => {
  feeds.start();
  server.listen(cfg.PORT, () => {
    console.log(`\n 15M Crypto Imbalance Bot — http://localhost:${cfg.PORT}`);
    console.log(` Assets: ${cfg.ASSET_KEYS.join(", ")} | drift=${cfg.DRIFT_ENABLED} | scan=${cfg.SCAN_MS}ms\n`);
    setInterval(scanOnce, cfg.SCAN_MS);
    setTimeout(scanOnce, 2500); // let feeds warm up first
  });
}).catch(e => { console.error("[boot] failed:", e.message); process.exit(1); });

module.exports = { app, scanOnce };
