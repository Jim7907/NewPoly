import React, { useEffect, useState } from 'react'
import { api, fmtMoney, fmtNum, ago, brandOf, BRAND_STYLE } from '../api.js'
import { Idx, Brand, Pill, Stat, USMap, FeedRow, statusTone, statusLabel } from '../ui.jsx'

export default function Home({ status }) {
  const [opps, setOpps] = useState([]); const [brand, setBrand] = useState('all'); const [grid, setGrid] = useState(null); const [plans, setPlans] = useState([])
  const [mapBrand, setMapBrand] = useState('levoit:air')
  useEffect(() => { const load = () => { api.get('/opportunities').then(setOpps); api.get('/plans?status=live').then(setPlans) }; load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [])
  useEffect(() => { api.get(`/grid?brand=${mapBrand}&horizon=act`).then(setGrid) }, [mapBrand, status && status.lastScore])
  const shown = opps.filter(o => brand === 'all' || brandOf(o.brand) === brand)
  const forecast = shown.reduce((a, o) => a + (o.forecast.revenue || 0), 0)
  const ready = shown.filter(o => ['ready', 'drafting', 'detected'].includes(o.status))
  const feeds = status ? status.feeds : []
  const live = feeds.filter(f => f.enabled && f.lastOk && !f.lastError).length
  return <>
    <div className="head">
      <div>
        <h1>{shown.length ? `${shown.length} opportunit${shown.length === 1 ? 'y is' : 'ies are'} live right now` : 'No opportunities above threshold right now'}</h1>
        <div className="sub">{status ? `signals refreshed ${ago(status.lastScore)} ago · ${fmtMoney(forecast)} forecast incremental across the next 14 days (estimate)` : 'loading…'}</div>
      </div>
      <div className="row">
        <select value={brand} onChange={e => setBrand(e.target.value)}><option value="all">All brands</option>{Object.entries(BRAND_STYLE).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select>
        <button onClick={() => api.post('/score/run').then(() => location.reload())}>Re-score now</button>
      </div>
    </div>
    <div className="grid g4" style={{ marginBottom: 16 }}>
      <Stat k="Forecast incremental" v={fmtMoney(forecast)} s="next 14 days · estimate until backtested" />
      <Stat k="Ready to launch" v={ready.length} s={`${shown.reduce((a, o) => a + o.creativeCount, 0)} creatives drafted`} dot="var(--green)" />
      <Stat k="Spend today" v={fmtMoney(status ? status.spendToday : 0)} s={`of ${fmtMoney(status ? status.money.dailyCapUsd : 0)} daily cap`} dot="var(--ink3)" />
      <Stat k="Needs a decision" v={status ? status.counts.awaiting + status.counts.heldWrites : 0} s="approvals and held writes" dot="var(--amber)" />
    </div>
    <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Opportunities detected <span className="muted" style={{ fontWeight: 500, fontSize: 12.5, marginLeft: 8 }}>creative drafted and channels proposed for each</span></h3>
    <div className="grid g3" style={{ marginBottom: 16 }}>
      {shown.slice(0, 6).map(o => <div key={o.id} className={`opp ${o.idx >= 81 ? 'hot' : ''}`}>
        <div className="row between"><div className="row"><Idx v={o.idx} /><div><div className="row"><Brand k={o.brand} /><span className="title">{o.title}</span></div><div className="where">{o.where_text}</div></div></div><Pill tone={statusTone(o.status)}>{statusLabel(o.status)}</Pill></div>
        <div className="kpis"><div>Forecast revenue<b>{fmtMoney(o.forecast.revenue)}</b></div><div>Units<b>{fmtNum(o.forecast.units)}</b></div><div>Cells<b>{o.zip3s.length}</b></div><div>Channels<b>{o.channels}</b></div><div>Creatives<b>{o.creativeCount}</b></div></div>
        <div className="row"><a href={`#/opportunity/${o.id}`}><button className="primary">{o.plan ? 'Open plan' : 'Review and launch'}</button></a><button onClick={() => api.post(`/opportunities/${o.id}/dismiss`).then(() => setOpps(opps.filter(x => x.id !== o.id)))}>Dismiss</button></div>
      </div>)}
      {!shown.length && <div className="card muted">Nothing above the detection threshold for this filter. The map below shows where demand is building. Feeds keep polling; new opportunities appear here automatically.</div>}
    </div>
    <div className="grid g-3-2">
      <div className="card">
        <div className="row between"><h3>Where demand is moving</h3><div className="row"><select value={mapBrand} onChange={e => setMapBrand(e.target.value)}><option value="levoit:air">Levoit · air</option><option value="levoit:humidity">Levoit · humidity</option><option value="cosori:kitchen">Cosori · kitchen</option><option value="etekcity:measure">Etekcity</option><option value="pawsync:pet">Pawsync</option></select><span className="small muted">index 0–100 · next 72 h</span></div></div>
        {grid ? <USMap cells={grid.cells} onPick={(c) => (location.hash = `#/system/cell/${c.zip3}`)} /> : <div className="muted">loading grid…</div>}
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <div className="card"><div className="row between"><h3>Campaigns running</h3><a href="#/plans" className="small">View all</a></div>
          {plans.length ? plans.map(p => <div key={p.id} className="feed"><Brand k={p.brand} /><span>{p.opportunity.title}</span><span className="age">{fmtMoney(p.budget)} · {p.writes.filter(w => w.status === 'sent').length} writes</span></div>) : <div className="muted small">Nothing live. Approved plans appear here with their spend and writes.</div>}
        </div>
        <div className="card"><div className="row between"><h3>Intelligence sources</h3><span className="small" style={{ color: 'var(--green)', fontWeight: 700 }}>{live} of {feeds.length} live</span></div>
          {feeds.map(f => <FeedRow key={f.id} f={f} />)}
          <div className="small muted" style={{ marginTop: 10 }}>Device readings are aggregated to ZIP3 areas with at least {status ? fmtNum(status.privacy.minDevicesPerCell) : '1,000'} devices. No household is targeted individually.</div>
        </div>
      </div>
    </div>
  </>
}
