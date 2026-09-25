// Express API + real-time loops + WebSocket push for the decision engine.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const cfg = require("./config");
const db = require("./db");
const data = require("./data");
const engine = require("./engine");
const portfolio = require("./portfolio");
const analyst = require("./llm/analyst");

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "256kb" }));

// ── Live state ──
const latest = new Map();          // assetId -> full Decision
const busy = new Set();            // assetIds currently evaluating
const strip = (d) => { if (!d) return d; const { signals, headlines, ...rest } = d; return { ...rest, nSignals: signals?.length || 0 }; };
const safe = (fn, d) => { try { return fn(); } catch { return d; } };

async function scanAsset(asset) {
  if (busy.has(asset.id) || db.getSetting("scan_active") === "false") return;
  busy.add(asset.id);
  try {
    const decision = await engine.evaluate(asset);
    decision.decisionId = engine.maybeLog(decision);
    latest.set(asset.id, decision);
    portfolio.markPrice(asset.id, decision.price);
    const { opened, closed } = portfolio.onDecision(decision, {
      marketOpen: asset.assetClass === "crypto" || data.marketOpen(new Date()),
      autoTrade: db.getSetting("auto_trade") === "true",
    });
    broadcast({ type: "decision", decision: strip(decision) });
    if (opened) broadcast({ type: "trade", trade: { ...opened, event: "open" } });
    if (closed) broadcast({ type: "trade", trade: { ...closed, event: "close" } });
  } catch (e) {
    console.error(`[scan] ${asset.symbol}:`, e.message);
  } finally { busy.delete(asset.id); }
}

// Stagger assets across the scan interval so data providers see a smooth request rate.
function startLoop(assets, everyMs) {
  if (!assets.length) return;
  const gap = Math.max(250, Math.floor(everyMs / assets.length));
  assets.forEach((a, i) => setTimeout(() => { scanAsset(a); setInterval(() => scanAsset(a), everyMs); }, 1500 + i * gap));
}

// ── WebSocket ──
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "decisions", decisions: [...latest.values()].map(strip), ts: new Date().toISOString() }));
});
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// ── Routes ──
const findAsset = (id) => cfg.ASSETS.find(a => a.id === id || a.symbol === id);

app.get("/api/health", (req, res) => res.json({
  status: "ok", uptime: process.uptime(), assets: cfg.ASSETS.map(a => a.id),
  llm: { enabled: analyst.enabled() && db.getSetting("llm_enabled") !== "false", model: cfg.LLM_MODEL },
  horizon: engine.currentHorizon(), marketOpen: safe(() => data.marketOpen(new Date()), null),
  wsClients: clients.size, settings: db.getAllSettings(), ts: new Date().toISOString(),
}));

app.get("/api/decisions", (req, res) => res.json({
  decisions: cfg.ASSETS.map(a => latest.get(a.id)).filter(Boolean).map(strip),
  thresholds: engine.thresholds(), horizon: engine.currentHorizon(), ts: new Date().toISOString(),
}));

app.get("/api/decision/:assetId", async (req, res) => {
  const asset = findAsset(req.params.assetId);
  if (!asset) return res.status(404).json({ error: "unknown asset" });
  let d = latest.get(asset.id);
  if (!d) { await scanAsset(asset); d = latest.get(asset.id); }
  if (!d) return res.status(503).json({ error: "no decision yet" });
  res.json({ ...d, history: db.decisionHistory(asset.id) });
});

app.get("/api/candles/:assetId", async (req, res) => {
  const asset = findAsset(req.params.assetId) || adHocAsset(req.params.assetId);
  if (!asset) return res.status(404).json({ error: "unknown asset" });
  const tf = parseInt(req.query.tf) || cfg.HORIZONS[engine.currentHorizon()].tf;
  const limit = Math.min(parseInt(req.query.limit) || 300, 1500);
  try { res.json({ candles: (await data.candles(asset, tf, limit)) || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// On-demand analysis for any ticker (not only the configured watchlist).
function adHocAsset(idOrSym, assetClass) {
  const raw = String(idOrSym || "").toUpperCase().replace(/^(CRYPTO|STOCK):/, "");
  if (!/^[A-Z0-9.\-]{1,12}$/.test(raw)) return null;
  const cls = assetClass || (String(idOrSym).toUpperCase().startsWith("CRYPTO:") ? "crypto" : "stock");
  if (cls === "crypto") {
    const u = cfg.CRYPTO_UNIVERSE[raw];
    return u ? { ...u, assetClass: "crypto", id: `CRYPTO:${raw}` }
             : { symbol: raw, name: raw, assetClass: "crypto", id: `CRYPTO:${raw}`, coinbase: `${raw}-USD`, kraken: `${raw}USD`, okx: `${raw}-USDT-SWAP`, coingecko: null, llama: null };
  }
  return { symbol: raw, name: raw, assetClass: "stock", id: `STOCK:${raw}`, etf: ["SPY", "QQQ", "IWM", "DIA", "VTI", "VOO"].includes(raw) };
}

app.post("/api/analyze", async (req, res) => {
  const { symbol, assetClass, horizon } = req.body || {};
  const asset = findAsset(`${assetClass === "crypto" ? "CRYPTO" : "STOCK"}:${String(symbol || "").toUpperCase()}`) || adHocAsset(symbol, assetClass);
  if (!asset) return res.status(400).json({ error: "invalid symbol" });
  try {
    const d = await engine.evaluate(asset, { horizon: cfg.HORIZONS[horizon] ? horizon : undefined, forceLLM: !!req.body?.deep });
    if (!d.price) return res.status(404).json({ error: `no market data for ${asset.symbol}` });
    res.json({ ...d, history: db.decisionHistory(asset.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/portfolio", (req, res) => res.json(portfolio.snapshot()));
app.get("/api/performance", (req, res) => res.json(engine.perfReport()));

app.get("/api/backtest", (req, res) => {
  const asset = findAsset(req.query.assetId || "CRYPTO:BTC");
  const r = asset && db.latestBacktest(asset.id, req.query.horizon || engine.currentHorizon());
  res.json(r || { note: "No backtest yet — POST /api/backtest {assetId, horizon}" });
});
app.post("/api/backtest", async (req, res) => {
  const asset = findAsset(req.body?.assetId) || adHocAsset(req.body?.assetId);
  const horizon = cfg.HORIZONS[req.body?.horizon] ? req.body.horizon : engine.currentHorizon();
  if (!asset) return res.status(400).json({ error: "unknown asset" });
  try {
    const backtest = require("./learning/backtest");
    const hc = cfg.HORIZONS[horizon];
    const candles = await data.candles(asset, hc.tf, Math.max(hc.history, 1000));
    if (!candles || candles.length < 300) return res.status(400).json({ error: `not enough history (${candles?.length || 0} bars)` });
    const result = await backtest.run({ candles, asset, horizon, cfg });
    const out = { ...result, assetId: asset.id, horizon, bars: candles.length, ts: new Date().toISOString() };
    db.saveBacktest(asset.id, horizon, out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/settings", (req, res) => {
  const allowed = ["min_confidence", "min_prob_edge", "min_agreement", "horizon", "auto_trade", "scan_active", "llm_enabled"];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    if (k === "horizon" && !cfg.HORIZONS[v]) continue;
    if (k.startsWith("min_") && !(Number(v) >= 0 && Number(v) <= 1)) continue;
    db.setSetting(k, v);
  }
  if (req.body?.horizon) latest.clear();
  res.json({ success: true, settings: db.getAllSettings() });
});

app.post("/api/reset-paper", (req, res) => {
  portfolio.reset(parseFloat(req.body?.amount) || cfg.PAPER_BALANCE);
  res.json({ success: true, portfolio: portfolio.snapshot() });
});

if (cfg.NODE_ENV === "production") {
  const dist = path.join(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ── Bootstrap ──
async function main() {
  await db.initDB();
  engine.loadState();

  // Real-time crypto ticks → paper stops/targets + UI price flashes (throttled per symbol).
  const lastTick = new Map();
  data.startStreams?.(cfg.CRYPTO, (t) => {
    const asset = cfg.CRYPTO.find(a => a.symbol === t.symbol || a.coinbase === t.product || a.id === t.assetId);
    if (!asset || !(t.price > 0)) return;
    for (const trade of portfolio.onPrice(asset.id, t.price)) broadcast({ type: "trade", trade: { ...trade, event: "close" } });
    const now = Date.now();
    if (now - (lastTick.get(asset.id) || 0) > 1000) {
      lastTick.set(asset.id, now);
      broadcast({ type: "tick", assetId: asset.id, symbol: asset.symbol, price: t.price, ts: t.ts || new Date().toISOString() });
    }
  });

  server.listen(cfg.PORT, () => {
    console.log(`\n DECISION ENGINE — http://localhost:${cfg.PORT}`);
    console.log(` Crypto: ${cfg.CRYPTO.map(a => a.symbol).join(", ")} | Stocks: ${cfg.STOCKS.map(a => a.symbol).join(", ")}`);
    console.log(` Horizon: ${engine.currentHorizon()} | LLM analyst: ${analyst.enabled() ? cfg.LLM_MODEL : "off (set ANTHROPIC_API_KEY)"}\n`);
    startLoop(cfg.CRYPTO, cfg.CRYPTO_SCAN_MS);
    startLoop(cfg.STOCKS, cfg.STOCK_SCAN_MS);
  });

  // Stock marks between scans (for paper stops) + learning resolution + equity curve.
  setInterval(() => engine.resolveDue().catch(e => console.error("[learn]", e.message)), 60_000);
  setInterval(() => { try { db.recordEquity(portfolio.equity()); } catch { /* ignore */ } }, 60_000);
  setInterval(async () => {
    if (!data.marketOpen(new Date())) return;
    for (const a of cfg.STOCKS) {
      const q = await data.quote(a).catch(() => null);
      if (q?.price > 0) for (const trade of portfolio.onPrice(a.id, q.price)) broadcast({ type: "trade", trade: { ...trade, event: "close" } });
    }
  }, 30_000);

  // Warm start once per horizon (walk-forward backtests → calibrator + prior weights).
  const h = engine.currentHorizon();
  if (!db.getSetting(`warm_${h}`) && process.env.WARM_START !== "false") {
    setTimeout(() => engine.warmStart({ horizon: h }).then(r => console.log(`[warm] calibrator fitted on ${r.pairs} OOS pairs`))
      .catch(e => console.error("[warm]", e.message)), 20_000);
  }

  const shutdown = () => { db.persistToDisk(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) main().catch(e => { console.error("[boot] failed:", e); process.exit(1); });

module.exports = { app, scanAsset, adHocAsset };
