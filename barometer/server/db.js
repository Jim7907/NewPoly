/**
 * Database layer — sql.js (pure JS SQLite, no native deps), same pattern as the
 * other apps in this repo. Persists to DB_PATH/barometer.db; in-memory if the
 * disk is not writable.
 */
const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

const DB_DIR = process.env.DB_PATH || path.join(__dirname, '../data')
const DB_FILE = path.join(DB_DIR, 'barometer.db')

let db = null
let dirty = false

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed TEXT NOT NULL, family TEXT NOT NULL, metric TEXT NOT NULL,
  geo_kind TEXT NOT NULL,        -- point | zip3 | state | national
  geo_key TEXT,                  -- zip3 or state code when not a point
  lat REAL, lon REAL,
  value REAL NOT NULL, unit TEXT,
  horizon_hours INTEGER DEFAULT 0, -- 0 = observed now; >0 = forecast this many hours ahead
  observed_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS obs_feed_time ON observations(feed, fetched_at);
CREATE INDEX IF NOT EXISTS obs_metric_time ON observations(metric, observed_at);

CREATE TABLE IF NOT EXISTS feed_status (
  feed TEXT PRIMARY KEY, family TEXT, enabled INTEGER DEFAULT 1,
  last_ok TEXT, last_error TEXT, last_count INTEGER DEFAULT 0, last_ms INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cell_scores (
  brand TEXT NOT NULL, zip3 TEXT NOT NULL, horizon TEXT NOT NULL,
  idx REAL NOT NULL, drivers TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY (brand, zip3, horizon)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY, brand TEXT NOT NULL, title TEXT NOT NULL, where_text TEXT,
  zip3s TEXT NOT NULL, states TEXT, idx REAL NOT NULL, horizon TEXT NOT NULL,
  status TEXT NOT NULL,          -- detected | drafting | ready | scheduled | live | done | dismissed
  drivers TEXT NOT NULL, forecast TEXT, signature TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, brand TEXT NOT NULL,
  lines TEXT NOT NULL, budget REAL NOT NULL, gate TEXT, status TEXT NOT NULL,
  -- draft | awaiting_approval | approved | launching | live | undone | killed | done
  created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, launched_at TEXT,
  undo_until TEXT, ended_at TEXT, notes TEXT
);

CREATE TABLE IF NOT EXISTS creatives (
  id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, brand TEXT NOT NULL,
  format TEXT NOT NULL, channel TEXT, headline TEXT, body TEXT, cta TEXT,
  claims TEXT, checks TEXT, status TEXT NOT NULL,  -- draft | approved | blocked
  generated_by TEXT, predicted_ctr REAL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  opportunity_id TEXT PRIMARY KEY, brief TEXT NOT NULL, generated_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS writes (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, channel TEXT NOT NULL,
  action TEXT NOT NULL, payload TEXT NOT NULL, amount REAL DEFAULT 0,
  dry_run INTEGER NOT NULL, status TEXT NOT NULL,   -- proposed | held | sent | failed | undone
  response TEXT, created_at TEXT NOT NULL, sent_at TEXT
);

CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY, brand TEXT NOT NULL, name TEXT NOT NULL, family TEXT,
  fulfillable INTEGER DEFAULT 0, inbound INTEGER DEFAULT 0, daily_rate REAL DEFAULT 0,
  siblings TEXT, marketplace TEXT DEFAULT 'amazon', source TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS holdout (zip3 TEXT PRIMARY KEY, reason TEXT, locked_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS firstparty_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, zip3 TEXT NOT NULL, brand TEXT, metric TEXT NOT NULL,
  value REAL NOT NULL, device_count INTEGER NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fp_zip_metric ON firstparty_readings(zip3, metric, observed_at);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, sku TEXT, zip3 TEXT NOT NULL,
  day TEXT NOT NULL, units REAL DEFAULT 0, revenue REAL DEFAULT 0, source TEXT
);
CREATE INDEX IF NOT EXISTS sales_brand_day ON sales(brand, day);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT
);
`

async function init() {
  const SQL = await initSqlJs()
  try {
    if (fs.existsSync(DB_FILE)) db = new SQL.Database(fs.readFileSync(DB_FILE))
  } catch (e) { console.error('[db] could not load existing file, starting fresh:', e.message) }
  if (!db) db = new SQL.Database()
  db.exec(SCHEMA)
  setInterval(persist, 15000).unref()
  process.on('SIGINT', () => { persist(); process.exit(0) })
  process.on('SIGTERM', () => { persist(); process.exit(0) })
  return api
}

function persist() {
  if (!db || !dirty) return
  try {
    fs.mkdirSync(DB_DIR, { recursive: true })
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()))
    dirty = false
  } catch (e) { console.error('[db] persist failed:', e.message) }
}

function run(sql, params = []) { db.run(sql, params); dirty = true }
function all(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}
function get(sql, params = []) { return all(sql, params)[0] || null }
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); dirty = true; return r } catch (e) { db.exec('ROLLBACK'); throw e } }

const json = (v) => (v == null ? null : JSON.stringify(v))
const parse = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s) } catch { return fallback } }

function setting(key, fallback) { const r = get('SELECT value FROM settings WHERE key=?', [key]); return r ? parse(r.value, fallback) : fallback }
function setSetting(key, value) { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]) }
function audit(actor, action, detail) { run('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)', [new Date().toISOString(), actor || 'system', action, json(detail)]) }

const api = { init, run, all, get, tx, persist, json, parse, setting, setSetting, audit }
module.exports = api
