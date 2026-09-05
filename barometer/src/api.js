const j = async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || r.statusText); return d }
const h = { 'Content-Type': 'application/json', 'x-actor': localStorage.getItem('barometer.actor') || 'web' }
export const api = {
  get: (p) => fetch('/api' + p).then(j),
  post: (p, body) => fetch('/api' + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }).then(j),
  patch: (p, body) => fetch('/api' + p, { method: 'PATCH', headers: h, body: JSON.stringify(body || {}) }).then(j)
}
export const fmtMoney = (n) => n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : `$${Math.round(n)}`
export const fmtNum = (n) => n == null ? '—' : Number(n).toLocaleString('en-US')
export const ago = (iso) => { if (!iso) return 'never'; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 90) return `${Math.round(s)}s`; if (s < 5400) return `${Math.round(s / 60)}m`; if (s < 172800) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d` }
export const LADDER = ['#EDF2F8', '#F7D9C4', '#EFAE85', '#DE7B51', '#BE4E36', '#8F3224']
export const LADDER_INK = ['#7C8FA3', '#8A5A3A', '#6E3A20', '#FFFFFF', '#FFFFFF', '#FFFFFF']
export const band = (v) => v <= 25 ? 0 : v <= 45 ? 1 : v <= 65 ? 2 : v <= 80 ? 3 : v <= 92 ? 4 : 5
export const BRAND_STYLE = { levoit: { bg: '#E0F4F4', ink: '#0A7B7B', name: 'Levoit' }, cosori: { bg: '#FBEDE4', ink: '#A94D1E', name: 'Cosori' }, etekcity: { bg: '#E8EAF8', ink: '#404E9E', name: 'Etekcity' }, pawsync: { bg: '#E5F2E8', ink: '#357348', name: 'Pawsync' } }
export const brandOf = (key) => (key || '').split(':')[0]
export const METRIC_NAME = { aqi: 'Air quality index', pm25: 'PM2.5 now', pm25_fc: 'PM2.5 forecast', fires: 'Fire detections', alert_air: 'Air quality alert', alert_heat: 'Heat advisory', alert_fire: 'Fire weather', alert_cold: 'Cold warning', pollen: 'Pollen index', temp_max_f: 'High temperature', temp_min_f: 'Low temperature', dew_point_f: 'Dew point', rh: 'Relative humidity', ili: 'Flu activity', power_price_c: 'Electricity price', power_yoy: 'Power price change', food_yoy: 'Food inflation', recipe_velocity: 'Recipe trend', fp_pm25: 'Indoor PM2.5 (fleet)', fp_filter: 'Filter life (fleet)', fp_run: 'Run hours (fleet)', fp_cook: 'Cook sessions (fleet)', cal_newyear: 'New year', cal_backtoschool: 'Back to school', cal_shedding: 'Shedding season' }
export const METRIC_UNIT = { aqi: 'AQI', pm25: 'µg/m³', pm25_fc: 'µg/m³', fires: '', alert_air: '/3', alert_heat: '/3', alert_fire: '/3', alert_cold: '/3', pollen: 'UPI', temp_max_f: '°F', temp_min_f: '°F', dew_point_f: '°F', rh: '%', ili: '% ILI', power_price_c: '¢/kWh', power_yoy: '% yoy', food_yoy: '% yoy', recipe_velocity: '%', fp_pm25: 'µg/m³', fp_filter: '%', fp_run: '%', fp_cook: '%' }
export const FEED_NAME = { openmeteo_aq: 'Open-Meteo air quality', openmeteo_wx: 'Open-Meteo weather', nws_alerts: 'NWS alerts', cdc_fluview: 'CDC FluView', bls_food_cpi: 'BLS food CPI', eia_power: 'EIA electricity', epa_airnow: 'EPA AirNow', purpleair: 'PurpleAir', nasa_firms: 'NASA FIRMS', google_pollen: 'Google Pollen', calendar: 'Calendar', firstparty: 'VeSync device fleet', manual: 'Partner signals' }
