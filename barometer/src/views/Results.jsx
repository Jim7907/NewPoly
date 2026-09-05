import React, { useEffect, useState } from 'react'
import { api, fmtMoney, fmtNum } from '../api.js'
import { Stat, Notice, Brand } from '../ui.jsx'

function Chart({ series, postFrom }) {
  const W = 760, H = 240, P = { l: 40, r: 10, t: 10, b: 28 }
  const max = Math.max(1, ...series.map(s => Math.max(s.treated, s.control)))
  const x = (i) => P.l + (i / Math.max(1, series.length - 1)) * (W - P.l - P.r), y = (v) => P.t + (1 - v / max) * (H - P.t - P.b)
  const path = (k) => series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`).join(' ')
  const i0 = series.findIndex(s => s.day >= postFrom)
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" style={{ width: '100%', height: 'auto' }}>
    {i0 >= 0 && <rect x={x(i0)} y={P.t} width={x(series.length - 1) - x(i0)} height={H - P.t - P.b} fill="#EBF3FE" />}
    {[0, 0.5, 1].map(f => <g key={f}><line x1={P.l} x2={W - P.r} y1={y(max * f)} y2={y(max * f)} stroke="#EEF3F9" /><text x={P.l - 6} y={y(max * f) + 4} textAnchor="end">{Math.round(max * f)}</text></g>)}
    <path d={path('control')} fill="none" stroke="#8FA3B8" strokeWidth="2" strokeDasharray="4 3" />
    <path d={path('treated')} fill="none" stroke="#2F7BF0" strokeWidth="2.5" />
    {series.map((s, i) => (i % Math.ceil(series.length / 8) === 0) && <text key={s.day} x={x(i)} y={H - 8} textAnchor="middle">{s.day.slice(5)}</text>)}
    <text x={W - P.r} y={P.t + 12} textAnchor="end" fill="#2F7BF0">treated</text><text x={W - P.r} y={P.t + 26} textAnchor="end" fill="#8FA3B8">holdout</text>
  </svg>
}

export default function Results({ id }) {
  const [r, setR] = useState(null); const [plan, setPlan] = useState(null); const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/plans/${id}`).then(setPlan); api.get(`/plans/${id}/results`).then(setR).catch(e => setErr(e.message)) }, [id])
  if (err) return <Notice tone="red">{err}</Notice>
  if (!r || !plan) return <div className="muted">loading…</div>
  return <>
    <div className="head"><div><h1><Brand k={plan.brand} /> {plan.opportunity.title} · results</h1><div className="sub">{r.window.postFrom} to {r.window.postTo} · {r.treatedCells} treated cells against {r.holdoutCells} locked holdout cells · pre-period {r.window.preFrom} to {r.window.preTo}</div></div><a href={`#/plan/${id}`}><button>Back to plan</button></a></div>
    {!r.hasData && <Notice>{r.note}. Until then this page shows the design of the measurement, not a number. <a href="#/system">Load demo sales</a> to see the mechanics.</Notice>}
    {r.hasData && <div className="grid g4" style={{ margin: '14px 0' }}>
      <Stat k="Incremental revenue" v={fmtMoney(r.incrementalRevenue)} s="above the holdout counterfactual" />
      <Stat k="Lift" v={`${r.lift >= 0 ? '+' : ''}${(r.lift * 100).toFixed(1)}%`} s={`90% interval ${(r.ci90[0] * 100).toFixed(1)} to ${(r.ci90[1] * 100).toFixed(1)}%${r.significant ? '' : ' · crosses zero'}`} dot={r.significant ? 'var(--green)' : 'var(--amber)'} />
      <Stat k="Return on spend" v={r.roas == null ? '—' : `${r.roas}×`} s={`${fmtMoney(r.spend)} approved`} dot="var(--green)" />
      <Stat k="Units" v={fmtNum(r.incrementalUnits)} s={`${fmtNum(r.treated.post)} sold vs ${fmtNum(r.counterfactual)} expected`} dot="var(--ink3)" />
    </div>}
    <div className="grid g-3-2">
      <div className="card"><h3>Daily units · treated areas against the holdout <span className="muted">shaded = campaign window</span></h3><Chart series={r.series} postFrom={r.window.postFrom} />
        <div className="small muted">The gap between the lines inside the shaded window is what the campaign added. Everything outside it is demand we would have had anyway and is not claimed.</div></div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <div className="card"><h3>By channel <span className="muted">spend share</span></h3>
          {r.hasData ? <table><thead><tr><th>Channel</th><th className="n">Spend</th><th className="n">Share</th><th className="n">Attributed</th></tr></thead><tbody>{r.byChannel.map(c => <tr key={c.channel}><td>{c.channel}</td><td className="n">{fmtMoney(c.spend)}</td><td className="n">{Math.round(c.share * 100)}%</td><td className="n">{fmtMoney(r.incrementalRevenue * c.share)}</td></tr>)}</tbody></table> : <div className="muted small">Available once sales rows exist.</div>}
          <div className="small muted" style={{ marginTop: 8 }}>Attributed by spend share. Per-channel holdouts are a later phase; this column is not a measurement.</div></div>
        <div className="card"><h3>Method</h3><div className="small">Difference-in-differences on daily units. Counterfactual = treated pre-period × (holdout post ÷ holdout pre). Interval from 500 bootstrap resamples over treated cells. If the interval crosses zero the playbook is not reused.</div>
          <button style={{ marginTop: 10 }} onClick={() => api.post('/measure/refit', { brand: plan.brand }).then(x => alert(JSON.stringify(x, null, 2)))}>Refit weights from measured plans</button></div>
      </div>
    </div>
  </>
}
