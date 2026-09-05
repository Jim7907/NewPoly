import React, { useEffect, useState } from 'react'
import { api } from './api.js'
import Home from './views/Home.jsx'
import Portfolio from './views/Portfolio.jsx'
import Pipeline from './views/Pipeline.jsx'
import Opportunity from './views/Opportunity.jsx'
import Channels from './views/Channels.jsx'
import Plan from './views/Plan.jsx'
import Results from './views/Results.jsx'
import System from './views/System.jsx'

const TABS = [['home', 'Home'], ['portfolio', 'Portfolio'], ['pipeline', 'How it works'], ['channels', 'Channels'], ['plans', 'Campaigns'], ['system', 'System']]

function useRoute() {
  const parse = () => { const h = location.hash.replace(/^#\/?/, ''); const [view, id] = h.split('/'); return { view: view || 'home', id } }
  const [r, setR] = useState(parse())
  useEffect(() => { const f = () => setR(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return r
}

export default function App() {
  const route = useRoute()
  const [status, setStatus] = useState(null)
  useEffect(() => { const load = () => api.get('/status').then(setStatus).catch(() => {}); load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [])
  const view = route.view
  return <>
    <div className="nav">
      <a className="mark" href="#/home" style={{ color: 'var(--ink)' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="7" fill="#2F7BF0" /><path d="M6.5 15.5 C 9 9.5, 15 9.5, 17.5 15.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="8.6" r="1.9" fill="#fff" /></svg>
        Barometer
      </a>
      <div className="tabs">{TABS.map(([k, l]) => <a key={k} href={'#/' + k} className={view === k || (k === 'plans' && ['plan', 'results'].includes(view)) || (k === 'home' && view === 'opportunity') ? 'on' : ''}>{l}</a>)}</div>
      <div className="right">
        {status && status.killSwitch && <span className="pill hot">Kill switch on</span>}
        {status && <span className={`pill ${status.liveWrites ? 'hot' : 'grey'}`}>{status.liveWrites ? 'Live writes' : 'Dry run'}</span>}
        {status && <span className="small muted">{status.counts.awaiting} awaiting approval · {status.counts.plansLive} live</span>}
      </div>
    </div>
    <div className="page">
      {view === 'home' && <Home status={status} />}
      {view === 'portfolio' && <Portfolio />}
      {view === 'pipeline' && <Pipeline status={status} />}
      {view === 'opportunity' && <Opportunity id={route.id} status={status} />}
      {view === 'channels' && <Channels status={status} />}
      {view === 'plans' && <Plan id={route.id} list />}
      {view === 'plan' && <Plan id={route.id} />}
      {view === 'results' && <Results id={route.id} />}
      {view === 'system' && <System status={status} onChange={() => api.get('/status').then(setStatus)} />}
    </div>
  </>
}
