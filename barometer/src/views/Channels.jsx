import React, { useEffect, useState } from 'react'
import { api, fmtMoney } from '../api.js'
import { Pill } from '../ui.jsx'

const READS = { amazon_sp: 'Campaign performance, search terms', amazon_dsp: 'Postal-code index performance', amazon_amc: 'Query and conversion signals', meta: 'Ad set delivery, conversions', google: 'Search terms, conversions', tiktok: 'Campaign delivery', walmart: 'Sponsored performance', klaviyo: 'Segment membership, sends', shopify: 'Orders by region', app_push: 'Aggregated device readings, filter life' }
const WRITES = { amazon_sp: 'Budget caps, top-of-search adjustments, event keywords', amazon_dsp: 'Postal-code index values 0–100', amazon_amc: 'Rule-based audiences pushed to DSP and SD', meta: 'Campaign and ad set with lat/lon radius targeting per cell', google: 'Search campaign with proximity targeting per cell', tiktok: 'Campaign with state targeting', walmart: 'Sponsored budget', klaviyo: 'Segment by ZIP3 prefix and a campaign draft', shopify: 'Storefront event banner', app_push: 'Push to the app team webhook, resolved to devices on their side' }

export default function Channels({ status }) {
  const [cfg, setCfg] = useState(null); const [plans, setPlans] = useState([])
  useEffect(() => { api.get('/config').then(setCfg); api.get('/plans').then(setPlans) }, [])
  const chans = status ? status.channels : []
  const latest = plans[0]
  return <>
    <div className="head"><div><h1>Channels</h1><div className="sub">What each connection reads, what it writes, and the standing limits that apply to every write.</div></div></div>
    <div className="grid g-3-2">
      <div className="grid g2">
        {chans.map(c => <div key={c.id} className="card">
          <div className="row between"><b>{c.name}</b><Pill tone={c.live ? 'hot' : c.configured ? 'ok' : 'grey'}>{c.mode}</Pill></div>
          <div className="small" style={{ marginTop: 8 }}><span className="muted">Reads</span> {READS[c.id]}</div>
          <div className="small"><span className="muted">Writes</span> {WRITES[c.id]}</div>
          {!c.configured && <div className="small muted" style={{ marginTop: 6 }}>needs {c.requires.join(', ')} in .env</div>}
          {c.shapeOnly && <div className="small muted" style={{ marginTop: 6 }}>Payload is recorded for hand-off; the platform API is partner-gated or in beta.</div>}
        </div>)}
      </div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <div className="card"><h3>Routing proposal <span className="muted">{latest ? latest.opportunity.title : 'latest plan'}</span></h3>
          {latest ? <table><thead><tr><th>Platform</th><th className="n">Share</th><th className="n">Amount</th><th>Geo</th></tr></thead><tbody>{latest.lines.map(l => <tr key={l.channel}><td>{l.name}</td><td className="n">{Math.round(l.share * 100)}%</td><td className="n">{fmtMoney(l.amount)}{l.holdsForPerson && <div className="small muted">waits for a person</div>}</td><td className="small">{l.geo.kind === 'zip3' ? `${l.geo.cells.length} cells` : l.geo.kind === 'state' ? (l.geo.states || []).join(', ') : 'national'}</td></tr>)}<tr><td><b>Total</b></td><td /><td className="n"><b>{fmtMoney(latest.budget)}</b></td><td /></tr></tbody></table> : <div className="muted small">No plan yet. Open an opportunity and build one.</div>}
        </div>
        <div className="card"><h3>Standing permissions</h3>
          {[['Create and change campaigns', 'Within the budget cap and date range you approve'], ['Upload audiences and indexes', 'Aggregated only, never a household identifier'], ['Publish approved creative', 'From the generated set, after the claim check']].map(([a, b]) => <div key={a} className="feed"><i style={{ background: 'var(--green)' }} /><div><b>{a}</b><div className="small muted">{b}</div></div></div>)}
          <div style={{ marginTop: 10 }}>{cfg && [['Never moves money on its own', `Any single write above $${cfg.money.singleWriteHoldUsd.toLocaleString()} waits for a person`], ['Never touches the holdout', `${status ? status.holdoutCells : ''} ZIP3 areas excluded from every write`], ['Never launches with the kill switch on', 'Released only by a person, logged in the audit trail']].map(([a, b]) => <div key={a} className="feed"><i style={{ background: 'var(--red)' }} /><div><b>{a}</b><div className="small muted">{b}</div></div></div>)}</div>
          <div className="small muted" style={{ marginTop: 10 }}>Live writes are {status && status.liveWrites ? 'ON' : 'OFF'} (LIVE_WRITES in .env). Off means every write is recorded exactly as it would be sent and nothing leaves.</div>
        </div>
      </div>
    </div>
  </>
}
