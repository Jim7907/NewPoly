// Historical (archived forecast, observed station value) pairs — the shared data layer for
// two jobs: seeding the bias fit so the bot is calibrated on day one instead of after a
// week of watching, and replaying the decision rule in the backtester.
//
// Known limits, stated rather than hidden:
//   • Open-Meteo's ENSEMBLE endpoint returns nulls for past dates, so historical ensemble
//     SPREAD is not retrievable. The spread ACROSS the deterministic models is, though, so
//     seeding calibrates the center (bias), the predictive sigma, AND a multi-model
//     dispersion track that the underdispersion filter falls back to until enough live
//     ensemble spread has accumulated.
//   • The historical-forecast archive stores the short-lead forecast for each day, so a
//     seeded pair is approximately lead 1. Live logging refines the per-lead fit from there.
const wx = require("./wx");
const obs = require("./obs");

const DAY_MS = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);

// Pair up archived forecasts with observed station extremes over [startDate, endDate].
// -> [{ date, rawCenter, obs, detMean, err }]
async function gather(station, kind, startDate, endDate) {
  const [fc, observed] = await Promise.all([
    wx.getHistoricalForecast(station, startDate, endDate, kind).catch(e => {
      console.error(`[history] forecast ${station.icao}: ${e.message}`); return {};
    }),
    obs.getDailyExtremes(station, startDate, endDate, kind).catch(e => {
      console.error(`[history] obs ${station.icao}: ${e.message}`); return {};
    }),
  ]);

  const out = [];
  for (const [date, f] of Object.entries(fc)) {
    const o = observed[date];
    if (o == null || f.rawCenter == null) continue;
    out.push({
      date, rawCenter: f.rawCenter, detMean: f.detMean, detSd: f.detSd, obs: o,
      err: +(o - f.rawCenter).toFixed(3),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Seed the DB's forecast+obs tables so bias.fitBias has something to work with immediately.
// Rows are written at `leadDays` (default 1) to match where the bot actually trades.
async function seedStation(db, station, kind, days = 45, leadDays = 1, endDate = null) {
  const end = endDate || addDays(iso(Date.now()), -1);
  const start = addDays(end, -Math.max(1, days));
  const pairs = await gather(station, kind, start, end);
  for (const p of pairs) {
    db.logForecast({
      // ensSd stays null: historical ensemble members are not retrievable. detSd is, and
      // it seeds the dispersion track the underdispersion filter falls back to.
      station: station.icao, kind, marketDate: p.date, leadDays,
      rawCenter: p.rawCenter, ensSd: null, ensMean: null,
      detMean: p.detMean, detSd: p.detSd, nMembers: 0,
    });
    db.logObs({ station: station.icao, kind, date: p.date, value: p.obs, source: "iem-asos" });
  }
  return { station: station.icao, kind, seeded: pairs.length, start, end };
}

module.exports = { gather, seedStation, addDays, iso };
