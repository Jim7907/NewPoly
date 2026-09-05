import React, { useEffect, useState } from 'react'
import { api, fmtNum, ago, FEED_NAME, METRIC_NAME } from '../api.js'
import { FeedRow, Pill, Notice, useToast, Idx, Brand } from '../ui.jsx'

export default function System({ status, onChange }) {
  const [hold, setHold] = useState([]); const [inv, setInv] = useState([]); const [audit, setAudit] = useState([]); const [fp, setFp] = useState(null); const [toast, say] = useToast()
  const [cell, setCell] = useState(null)
  const sub = location.hash.split('/')
  const load = () => { api.get('/holdout').then(setHold); api.get('/inventory').then(setInv); api.get('/audit?limit=40').then(setAudit); api.get('/firstparty/status').then(setFp); if (sub[2] === 'cell' && sub[3]) api.get(`/grid/${sub[3]}`).then(setCell) }
  useEffect(load, [location.hash])
  const act = (fn, msg) => fn().then(() => { load(); onChange && onChange(); if (msg) say(msg) }).catch(e => say(e.message))
  if (!status) return <div className="muted">loading…</div>
  const curl = `curl -X POST http://<host>:3004/api/firstparty/readings \\\n  -H 'Authorization: Bearer $FIRSTPARTY_INGEST_TOKEN' -H 'Content-Type: application/json' \\\n  -d '{"readings":[{"zip3":"972","brand":"levoit","metric":"indoor_pm25","value":41.2,"deviceCount":1840,"observedAt":"${new Date().toISOString()}"}]}'`
  return <>
    {toast}
    <div className="head"><div><h1>System</h1><div className="sub">Feeds, the holdout, the open first-party adapter, inventory, and the audit trail.</div></div>
      <div className="row"><button className={status.killSwitch ? 'soft' : 'danger'} onClick={() => act(() => api.post('/settings/kill-switch', { on: !status.killSwitch }), status.killSwitch ? 'kill switch released' : 'kill switch ON')}>{status.killSwitch ? 'Release kill switch' : 'Kill switch'}</button><button onClick={() => act(() => api.post('/feeds/run'), 'feeds polled and re-scored')}>Poll all feeds</button></div></div>
    {cell && <div className="card" style={{ marginBottom: 16 }}><div className="row between"><h3>Cell {cell.zip3} · {cell.state} <span className="muted">{cell.zctas} ZCTAs · {fmtNum(cell.landKm2)} km²{cell.holdout ? ' · holdout' : ''}</span></h3><a href="#/system"><button>Close</button></a></div>
      <div className="grid g3">{cell.scores.filter(s => s.horizon !== 'watch').map(s => <div key={s.brand + s.horizon} className="driver"><div className="row between"><Brand k={s.brand} /><span className="small muted">{s.horizon}</span><Idx v={s.idx} /></div>{s.drivers.slice(0, 4).map(d => <div key={d.metric} className="small" style={{ marginTop: 4 }}>{METRIC_NAME[d.metric] || d.metric}: <b>{typeof d.value === 'number' ? +d.value.toFixed(1) : d.value}</b> · {d.share}% · fresh {d.fresh}</div>)}{!s.drivers.length && <div className="small muted">no signals present</div>}</div>)}</div></div>}
    <div className="grid g-3-2">
      <div className="grid" style={{ alignContent: 'start' }}>
        <div className="card"><h3>Feeds <span className="muted">{status.feeds.filter(f => f.enabled).length} enabled</span></h3>
          <table><thead><tr><th>Feed</th><th>Family</th><th>Cadence</th><th className="n">Last count</th><th>Last ok</th><th>State</th></tr></thead>
            <tbody>{status.feeds.map(f => <tr key={f.id}><td><b>{f.name}</b>{f.requires && <div className="mono muted">{f.requires}</div>}</td><td className="small">{f.family}</td><td className="mono">{f.cadence}</td><td className="n">{fmtNum(f.lastCount)}</td><td className="small">{f.lastOk ? ago(f.lastOk) + ' ago' : '—'}</td><td>{!f.enabled ? <Pill>waiting for key</Pill> : f.lastError ? <Pill tone="hot">error</Pill> : f.lastOk ? <Pill tone="ok">live</Pill> : <Pill tone="warm">pending</Pill>}{f.lastError && <div className="small muted" style={{ maxWidth: 260 }}>{f.lastError}</div>}<button style={{ marginTop: 4 }} onClick={() => act(() => api.post(`/feeds/run?id=${f.id}`), `${f.name} polled`)}>Poll</button></td></tr>)}</tbody></table></div>
        <div className="card"><h3>First-party adapter <span className="muted">left open by design</span></h3>
          <div className="row" style={{ marginBottom: 8 }}><Pill tone={fp && fp.connected ? 'ok' : 'grey'}>{fp && fp.connected ? 'receiving' : 'not connected'}</Pill>{fp && fp.connected && <span className="small">{fmtNum(fp.readings)} readings · {fp.cells} cells · {fp.cellsAboveFloor} above the {fmtNum(fp.privacyFloor)}-device floor · latest {ago(fp.latest)} ago</span>}</div>
          <div className="small">Nothing here talks to the VeSync IoT platform. The team that owns device data aggregates to ZIP3 on their side and POSTs it in. Barometer never receives a device id, a household or a coordinate. Accepted metrics: <span className="mono">{fp ? fp.metrics.join(', ') : ''}</span>.</div>
          <pre className="mono" style={{ background: 'var(--l0)', padding: 10, borderRadius: 8, overflow: 'auto', fontSize: 11, marginTop: 8 }}>{curl}</pre></div>
        <div className="card"><h3>Inventory <span className="muted">{inv.filter(i => i.source !== 'catalog').length} of {inv.length} SKUs reporting</span></h3>
          <table><thead><tr><th>SKU</th><th>Brand</th><th className="n">Fulfillable</th><th className="n">Inbound</th><th className="n">Daily</th><th className="n">Cover</th><th>Source</th></tr></thead>
            <tbody>{inv.map(i => <tr key={i.sku}><td className="mono">{i.sku}</td><td><Brand k={i.brand} /></td><td className="n">{fmtNum(i.fulfillable)}</td><td className="n">{fmtNum(i.inbound)}</td><td className="n">{fmtNum(i.daily_rate)}</td><td className="n">{i.coverDays == null ? '—' : i.coverDays + 'd'}</td><td className="small">{i.source}</td></tr>)}</tbody></table>
          <div className="row" style={{ marginTop: 10 }}><button onClick={() => act(() => api.post('/inventory/sync-amazon').then(r => { if (r.skipped) throw new Error(r.reason) }), 'Amazon inventory synced')}>Sync from Amazon SP-API</button><span className="small muted">or POST /api/inventory with rows [{'{'}sku, fulfillable, inbound, dailyRate{'}'}]</span></div></div>
      </div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <div className="card"><h3>Holdout <span className="muted">{hold.length} cells, locked {hold[0] ? ago(hold[0].locked_at) + ' ago' : ''}</span></h3>
          <div className="small muted" style={{ marginBottom: 8 }}>Excluded from every write, permanently. Chosen once, stratified across states on typical cells. Every result is measured against these.</div>
          <div className="row wrap" style={{ gap: 6 }}>{hold.map(h => <span key={h.zip3} className="tag" title={`${h.landKm2} km²`}>{h.zip3} {h.state}</span>)}</div></div>
        <div className="card"><h3>Demo data <span className="muted">synthetic, labelled</span></h3>
          <div className="small">Loads 45 days of made-up sales for every cell and an inventory position with one deliberately thin SKU, so the gate, launch and measurement can be walked through before Data Kiosk and SP-API are connected. Everything it writes is tagged <span className="mono">source=demo</span>.</div>
          <div className="row" style={{ marginTop: 8 }}><button onClick={() => act(() => api.post('/demo/seed', { confirm: 'DEMO' }), 'demo data loaded')}>Load demo data</button><button onClick={() => act(() => api.post('/demo/clear'), 'demo data cleared')}>Clear</button></div></div>
        <div className="card"><h3>Audit trail</h3>{audit.map(a => <div key={a.id} className="feed"><span className="mono muted" style={{ fontSize: 11 }}>{a.at.slice(5, 16).replace('T', ' ')}</span><span><b>{a.action}</b> <span className="muted">{a.actor}</span></span><span className="age" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.detail ? JSON.stringify(a.detail).slice(0, 80) : ''}</span></div>)}</div>
      </div>
    </div>
  </>
}
