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

const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const AWC = "https://aviationweather.gov/api/data/metar";

const ext = axios.create({ timeout: 30000, headers: { Accept: "application/json,text/csv", "User-Agent": "wxladder-bot/1.0" } });

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
  const { data } = await ext.get(url, { responseType: "text" });
  return parseAsosCsv(data);
}

async function fetchRecentMetar(station, hours = 48) {
  const { data } = await ext.get(`${AWC}?ids=${station.icao}&format=json&hours=${hours}`);
  return metarRowsToObs(Array.isArray(data) ? data : [], station.tz);
}

// Resolved value for one station-day. Archive first (authoritative + complete); recent METAR
// as a fallback for a day the archive has not ingested yet.
async function getDailyExtreme(station, date, kind = "high") {
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

module.exports = {
  getDailyExtreme, getDailyExtremes, fetchAsos, fetchRecentMetar,
  parseAsosCsv, dailyExtreme, localDateOf, metarRowsToObs,
};
