/**
 * Open-Meteo — no key, global coverage. Two feeds:
 *   air quality: PM2.5 and US AQI now, plus PM2.5 forecast up to 5 days (the 0–72h and 3–7d horizons)
 *   weather:     daily max/min temperature, dew point, relative humidity, 7-day forecast
 * Every ZIP3 centroid is probed, 50 per request. ~18 requests per feed per poll.
 */
const grid = require('../grid')
const { getJson, chunk, sleep } = require('./http')

const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const WX_URL = 'https://api.open-meteo.com/v1/forecast'
const BATCH = 25
const C2F = (c) => c * 9 / 5 + 32

function hoursFrom(nowMs, iso) { return Math.round((Date.parse(iso + 'Z') - nowMs) / 3600000) }

const airQuality = {
  id: 'openmeteo_aq', name: 'Open-Meteo air quality', family: 'environmental', cadence: '7 * * * *', requires: null, metrics: ['aqi','pm25','pm25_fc'],
  async fetch() {
    const cells = grid.all(); const out = []; const nowMs = Date.now()
    for (const batch of chunk(cells, BATCH)) {
      const data = await getJson(AQ_URL, { params: {
        latitude: batch.map(c => c.lat).join(','), longitude: batch.map(c => c.lon).join(','),
        hourly: 'pm2_5', current: 'pm2_5,us_aqi', forecast_days: 5, timezone: 'UTC'
      }, timeout: 90000 })
      const results = Array.isArray(data) ? data : [data]
      results.forEach((r, i) => {
        const cell = batch[i]; if (!r || !cell) return
        const geo = { kind: 'zip3', key: cell.zip3 }
        const obsAt = r.current && r.current.time ? r.current.time + ':00Z' : new Date(nowMs).toISOString()
        if (r.current) {
          if (r.current.us_aqi != null) out.push({ metric: 'aqi', geo, value: r.current.us_aqi, unit: 'USAQI', observedAt: obsAt })
          if (r.current.pm2_5 != null) out.push({ metric: 'pm25', geo, value: r.current.pm2_5, unit: 'ug/m3', observedAt: obsAt })
        }
        // forecast: take the max PM2.5 inside each horizon window so a plume that arrives on day 2 registers
        if (r.hourly && r.hourly.time) {
          let max72 = -1, max168 = -1
          r.hourly.time.forEach((t, k) => {
            const h = hoursFrom(nowMs, t); const v = r.hourly.pm2_5[k]
            if (v == null || h < 0) return
            if (h <= 72) max72 = Math.max(max72, v); else if (h <= 168) max168 = Math.max(max168, v)
          })
          if (max72 >= 0) out.push({ metric: 'pm25_fc', geo, value: max72, unit: 'ug/m3', horizonHours: 72, observedAt: obsAt })
          if (max168 >= 0) out.push({ metric: 'pm25_fc', geo, value: max168, unit: 'ug/m3', horizonHours: 168, observedAt: obsAt })
        }
      })
      await sleep(400)
    }
    return out
  }
}

const weather = {
  id: 'openmeteo_wx', name: 'Open-Meteo weather', family: 'environmental', cadence: '23 */3 * * *', requires: null, metrics: ['temp_max_f','temp_min_f','dew_point_f','rh'],
  async fetch() {
    const cells = grid.all(); const out = []; const now = new Date().toISOString()
    for (const batch of chunk(cells, BATCH)) {
      const data = await getJson(WX_URL, { params: {
        latitude: batch.map(c => c.lat).join(','), longitude: batch.map(c => c.lon).join(','),
        daily: 'temperature_2m_max,temperature_2m_min,dew_point_2m_mean,relative_humidity_2m_mean',
        forecast_days: 7, timezone: 'UTC'
      }, timeout: 90000 })
      const results = Array.isArray(data) ? data : [data]
      results.forEach((r, i) => {
        const cell = batch[i]; if (!r || !r.daily || !cell) return
        const geo = { kind: 'zip3', key: cell.zip3 }
        const d = r.daily
        const win = (arr, from, to, fn) => { const s = arr.slice(from, to).filter(v => v != null); return s.length ? fn(s) : null }
        const max = (s) => Math.max(...s), min = (s) => Math.min(...s), mean = (s) => s.reduce((a, b) => a + b, 0) / s.length
        // act window: days 0-2; schedule window: days 3-6
        const push = (metric, v, hh, unit) => { if (v != null) out.push({ metric, geo, value: v, unit, horizonHours: hh, observedAt: now }) }
        push('temp_max_f', win(d.temperature_2m_max, 0, 3, max) != null ? C2F(win(d.temperature_2m_max, 0, 3, max)) : null, 72, 'F')
        push('temp_max_f', win(d.temperature_2m_max, 3, 7, max) != null ? C2F(win(d.temperature_2m_max, 3, 7, max)) : null, 168, 'F')
        push('temp_min_f', win(d.temperature_2m_min, 0, 3, min) != null ? C2F(win(d.temperature_2m_min, 0, 3, min)) : null, 72, 'F')
        push('temp_min_f', win(d.temperature_2m_min, 3, 7, min) != null ? C2F(win(d.temperature_2m_min, 3, 7, min)) : null, 168, 'F')
        push('dew_point_f', win(d.dew_point_2m_mean, 0, 3, min) != null ? C2F(win(d.dew_point_2m_mean, 0, 3, min)) : null, 72, 'F')
        push('dew_point_f', win(d.dew_point_2m_mean, 3, 7, min) != null ? C2F(win(d.dew_point_2m_mean, 3, 7, min)) : null, 168, 'F')
        push('rh', win(d.relative_humidity_2m_mean, 0, 3, mean), 72, '%')
      })
      await sleep(400)
    }
    return out
  }
}

module.exports = { airQuality, weather }
