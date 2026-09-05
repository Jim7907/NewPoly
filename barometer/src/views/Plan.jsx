import React, { useEffect, useState } from 'react'
import { api, fmtMoney, fmtNum, ago } from '../api.js'
import { Brand, Pill, Idx, DriverTile, Notice, useToast, statusTone, statusLabel } from '../ui.jsx'

function List() {
  const [plans, setPlans] = useState([])
  useEffect(() => { api.get('/plans').then(setPlans) }, [])
  return <>
    <div className="head"><div><h1>Campaigns</h1><div className="sub">Every plan, its gate result, its approval and its writes.</div></div></div>
    <div className="card"><table><thead><tr><th>Plan</th><th>Brand</th><th>Opportunity</th><th className="n">Budget</th><th>Gate</th><th>Status</th><th>Writes</th><th /></tr></thead>
      <tbody>{plans.map(p => <tr key={p.id}><td className="mono">{p.id}</td><td><Brand k={p.brand} /></td><td><a href={`#/opportunity/${p.opportunity_id}`}>{p.opportunity.title}</a></td><td className="n">{fmtMoney(p.budget)}</td><td className="small">{p.gate.summary}</td><td><Pill tone={statusTone(p.status)}>{statusLabel(p.status)}</Pill></td><td className="small">{p.writes.filter(w => w.status === 'sent').length} sent · {p.writes.filter(w => w.status === 'held').length} held</td><td><a href={`#/plan/${p.id}`}><button>Open</button></a> {['live', 'done', 'killed'].includes(p.status) && <a href={`#/results/${p.id}`}><button className="soft">Results</button></a>}</td></tr>)}
        {!plans.length && <tr><td colSpan="8" className="muted">No plans yet. Open an opportunity from Home and build one.</td></tr>}</tbody></table></div>
  </>
}

export default function Plan({ id, list }) {
  if (list) return <List />
  const [p, setP] = useState(null); const [busy, setBusy] = useState(false); const [toast, say] = useToast(); const [now, setNow] = useState(Date.now())
  const load = () => api.get(`/plans/${id}`).then(setP).catch(e => say(e.message))
  useEffect(() => { load(); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [id])
  if (!p) return <div className="muted">loading…{toast}</div>
  const o = p.opportunity
  const act = async (fn, msg) => { setBusy(true); try { await fn(); await load(); if (msg) say(msg) } catch (e) { say(e.message) } finally { setBusy(false) } }
  const undoLeft = p.undo_until ? Math.max(0, Math.round((Date.parse(p.undo_until) - now) / 1000)) : 0
  const steps = ['awaiting_approval', 'approved', 'live', 'done']
  const si = Math.max(0, steps.indexOf(p.status === 'launching' ? 'live' : p.status))
  const approvedCreatives = p.creatives.filter(c => c.status === 'approved').length
  return <>
    {toast}
    <div className="head">
      <div className="row" style={{ gap: 14 }}><Idx v={o.idx} /><div><div className="row"><Brand k={p.brand} /><h1 style={{ margin: 0 }}>{o.title}</h1><Pill tone={statusTone(p.status)}>{statusLabel(p.status)}</Pill></div><div className="sub">{o.where_text} · plan {p.id} · created {ago(p.created_at)} ago{p.approved_by ? ` · approved by ${p.approved_by}` : ''}</div></div></div>
      <div className="row">
        {p.status === 'awaiting_approval' && <button className="primary" disabled={busy} onClick={() => act(() => api.post(`/plans/${id}/approve`), 'approved')}>Approve {fmtMoney(p.budget)}</button>}
        {p.status === 'approved' && <button className="primary" disabled={busy} onClick={() => act(() => api.post(`/plans/${id}/launch`), 'launched')}>Launch into {p.lines.length} platforms</button>}
        {['live', 'launching', 'approved'].includes(p.status) && <button className="danger" disabled={busy} onClick={() => { const reason = prompt(undoLeft ? `Undo (${undoLeft}s left in the window). Reason?` : 'Stop this plan. Reason?'); if (reason != null) act(() => api.post(`/plans/${id}/stop`, { reason }), undoLeft ? 'undone' : 'stopped') }}>{undoLeft ? `Undo · ${undoLeft}s` : 'Stop'}</button>}
        {['live', 'done', 'killed', 'undone'].includes(p.status) && <a href={`#/results/${id}`}><button className="soft">Results</button></a>}
        <a href={`#/opportunity/${o.id}`}><button>Creatives</button></a>
      </div>
    </div>
    <div className="row" style={{ gap: 22, marginBottom: 16 }}>{['Plan built', 'Approved', 'Live', 'Finished'].map((l, i) => <div key={l} className={`step ${i < si ? 'done' : i === si ? 'now' : ''}`}><span className="dot">{i < si ? '✓' : i + 1}</span><b>{l}</b></div>)}{p.status === 'undone' || p.status === 'killed' ? <Pill tone="grey">{statusLabel(p.status)}{p.notes ? ` · ${p.notes}` : ''}</Pill> : null}</div>
    {p.status === 'approved' && approvedCreatives === 0 && <Notice>No creative is approved yet. Launch will send platform payloads without copy; approve creatives first on the opportunity page.</Notice>}
    <div className="grid g4" style={{ marginBottom: 16 }}>{o.drivers.slice(0, 4).map(d => <DriverTile key={d.metric} d={d} />)}</div>
    <div className="grid g-3-2">
      <div className="card"><h3>Media plan <span className="muted">{fmtMoney(p.budget)} · {p.lines.length} platforms · {p.gate.holdoutExcluded || 0} holdout cells excluded</span></h3>
        <table><thead><tr><th>Platform</th><th className="n">Share</th><th className="n">Amount</th><th>Geography</th><th>Creative</th><th>Write</th></tr></thead>
          <tbody>{p.lines.map(l => { const w = p.writes.find(x => x.channel === l.channel); const c = p.creatives.find(x => x.channel === l.channel)
            return <tr key={l.channel}><td><b>{l.name}</b><div className="small muted">{l.kind}</div></td><td className="n">{Math.round(l.share * 100)}%</td><td className="n">{fmtMoney(l.amount)}{l.rerouted ? <div className="small muted">{fmtMoney(l.rerouted)} rerouted</div> : null}{l.holdsForPerson && <div className="small" style={{ color: '#96650F' }}>waits for a person</div>}</td>
              <td className="small">{l.geo.kind === 'zip3' ? `${l.geo.cells.length} cells` : l.geo.kind === 'state' ? (l.geo.states || []).join(', ') : `national · weighted to ${(l.geo.weightedBy || []).slice(0, 3).join(', ')}`}</td>
              <td className="small">{c ? <span><Pill tone={c.status === 'approved' ? 'ok' : 'grey'}>{c.status}</Pill> {c.headline}</span> : <span className="muted">none for this channel</span>}</td>
              <td className="small">{w ? <span><Pill tone={w.status === 'sent' ? 'ok' : w.status === 'held' ? 'warm' : w.status === 'failed' ? 'hot' : 'grey'}>{w.status}{w.dry_run ? ' · dry' : ''}</Pill>{w.status === 'held' && <button style={{ marginLeft: 6 }} disabled={busy} onClick={() => act(() => api.post(`/writes/${w.id}/release`), 'released')}>Release</button>}</span> : <span className="muted">not launched</span>}</td></tr> })}</tbody></table>
        {p.writes.length > 0 && <details style={{ marginTop: 10 }}><summary className="small">Payloads as sent ({p.writes.length})</summary>{p.writes.map(w => <pre key={w.id} className="mono" style={{ background: 'var(--l0)', padding: 10, borderRadius: 8, overflow: 'auto', fontSize: 11 }}>{w.channel} · {w.action} · {w.status}{w.dry_run ? ' (dry run)' : ''}{'\n'}{JSON.stringify(w.payload, null, 1)}{w.response ? '\n→ ' + JSON.stringify(w.response) : ''}</pre>)}</details>}
      </div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <div className="card"><h3>Inventory gate <span className="muted">{p.gate.summary}</span></h3>
          <div className="small muted" style={{ marginBottom: 8 }}>Days of cover at the uplifted rate ({p.gate.uplift}× baseline) against a {p.gate.days}-day window. Held SKUs reroute their spend to the sibling with the most cover; nothing is deleted.</div>
          <table><thead><tr><th>SKU</th><th className="n">Fulfillable</th><th className="n">Inbound</th><th className="n">Cover</th><th>Status</th></tr></thead>
            <tbody>{(p.gate.checks || []).map(c => <tr key={c.sku}><td className="small"><b>{c.name}</b><div className="mono muted">{c.sku}</div></td><td className="n">{fmtNum(c.fulfillable)}</td><td className="n">{fmtNum(c.inbound)}</td><td className="n">{c.coverDays == null ? '—' : `${c.coverDays}d`}</td><td><Pill tone={c.status === 'ok' ? 'ok' : c.status === 'thin' ? 'warm' : c.status === 'hold' ? 'hot' : 'grey'}>{c.status}</Pill>{c.rerouteTo && <div className="small muted">→ {c.rerouteTo}</div>}</td></tr>)}</tbody></table>
          {p.gate.blocks && <Notice tone="red" >The gate blocks this plan: every SKU is held and there is nothing in stock to reroute to.</Notice>}
        </div>
        <div className="card"><h3>Money rules</h3>
          <div className="small">{[['Event cap', 'no plan above the configured cap without a person raising it'], ['Single write hold', 'anything large waits for a person, per platform'], ['Holdout', 'locked cells are stripped again at the moment of write'], ['Undo', 'ninety seconds after launch; kill at any time after that']].map(([a, b]) => <div key={a} className="feed"><i style={{ background: 'var(--blue)' }} /><div><b>{a}</b><div className="muted">{b}</div></div></div>)}</div>
        </div>
      </div>
    </div>
  </>
}
