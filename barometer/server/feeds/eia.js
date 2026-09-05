/** EIA residential electricity price by state, ¢/kWh, latest month and year-on-year change. Needs EIA_API_KEY (free). */
const { getJson } = require('./http')
module.exports = {
  id: 'eia_power', name: 'EIA residential electricity price', family: 'economic', cadence: '45 7 * * *', requires: 'EIA_API_KEY', metrics: ['power_price_c','power_yoy'],
  async fetch() {
    const data = await getJson('https://api.eia.gov/v2/electricity/retail-sales/data/', { params: {
      api_key: process.env.EIA_API_KEY, frequency: 'monthly', 'data[0]': 'price', 'facets[sectorid][]': 'RES',
      'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: 2000
    } })
    const rows = (data.response && data.response.data) || []
    const byState = new Map()
    for (const r of rows) { if (!/^[A-Z]{2}$/.test(r.stateid)) continue; if (!byState.has(r.stateid)) byState.set(r.stateid, []); byState.get(r.stateid).push(r) }
    const out = []; const now = new Date().toISOString()
    for (const [st, list] of byState) {
      list.sort((a, b) => (a.period < b.period ? 1 : -1))
      const latest = list[0]; if (!latest || latest.price == null) continue
      const [y, m] = latest.period.split('-'); const prior = list.find(x => x.period === `${Number(y) - 1}-${m}`)
      out.push({ metric: 'power_price_c', geo: { kind: 'state', key: st }, value: Number(latest.price), unit: 'c/kWh', observedAt: now, meta: { period: latest.period } })
      if (prior && prior.price) out.push({ metric: 'power_yoy', geo: { kind: 'state', key: st }, value: +((Number(latest.price) / Number(prior.price) - 1) * 100).toFixed(2), unit: '%', observedAt: now, meta: { period: latest.period } })
    }
    return out
  }
}
