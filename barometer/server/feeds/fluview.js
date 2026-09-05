/**
 * CDC FluView via the Delphi Epidata API — no key. Weighted ILI % by HHS region,
 * fanned out to the states in each region. Weekly, lags about a week.
 */
const grid = require('../grid')
const { getJson } = require('./http')

const HHS = {
  hhs1: ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'], hhs2: ['NJ', 'NY'], hhs3: ['DE', 'DC', 'MD', 'PA', 'VA', 'WV'],
  hhs4: ['AL', 'FL', 'GA', 'KY', 'MS', 'NC', 'SC', 'TN'], hhs5: ['IL', 'IN', 'MI', 'MN', 'OH', 'WI'],
  hhs6: ['AR', 'LA', 'NM', 'OK', 'TX'], hhs7: ['IA', 'KS', 'MO', 'NE'], hhs8: ['CO', 'MT', 'ND', 'SD', 'UT', 'WY'],
  hhs9: ['AZ', 'CA', 'HI', 'NV'], hhs10: ['AK', 'ID', 'OR', 'WA']
}
function epiweekRange() {
  const now = new Date(); const y = now.getUTCFullYear()
  const start = new Date(Date.UTC(y, 0, 4)); const wk = Math.max(1, Math.ceil(((now - start) / 86400000 + start.getUTCDay() + 1) / 7))
  const from = wk > 8 ? `${y}${String(wk - 8).padStart(2, '0')}` : `${y - 1}44`
  return `${from}-${y}${String(Math.min(53, wk)).padStart(2, '0')}`
}

module.exports = {
  id: 'cdc_fluview', name: 'CDC FluView (Delphi)', family: 'epidemiological', cadence: '0 6 * * *', requires: null, metrics: ['ili'],
  async fetch() {
    const data = await getJson('https://api.delphi.cmu.edu/epidata/fluview/', { params: { regions: Object.keys(HHS).join(','), epiweeks: epiweekRange() } })
    const rows = data.epidata || []
    const latest = new Map()
    for (const r of rows) { const cur = latest.get(r.region); if (!cur || r.epiweek > cur.epiweek) latest.set(r.region, r) }
    const out = []; const now = new Date().toISOString()
    for (const [region, r] of latest) {
      for (const st of HHS[region] || []) {
        out.push({ metric: 'ili', geo: { kind: 'state', key: st }, value: r.wili, unit: '%', observedAt: now, meta: { epiweek: r.epiweek, region } })
      }
    }
    return out
  }
}
