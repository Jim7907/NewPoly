import React, { useEffect, useState } from 'react'
import { LADDER, LADDER_INK, band, BRAND_STYLE, brandOf, ago, METRIC_NAME, METRIC_UNIT } from './api.js'

export const Idx = ({ v }) => { const b = band(v || 0); return <div className="idx" style={{ background: LADDER[b], color: LADDER_INK[b] }}><small>IDX</small>{Math.round(v || 0)}</div> }
export const Brand = ({ k }) => { const s = BRAND_STYLE[brandOf(k)] || { bg: '#eee', ink: '#333', name: k }; return <span className="brand" style={{ background: s.bg, color: s.ink }}>{s.name}</span> }
export const Pill = ({ tone = 'grey', children }) => <span className={`pill ${tone}`}>{children}</span>
export const Stat = ({ k, v, s, dot }) => <div className="card stat"><div className="k"><i style={{ background: dot || 'var(--blue)' }} />{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
export const Ladder = () => <div className="legend"><span>Quiet</span>{LADDER.map((c, i) => <i key={i} style={{ background: c }} />)}<span>Extreme</span></div>
export const Notice = ({ tone = '', children }) => <div className={`notice ${tone}`}>{children}</div>
export const statusTone = (s) => ({ detected: 'calm', drafting: 'calm', ready: 'warm', scheduled: 'warm', live: 'hot', done: 'ok', awaiting_approval: 'warm', approved: 'ok', launching: 'hot', undone: 'grey', killed: 'grey', faded: 'grey', dismissed: 'grey' }[s] || 'grey')
export const statusLabel = (s) => ({ detected: 'detected', drafting: 'drafting', ready: 'ready to launch', scheduled: 'scheduled', live: 'live', done: 'finished', awaiting_approval: 'needs approval', approved: 'approved', launching: 'launching', undone: 'undone', killed: 'stopped', faded: 'faded', dismissed: 'dismissed' }[s] || s)

export function useToast() {
  const [msg, setMsg] = useState(null)
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4200); return () => clearTimeout(t) }, [msg])
  return [msg ? <div className="toast">{msg}</div> : null, setMsg]
}

/** Cells drawn at their real centroids (lower 48 in the frame; AK and HI listed underneath). */
export function USMap({ cells = [], height = 300, onPick, highlight }) {
  const W = 620, H = height
  const lon0 = -125, lon1 = -66, lat0 = 24.5, lat1 = 49.5
  const x = (lon) => ((lon - lon0) / (lon1 - lon0)) * W
  const y = (lat) => ((lat1 - lat) / (lat1 - lat0)) * H
  const inFrame = cells.filter(c => c.lon >= lon0 && c.lon <= lon1 && c.lat >= lat0 && c.lat <= lat1)
  const other = cells.filter(c => !(c.lon >= lon0 && c.lon <= lon1 && c.lat >= lat0 && c.lat <= lat1) && (c.idx || 0) >= 46)
  const hl = new Set(highlight || [])
  return <div>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {inFrame.map(c => { const b = band(c.idx || 0); const r = b >= 3 ? 4.2 : b >= 1 ? 3.4 : 2.6
        return <circle key={c.zip3} cx={x(c.lon)} cy={y(c.lat)} r={hl.has(c.zip3) ? r + 1.5 : r} fill={c.holdout ? '#B9C7D6' : LADDER[b]} stroke={hl.has(c.zip3) ? '#1B5FCC' : c.holdout ? '#55677C' : 'none'} strokeWidth={hl.has(c.zip3) ? 1.6 : 1} strokeDasharray={c.holdout && !hl.has(c.zip3) ? '1.5 1.5' : undefined} style={{ cursor: onPick ? 'pointer' : 'default' }} onClick={() => onPick && onPick(c)}><title>{c.zip3} {c.state} · index {Math.round(c.idx || 0)}{c.holdout ? ' · holdout' : ''}</title></circle> })}
    </svg>
    <div className="row between" style={{ marginTop: 6 }}><Ladder /><span className="small muted">{other.length ? `Also elevated outside the frame: ${other.map(c => c.zip3 + ' ' + c.state).join(', ')}` : 'dashed = holdout cell'}</span></div>
  </div>
}

export const DriverTile = ({ d }) => <div className="driver">
  <div className="m">{METRIC_NAME[d.metric] || d.metric}</div>
  <div className="v">{typeof d.value === 'number' ? (Math.abs(d.value) >= 100 ? Math.round(d.value) : +d.value.toFixed(1)) : d.value} <span className="small muted">{METRIC_UNIT[d.metric] || ''}</span></div>
  <div className="bar"><i style={{ width: `${Math.min(100, d.share || 0)}%` }} /></div>
  <div className="small muted" style={{ marginTop: 4 }}>{d.share}% of the score · {d.feed}{d.cells ? ` · ${d.cells} cells` : ''}</div>
</div>

export const FeedRow = ({ f }) => <div className="feed">
  <i style={{ background: !f.enabled ? '#CFDCEA' : f.lastError ? 'var(--red)' : f.lastOk ? 'var(--green)' : 'var(--amber)' }} />
  <span style={{ color: f.enabled ? 'var(--ink)' : 'var(--ink3)' }}>{f.name}</span>
  {!f.enabled && <span className="tag">needs {f.requires}</span>}
  {f.enabled && f.lastError && <span className="tag" title={f.lastError} style={{ background: 'var(--red-soft)', color: '#B33B3B' }}>error</span>}
  <span className="age">{f.enabled ? (f.lastOk ? ago(f.lastOk) : 'pending') : 'off'}</span>
</div>
