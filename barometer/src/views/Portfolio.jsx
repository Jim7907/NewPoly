import React, { useEffect, useState } from 'react'
import { api, fmtMoney, BRAND_STYLE, brandOf, METRIC_NAME } from '../api.js'
import { Idx, Brand, Pill, statusTone, statusLabel } from '../ui.jsx'

const FAMILIES = ['environmental', 'epidemiological', 'cultural', 'economic', 'calendar', 'firstparty']
const familyOf = (m) => /^(aqi|pm25|fires|alert|pollen|temp|dew|rh)/.test(m) ? 'environmental' : m === 'ili' ? 'epidemiological' : m === 'recipe_velocity' ? 'cultural' : /^(power|food)/.test(m) ? 'economic' : /^cal_/.test(m) ? 'calendar' : /^fp_/.test(m) ? 'firstparty' : 'other'

export default function Portfolio() {
  const [brands, setBrands] = useState([]); const [opps, setOpps] = useState([]); const [plans, setPlans] = useState([])
  useEffect(() => { api.get('/brands').then(setBrands); api.get('/opportunities').then(setOpps); api.get('/plans').then(setPlans) }, [])
  return <>
    <div className="head"><div><h1>Four brands, one engine</h1><div className="sub">The same grid, the same creative engine and the same holdout. Only the signals and the claim rules change per brand.</div></div></div>
    <div className="grid g4" style={{ marginBottom: 16 }}>
      {brands.map(b => { const bo = opps.filter(o => brandOf(o.brand) === b.id); const live = plans.filter(p => brandOf(p.brand) === b.id && p.status === 'live'); const s = BRAND_STYLE[b.id]
        return <div key={b.id} className="card" style={{ borderTop: `3px solid ${b.color}` }}>
          <div className="row between"><Brand k={b.id} /><span className="small muted">{b.families.map(f => f.name).join(' · ')}</span></div>
          <div className="stat"><div className="v">{bo.length}</div><div className="s">open opportunit{bo.length === 1 ? 'y' : 'ies'} · {fmtMoney(bo.reduce((a, o) => a + (o.forecast.revenue || 0), 0))} forecast</div></div>
          <div className="small" style={{ marginTop: 8 }}><b>Signals:</b> {[...new Set(b.families.flatMap(f => f.signals.map(x => familyOf(x.metric))))].join(', ')}</div>
          <div className="small muted" style={{ marginTop: 4 }}>{live.length} live · {fmtMoney(live.reduce((a, p) => a + p.budget, 0))} in market</div>
        </div> })}
    </div>
    <div className="grid g-3-2">
      <div className="card"><h3>Opportunities across the portfolio <span className="muted">ranked by the same index</span></h3>
        <table><thead><tr><th>Index</th><th>Brand</th><th>Opportunity</th><th>Where</th><th>Top driver</th><th className="n">Forecast</th><th>Status</th></tr></thead>
          <tbody>{opps.map(o => <tr key={o.id}><td><Idx v={o.idx} /></td><td><Brand k={o.brand} /></td><td><a href={`#/opportunity/${o.id}`}><b>{o.title}</b></a></td><td className="small">{o.where_text}</td><td className="small">{o.drivers[0] ? `${METRIC_NAME[o.drivers[0].metric] || o.drivers[0].metric} · ${o.drivers[0].share}%` : '—'}</td><td className="n">{fmtMoney(o.forecast.revenue)}</td><td><Pill tone={statusTone(o.status)}>{statusLabel(o.status)}</Pill></td></tr>)}
            {!opps.length && <tr><td colSpan="7" className="muted">No open opportunities. Cells still carry an index; see the map on Home.</td></tr>}</tbody></table>
      </div>
      <div className="card"><h3>Signal matrix <span className="muted">which families move which brand</span></h3>
        <table className="matrix"><thead><tr><th>Family</th>{brands.map(b => <th key={b.id} style={{ textAlign: 'center' }}>{b.name}</th>)}</tr></thead>
          <tbody>{FAMILIES.map(fam => <tr key={fam}><td style={{ textTransform: 'capitalize' }}>{fam === 'firstparty' ? 'First-party devices' : fam}</td>{brands.map(b => { const w = b.families.flatMap(f => f.signals).filter(s => familyOf(s.metric) === fam).reduce((a, s) => a + s.weight, 0)
            return <td key={b.id}><span className="cell" title={`${w} weight`} style={{ background: w === 0 ? 'var(--l0)' : w < 15 ? '#F7D9C4' : w < 30 ? '#EFAE85' : '#DE7B51' }} /></td> })}</tr>)}</tbody></table>
        <div className="small muted" style={{ marginTop: 8 }}>Darker = more weight in that brand's index. Most cells are shared, which is the case for one platform rather than four.</div>
      </div>
    </div>
  </>
}
