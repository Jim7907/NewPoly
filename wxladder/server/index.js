// Express API + scan loop + WebSocket push for the temperature-ladder bot.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const cfg = require("./config");
const db = require("./db");
const wx = require("./wx");
const poly = require("./poly");
const bias = require("./bias");
const ladderMod = require("./ladder");
const engine = require("./engine");
const calib = require("./calib");
const backtest = require("./backtest");

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: "*" }));
app.use(express.json());

const safe = (fn, d) => { try { return fn(); } catch { return d; } };

let liveCache = { ladders: [], ts: null, scanning: false, lastError: null };
let scanning = false;
let seeded = false;

// ── Scan ────────────────────────────────────────────────────────
async function scanOnce() {
  if (scanning) return liveCache;
  scanning = true;
  const params = db.effectiveParams();
  try {
    await engine.resolveDue(Date.now(), params);
    await engine.backfillObs(Date.now(), params.OBS_BACKFILL_PER_SCAN);

    const all = await poly.getLadders(Date.now());
    const tradable = poly.selectTradable(all, {
      nowMs: Date.now(), minLead: params.MIN_LEAD_DAYS, maxLead: params.MAX_LEAD_DAYS, kinds: params.KINDS,
    });

    // Forecast once per station+kind that actually has a live market.
    const need = [...new Set(tradable.filter(l => !l.unsupported).map(l => `${l.city}|${l.kind}`))];
    const forecasts = {};
    for (const key of need) {
      const [city, kind] = key.split("|");
      const station = cfg.UNIVERSE[city];
      try { forecasts[key] = await wx.getForecast(station, kind); }
      catch (e) { console.error(`[scan] wx ${city}/${kind}: ${e.message}`); }
    }

    const bankroll = parseFloat(db.getSetting("paper_balance") || "0");
    const openExposure = db.openExposure();

    // Pass 1 — build on Gamma top-of-book to find which markets are worth a real book pull.
    const plans = [];
    for (const lad of tradable) {
      const fcAll = forecasts[`${lad.city}|${lad.kind}`];
      const forecast = fcAll && fcAll.dates ? fcAll.dates[lad.date] : null;
      if (forecast) {
        db.logForecast({
          station: lad.station.icao, kind: lad.kind, marketDate: lad.date, leadDays: lad.leadDays,
          rawCenter: forecast.rawCenter, ensSd: forecast.ensSd, ensMean: forecast.ensMean,
          detMean: forecast.detMean, nMembers: forecast.nMembers,
        });
      }
      const biasFit = bias.fitBias(db.biasPairs(lad.station.icao, lad.kind, lad.leadDays), {
        asOf: lad.date, windowDays: params.BIAS_WINDOW_DAYS,
        halfLifeDays: params.BIAS_HALFLIFE_DAYS, clampTo: params.BIAS_CLAMP,
      });
      const spreadHist = bias.spreadHistory(db.spreadRows(lad.station.icao, lad.kind, lad.leadDays), { asOf: lad.date });
      plans.push({ lad, forecast, biasFit, spreadHist,
        plan: ladderMod.buildLadder({ lad, forecast, biasFit, spreadHist, books: {}, bankroll, openExposure }, params) });
    }

    // Pass 2 — only markets that look live get a real order-book pull, then re-decide on it.
    const worth = plans.filter(p =>
      p.plan.signal !== "—" ||
      (p.plan.basketEv != null && p.plan.basketEv >= params.MIN_BASKET_EV * 0.5 &&
       !p.plan.reasons.includes("bias-uncalibrated") && !p.plan.reasons.includes("station-unsupported")));
    if (worth.length) {
      const tokens = worth.flatMap(p => p.lad.buckets.map(b => b.yesToken));
      const books = await poly.getBooks(tokens);
      for (const p of worth) {
        p.plan = ladderMod.buildLadder(
          { lad: p.lad, forecast: p.forecast, biasFit: p.biasFit, spreadHist: p.spreadHist, books, bankroll, openExposure },
          params);
        p.plan.bookChecked = true;
      }
    }

    for (const p of plans) {
      const id = engine.tryEnter(p.plan, params);
      if (id) { p.plan.placed = id; console.log(`[trade] ${p.plan.city}/${p.plan.kind} ${p.plan.date} -> ${id} $${p.plan.outlay}`); }
    }

    const ladders = plans.map(p => p.plan);
    ladders.sort((a, b) => {
      const rank = (x) => (x.signal !== "—" ? 0 : x.basketEv != null ? 1 : 2);
      return rank(a) - rank(b) || (b.basketEv ?? -9) - (a.basketEv ?? -9) || a.city.localeCompare(b.city);
    });
    liveCache = { ladders, ts: new Date().toISOString(), scanning: false, lastError: null };
    broadcast({ type: "live", ladders, stats: safe(() => db.getStats(), null), ts: liveCache.ts });
  } catch (e) {
    console.error("[scan]", e.message);
    liveCache = { ...liveCache, lastError: e.message, ts: new Date().toISOString() };
  } finally {
    scanning = false;
  }
  return liveCache;
}

// ── WebSocket push ──
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "live", ladders: liveCache.ladders, stats: safe(() => db.getStats(), null), ts: liveCache.ts }));
});
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// ── Routes ──
app.get("/api/health", (req, res) => res.json({
  status: "ok", uptime: process.uptime(), stations: cfg.STATIONS.length, kinds: cfg.KINDS,
  wsClients: clients.size, seeded, lastScan: liveCache.ts, lastError: liveCache.lastError,
  ts: new Date().toISOString(),
}));

app.get("/api/live", (req, res) => res.json({
  ...liveCache, stats: safe(() => db.getStats(), null), settings: db.getAllSettings(),
}));

app.get("/api/ladder/:eventId", (req, res) => {
  const l = liveCache.ladders.find(x => x.eventId === req.params.eventId);
  return l ? res.json(l) : res.status(404).json({ error: "not found in current scan" });
});

app.get("/api/baskets", (req, res) => res.json({ baskets: db.getRecentBaskets(parseInt(req.query.limit) || 200) }));
app.get("/api/stats", (req, res) => res.json(db.getStats()));

// Station table with each station's current bias fit — the "am I calibrated here?" view.
app.get("/api/stations", (req, res) => {
  const kinds = cfg.KINDS;
  const rows = [];
  for (const s of Object.values(cfg.UNIVERSE)) {
    for (const kind of kinds) {
      const pairs = db.biasPairs(s.icao, kind, cfg.MIN_LEAD_DAYS);
      const fit = bias.fitBias(pairs, { asOf: new Date().toISOString().slice(0, 10), windowDays: cfg.BIAS_WINDOW_DAYS, clampTo: cfg.BIAS_CLAMP });
      const spread = bias.spreadHistory(db.spreadRows(s.icao, kind, cfg.MIN_LEAD_DAYS));
      rows.push({
        city: s.city, station: s.icao, name: s.name, lat: s.lat, lon: s.lon, tz: s.tz,
        resolver: s.resolver, unsupported: !!s.unsupported, kind,
        biasSamples: fit.n, bias: fit.bias, rmse: fit.rmse, rmseUncorrected: fit.rmseUncorrected,
        calibrated: fit.n >= cfg.MIN_BIAS_SAMPLES,
        spreadSamples: spread.length,
        dispersionReady: spread.length >= cfg.MIN_DISP_SAMPLES,
      });
    }
  }
  res.json({ stations: rows, minBiasSamples: cfg.MIN_BIAS_SAMPLES, minDispSamples: cfg.MIN_DISP_SAMPLES });
});

app.get("/api/calibration", (req, res) => {
  const baskets = db.getRecentBaskets(5000);
  res.json({
    legs: calib.legCalibration(baskets),
    cover: calib.coverCalibration(baskets),
    center: calib.centerError(baskets),
    byStation: calib.groupBy(baskets, b => b.station),
    byRegime: calib.groupBy(baskets, b => b.regime || "unknown"),
    byLead: calib.groupBy(baskets, b => `D+${b.leadDays}`),
    ts: new Date().toISOString(),
  });
});

app.get("/api/backtest", (req, res) => res.json(db.getLatestBacktest() || { note: "No backtest run yet. POST /api/backtest to run." }));
app.post("/api/backtest", async (req, res) => {
  try {
    const result = await backtest.run({
      days: req.body?.days, cities: req.body?.cities, kinds: req.body?.kinds,
    });
    db.saveBacktest({ days: result.days, cities: result.cities }, result);
    // Only write back what the offline data can actually fit. W_MODEL and MIN_BASKET_EV
    // depend on historical CLOB prices, which are not freely replayable, so those stay
    // where they are and the CALIBRATION tab judges them forward instead.
    if (req.body?.apply !== false && result.best) {
      db.setSetting("sigma_mult", result.best.SIGMA_MULT);
      db.setSetting("bias_halflife_days", result.best.BIAS_HALFLIFE_DAYS);
      db.setSetting("bias_window_days", result.best.BIAS_WINDOW_DAYS);
      if (result.recommended && result.recommended.minCoverProb != null) {
        db.setSetting("min_cover_prob", result.recommended.minCoverProb);
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Seed the bias history from the archives (safe to re-run; skips calibrated stations).
app.post("/api/seed", async (req, res) => {
  try {
    const results = await engine.seedBias({ days: req.body?.days || cfg.SEED_DAYS });
    seeded = true;
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual paper entry from the current scan's plan.
app.post("/api/paper-trade", (req, res) => {
  try {
    const plan = liveCache.ladders.find(l => l.eventId === String(req.body?.eventId));
    if (!plan) return res.status(400).json({ error: "No live plan for that event" });
    if (!(plan.outlay > 0)) return res.status(400).json({ error: "Plan has no funded rungs" });
    if (db.hasOpenBasket(plan.eventId)) return res.status(400).json({ error: "Already holding a ladder on this market" });
    const id = db.placeBasket(plan, db.getSetting("sizing") || cfg.SIZING);
    if (!id) return res.status(400).json({ error: "Nothing to place" });
    res.json({ success: true, basketId: id, stats: db.getStats() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/settings", (req, res) => {
  const allowed = ["paper_enabled", "scan_active", "sizing", "w_model", "min_basket_ev",
                   "min_cover_prob", "max_basket_cost", "spread_gamma", "underdisp_lo",
                   "overdisp_hi", "skip_when_wide", "sigma_mult", "bias_halflife_days",
                   "bias_window_days"];
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.includes(k)) db.setSetting(k, v);
  res.json({ success: true, settings: db.getAllSettings() });
});

app.post("/api/reset-paper", (req, res) => {
  const amount = parseFloat(req.body?.amount) || cfg.PAPER_BALANCE;
  db.setSetting("paper_balance", amount.toFixed(2));
  res.json({ success: true, newBalance: amount });
});

app.post("/api/scan", async (req, res) => { const r = await scanOnce(); res.json({ success: true, ladders: r.ladders.length, ts: r.ts }); });

// Serve the built frontend in production.
if (process.env.NODE_ENV === "production") {
  const dist = path.join(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ── Bootstrap ──
if (require.main === module) {
  db.initDB().then(async () => {
    server.listen(cfg.PORT, () => {
      console.log(`\n Temperature Ladder Bot — http://localhost:${cfg.PORT}`);
      console.log(` ${cfg.STATIONS.length} resolution stations · kinds ${cfg.KINDS.join("/")} · D+${cfg.MIN_LEAD_DAYS}..D+${cfg.MAX_LEAD_DAYS} · paper only\n`);
    });
    if (cfg.SEED_ON_BOOT) {
      console.log("[boot] seeding bias history from archives (first run takes a few minutes)…");
      try { await engine.seedBias({}); seeded = true; console.log("[boot] bias seeding done"); }
      catch (e) { console.error("[boot] seeding failed:", e.message); }
    }
    await scanOnce();
    setInterval(scanOnce, cfg.SCAN_MS);
  }).catch(e => { console.error("[boot] failed:", e.message); process.exit(1); });
}

module.exports = { app, scanOnce, server };
