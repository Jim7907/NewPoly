/**
 * Database layer — sql.js (pure JS SQLite, no native deps)
 * Persists to /app/data/bot.db inside Docker
 * Falls back to in-memory if disk write fails
 */

const initSqlJs = require("sql.js");
const fs        = require("fs");
const path      = require("path");

const DB_DIR  = process.env.DB_PATH || path.join(__dirname, "../data");
const DB_FILE = path.join(DB_DIR, "bot.db");

let db   = null;
let SQL  = null;

// Save DB to disk every 30 seconds
function persistToDisk() {
  if (!db) return;
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const data = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch(e) {
    console.error("[db] Persist failed:", e.message);
  }
}

async function initDB() {
  SQL = await initSqlJs();

  // Try to load existing DB from disk
  try {
    if (fs.existsSync(DB_FILE)) {
      const fileBuffer = fs.readFileSync(DB_FILE);
      db = new SQL.Database(fileBuffer);
      console.log("[db] Loaded existing database from", DB_FILE);
    } else {
      db = new SQL.Database();
      console.log("[db] Created new database");
    }
  } catch(e) {
    console.error("[db] Load failed, starting fresh:", e.message);
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      city        TEXT,
      stationId   TEXT,
      outcome     TEXT,
      question    TEXT,
      modelProb   REAL,
      polyProb    REAL,
      netEdge     REAL,
      direction   TEXT,
      marketId    TEXT,
      strategy    TEXT DEFAULT 'weather',
      acted       INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      oppId       TEXT,
      mode        TEXT NOT NULL,
      direction   TEXT NOT NULL,
      marketId    TEXT,
      question    TEXT,
      price       REAL NOT NULL,
      size        REAL NOT NULL,
      outcome     TEXT,
      resolvedAt  TEXT,
      pnl         REAL,
      status      TEXT DEFAULT 'open',
      notes       TEXT,
      FOREIGN KEY(oppId) REFERENCES opportunities(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Default settings
  const defaults = {
    paper_balance:  "1000",
    paper_enabled:  "true",
    live_enabled:   "false",
    min_edge:       "1.5",
    max_position:   "50",
    scan_active:    "true",
  };

  for (const [k, v] of Object.entries(defaults)) {
    db.run("INSERT OR IGNORE INTO settings VALUES (?, ?)", [k, v]);
  }

  // Persist every 30s
  setInterval(persistToDisk, 30000);
  persistToDisk();

  console.log("[db] Ready");
  return db;
}

// ── Settings ─────────────────────────────────────────────────
function getSetting(key) {
  const rows = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
  return rows[0]?.values[0]?.[0] ?? null;
}

function setSetting(key, value) {
  db.run("INSERT OR REPLACE INTO settings VALUES (?, ?)", [key, String(value)]);
  persistToDisk();
}

function getAllSettings() {
  const rows = db.exec("SELECT key, value FROM settings");
  const obj  = {};
  (rows[0]?.values || []).forEach(([k, v]) => { obj[k] = v; });
  return obj;
}

// ── Opportunities ─────────────────────────────────────────────
function saveOpportunity(opp) {
  const id = `${opp.stationId || opp.type}_${opp.marketId || opp.question?.slice(0,20)}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "_");
  try {
    db.run(`
      INSERT OR IGNORE INTO opportunities
        (id, ts, city, stationId, outcome, question, modelProb, polyProb, netEdge, direction, marketId, strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      new Date().toISOString(),
      opp.city || "",
      opp.stationId || opp.type || "",
      opp.outcome || opp.strategy || "",
      (opp.question || "").slice(0, 200),
      opp.modelProb || opp.modelAligned || 0,
      opp.polyProb || 0,
      opp.netEdge || 0,
      opp.direction || "",
      opp.marketId || "",
      opp.strategy || "weather",
    ]);
    return id;
  } catch(e) {
    console.error("[db] saveOpportunity:", e.message);
    return null;
  }
}

function getRecentOpportunities(limit = 50) {
  try {
    const rows = db.exec(`
      SELECT * FROM opportunities ORDER BY ts DESC LIMIT ${limit}
    `);
    if (!rows[0]) return [];
    const cols = rows[0].columns;
    return rows[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
  } catch(e) { return []; }
}

// ── Trades ────────────────────────────────────────────────────
function placeTrade({ oppId, mode, direction, marketId, question, price, size }) {
  const id = `trade_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  db.run(`
    INSERT INTO trades (id, ts, oppId, mode, direction, marketId, question, price, size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `, [id, new Date().toISOString(), oppId || "", mode, direction, marketId || "", (question||"").slice(0,200), price, size]);

  // If paper trade, deduct from paper balance
  if (mode === "paper") {
    const current = parseFloat(getSetting("paper_balance") || "1000");
    setSetting("paper_balance", (current - size).toFixed(2));
  }

  persistToDisk();
  return id;
}

function resolveTrade(tradeId, resolvedYes) {
  // Get trade
  const rows = db.exec(`SELECT * FROM trades WHERE id = '${tradeId}'`);
  if (!rows[0]?.values[0]) return null;
  const cols  = rows[0].columns;
  const trade = {};
  cols.forEach((c, i) => { trade[c] = rows[0].values[0][i]; });

  // Calculate P&L
  // BUY YES: if resolves YES, get $1.00 per share. size = USDC spent. shares = size/price
  // BUY NO:  if resolves NO,  get $1.00 per share.
  const shares = trade.size / trade.price;
  const directionWon =
    (trade.direction === "BUY YES" && resolvedYes) ||
    (trade.direction === "BUY NO"  && !resolvedYes);
  const pnl = directionWon ? +(shares - trade.size).toFixed(2) : +(-trade.size).toFixed(2);
  const status  = directionWon ? "won" : "lost";
  const outcome = resolvedYes ? "YES" : "NO";

  db.run(`
    UPDATE trades
    SET pnl = ?, status = ?, outcome = ?, resolvedAt = ?
    WHERE id = ?
  `, [pnl, status, outcome, new Date().toISOString(), tradeId]);

  // Update paper balance with winnings
  if (trade.mode === "paper" && directionWon) {
    const current = parseFloat(getSetting("paper_balance") || "0");
    setSetting("paper_balance", (current + trade.size + pnl).toFixed(2));
  }

  persistToDisk();
  return { tradeId, pnl, status, outcome, shares: +shares.toFixed(4) };
}

function getRecentTrades(limit = 100) {
  try {
    const rows = db.exec(`
      SELECT * FROM trades ORDER BY ts DESC LIMIT ${limit}
    `);
    if (!rows[0]) return [];
    const cols = rows[0].columns;
    return rows[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
  } catch(e) { return []; }
}

function getStats() {
  try {
    const trades = getRecentTrades(10000);
    const closed = trades.filter(t => t.status !== "open");
    const won    = closed.filter(t => t.status === "won");
    const totalPnl  = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const paperBal  = parseFloat(getSetting("paper_balance") || "1000");
    const winRate   = closed.length > 0 ? (won.length / closed.length * 100) : 0;
    return {
      paperBalance: +paperBal.toFixed(2),
      totalTrades:  trades.length,
      openTrades:   trades.filter(t => t.status === "open").length,
      closedTrades: closed.length,
      wonTrades:    won.length,
      lostTrades:   closed.length - won.length,
      winRate:      +winRate.toFixed(1),
      totalPnl:     +totalPnl.toFixed(2),
      roi:          closed.length > 0 ? +((totalPnl / (1000 - paperBal + totalPnl + paperBal - 1000 || 1)) * 100).toFixed(1) : 0,
    };
  } catch(e) {
    return { paperBalance: 1000, totalTrades: 0, winRate: 0, totalPnl: 0 };
  }
}

function getOpenTrades() {
  return getRecentTrades(1000).filter(t => t.status === "open");
}

module.exports = {
  initDB,
  getSetting, setSetting, getAllSettings,
  saveOpportunity, getRecentOpportunities,
  placeTrade, resolveTrade, getRecentTrades, getOpenTrades,
  getStats,
  persistToDisk,
};
