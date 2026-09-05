/** BLS food-at-home CPI (CUUR0000SAF11), year-on-year %. National. A key raises the daily quota; not required. */
const { http } = require('./http')
module.exports = {
  id: 'bls_food_cpi', name: 'BLS food-at-home CPI', family: 'economic', cadence: '30 7 * * *', requires: null, metrics: ['food_yoy'],
  async fetch() {
    const y = new Date().getUTCFullYear()
    const body = { seriesid: ['CUUR0000SAF11'], startyear: String(y - 2), endyear: String(y) }
    if (process.env.BLS_API_KEY) body.registrationkey = process.env.BLS_API_KEY
    const r = await http.post('https://api.bls.gov/publicAPI/v2/timeseries/data/', body)
    if (r.data.status !== 'REQUEST_SUCCEEDED') throw new Error(r.data.message ? r.data.message.join('; ') : 'BLS request failed')
    const series = r.data.Results.series[0].data.filter(d => d.period.startsWith('M'))
    const latest = series[0]
    const prior = series.find(d => d.period === latest.period && Number(d.year) === Number(latest.year) - 1)
    if (!prior) return []
    const yoy = (Number(latest.value) / Number(prior.value) - 1) * 100
    return [{ metric: 'food_yoy', geo: { kind: 'national' }, value: +yoy.toFixed(2), unit: '%', observedAt: new Date().toISOString(), meta: { period: `${latest.year}-${latest.period}` } }]
  }
}
