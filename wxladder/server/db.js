// Persistence — sql.js (pure-JS SQLite, no native deps), same approach as the sibling
// crypto15m app but with a basket/leg schema: a ladder is one position made of 3-4 rungs,
// and both levels have to be settled and scored.
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const DB_DIR = cfg.DB_PATH ? path.resolve(cfg.DB_PATH) : path.join(__dirname, "../data");
const DB_FILE = path.join(DB_DIR, "wxladder.db");

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

  db.run(`CREATE TABLE IF NOT EXISTS baskets (
    id TEXT PRIMARY KEY, ts TEXT, eventId TEXT, slug TEXT, city TEXT, station TEXT, kind TEXT,
    marketDate TEXT, leadDays INTEGER, unit TEXT,
    rawCenter REAL, bias REAL, center REAL, sigma REAL, ensSd REAL, dispRatio REAL, regime TEXT,
    tvd REAL, width INTEGER, coverProb REAL, basketCost REAL, basketEv REAL, fillEv REAL,
    overround REAL, budget REAL, outlay REAL, sizing TEXT, bucketRule TEXT,
    status TEXT DEFAULT 'open', resolvedAt TEXT, obsValue REAL, obsSource TEXT,
    winLabel TEXT, payout REAL, pnl REAL )`);

  try { db.run(`ALTER TABLE baskets ADD COLUMN bucketRule TEXT`); } catch { /* already present */ }

  db.run(`CREATE TABLE IF NOT EXISTS legs (
    id TEXT PRIMARY KEY, basketId TEXT, label TEXT, deg REAL, type TEXT,
    marketId TEXT, tokenId TEXT, prob REAL, pModel REAL, pMarket REAL,
    ask REAL, fillAsk REAL, qEff REAL, feePerShare REAL, shares REAL, dollars REAL,
    won INTEGER )`);
  db.run(`CREATE INDEX IF NOT EXISTS legs_basket ON legs(basketId)`);

  // Forecast log — the raw (pre-correction) center per station+kind+date+lead. Joined
  // against `obs` this is exactly the training set bias.js fits on.
  db.run(`CREATE TABLE IF NOT EXISTS forecasts (
    id TEXT PRIMARY KEY, ts TEXT, station TEXT, kind TEXT, marketDate TEXT, leadDays INTEGER,
    rawCenter REAL, ensSd REAL, ensMean REAL, detMean REAL, detSd REAL, nMembers INTEGER )`);
  db.run(`CREATE INDEX IF NOT EXISTS fc_lookup ON forecasts(station, kind, leadDays)`);
  // Migrate databases written before the multi-model dispersion track existed.
  try { db.run(`ALTER TABLE forecasts ADD COLUMN detSd REAL`); } catch { /* already present */ }

  db.run(`CREATE TABLE IF NOT EXISTS obs (
    id TEXT PRIMARY KEY, station TEXT, kind TEXT, obsDate TEXT, value REAL, source TEXT, ts TEXT )`);

  db.run(`CREATE TABLE IF NOT EXISTS backtests (id TEXT PRIMARY KEY, ts TEXT, params TEXT, result TEXT)`);

  const defaults = {
    paper_balance: String(cfg.PAPER_BALANCE),
    ...Object.fromEntries(cfg.SIZING_MODES.map(m => [`paper_balance_${m}`, String(cfg.PAPER_BALANCE)])),
    paper_enabled: "true",
    scan_active: "true",
    sizing: cfg.SIZING,
    w_model: String(cfg.W_MODEL),
    min_basket_ev: String(cfg.MIN_BASKET_EV),
    min_cover_prob: String(cfg.MIN_COVER_PROB),
    max_basket_cost: String(cfg.MAX_BASKET_COST),
    spread_gamma: String(cfg.SPREAD_GAMMA),
    underdisp_lo: String(cfg.UNDERDISP_LO),
    overdisp_hi: String(cfg.OVERDISP_HI),
    skip_when_wide: String(cfg.SKIP_WHEN_WIDE),
    sigma_mult: String(cfg.SIGMA_MULT),
    bias_halflife_days: String(cfg.BIAS_HALFLIFE_DAYS),
    bias_window_days: String(cfg.BIAS_WINDOW_DAYS),
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
const q = (sql, params = []) => rowsToObjs(db.exec(sql, params));

// ── Settings ──
function getSetting(k) { const r = db.exec("SELECT value FROM settings WHERE key=?", [k]); return r[0]?.values[0]?.[0] ?? null; }
function setSetting(k, v) { db.run("INSERT OR REPLACE INTO settings VALUES (?,?)", [k, String(v)]); persistToDisk(); }
function getAllSettings() { return Object.fromEntries(q("SELECT key,value FROM settings").map(r => [r.key, r.value])); }

// Runtime overrides layered on top of the static config, so the UI/backtest can retune
// thresholds without a restart.
function effectiveParams() {
  const s = getAllSettings();
  const n = (k, d) => (s[k] != null && s[k] !== "" && !isNaN(Number(s[k])) ? Number(s[k]) : d);
  return {
    ...cfg,
    SIZING: s.sizing || cfg.SIZING,
    W_MODEL: n("w_model", cfg.W_MODEL),
    MIN_BASKET_EV: n("min_basket_ev", cfg.MIN_BASKET_EV),
    MIN_COVER_PROB: n("min_cover_prob", cfg.MIN_COVER_PROB),
    MAX_BASKET_COST: n("max_basket_cost", cfg.MAX_BASKET_COST),
    SPREAD_GAMMA: n("spread_gamma", cfg.SPREAD_GAMMA),
    UNDERDISP_LO: n("underdisp_lo", cfg.UNDERDISP_LO),
    OVERDISP_HI: n("overdisp_hi", cfg.OVERDISP_HI),
    SKIP_WHEN_WIDE: s.skip_when_wide === "true",
    SIGMA_MULT: n("sigma_mult", cfg.SIGMA_MULT),
    BIAS_HALFLIFE_DAYS: n("bias_halflife_days", cfg.BIAS_HALFLIFE_DAYS),
    BIAS_WINDOW_DAYS: n("bias_window_days", cfg.BIAS_WINDOW_DAYS),
  };
}

// ── Forecast + observation logs (the bias training set) ──
function logForecast(f) {
  const id = `f_${f.station}_${f.kind}_${f.marketDate}_${f.leadDays}`;
  db.run(`INSERT OR REPLACE INTO forecasts (id,ts,station,kind,marketDate,leadDays,rawCenter,ensSd,ensMean,detMean,detSd,nMembers)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, new Date().toISOString(), f.station, f.kind, f.marketDate, f.leadDays,
     f.rawCenter ?? null, f.ensSd ?? null, f.ensMean ?? null, f.detMean ?? null, f.detSd ?? null, f.nMembers ?? null]);
}

function logObs(o) {
  const id = `o_${o.station}_${o.kind}_${o.date}`;
  db.run(`INSERT OR REPLACE INTO obs (id,station,kind,obsDate,value,source,ts) VALUES (?,?,?,?,?,?,?)`,
    [id, o.station, o.kind, o.date, o.value, o.source || null, new Date().toISOString()]);
}
function getObs(station, kind, date) {
  const r = q("SELECT * FROM obs WHERE station=? AND kind=? AND obsDate=?", [station, kind, date]);
  return r[0] || null;
}

// Forecast/observation pairs for one station+kind+lead — bias.fitBias consumes these directly.
function biasPairs(station, kind, leadDays, limit = 400) {
  return q(`SELECT f.marketDate AS date, f.rawCenter AS rawCenter, f.ensSd AS ensSd, f.leadDays AS leadDays, o.value AS obs
            FROM forecasts f JOIN obs o
              ON o.station=f.station AND o.kind=f.kind AND o.obsDate=f.marketDate
            WHERE f.station=? AND f.kind=? AND f.leadDays=?
            ORDER BY f.marketDate DESC LIMIT ${+limit}`, [station, kind, leadDays]);
}

// Every lead's pairs, tagged with their lead. The station offset is a representativeness
// error (grid cell vs the actual gauge), so it does not depend on forecast lead and pooling
// across leads is both valid and worth ~3x the samples. Measured over 7 stations: pooled
// bias +1.26 at lead 1 vs +1.28 at lead 2, with the large offsets stable to within 0.3 C
// (Changi 2.26/2.28, Haneda 4.19/4.48).
function biasPairsAllLeads(station, kind, limit = 1200) {
  return q(`SELECT f.marketDate AS date, f.rawCenter AS rawCenter, f.ensSd AS ensSd, f.leadDays AS leadDays, o.value AS obs
            FROM forecasts f JOIN obs o
              ON o.station=f.station AND o.kind=f.kind AND o.obsDate=f.marketDate
            WHERE f.station=? AND f.kind=?
            ORDER BY f.marketDate DESC LIMIT ${+limit}`, [station, kind]);
}

// Spread history — kept separate from the bias pairs because it survives days with no
// observation. Two tracks: the live ensemble spread, and the multi-model spread that can be
// reconstructed for past dates and therefore seeded.
function spreadRows(station, kind, leadDays, limit = 400) {
  return q(`SELECT marketDate AS date, ensSd, detSd FROM forecasts
            WHERE station=? AND kind=? AND leadDays=? AND (ensSd IS NOT NULL OR detSd IS NOT NULL)
            ORDER BY marketDate DESC LIMIT ${+limit}`, [station, kind, leadDays]);
}

// ── Baskets ──
// Scoped to the sizing policy, so both books may hold the same market at once — that pairing
// is the entire point of running them side by side.
function hasOpenBasket(eventId, sizing) {
  const sql = sizing
    ? "SELECT 1 FROM baskets WHERE eventId=? AND sizing=? AND status='open' LIMIT 1"
    : "SELECT 1 FROM baskets WHERE eventId=? AND status='open' LIMIT 1";
  const args = sizing ? [eventId, sizing] : [eventId];
  return (db.exec(sql, args)[0]?.values.length || 0) > 0;
}
function openExposure(sizing) {
  const r = sizing
    ? db.exec("SELECT SUM(outlay) FROM baskets WHERE status='open' AND sizing=?", [sizing])
    : db.exec("SELECT SUM(outlay) FROM baskets WHERE status='open'");
  return Number(r[0]?.values[0]?.[0] || 0);
}

// Place a paper basket. The whole outlay is debited up front, exactly like buying the rungs.
function placeBasket(plan, sizing) {
  const funded = (plan.legs || []).filter(l => l.shares > 0);
  if (!funded.length) return null;
  const id = `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const outlay = +funded.reduce((s, l) => s + l.dollars, 0).toFixed(4);
  db.run(`INSERT INTO baskets (id,ts,eventId,slug,city,station,kind,marketDate,leadDays,unit,
            rawCenter,bias,center,sigma,ensSd,dispRatio,regime,tvd,width,coverProb,basketCost,basketEv,fillEv,
            overround,budget,outlay,sizing,bucketRule,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open')`,
    [id, new Date().toISOString(), plan.eventId, plan.slug, plan.city, plan.station, plan.kind,
     plan.date, plan.leadDays, plan.unit, plan.rawCenter, plan.bias, plan.center, plan.sigma,
     plan.ensSd, plan.dispRatio, plan.regime, plan.tvd, funded.length, plan.coverProb,
     plan.basketCost, plan.basketEv, plan.fillEv, plan.overround, plan.budget, outlay,
     sizing || cfg.SIZING, plan.bucketRule || "round"]);

  for (const l of funded) {
    db.run(`INSERT INTO legs (id,basketId,label,deg,type,marketId,tokenId,prob,pModel,pMarket,ask,fillAsk,qEff,feePerShare,shares,dollars)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`l_${id}_${l.idx}`, id, l.label, l.deg ?? null, l.type ?? null, l.marketId, l.tokenId,
       l.prob, l.pModel ?? null, l.pMarket ?? null, l.ask, l.fillAsk ?? l.ask, l.qEff,
       l.feePerShare ?? null, l.shares, l.dollars]);
  }
  setBalance(sizing || cfg.SIZING, getBalance(sizing || cfg.SIZING) - outlay);
  persistToDisk();
  return id;
}

const getBasket = (id) => q("SELECT * FROM baskets WHERE id=?", [id])[0] || null;
const getLegs = (basketId) => q("SELECT * FROM legs WHERE basketId=? ORDER BY deg", [basketId]);
const getOpenBaskets = () => q("SELECT * FROM baskets WHERE status='open' ORDER BY marketDate");
function getRecentBaskets(limit = 200) {
  const rows = q(`SELECT * FROM baskets ORDER BY ts DESC LIMIT ${+limit}`);
  return rows.map(b => ({ ...b, legs: getLegs(b.id) }));
}

// Settle a basket against the observed station value. `obsValue == null` voids and refunds.
function settleBasket(basketId, obsValue, obsSource) {
  const b = getBasket(basketId);
  if (!b) return null;
  const legs = getLegs(basketId);

  if (obsValue == null) {
    db.run("UPDATE baskets SET status='void', resolvedAt=? WHERE id=?", [new Date().toISOString(), basketId]);
    setBalance(b.sizing, getBalance(b.sizing) + b.outlay);
    persistToDisk();
    return { basketId, status: "void", refund: b.outlay };
  }

  // The winning rung is the one whose bucket contains the observed reading, under the SAME
  // rule the probabilities were built with — METAR hands us an integer where floor and round
  // agree, but HKO hands us 31.6 and only the rule decides between "31C" and "32C".
  // `deg`+`type` reconstruct the interval without needing Infinity to survive SQL.
  const rule = b.bucketRule || "round";
  const v = rule === "floor" ? Math.floor(obsValue) : Math.round(obsValue);
  const contains = (l) => l.type === "tail-low" ? v <= l.deg
    : l.type === "tail-high" ? v >= l.deg
      : v === l.deg;
  let payout = 0, winLabel = null;
  for (const l of legs) {
    const won = contains(l) ? 1 : 0;
    if (won) { payout += l.shares; winLabel = l.label; }
    db.run("UPDATE legs SET won=? WHERE id=?", [won, l.id]);
  }
  payout = +payout.toFixed(4);
  const pnl = +(payout - b.outlay).toFixed(4);
  db.run("UPDATE baskets SET status=?, resolvedAt=?, obsValue=?, obsSource=?, winLabel=?, payout=?, pnl=? WHERE id=?",
    [payout > 0 ? "won" : "lost", new Date().toISOString(), obsValue, obsSource || null, winLabel, payout, pnl, basketId]);
  if (payout > 0) setBalance(b.sizing, getBalance(b.sizing) + payout);
  persistToDisk();
  return { basketId, status: payout > 0 ? "won" : "lost", obsValue, winLabel, payout, pnl };
}

// Each sizing policy is its own paper book: separate bankroll, separate exposure, separate
// P&L. Sharing one balance would let whichever policy traded first starve the other and make
// the comparison meaningless.
const balanceKey = (sizing) => `paper_balance_${sizing || cfg.SIZING}`;
function getBalance(sizing) {
  const v = getSetting(balanceKey(sizing));
  return v == null ? cfg.PAPER_BALANCE : parseFloat(v);
}
const setBalance = (sizing, v) => setSetting(balanceKey(sizing), Number(v).toFixed(4));

function getStats(sizing) {
  if (sizing) return statsFor(sizing);
  const byMode = Object.fromEntries(cfg.SIZING_MODES.map(m => [m, statsFor(m)]));
  const primary = byMode[cfg.SIZING] || statsFor(cfg.SIZING);
  return { ...primary, byMode };
}

function statsFor(sizing) {
  const all = q("SELECT * FROM baskets WHERE sizing=?", [sizing]);
  const closed = all.filter(b => b.status === "won" || b.status === "lost");
  const won = closed.filter(b => b.status === "won");
  const totalPnl = closed.reduce((s, b) => s + (b.pnl || 0), 0);
  const staked = closed.reduce((s, b) => s + (b.outlay || 0), 0);
  return {
    sizing,
    paperBalance: +getBalance(sizing).toFixed(2),
    totalBaskets: all.length,
    openBaskets: all.filter(b => b.status === "open").length,
    closedBaskets: closed.length,
    wonBaskets: won.length,
    lostBaskets: closed.length - won.length,
    voidBaskets: all.filter(b => b.status === "void").length,
    // Two DIFFERENT rates, because on a probability-weighted ladder they genuinely diverge:
    // covering the outcome does not imply profiting from it. When the outcome lands on an
    // outer rung, that rung holds the smallest allocation and can pay back less than the whole
    // basket cost — a covered loss. Reporting only the cover rate next to a negative P&L reads
    // like a bug, so both are published.
    coverRate: closed.length ? +(won.length / closed.length * 100).toFixed(1) : 0,
    profitRate: closed.length ? +(closed.filter(b => (b.pnl || 0) > 0).length / closed.length * 100).toFixed(1) : 0,
    coveredLosses: closed.filter(b => b.status === "won" && (b.pnl || 0) <= 0).length,
    hitRate: closed.length ? +(won.length / closed.length * 100).toFixed(1) : 0,  // back-compat alias for coverRate
    totalPnl: +totalPnl.toFixed(2),
    roi: staked > 0 ? +(totalPnl / staked * 100).toFixed(2) : 0,
    staked: +staked.toFixed(2),
    openExposure: +openExposure(sizing).toFixed(2),
  };
}

// ── Backtests ──
function saveBacktest(params, result) {
  const id = `bt_${Date.now()}`;
  db.run("INSERT INTO backtests VALUES (?,?,?,?)", [id, new Date().toISOString(), JSON.stringify(params), JSON.stringify(result)]);
  persistToDisk();
  return id;
}
function getLatestBacktest() {
  const r = q("SELECT * FROM backtests ORDER BY ts DESC LIMIT 1")[0];
  return r ? { id: r.id, ts: r.ts, params: JSON.parse(r.params), result: JSON.parse(r.result) } : null;
}

function close() { if (persistTimer) clearInterval(persistTimer); persistToDisk(); }

module.exports = {
  initDB, getSetting, setSetting, getAllSettings, effectiveParams,
  logForecast, logObs, getObs, biasPairs, biasPairsAllLeads, spreadRows,
  placeBasket, getBasket, getLegs, getOpenBaskets, getRecentBaskets, hasOpenBasket,
  getBalance, setBalance, balanceKey,
  openExposure, settleBasket, getStats,
  saveBacktest, getLatestBacktest, persistToDisk, close, _q: q,
};
