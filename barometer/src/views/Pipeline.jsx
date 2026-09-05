import React, { useEffect, useState } from 'react'
import { api, fmtNum, FEED_NAME } from '../api.js'

export default function Pipeline({ status }) {
  const [cfg, setCfg] = useState(null); const [fp, setFp] = useState(null); const [brands, setBrands] = useState([])
  useEffect(() => { api.get('/config').then(setCfg); api.get('/firstparty/status').then(setFp); api.get('/brands').then(setBrands) }, [])
  const feeds = status ? status.feeds : []
  const fam = (k) => feeds.filter(f => f.family === k)
  const cnt = (k) => fam(k).reduce((a, f) => a + (f.enabled ? f.lastCount : 0), 0)
  const S = ({ n, title, sub, children }) => <div className="stage"><h4><span className="n">{n}</span>{title}</h4><div className="sub">{sub}</div>{children}</div>
  const B = ({ t, children, tone }) => <div className="box" style={tone === 'trace' ? { background: '#FBEDE4', borderColor: '#F1D6CB' } : {}}><b style={{ color: tone === 'trace' ? '#A94D1E' : 'var(--ink3)' }}>{t}</b><div className="t">{children}</div></div>
  return <>
    <div className="head"><div><h1>How an opportunity is made</h1><div className="sub">The same five steps run for every brand, live. Only the signals and the claim rules change.</div></div></div>
    <div className="grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 16 }}>
      <S n="1" title="Collect" sub={`${feeds.filter(f => f.enabled).length} feeds enabled, ${feeds.filter(f => f.requires && !f.enabled).length} waiting for a key`}>
        <B t="Environmental">{fam('environmental').map(f => FEED_NAME[f.id]).join(', ')}<br />{fmtNum(cnt('environmental'))} observations</B>
        <B t="Health and economic">{[...fam('epidemiological'), ...fam('economic')].map(f => FEED_NAME[f.id]).join(', ')}<br />{fmtNum(cnt('epidemiological') + cnt('economic'))} observations</B>
        <B t="First-party">{fp && fp.connected ? `${fmtNum(fp.readings)} readings, ${fp.cellsAboveFloor} cells above the floor` : 'not connected — open adapter, see System'}</B>
      </S>
      <S n="2" title="Normalise" sub="Everything lands on one grid">
        <B t="One geography">{status ? fmtNum(status.gridCells) : '—'} ZIP3 cells nationwide, from Census centroids</B>
        <B t="Privacy floor">device data scored only above {status ? fmtNum(status.privacy.minDevicesPerCell) : '1,000'} devices per cell, never a household</B>
        <B t="Correction">low-cost sensors read high in smoke; EPA humidity correction applied before use</B>
        <B t="Freshness">a stale feed drops out of the score instead of freezing at its last value</B>
      </S>
      <S n="3" title="Decide" sub="One index per family, per cell, per horizon">
        <B t="Weighted model">{brands.reduce((a, b) => a + b.families.length, 0)} product families, each subscribed to the signals that move it; weights refit from holdout results</B>
        <B t="Thresholds">AQI category boundaries 101 / 151 / 201, the numbers people see</B>
        <B t="Three horizons">{cfg ? Object.values(cfg.horizons).map(h => `${h.label} ${h.hours[0]}–${h.hours[1]}h`).join(' · ') : ''}; watch never spends</B>
        <B t="Detection">cell ≥ {status ? status.detect.cellThreshold : 55}, clusters within {status ? status.detect.clusterKm : 170} km</B>
      </S>
      <S n="4" title="Create" sub="A brief first, then the assets">
        <B t="The brief">signal, evidence, angle, product and what is off limits, written before any asset</B>
        <B t="Generation">eight formats and a headline pool · {status && status.creativeEnabled ? status.creativeModel : 'templates until ANTHROPIC_API_KEY is set'}</B>
        <B t="Claim rules per brand" tone="trace">{brands.map(b => `${b.name}: ${b.families[0].claims.note.split('.')[0]}`).join(' · ')}</B>
        <B t="A person signs off">nothing ships on the model's word; the claim check cannot be skipped</B>
      </S>
      <S n="5" title="Activate" sub="Written into the ad accounts">
        <B t="Routing">{cfg ? Object.keys(cfg.channels).length : 10} platforms, one plan; {status ? status.channels.filter(c => c.live).length : 0} live, the rest dry-run</B>
        <B t="Money rules">{cfg ? `capped at $${fmtNum(cfg.money.eventCapUsd)} per event · any single write over $${fmtNum(cfg.money.singleWriteHoldUsd)} waits for a person` : ''}</B>
        <B t="Holdout first">{status ? status.holdoutCells : 0} cells locked out of every write before a dollar moves</B>
        <B t="Reversible">{cfg ? cfg.money.undoWindowSeconds : 90} seconds to undo, kill switch always armed</B>
      </S>
    </div>
    <div className="card" style={{ borderColor: '#C7DDFB' }}>
      <div className="row" style={{ gap: 16 }}>
        <div><b>6 · Measure, then learn</b><div className="small muted">The loop back into step 3</div></div>
        <div className="box" style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}><b className="small">Holdout</b><div className="small muted">treated cells compared with locked cells that saw no spend</div></div>
        <div className="box" style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}><b className="small">Lift</b><div className="small muted">only the incremental part is reported, with a confidence interval</div></div>
        <div className="box" style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}><b className="small">Creative</b><div className="small muted">the line that won becomes the default opening next time</div></div>
        <div className="box" style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}><b className="small">Weights</b><div className="small muted">signal contributions refit on what actually sold</div></div>
      </div>
    </div>
  </>
}
