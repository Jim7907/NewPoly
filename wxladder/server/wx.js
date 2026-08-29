// Forecast layer — Open-Meteo, sampled at the exact resolution-station coordinates.
//
//   • ensemble-api  -> every member of ECMWF-IFS / GFS / ICON as an HOURLY series.  We take
//                      each member's own daily extreme, which mirrors how the market
//                      resolves (max/min of the station's readings across the local day)
//                      instead of trusting a single `temperature_2m_max` field.
//   • forecast api  -> the high-resolution deterministic runs, which resolve the station's
//                      grid cell better than the coarse ensemble grids. They set the CENTER;
//                      the ensemble sets the SPREAD.
//
// Note the grids still snap: the ensemble runs on ~0.25 deg cells, so a coastal station like
// WSSS is evaluated up to ~20 km away. That residual is exactly what bias.js measures and
// removes — it is a station offset, not noise.
const axios = require("axios");
const cfg = require("./config");
const { mean, stdev } = require("./math");
const { RateLimiter, withRetry } = require("./ratelimit");

const ENSEMBLE_API = "https://ensemble-api.open-meteo.com/v1/ensemble";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const HISTORICAL_API = "https://historical-forecast-api.open-meteo.com/v1/forecast";

const ext = axios.create({ timeout: 45000, headers: { Accept: "application/json", "User-Agent": "wxladder-bot/1.0" } });

// Ensemble payloads are large (120+ member series) and Open-Meteo occasionally stalls under
// a burst of station requests. One retry turns a transient stall into a slow success rather
// than a station silently missing its forecast for the whole TTL window.
const getWithRetry = (url) => withRetry(() => ext.get(url), { tries: 2, label: "open-meteo" });

const limiter = new RateLimiter(3, 6);

// ── Pure helpers (unit-tested) ──────────────────────────────────

// Reduce an hourly series to one value per LOCAL calendar day. Open-Meteo returns local
// wall-clock strings ("2026-08-24T14:00") when a timezone is requested, so the date prefix
// is already the station's own day — the same day the market resolves on.
function extremeByDate(times, values, kind = "high") {
  const pick = kind === "low" ? Math.min : Math.max;
  const out = {};
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v == null || !isFinite(v)) continue;
    const d = String(times[i]).slice(0, 10);
    out[d] = out[d] == null ? v : pick(out[d], v);
  }
  return out;
}

// Split the ensemble response's hourly keys into {key, model, member}. Open-Meteo names them
// `temperature_2m_member07_ecmwf_ifs025_ensemble`, with the control run lacking `_memberNN`.
function parseSeriesKeys(hourly) {
  const out = [];
  for (const key of Object.keys(hourly)) {
    if (key === "time" || !key.startsWith("temperature_2m")) continue;
    const rest = key.slice("temperature_2m".length).replace(/^_/, "");
    const m = rest.match(/^member(\d+)_?(.*)$/);
    out.push(m
      ? { key, member: parseInt(m[1], 10), model: m[2] || "unknown" }
      : { key, member: 0, model: rest || "unknown" });
  }
  return out;
}

// Collapse the whole ensemble to per-date member arrays.
// -> { "2026-08-25": { members:[..], byModel:{ecmwf:[..],..} }, ... }
function membersByDate(hourly, kind = "high") {
  const series = parseSeriesKeys(hourly);
  const acc = {};
  for (const s of series) {
    const byDate = extremeByDate(hourly.time, hourly[s.key], kind);
    for (const [date, v] of Object.entries(byDate)) {
      const rec = (acc[date] ||= { members: [], byModel: {} });
      rec.members.push(v);
      (rec.byModel[s.model] ||= []).push(v);
    }
  }
  return acc;
}

// Per-date deterministic model values from a multi-model forecast response.
function deterministicByDate(hourly, kind = "high") {
  const acc = {};
  for (const key of Object.keys(hourly)) {
    if (key === "time" || !key.startsWith("temperature_2m")) continue;
    const model = key.slice("temperature_2m".length).replace(/^_/, "") || "default";
    for (const [date, v] of Object.entries(extremeByDate(hourly.time, hourly[key], kind))) {
      (acc[date] ||= {})[model] = v;
    }
  }
  return acc;
}

// Combine the two into the predictive inputs the ladder needs.
// The center is a weighted blend of the high-res deterministic consensus and the ensemble
// mean; the spread is the ensemble's own standard deviation (pre-bias, pre-calibration).
function combine({ members, byModel, det }, wDet = cfg.W_DET) {
  const ensMean = members.length ? mean(members) : null;
  const ensSd = members.length > 1 ? stdev(members) : null;
  const detVals = det ? Object.values(det).filter(v => v != null && isFinite(v)) : [];
  const detMean = detVals.length ? mean(detVals) : null;
  const detSpread = detVals.length > 1 ? Math.max(...detVals) - Math.min(...detVals) : null;
  // Disagreement ACROSS the deterministic models is a second, coarser dispersion signal.
  // It matters because it is the only one that can be reconstructed for past dates — the
  // ensemble endpoint serves nulls historically — so it is what lets the underdispersion
  // filter start calibrated instead of waiting ~10 days to accumulate live spread.
  const detSd = detVals.length > 1 ? stdev(detVals) : null;

  let raw;
  if (detMean != null && ensMean != null) raw = wDet * detMean + (1 - wDet) * ensMean;
  else raw = detMean != null ? detMean : ensMean;

  return {
    rawCenter: raw == null ? null : +raw.toFixed(3),
    ensMean: ensMean == null ? null : +ensMean.toFixed(3),
    ensSd: ensSd == null ? null : +ensSd.toFixed(4),
    detMean: detMean == null ? null : +detMean.toFixed(3),
    detSpread: detSpread == null ? null : +detSpread.toFixed(3),
    detSd: detSd == null ? null : +detSd.toFixed(4),
    nMembers: members.length,
    perModelMean: Object.fromEntries(Object.entries(byModel || {}).map(([k, v]) => [k, +mean(v).toFixed(2)])),
    members,
  };
}

// ── Network ─────────────────────────────────────────────────────
const cache = new Map();   // `${icao}|${kind}` -> { ts, data }

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : v)}`)
    .join("&");
}

async function fetchEnsemble(station, days, kind) {
  await limiter.acquire();
  const url = `${ENSEMBLE_API}?${qs({
    latitude: station.lat, longitude: station.lon, hourly: "temperature_2m",
    models: cfg.ENS_MODELS, forecast_days: days, timezone: station.tz, cell_selection: "nearest",
  })}`;
  const { data } = await getWithRetry(url);
  const rec = Array.isArray(data) ? data[0] : data;
  return membersByDate(rec.hourly, kind);
}

async function fetchDeterministic(station, days, kind) {
  await limiter.acquire();
  const url = `${FORECAST_API}?${qs({
    latitude: station.lat, longitude: station.lon, hourly: "temperature_2m",
    models: cfg.DET_MODELS, forecast_days: days, timezone: station.tz, cell_selection: "nearest",
  })}`;
  const { data } = await getWithRetry(url);
  const rec = Array.isArray(data) ? data[0] : data;
  return deterministicByDate(rec.hourly, kind);
}

// Forecast for one station+kind, keyed by local date. Cached for WX_TTL_MIN — the model
// runs that feed it only land every 6-12 h, so re-polling faster buys nothing.
async function getForecast(station, kind = "high", { force = false } = {}) {
  const ck = `${station.icao}|${kind}`;
  const hit = cache.get(ck);
  if (!force && hit && Date.now() - hit.ts < cfg.WX_TTL_MIN * 60000) return hit.data;

  const days = Math.max(2, cfg.MAX_LEAD_DAYS + 1);
  const [ens, det] = await Promise.all([
    fetchEnsemble(station, days, kind).catch(e => { console.error(`[wx] ensemble ${station.icao}: ${e.message}`); return {}; }),
    fetchDeterministic(station, days, kind).catch(e => { console.error(`[wx] det ${station.icao}: ${e.message}`); return {}; }),
  ]);

  const dates = [...new Set([...Object.keys(ens), ...Object.keys(det)])].sort();
  const data = {};
  for (const d of dates) {
    const e = ens[d] || { members: [], byModel: {} };
    data[d] = combine({ members: e.members, byModel: e.byModel, det: det[d] }, cfg.W_DET);
  }
  const out = { station: station.icao, kind, dates: data, fetchedAt: new Date().toISOString() };
  cache.set(ck, { ts: Date.now(), data: out });
  return out;
}

// Archived forecast for a past date range — powers bias seeding and the backtest.
// Open-Meteo's historical-forecast archive stores what the models actually predicted, so
// this is a forecast replay and not a reanalysis peek at the answer.
async function getHistoricalForecast(station, startDate, endDate, kind = "high") {
  await limiter.acquire();
  const url = `${HISTORICAL_API}?${qs({
    latitude: station.lat, longitude: station.lon, hourly: "temperature_2m",
    models: cfg.DET_MODELS, start_date: startDate, end_date: endDate,
    timezone: station.tz, cell_selection: "nearest",
  })}`;
  const { data } = await ext.get(url);
  const rec = Array.isArray(data) ? data[0] : data;
  const det = deterministicByDate(rec.hourly, kind);
  const out = {};
  for (const [d, models] of Object.entries(det)) {
    out[d] = combine({ members: [], byModel: {}, det: models }, 1);
  }
  return out;
}

function clearCache() { cache.clear(); }

module.exports = {
  getForecast, getHistoricalForecast, clearCache,
  extremeByDate, parseSeriesKeys, membersByDate, deterministicByDate, combine,
  RateLimiter, _cache: cache,
};
