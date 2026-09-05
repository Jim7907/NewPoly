import React, { useEffect, useState } from 'react'
import { api, fmtMoney, fmtNum, ago, METRIC_NAME } from '../api.js'
import { Idx, Brand, Pill, USMap, DriverTile, Notice, useToast, statusTone, statusLabel } from '../ui.jsx'

const SIZE = { meta_feed: [220, 220], meta_story: [150, 267], tiktok: [150, 267], amazon_banner: [300, 100], amazon_headline: [300, 60], google_rsa: [300, 90], app_push: [260, 70], email: [300, 150] }

function Ad({ c, onEdit, onStatus }) {
  const [w, h] = SIZE[c.format] || [220, 140]
  const bad = c.checks.filter(x => !x.pass)
  return <div className="ad">
    <div className="top"><span>{c.label}</span><span style={{ marginLeft: 'auto' }}><Pill tone={c.status === 'approved' ? 'ok' : c.status === 'blocked' ? 'hot' : 'calm'}>{c.status}</Pill></span></div>
    {c.format !== 'amazon_headline' && <div className="img" style={{ height: Math.min(140, h * 0.55) }}>{c.format.replace('_', ' ').toUpperCase()} · {w}×{h}</div>}
    <div className="body"><div className="h">{c.headline}</div>{c.body && <div className="b">{c.body}</div>}<span className="cta">{c.cta}</span>
      <div style={{ marginTop: 8 }}>{c.checks.map(x => <div key={x.rule} className="check"><i className={x.pass ? 'ok' : 'bad'}>{x.pass ? '✓' : '!'}</i><span>{x.rule}{!x.pass && <span className="muted"> — {x.detail}</span>}</span></div>)}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => { const headline = prompt('Headline', c.headline); if (headline == null) return; const body = c.body ? prompt('Body', c.body) : ''; onEdit(c.id, { headline, body: body ?? c.body }) }}>Edit</button>
        {c.status !== 'approved' && <button className="soft" disabled={!!bad.length} onClick={() => onStatus(c.id, 'approved')}>Approve</button>}
        {c.status === 'approved' && <button onClick={() => onStatus(c.id, 'draft')}>Unapprove</button>}
      </div></div>
  </div>
}

export default function Opportunity({ id, status }) {
  const [o, setO] = useState(null); const [grid, setGrid] = useState(null); const [budget, setBudget] = useState(''); const [busy, setBusy] = useState(false); const [toast, say] = useToast()
  const load = () => api.get(`/opportunities/${id}`).then(x => { setO(x); return api.get(`/grid?brand=${x.brand}&horizon=${x.horizon}`).then(setGrid) }).catch(e => say(e.message))
  useEffect(() => { load() }, [id])
  if (!o) return <div className="muted">loading…{toast}</div>
  const cr = o.creatives
  const approved = cr.creatives.filter(c => c.status === 'approved').length
  const act = async (fn, msg) => { setBusy(true); try { await fn(); await load(); if (msg) say(msg) } catch (e) { say(e.message) } finally { setBusy(false) } }
  const plan = o.plans[0]
  return <>
    {toast}
    <div className="head">
      <div className="row" style={{ gap: 14 }}><Idx v={o.idx} /><div><div className="row"><Brand k={o.brand} /><h1 style={{ margin: 0 }}>{o.title}</h1><Pill tone={statusTone(o.status)}>{statusLabel(o.status)}</Pill></div><div className="sub">{o.where_text} · {o.zip3s.length} cells · {o.horizon === 'act' ? 'act within 72 h' : 'schedule 3–7 days'} · index {o.label} · updated {ago(o.updated_at)} ago{o.holdoutCells ? ` · ${o.holdoutCells} holdout cells excluded` : ''}</div></div></div>
      <div className="row">
        {plan ? <a href={`#/plan/${plan.id}`}><button className="primary">Open plan · {statusLabel(plan.status)}</button></a> : <>
          <input placeholder={`budget, default ${fmtMoney(o.forecast.revenue * (status ? status.money.budgetPerForecastRevenue : 0.2))}`} value={budget} onChange={e => setBudget(e.target.value)} style={{ width: 200 }} />
          <button className="primary" disabled={busy} onClick={() => act(async () => { const p = await api.post(`/opportunities/${id}/plan`, { budget: budget ? Number(budget) : undefined }); location.hash = `#/plan/${p.id}` })}>Build the plan</button></>}
      </div>
    </div>
    <div className="grid g4" style={{ marginBottom: 16 }}>
      {o.drivers.slice(0, 4).map(d => <DriverTile key={d.metric} d={d} />)}
    </div>
    <div className="grid g-3-2" style={{ marginBottom: 16 }}>
      <div className="card"><h3>Cells in this opportunity <span className="muted">{o.states.join(' · ')}</span></h3>{grid ? <USMap cells={grid.cells} highlight={o.zip3s} height={260} /> : <div className="muted">loading grid…</div>}</div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <div className="card"><h3>Forecast <span className="muted">estimate</span></h3>
          <div className="kpis"><div>Revenue<b>{fmtMoney(o.forecast.revenue)}</b></div><div>Units<b>{fmtNum(o.forecast.units)}</b></div><div>Window<b>{o.forecast.days} days</b></div></div>
          <div className="small muted" style={{ marginTop: 8 }}>{o.forecast.basis}. {o.forecast.holdoutNote}.</div></div>
        <div className="card"><h3>The brief <span className="muted">{cr.brief ? `${cr.brief.generatedBy === 'template' ? 'template' : cr.brief.generatedBy}` : 'not written yet'}</span></h3>
          {cr.brief ? <div className="small">
            <div><b>Signal</b><ul style={{ margin: '2px 0 8px 18px', padding: 0 }}>{cr.brief.signal.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
            <div><b>Evidence</b><div className="muted">{cr.brief.evidence}</div></div>
            <div style={{ marginTop: 6 }}><b>Angle</b><div>{cr.brief.angle}</div></div>
            <div style={{ marginTop: 6 }}><b>Off limits</b><div className="muted">{cr.brief.offLimits}</div></div>
            {cr.brief.headlinePool && cr.brief.headlinePool.length > 0 && <div style={{ marginTop: 6 }}><b>Headline pool</b>{cr.brief.headlinePool.map((h, i) => <div key={i} className="row between" style={{ padding: '3px 0', borderBottom: '1px solid #EEF3F9' }}><span>{h.headline}</span><span className="mono muted">{h.predictedCtr != null ? `${(h.predictedCtr * 100).toFixed(1)}% est.` : h.tone || ''}</span></div>)}</div>}
          </div> : <div className="muted small">Creative is drafted automatically for new opportunities. Generate now if it has not arrived.</div>}
          <button style={{ marginTop: 10 }} disabled={busy} onClick={() => act(() => api.post(`/opportunities/${id}/creatives`), 'creative regenerated')}>{cr.brief ? 'Regenerate' : 'Generate creative'}</button>
          {!cr.generationEnabled && <div className="small muted" style={{ marginTop: 6 }}>Template copy — set ANTHROPIC_API_KEY for generated creative ({cr.model}).</div>}
        </div>
      </div>
    </div>
    <div className="card">
      <div className="row between"><h3>Creative studio <span className="muted">{cr.creatives.length} assets · {approved} approved · claim check on every one</span></h3>{!approved && cr.creatives.length > 0 && <Notice>Approve at least one creative per channel before launch. Blocked creatives failed the claim check and cannot be approved until edited.</Notice>}</div>
      <div className="grid g4" style={{ marginTop: 10 }}>{cr.creatives.map(c => <Ad key={c.id} c={c} onEdit={(cid, f) => act(() => api.patch(`/creatives/${cid}`, f), 'saved and re-checked')} onStatus={(cid, s) => act(() => api.post(`/creatives/${cid}/status`, { status: s }))} />)}</div>
    </div>
  </>
}
