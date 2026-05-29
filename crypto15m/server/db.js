// Persistence — sql.js (pure-JS SQLite, no native deps). Adapted from the weather app's
// server/db.js but with a fee-aware, oracle-resolved schema for 15m crypto trades.
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const DB_DIR = cfg.DB_PATH ? path.resolve(cfg.DB_PATH) : path.join(__dirname, "../data");
const DB_FILE = path.join(DB_DIR, "crypto15m.db");

let db = null, persistTimer = null;

function persistToDisk() {
  if (!db) return;
  try { fs.mkdirSync(DB_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, Buffer.from(db.export())); }
  catch (e) { console.error("[db] persist failed:", e.message); }
}

async function initDB() {
  const SQL = await initSqlJs();
  try {
    db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  } catch (e) { console.error("[db] load failed, fresh:", e.message); db = new SQL.Database(); }

  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY, ts TEXT, asset TEXT, marketId TEXT, upToken TEXT, side TEXT,
    entryPrice REAL, feeFrac REAL, fee REAL, size REAL, pUsed REAL, z REAL, leadBps REAL,
    windowEnd TEXT, sOpen REAL, refSource TEXT, mode TEXT, status TEXT DEFAULT 'open',
    resolvedAt TEXT, sClose REAL, resolvedUp INTEGER, pnl REAL )`);
  db.run(`CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY, ts TEXT, asset TEXT, marketId TEXT, secsLeft INTEGER, z REAL,
    pModel REAL, pUsed REAL, pMarketUp REAL, side TEXT, pSide REAL, rawEdge REAL, netEdge REAL,
    mode TEXT, signal TEXT, resolvedUp INTEGER )`);
  db.run(`CREATE TABLE IF NOT EXISTS backtests (id TEXT PRIMARY KEY, ts TEXT, params TEXT, result TEXT)`);

  const defaults = {
    paper_balance: String(cfg.PAPER_BALANCE),
    paper_enabled: "true",
    scan_active: "true",
    min_edge: String(cfg.MIN_EDGE),
    min_p: String(cfg.MIN_P),
    min_z: String(cfg.MIN_Z),
    late_window_s: String(cfg.LATE_WINDOW_S),
    drift_enabled: String(cfg.DRIFT_ENABLED),
  };
  for (const [k, v] of Object.entries(defaults)) db.run("INSERT OR IGNORE INTO settings VALUES (?,?)", [k, v]);

  persistTimer = setInterval(persistToDisk, 30000);
  persistToDisk();
  return db;
}

const rowsToObjs = (res) => {
  if (!res[0]) return [];
  const cols = res[0].columns;
  return res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
};

// ── Settings ──
function getSetting(k) { const r = db.exec("SELECT value FROM settings WHERE key=?", [k]); return r[0]?.values[0]?.[0] ?? null; }
function setSetting(k, v) { db.run("INSERT OR REPLACE INTO settings VALUES (?,?)", [k, String(v)]); persistToDisk(); }
function getAllSettings() { return Object.fromEntries((rowsToObjs(db.exec("SELECT key,value FROM settings"))).map(r => [r.key, r.value])); }

// ── Trades ──
function placeTrade(t) {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const fee = +(t.feeFrac * t.size).toFixed(4);
  db.run(`INSERT INTO trades (id,ts,asset,marketId,upToken,side,entryPrice,feeFrac,fee,size,pUsed,z,leadBps,windowEnd,sOpen,refSource,mode,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open')`,
    [id, new Date().toISOString(), t.asset, t.marketId, t.upToken, t.side, t.entryPrice, t.feeFrac, fee, t.size,
     t.pUsed, t.z, t.leadBps, t.windowEnd, t.sOpen, t.refSource, t.mode]);
  // Debit stake + fee from paper balance immediately.
  const bal = parseFloat(getSetting("paper_balance") || "0");
  setSetting("paper_balance", (bal - t.size - fee).toFixed(4));
  persistToDisk();
  return id;
}

function getOpenTrades() { return rowsToObjs(db.exec("SELECT * FROM trades WHERE status='open'")); }
function getRecentTrades(limit = 200) { return rowsToObjs(db.exec(`SELECT * FROM trades ORDER BY ts DESC LIMIT ${+limit}`)); }
function hasOpenTrade(marketId) { return (db.exec("SELECT 1 FROM trades WHERE marketId=? AND status='open' LIMIT 1", [marketId])[0]?.values.length || 0) > 0; }
function openExposure() { return getOpenTrades().reduce((s, t) => s + (t.size || 0), 0); }

// Settle a trade. resolvedUp: boolean | null(void). Returns settlement detail.
function settleTrade(tradeId, resolvedUp, sClose) {
  const r = db.exec("SELECT * FROM trades WHERE id=?", [tradeId]);
  const t = rowsToObjs(r)[0];
  if (!t) return null;
  if (resolvedUp == null) {                       // void -> refund stake + fee
    db.run("UPDATE trades SET status='void', resolvedAt=?, sClose=? WHERE id=?", [new Date().toISOString(), sClose ?? null, tradeId]);
    setSetting("paper_balance", (parseFloat(getSetting("paper_balance")) + t.size + (t.fee || 0)).toFixed(4));
    persistToDisk();
    return { tradeId, status: "void" };
  }
  const shares = t.size / t.entryPrice;
  const won = (t.side === "UP" && resolvedUp) || (t.side === "DOWN" && !resolvedUp);
  // Stake+fee already debited. Win pays out `shares`; pnl is net of stake+fee.
  const pnl = won ? +(shares - t.size - (t.fee || 0)).toFixed(4) : +(-t.size - (t.fee || 0)).toFixed(4);
  db.run("UPDATE trades SET status=?, resolvedAt=?, sClose=?, resolvedUp=?, pnl=? WHERE id=?",
    [won ? "won" : "lost", new Date().toISOString(), sClose ?? null, resolvedUp ? 1 : 0, pnl, tradeId]);
  db.run("UPDATE signals SET resolvedUp=? WHERE marketId=?", [resolvedUp ? 1 : 0, t.marketId]);
  if (won) setSetting("paper_balance", (parseFloat(getSetting("paper_balance")) + shares).toFixed(4));
  persistToDisk();
  return { tradeId, status: won ? "won" : "lost", pnl, resolvedUp, shares: +shares.toFixed(4) };
}

function getStats() {
  const trades = getRecentTrades(10000);
  const closed = trades.filter(t => t.status === "won" || t.status === "lost");
  const won = closed.filter(t => t.status === "won");
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const bal = parseFloat(getSetting("paper_balance") || "0");
  return {
    paperBalance: +bal.toFixed(2),
    totalTrades: trades.length,
    openTrades: trades.filter(t => t.status === "open").length,
    closedTrades: closed.length,
    wonTrades: won.length,
    lostTrades: closed.length - won.length,
    voidTrades: trades.filter(t => t.status === "void").length,
    winRate: closed.length ? +(won.length / closed.length * 100).toFixed(1) : 0,
    totalPnl: +totalPnl.toFixed(2),
    avgEv: closed.length ? +(totalPnl / closed.reduce((s, t) => s + t.size, 0) * 100).toFixed(2) : 0,
  };
}

// ── Signals log (for calibration) ──
function logSignal(s) {
  const id = `s_${Date.now()}_${s.asset}`;
  db.run(`INSERT OR REPLACE INTO signals (id,ts,asset,marketId,secsLeft,z,pModel,pUsed,pMarketUp,side,pSide,rawEdge,netEdge,mode,signal)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, new Date().toISOString(), s.asset, s.marketId, s.secsLeft ?? null, s.z ?? null, s.pModel ?? null,
     s.pUsed ?? null, s.pMarketUp ?? null, s.side ?? null, s.pSide ?? null, s.rawEdge ?? null, s.netEdge ?? null, s.mode ?? null, s.signal ?? null]);
}
function getResolvedSignals(limit = 5000) {
  return rowsToObjs(db.exec(`SELECT * FROM signals WHERE resolvedUp IS NOT NULL ORDER BY ts DESC LIMIT ${+limit}`));
}

// ── Backtests ──
function saveBacktest(params, result) {
  const id = `bt_${Date.now()}`;
  db.run("INSERT INTO backtests VALUES (?,?,?,?)", [id, new Date().toISOString(), JSON.stringify(params), JSON.stringify(result)]);
  persistToDisk();
  return id;
}
function getLatestBacktest() {
  const r = rowsToObjs(db.exec("SELECT * FROM backtests ORDER BY ts DESC LIMIT 1"))[0];
  if (!r) return null;
  return { id: r.id, ts: r.ts, params: JSON.parse(r.params), result: JSON.parse(r.result) };
}

function close() { if (persistTimer) clearInterval(persistTimer); persistToDisk(); }

module.exports = {
  initDB, getSetting, setSetting, getAllSettings,
  placeTrade, getOpenTrades, getRecentTrades, hasOpenTrade, openExposure, settleTrade, getStats,
  logSignal, getResolvedSignals, saveBacktest, getLatestBacktest, persistToDisk, close,
  _rowsToObjs: rowsToObjs,
};
