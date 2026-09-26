// Persistence — sql.js (pure-JS SQLite, no native deps), same approach as crypto15m/server/db.js.
// Stores: settings, decision snapshots (+ their resolved outcomes, which drive online learning),
// the paper portfolio (positions + closed trades + equity curve), learned model state
// (calibrator / signal weights as JSON) and backtest results.
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cfg = require("./config");

const DB_DIR = cfg.DB_PATH ? path.resolve(cfg.DB_PATH) : path.join(__dirname, "../data");
const DB_FILE = path.join(DB_DIR, "decision-engine.db");

let db = null, persistTimer = null, dirty = false;
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function persistToDisk() {
  if (!db || !dirty) return;
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, DB_FILE);   // atomic replace — never leaves a half-written DB
    dirty = false;
  } catch (e) { console.error("[db] persist failed:", e.message); }
}

async function initDB({ memory = false } = {}) {
  const SQL = await initSqlJs();
  try {
    db = !memory && fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  } catch (e) { console.error("[db] load failed, starting fresh:", e.message); db = new SQL.Database(); }

  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY, ts TEXT, assetId TEXT, symbol TEXT, assetClass TEXT, horizon TEXT,
    action TEXT, pUp REAL, pRaw REAL, confidence REAL, agreement REAL, price REAL,
    regime TEXT, families TEXT, votes TEXT, resolveAt INTEGER,
    resolved INTEGER DEFAULT 0, priceAtResolve REAL, fwdReturn REAL, y INTEGER )`);
  // v2.1: directional forecast columns (added to existing DBs in place)
  for (const col of ["fdir INTEGER", "falign REAL", "fstrength TEXT"]) { try { db.run(`ALTER TABLE decisions ADD COLUMN ${col}`); } catch { /* exists */ } }
  db.run(`CREATE INDEX IF NOT EXISTS ix_dec_asset ON decisions(assetId, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_dec_resolve ON decisions(resolved, resolveAt)`);
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY, openedAt TEXT, assetId TEXT, symbol TEXT, assetClass TEXT,
    direction TEXT, qty REAL, entry REAL, stop REAL, target REAL, expiresAt INTEGER,
    costUsd REAL, decisionId TEXT, pUp REAL, confidence REAL, status TEXT DEFAULT 'open',
    closedAt TEXT, exit REAL, exitReason TEXT, pnl REAL, pnlPct REAL, fees REAL )`);
  db.run(`CREATE TABLE IF NOT EXISTS equity (ts TEXT, equity REAL)`);
  db.run(`CREATE TABLE IF NOT EXISTS model_state (key TEXT PRIMARY KEY, ts TEXT, json TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS backtests (id TEXT PRIMARY KEY, ts TEXT, assetId TEXT, horizon TEXT, result TEXT)`);

  const defaults = {
    cash: String(cfg.PAPER_BALANCE),
    start_equity: String(cfg.PAPER_BALANCE),
    peak_equity: String(cfg.PAPER_BALANCE),
    horizon: cfg.HORIZON,
    min_confidence: String(cfg.MIN_CONFIDENCE),
    min_prob_edge: String(cfg.MIN_PROB_EDGE),
    min_agreement: String(cfg.MIN_AGREEMENT),
    auto_trade: "true",
    scan_active: "true",
    llm_enabled: String(cfg.LLM_ENABLED),
  };
  for (const [k, v] of Object.entries(defaults)) db.run("INSERT OR IGNORE INTO settings VALUES (?,?)", [k, v]);
  dirty = true;

  if (!memory) {
    persistTimer = setInterval(persistToDisk, 30000);
    persistTimer.unref?.();
    persistToDisk();
  }
  return db;
}

const rows = (sql, params = []) => {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
};
const run = (sql, params = []) => { db.run(sql, params); dirty = true; };
const J = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ── Settings ──
const getSetting = (k) => rows("SELECT value FROM settings WHERE key=?", [k])[0]?.value ?? null;
const setSetting = (k, v) => run("INSERT OR REPLACE INTO settings VALUES (?,?)", [k, String(v)]);
const getAllSettings = () => Object.fromEntries(rows("SELECT key,value FROM settings").map(r => [r.key, r.value]));
const num = (k, d) => { const v = parseFloat(getSetting(k)); return Number.isFinite(v) ? v : d; };

// ── Decisions (learning samples) ──
// `votes` keeps only what the learner needs: [{id, family, score, confidence}].
function logDecision(d, resolveAt) {
  const id = uid();
  const votes = (d.signals || []).map(s => ({ id: s.id, family: s.family, score: +(+s.score).toFixed(4), confidence: +(+s.confidence).toFixed(4) }));
  const f = d.forecast || null;
  run(`INSERT INTO decisions (id,ts,assetId,symbol,assetClass,horizon,action,pUp,pRaw,confidence,agreement,price,regime,families,votes,resolveAt,fdir,falign,fstrength)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    // audit: the pRaw column feeds the calibrator, so store the backtest-equivalent pRawCal when present
    [id, d.ts || nowIso(), d.assetId, d.symbol, d.assetClass, d.horizon, d.action, d.pUp, d.pRawCal ?? d.pRaw, d.confidence,
     d.agreement ?? null, d.price, d.regime?.label || null, JSON.stringify(d.families || {}), JSON.stringify(votes), resolveAt,
     f ? (f.direction === "UP" ? 1 : -1) : null, f ? f.alignment : null, f ? f.strength : null]);
  return id;
}

const dueDecisions = (nowMs) => rows("SELECT * FROM decisions WHERE resolved=0 AND resolveAt<=? ORDER BY resolveAt LIMIT 500", [nowMs])
  .map(r => ({ ...r, votes: J(r.votes, []), families: J(r.families, {}) }));

function resolveDecision(id, priceAtResolve, fwdReturn, y) {
  run("UPDATE decisions SET resolved=1, priceAtResolve=?, fwdReturn=?, y=? WHERE id=?", [priceAtResolve, fwdReturn, y, id]);
}

const resolvedDecisions = (limit = 5000) => rows("SELECT * FROM decisions WHERE resolved=1 AND y IS NOT NULL ORDER BY ts DESC LIMIT ?", [limit])
  .map(r => ({ ...r, families: J(r.families, {}) }));

const decisionHistory = (assetId, limit = 300) =>
  rows("SELECT ts,action,pUp,confidence,price FROM decisions WHERE assetId=? ORDER BY ts DESC LIMIT ?", [assetId, limit]).reverse();

const lastDecisionTs = (assetId, horizon) =>
  rows("SELECT ts, action FROM decisions WHERE assetId=? AND horizon=? ORDER BY ts DESC LIMIT 1", [assetId, horizon])[0] || null;

// ── Paper portfolio ──
const openPositions = () => rows("SELECT * FROM positions WHERE status='open' ORDER BY openedAt");
const openPosition = (assetId) => rows("SELECT * FROM positions WHERE status='open' AND assetId=? LIMIT 1", [assetId])[0] || null;
const closedTrades = (limit = 500) => rows("SELECT * FROM positions WHERE status='closed' ORDER BY closedAt DESC LIMIT ?", [limit]);

function insertPosition(p) {
  const id = uid();
  run(`INSERT INTO positions (id,openedAt,assetId,symbol,assetClass,direction,qty,entry,stop,target,expiresAt,costUsd,decisionId,pUp,confidence,fees)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, nowIso(), p.assetId, p.symbol, p.assetClass, p.direction, p.qty, p.entry, p.stop, p.target, p.expiresAt,
     p.costUsd, p.decisionId || null, p.pUp, p.confidence, p.fees || 0]);
  return id;
}

function closePosition(id, { exit, exitReason, pnl, pnlPct, fees }) {
  run(`UPDATE positions SET status='closed', closedAt=?, exit=?, exitReason=?, pnl=?, pnlPct=?, fees=COALESCE(fees,0)+? WHERE id=?`,
    [nowIso(), exit, exitReason, pnl, pnlPct, fees || 0, id]);
}

function updateStop(id, stop) { run("UPDATE positions SET stop=? WHERE id=?", [stop, id]); }

function recordEquity(equity) {
  const last = rows("SELECT ts FROM equity ORDER BY ts DESC LIMIT 1")[0];
  if (last && Date.now() - new Date(last.ts).getTime() < 60_000) return; // ≤ 1 point / minute
  run("INSERT INTO equity VALUES (?,?)", [nowIso(), equity]);
}
const equityCurve = (limit = 2000) => rows("SELECT ts, equity FROM equity ORDER BY ts DESC LIMIT ?", [limit]).reverse();

// ── Model state ──
const saveModel = (key, obj) => run("INSERT OR REPLACE INTO model_state VALUES (?,?,?)", [key, nowIso(), JSON.stringify(obj)]);
const loadModel = (key) => J(rows("SELECT json FROM model_state WHERE key=?", [key])[0]?.json, null);

// ── Backtests ──
function saveBacktest(assetId, horizon, result) {
  run("INSERT INTO backtests VALUES (?,?,?,?,?)", [uid(), nowIso(), assetId, horizon, JSON.stringify(result)]);
}
const latestBacktest = (assetId, horizon) =>
  J(rows("SELECT result FROM backtests WHERE assetId=? AND horizon=? ORDER BY ts DESC LIMIT 1", [assetId, horizon])[0]?.result, null);

module.exports = {
  initDB, persistToDisk, getSetting, setSetting, getAllSettings, num,
  logDecision, dueDecisions, resolveDecision, resolvedDecisions, decisionHistory, lastDecisionTs,
  openPositions, openPosition, closedTrades, insertPosition, closePosition, updateStop, recordEquity, equityCurve,
  saveModel, loadModel, saveBacktest, latestBacktest,
};
