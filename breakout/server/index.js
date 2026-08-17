// Express API for the breakout backtester. Stateless: every response is derived from the
// (symbol, timeframe, params) triple in the request, so any chart the UI draws is reproducible.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const cfg = require("./config");
const candles = require("./candles");
const strategy = require("./strategy");
const backtest = require("./backtest");
const optimize = require("./optimize");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

const bad = (res, msg) => res.status(400).json({ error: msg });

// Only accept known symbols/timeframes — these flow into an outbound URL.
function resolveTarget(q) {
  const symbol = String(q.symbol || cfg.SYMBOLS[0].id).toUpperCase();
  const tf = String(q.tf || "15m");
  if (!cfg.SYMBOLS.some(s => s.id === symbol)) return { error: `unknown symbol: ${symbol}` };
  if (!cfg.TIMEFRAMES.some(t => t.id === tf)) return { error: `unknown timeframe: ${tf}` };
  return { symbol, tf, limit: Math.min(Number(q.limit) || 1500, cfg.MAX_BARS) };
}

app.get("/api/health", (req, res) => res.json({
  status: "ok", uptime: process.uptime(),
  symbols: cfg.SYMBOLS.map(s => s.id), timeframes: cfg.TIMEFRAMES.map(t => t.id),
  ts: new Date().toISOString(),
}));

app.get("/api/config", (req, res) => res.json({
  symbols: cfg.SYMBOLS, timeframes: cfg.TIMEFRAMES,
  defaults: cfg.DEFAULT_PARAMS, presets: cfg.PRESETS,
}));

app.get("/api/candles", async (req, res) => {
  const t = resolveTarget(req.query);
  if (t.error) return bad(res, t.error);
  try {
    const data = await candles.getBars(t.symbol, t.tf, t.limit, { source: req.query.source, refresh: req.query.refresh === "true" });
    res.json({ symbol: t.symbol, tf: t.tf, ...data });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// The main call behind the chart: bars + every signal + simulated trades + panel stats.
app.post("/api/backtest", async (req, res) => {
  const t = resolveTarget(req.body || {});
  if (t.error) return bad(res, t.error);
  try {
    const data = await candles.getBars(t.symbol, t.tf, t.limit, { source: req.body.source, refresh: req.body.refresh });
    if (data.bars.length < 60) return bad(res, `not enough bars (${data.bars.length})`);
    const result = backtest.run(data.bars, req.body.params || {});
    res.json({
      symbol: t.symbol, tf: t.tf, source: data.source, cached: !!data.cached,
      dataError: data.error || null,
      ...result,
      bars: data.bars,                            // after the spread: `result` carries barCount, not bars
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Signals only — cheap enough to call while dragging a parameter slider.
app.post("/api/signals", async (req, res) => {
  const t = resolveTarget(req.body || {});
  if (t.error) return bad(res, t.error);
  try {
    const data = await candles.getBars(t.symbol, t.tf, t.limit, { source: req.body.source });
    const params = strategy.withDefaults(req.body.params || {});
    const series = strategy.buildSeries(data.bars, params);
    res.json({ symbol: t.symbol, tf: t.tf, source: data.source, signals: strategy.detectSignals(data.bars, params, series) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/optimize", async (req, res) => {
  const t = resolveTarget(req.body || {});
  if (t.error) return bad(res, t.error);
  try {
    const data = await candles.getBars(t.symbol, t.tf, t.limit, { source: req.body.source });
    if (data.bars.length < 300) return bad(res, `need >=300 bars to optimize (got ${data.bars.length})`);
    const result = optimize.run(data.bars, req.body.params || {}, {
      objective: req.body.objective, minTrades: req.body.minTrades,
      splitPct: req.body.splitPct, grid: req.body.grid,
    });
    res.json({ symbol: t.symbol, tf: t.tf, source: data.source, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Same params, every symbol — the "which market does this edge live in" view.
app.post("/api/scan", async (req, res) => {
  const tf = String(req.body?.tf || "15m");
  if (!cfg.TIMEFRAMES.some(x => x.id === tf)) return bad(res, `unknown timeframe: ${tf}`);
  const limit = Math.min(Number(req.body?.limit) || 1000, cfg.MAX_BARS);
  const rows = [];
  for (const s of cfg.SYMBOLS) {
    try {
      const data = await candles.getBars(s.id, tf, limit, { source: req.body?.source });
      const r = backtest.run(data.bars, req.body?.params || {});
      const last = r.signals.filter(x => x.accepted).slice(-1)[0] || null;
      rows.push({
        symbol: s.id, source: data.source, stats: r.stats,
        lastSignal: last && { t: last.t, side: last.side, level: last.level, barsAgo: data.bars.length - 1 - last.i },
      });
    } catch (e) { rows.push({ symbol: s.id, error: e.message }); }
  }
  res.json({ tf, rows, ts: new Date().toISOString() });
});

// Serve the built UI whenever a build exists, regardless of NODE_ENV, so `npm run build` plus
// `npm run server` is a single-port setup. Without a build, `/` explains where the UI actually
// is instead of returning a bare 404 — in dev the UI is served by Vite on another port.
const dist = path.join(__dirname, "../dist");
const hasBuild = fs.existsSync(path.join(dist, "index.html"));
if (hasBuild) {
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  app.get("/", (req, res) => res.status(200).type("html").send(
    `<body style="background:#06070d;color:#cbd5e1;font-family:ui-monospace,monospace;padding:40px;line-height:1.7">
     <h2 style="color:#38bdf8">Breakout Lab — API only on this port</h2>
     <p>This port (${cfg.PORT}) serves the API. No frontend build was found, so there is no UI here.</p>
     <p><b>In dev</b> the UI runs on Vite: open <a style="color:#22c55e" href="http://localhost:3004">http://localhost:3004</a></p>
     <p><b>For one port</b>, build first: <code style="color:#f59e0b">npm run build && npm start</code> — then the UI is served right here.</p>
     <p>API is up: <a style="color:#38bdf8" href="/api/health">/api/health</a></p></body>`));
}

if (require.main === module) {
  app.listen(cfg.PORT, () => {
    console.log(`\n  Breakout Backtester — ${cfg.SYMBOLS.length} symbols · ${cfg.TIMEFRAMES.map(t => t.id).join(", ")}`);
    if (hasBuild) {
      console.log(`  UI + API:  http://localhost:${cfg.PORT}\n`);
    } else {
      console.log(`  API:       http://localhost:${cfg.PORT}   (no build found — API only)`);
      console.log(`  UI (dev):  http://localhost:3004          <-- open this one`);
      console.log(`  One port instead:  npm run local\n`);
    }
  });
}

module.exports = app;
