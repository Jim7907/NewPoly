// Paper-trading engine: place ladders, settle them against the station's own readings, and
// keep the bias/observation loop fed.
//
// The feedback loop matters as much as the trading. The bot refuses to trade a station
// until MIN_BIAS_SAMPLES forecast/observation pairs exist for it — so it has to record
// forecasts and observations for EVERY station it watches, traded or not, or it would
// deadlock waiting for calibration it never collects.
const cfg = require("./config");
const db = require("./db");
const obsApi = require("./obs");
const poly = require("./poly");
const history = require("./history");

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// Place a paper basket from an actionable plan. Returns the basket id or null.
function tryEnter(plan, params = cfg) {
  if (db.getSetting("paper_enabled") !== "true" || db.getSetting("scan_active") !== "true") return null;
  if (!plan || plan.signal === "—" || !(plan.outlay > 0)) return null;
  if (db.hasOpenBasket(plan.eventId)) return null;
  const funded = (plan.legs || []).filter(l => l.shares > 0);
  if (funded.length < params.LADDER_MIN_W) return null;
  return db.placeBasket(plan, params.SIZING);
}

// Settle every open basket whose local day has finished at its own station.
async function resolveDue(nowMs = Date.now(), params = cfg) {
  const settled = [];
  for (const b of db.getOpenBaskets()) {
    const station = Object.values(cfg.UNIVERSE).find(s => s.icao === b.station);
    if (!station) continue;
    const today = poly.localToday(station.tz, nowMs);
    if (today <= b.marketDate) continue;                  // the station's day is still running

    let value = null, source = null;
    const cached = db.getObs(b.station, b.kind, b.marketDate);
    if (cached) { value = cached.value; source = cached.source; }
    else {
      const o = await obsApi.getDailyExtreme(station, b.marketDate, b.kind);
      if (o) {
        value = o.value; source = o.source;
        db.logObs({ station: b.station, kind: b.kind, date: b.marketDate, value, source });
      }
    }

    if (value == null) {
      // Never invent a settlement. Void only once the station has clearly not reported.
      if (daysBetween(b.marketDate, today) > params.SETTLE_GRACE_DAYS) {
        settled.push(db.settleBasket(b.id, null, null));
      }
      continue;
    }
    settled.push(db.settleBasket(b.id, value, source));
  }
  return settled.filter(Boolean);
}

// Fetch observations for past forecast dates we have not verified yet. This is the learning
// loop: every row it writes sharpens the bias fit and the sigma anchor for that station.
async function backfillObs(nowMs = Date.now(), limit = cfg.OBS_BACKFILL_PER_SCAN) {
  const missing = db._q(`SELECT DISTINCT f.station, f.kind, f.marketDate
                         FROM forecasts f LEFT JOIN obs o
                           ON o.station=f.station AND o.kind=f.kind AND o.obsDate=f.marketDate
                         WHERE o.id IS NULL
                         ORDER BY f.marketDate DESC LIMIT ${+limit * 4}`);
  const done = [];
  for (const m of missing) {
    if (done.length >= limit) break;
    const station = Object.values(cfg.UNIVERSE).find(s => s.icao === m.station);
    if (!station) continue;
    if (poly.localToday(station.tz, nowMs) <= m.marketDate) continue;   // day not over yet
    const o = await obsApi.getDailyExtreme(station, m.marketDate, m.kind);
    if (!o) continue;
    db.logObs({ station: m.station, kind: m.kind, date: m.marketDate, value: o.value, source: o.source });
    done.push({ station: m.station, kind: m.kind, date: m.marketDate, value: o.value });
  }
  return done;
}

// One-shot bias seeding so the bot starts calibrated rather than spending its first week
// refusing every market. Only touches stations that are not already calibrated.
async function seedBias({ days = cfg.SEED_DAYS, kinds = cfg.KINDS, stations = cfg.STATIONS, minSamples = cfg.MIN_BIAS_SAMPLES } = {}) {
  const results = [];
  for (const station of stations) {
    if (station.unsupported) continue;
    for (const kind of kinds) {
      const have = db.biasPairs(station.icao, kind, cfg.MIN_LEAD_DAYS).length;
      if (have >= minSamples) { results.push({ station: station.icao, kind, skipped: true, have }); continue; }
      try {
        results.push(await history.seedStation(db, station, kind, days, cfg.MIN_LEAD_DAYS));
      } catch (e) {
        console.error(`[seed] ${station.icao}/${kind}: ${e.message}`);
        results.push({ station: station.icao, kind, error: e.message });
      }
    }
  }
  db.persistToDisk();
  return results;
}

module.exports = { tryEnter, resolveDue, backfillObs, seedBias, daysBetween };
