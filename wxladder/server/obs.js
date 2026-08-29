// Observation layer — the station readings the market actually resolves on.
//
// Polymarket's text: "the highest reading under the 'Temp' column for all times on this
// day" from NOAA's timeseries page for the station, "to whole degrees Celsius". That page
// is a METAR viewer, so the resolved value is the max (or min) of the station's METAR
// integer-degree temperatures across the local calendar day. Both sources below serve the
// same METAR stream:
//   • Iowa State IEM ASOS archive -> full history, used for settlement + bias + backtest.
//   • aviationweather.gov METAR   -> last ~48 h, used as a live fallback.
const axios = require("axios");
const { RateLimiter, withRetry } = require("./ratelimit");

const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const AWC = "https://aviationweather.gov/api/data/metar";
const HKO = "https://data.weather.gov.hk/weatherAPI/opendata/opendata.php";

const ext = axios.create({ timeout: 45000, headers: { Accept: "application/json,text/csv", "User-Agent": "wxladder-bot/1.0" } });

// Both are free public services and a seeding pass hits them ~64 times each. Keep well
// inside what they will serve, and back off rather than drop a station's history on a 429.
const iemLimiter = new RateLimiter(1, 2);
const awcLimiter = new RateLimiter(2, 4);
const hkoLimiter = new RateLimiter(1, 2);

// ── Pure helpers (unit-tested) ──────────────────────────────────

// IEM `format=onlycomma` CSV -> [{ station, valid, tmpc }] with numeric tmpc.
function parseAsosCsv(csv) {
  const lines = String(csv).trim().split("\n").filter(l => l && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const cols = lines[0].split(",").map(s => s.trim());
  const out = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    const row = Object.fromEntries(cols.map((c, i) => [c, (parts[i] ?? "").trim()]));
    const t = parseFloat(row.tmpc);
    if (!isNaN(t)) out.push({ station: row.station, valid: row.valid, tmpc: t });
  }
  return out;
}

// The resolved integer for one local day. Each reading is rounded first — that is the value
// the "Temp" column displays — and the extreme is taken over the rounded readings.
// Returns null rather than guessing when the day is not adequately covered.
function dailyExtreme(rows, date, kind = "high", minReadings = 12) {
  const day = rows.filter(r => String(r.valid).slice(0, 10) === date);
  if (day.length < minReadings) return null;
  const vals = day.map(r => Math.round(r.tmpc));
  return { value: kind === "low" ? Math.min(...vals) : Math.max(...vals), readings: day.length };
}

// aviationweather.gov returns obsTime as a unix second stamp; project it into the station's
// local day so the grouping matches the resolution source.
function localDateOf(unixSec, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(unixSec * 1000));
}

function metarRowsToObs(metars, tz) {
  return metars
    .filter(m => m && m.temp != null && isFinite(m.temp))
    .map(m => ({ station: m.icaoId, valid: `${localDateOf(m.obsTime, tz)} `, tmpc: Number(m.temp) }));
}

// ── Network ─────────────────────────────────────────────────────

// Station readings over [startDate, endDate] inclusive, in the station's local timezone.
async function fetchAsos(station, startDate, endDate) {
  const [y1, m1, d1] = startDate.split("-");
  const [y2, m2, d2] = endDate.split("-");
  // IEM's end date is exclusive-ish on the boundary hour, so ask for one extra day.
  const end = new Date(Date.UTC(+y2, +m2 - 1, +d2 + 1));
  const url = `${IEM}?station=${station.icao}&data=tmpc&year1=${y1}&month1=${+m1}&day1=${+d1}` +
    `&year2=${end.getUTCFullYear()}&month2=${end.getUTCMonth() + 1}&day2=${end.getUTCDate()}` +
    `&format=onlycomma&tz=${encodeURIComponent(station.tz)}&missing=empty&trace=empty`;
  await iemLimiter.acquire();
  const { data } = await withRetry(() => ext.get(url, { responseType: "text" }), { label: `iem ${station.icao}` });
  return parseAsosCsv(data);
}

async function fetchRecentMetar(station, hours = 48) {
  await awcLimiter.acquire();
  const { data } = await withRetry(() => ext.get(`${AWC}?ids=${station.icao}&format=json&hours=${hours}`), { label: `awc ${station.icao}` });
  return metarRowsToObs(Array.isArray(data) ? data : [], station.tz);
}

// Resolved value for one station-day. Archive first (authoritative + complete); recent METAR
// as a fallback for a day the archive has not ingested yet.
async function getDailyExtreme(station, date, kind = "high") {
  if (station.obsSource === "hko") {
    try {
      const vals = await getHkoExtremes(date, date, kind);
      if (vals[date] != null) return { value: vals[date], readings: 1, date, station: station.icao, kind, source: "hko-daily-extract" };
    } catch (e) { console.error(`[obs] hko ${date}: ${e.message}`); }
    return null;    // the Daily Extract lags; waiting is correct, inventing a value is not
  }
  try {
    const rows = await fetchAsos(station, date, date);
    const r = dailyExtreme(rows, date, kind);
    if (r) return { ...r, date, station: station.icao, kind, source: "iem-asos" };
  } catch (e) { console.error(`[obs] iem ${station.icao} ${date}: ${e.message}`); }

  try {
    const rows = await fetchRecentMetar(station, 48);
    const r = dailyExtreme(rows, date, kind);
    if (r) return { ...r, date, station: station.icao, kind, source: "awc-metar" };
  } catch (e) { console.error(`[obs] awc ${station.icao} ${date}: ${e.message}`); }

  return null;
}

// Bulk history for bias fitting / backtesting: { "2026-08-10": 32, ... }
async function getDailyExtremes(station, startDate, endDate, kind = "high") {
  if (station.obsSource === "hko") return getHkoExtremes(startDate, endDate, kind);
  const rows = await fetchAsos(station, startDate, endDate);
  const dates = [...new Set(rows.map(r => String(r.valid).slice(0, 10)))].sort();
  const out = {};
  for (const d of dates) {
    if (d < startDate || d > endDate) continue;
    const r = dailyExtreme(rows, d, kind);
    if (r) out[d] = r.value;
  }
  return out;
}

// ── Hong Kong Observatory ───────────────────────────────────────
// The one market that does not resolve off METAR. HKO publishes the HQ gauge's daily
// maximum/minimum to 0.1 C via its open-data CSV, which IS the resolution field —
// so it is read directly rather than reconstructed from hourly readings.
// Note the publication lag: the current month returns headers only, which is why Hong Kong
// carries a much longer settle grace than the METAR stations.

// "2026,7,29,27.9,C" -> { "2026-07-29": 27.9 }. Rows flagged incomplete are dropped.
function parseHkoCsv(text, year, month) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^(\d{4}),(\d{1,2}),(\d{1,2}),([-\d.]+)(?:,\s*"?([A-Z*#]*)"?)?/);
    if (!m) continue;
    if (Number(m[1]) !== year || Number(m[2]) !== month) continue;
    const flag = (m[5] || "C").trim();
    if (flag && flag !== "C") continue;                 // *** unavailable / # incomplete
    const v = parseFloat(m[4]);
    if (!isFinite(v)) continue;
    out[`${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`] = v;
  }
  return out;
}

async function fetchHkoMonth(year, month, kind = "high") {
  await hkoLimiter.acquire();
  const dataType = kind === "low" ? "CLMMINT" : "CLMMAXT";
  const url = `${HKO}?dataType=${dataType}&year=${year}&month=${month}&station=HKO&rf=json`;
  const { data } = await withRetry(() => ext.get(url, { responseType: "text" }), { label: `hko ${year}-${month}` });
  return parseHkoCsv(data, year, month);
}

// Every month spanned by [startDate, endDate], merged.
async function getHkoExtremes(startDate, endDate, kind = "high") {
  const [y1, m1] = startDate.split("-").map(Number);
  const [y2, m2] = endDate.split("-").map(Number);
  const out = {};
  for (let y = y1, m = m1; y < y2 || (y === y2 && m <= m2); m === 12 ? (m = 1, y++) : m++) {
    try { Object.assign(out, await fetchHkoMonth(y, m, kind)); }
    catch (e) { console.error(`[obs] hko ${y}-${m}: ${e.message}`); }
  }
  return Object.fromEntries(Object.entries(out).filter(([d]) => d >= startDate && d <= endDate));
}

module.exports = {
  getDailyExtreme, getDailyExtremes, fetchAsos, fetchRecentMetar,
  parseAsosCsv, dailyExtreme, localDateOf, metarRowsToObs,
  parseHkoCsv, fetchHkoMonth, getHkoExtremes,
};
