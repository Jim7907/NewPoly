import React, { useState, useEffect, useRef, useCallback } from "react";

const STATUS = { IDLE:"IDLE", LIVE:"LIVE", FOUND:"FOUND", PAUSED:"PAUSED" };
const f2   = n => typeof n==="number"?n.toFixed(2):"--";
const fUp  = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const now8 = () => new Date().toISOString().slice(11,19);

function Pill({ status }) {
  const M = {
    IDLE:   {bg:"#1a1a2e",bd:"#333",   tx:"#555",   dot:"#444",   lb:"IDLE"},
    LIVE:   {bg:"#0a1628",bd:"#0ea5e9",tx:"#38bdf8",dot:"#0ea5e9",lb:"LIVE"},
    FOUND:  {bg:"#0a2010",bd:"#22c55e",tx:"#4ade80",dot:"#22c55e",lb:"EDGE FOUND"},
    PAUSED: {bg:"#1a1200",bd:"#ca8a04",tx:"#facc15",dot:"#ca8a04",lb:"PAUSED"},
  };
  const C=M[status]||M.IDLE;
  return (
    <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"5px 14px",background:C.bg,border:`1px solid ${C.bd}`,borderRadius:20}}>
      <span style={{width:7,height:7,borderRadius:"50%",background:C.dot,boxShadow:`0 0 8px ${C.dot}`,animation:(status==="LIVE"||status==="FOUND")?"blink 1s infinite":"none"}}/>
      <span style={{fontSize:10,fontWeight:700,letterSpacing:2,color:C.tx,fontFamily:"monospace"}}>{C.lb}</span>
    </div>
  );
}

function Stat({ label, value, color, sub }) {
  return (
    <div style={{background:"#0d1117",border:"1px solid #1e2a3a",borderRadius:10,padding:"12px 16px",flex:1,minWidth:80}}>
      <div style={{fontSize:8,color:"#4a5568",letterSpacing:2,marginBottom:4,fontFamily:"monospace"}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color:color||"#38bdf8",fontFamily:"monospace"}}>{value}</div>
      {sub&&<div style={{fontSize:8,color:"#334155",marginTop:2}}>{sub}</div>}
    </div>
  );
}

function LogLine({ e }) {
  const c=e.type==="success"?"#4ade80":e.type==="warn"?"#facc15":e.type==="error"?"#f87171":e.type==="live"?"#0ea5e9":"#334155";
  return (
    <div style={{display:"flex",gap:8,padding:"2px 0",borderBottom:"1px solid #080808",fontSize:10}}>
      <span style={{color:"#1e2a3a",fontFamily:"monospace",flexShrink:0}}>{e.time}</span>
      <span style={{color:c}}>{e.msg}</span>
    </div>
  );
}

function OppRow({ o, onTrade }) {
  const absEdge = Math.abs(o.netEdge||0);
  const ec = absEdge>2?"#4ade80":absEdge>1?"#facc15":"#f87171";
  const aligned = o.modelAligned ?? o.modelProb;
  return (
    <div style={{padding:"10px 14px",borderBottom:"1px solid #111",background:absEdge>2?"#080f1e":"#0a0a14",borderLeft:"3px solid "+(absEdge>2?"#4ade80":"#0ea5e9")}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
        <div style={{flex:1}}>
          <span style={{color:"#0ea5e9",fontFamily:"monospace",fontSize:10,fontWeight:700}}>[{o.stationId}]</span>
          <span style={{color:"#e2e8f0",fontSize:11,marginLeft:8}}>{o.city} — {o.outcome}</span>
          {o.isLive&&<span style={{fontSize:8,color:"#4ade80",background:"#0a2010",padding:"1px 5px",borderRadius:3,marginLeft:8}}>LIVE</span>}
          {o.yesDirection==="inverted"&&<span style={{fontSize:8,color:"#facc15",background:"#1a1200",padding:"1px 5px",borderRadius:3,marginLeft:8}}>YES=NOT HOT</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <div style={{fontSize:11,fontWeight:800,color:ec,fontFamily:"monospace"}}>
            {o.direction} | +{absEdge.toFixed(2)}%
          </div>
          {onTrade&&(
            <button onClick={()=>onTrade(o)} style={{
              background:o.direction==="BUY YES"?"#0ea5e9":"#f97316",
              color:"#000",border:"none",borderRadius:5,padding:"4px 12px",
              cursor:"pointer",fontSize:9,fontWeight:800,fontFamily:"monospace"
            }}>{o.direction}</button>
          )}
        </div>
      </div>
      <div style={{fontSize:9,color:"#4a5568",lineHeight:1.7}}>
        Model: {aligned!=null?(aligned*100).toFixed(1):"--"}% | Poly YES: {o.polyProb!=null?(o.polyProb*100).toFixed(1)+"%" :"--"} | Net edge: +{absEdge.toFixed(1)}% | {o.ts}
      </div>
      {o.question&&<div style={{fontSize:9,color:"#334155",marginTop:2,fontStyle:"italic"}}>"{o.question.slice(0,90)}"</div>}
    </div>
  );
}

function StationDetail({ data, loading, onRefresh }) {
  if (loading) return <div style={{textAlign:"center",color:"#334155",padding:"60px 0",fontSize:12}}>Scanning...</div>;
  if (!data)   return <div style={{textAlign:"center",color:"#1e2a3a",padding:"60px 0",fontSize:12}}>Select a station or click SCAN ALL</div>;
  const st=data.station, cnd=data.conditions||{};
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <div>
          <div style={{fontSize:18,fontWeight:800,color:"#e2e8f0"}}>{st.city} <span style={{fontSize:10,color:"#4a5568"}}>{st.country}</span></div>
          <div style={{fontSize:9,color:"#0ea5e9",fontFamily:"monospace",marginTop:2}}>[{st.stationId}] {st.stationName} | {st.lat}, {st.lon}</div>
          <div style={{fontSize:8,color:"#334155",marginTop:2}}>{data.modelsOk}/3 models | {data.liveMarkets} live markets | {data.fetchTime?.slice(11,19)}</div>
        </div>
        <button onClick={onRefresh} style={{background:"#1e2a3a",color:"#64748b",border:"1px solid #1e2a3a",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:9,fontFamily:"monospace"}}>Refresh</button>
      </div>

      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
        {[{l:"TEMP",v:`${cnd.tempC}C`,c:"#f97316"},{l:"HUMIDITY",v:`${cnd.hum}%`,c:"#38bdf8"},{l:"WIND",v:`${cnd.wind}kph`,c:"#a78bfa"},{l:"MAX",v:`${cnd.maxC}C/${cnd.maxF}F`,c:"#facc15"},{l:"PRECIP",v:`${cnd.precIn}in`,c:"#4ade80"}].map(x=>(
          <div key={x.l} style={{flex:1,background:"#0a0a14",border:"1px solid #1e2a3a",borderRadius:7,padding:"7px 9px",minWidth:0}}>
            <div style={{fontSize:7,color:"#4a5568",letterSpacing:1,marginBottom:2}}>{x.l}</div>
            <div style={{fontSize:12,fontWeight:800,color:x.c,fontFamily:"monospace"}}>{x.v}</div>
          </div>
        ))}
      </div>

      {data.opportunities?.length>0&&(
        <div style={{marginBottom:12}}>
          <div style={{fontSize:8,color:"#4ade80",letterSpacing:2,marginBottom:6}}>{data.opportunities.length} LIVE EDGE(S) FOUND</div>
          {data.opportunities.map((o,i)=>(
            <div key={i} style={{background:"#080f1e",border:"1px solid #22c55e",borderRadius:8,padding:"10px 12px",marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{color:"#4ade80",fontFamily:"monospace",fontWeight:700,fontSize:12}}>{o.direction} — {o.outcome}</span>
                <span style={{color:"#4ade80",fontFamily:"monospace",fontWeight:800}}>+{f2(o.netEdge)}% net</span>
              </div>
              <div style={{fontSize:9,color:"#4a5568"}}>Model: {(o.modelProb*100).toFixed(1)}% vs Poly: {(o.polyProb*100).toFixed(1)}% | Spread: {o.spread}% | {o.isLive?"LIVE PRICE":"est"}</div>
              {o.question&&<div style={{fontSize:9,color:"#334155",marginTop:3}}>{o.question.slice(0,70)}</div>}
            </div>
          ))}
        </div>
      )}

      {data.markets?.length>0&&(
        <div>
          <div style={{fontSize:8,color:"#334155",letterSpacing:2,marginBottom:6}}>LIVE POLYMARKET MARKETS</div>
          {data.markets.map((m,i)=>(
            <div key={i} style={{background:"#0a0a14",border:"1px solid #1a1a2a",borderRadius:7,padding:"8px 10px",marginBottom:4}}>
              <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.4}}>{(m.question||m.title||"").slice(0,80)}</div>
              <div style={{display:"flex",gap:12,marginTop:4,fontSize:9,color:"#4a5568"}}>
                <span>Vol: ${Number(m.volume||m.volume24hr||0).toLocaleString()}</span>
                {m.outcomePrices&&<span style={{color:"#38bdf8"}}>YES: {(parseFloat(m.outcomePrices[0]||0)*100).toFixed(0)}%</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── DIAGNOSTICS PANEL ───────────────────────────────────────
function DiagPanel() {
  const [result, setResult] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  const runTest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch("/api/test");
      const d = await r.json();
      setResult(d);
    } catch(e) {
      setResult({ error: e.message, allOk: false });
    }
    setLoading(false);
  };

  return (
    <div style={{padding:"12px 14px",background:"#0a0010",border:"1px solid #7c3aed",borderRadius:8,marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div style={{fontSize:10,color:"#a78bfa",fontWeight:700,letterSpacing:1}}>CONNECTIVITY DIAGNOSTICS</div>
        <button onClick={runTest} disabled={loading} style={{background:"#7c3aed",color:"#fff",border:"none",borderRadius:5,padding:"4px 12px",cursor:"pointer",fontSize:9,fontFamily:"monospace"}}>
          {loading ? "TESTING..." : "RUN TEST"}
        </button>
      </div>
      {!result && !loading && (
        <div style={{fontSize:9,color:"#334155"}}>Click RUN TEST to check if the server can reach Open-Meteo and Polymarket APIs</div>
      )}
      {loading && (
        <div style={{fontSize:9,color:"#a78bfa"}}>Testing connectivity to all APIs...</div>
      )}
      {result && (
        <div>
          {result.error && (
            <div style={{fontSize:9,color:"#f87171",marginBottom:6}}>Error: {result.error}</div>
          )}
          {result.results && Object.entries(result.results).map(([name, r]) => (
            <div key={name} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid #111",fontSize:9}}>
              <span style={{color:"#64748b",fontFamily:"monospace"}}>{name}</span>
              <span style={{color:r.ok?"#4ade80":"#f87171",fontFamily:"monospace",fontWeight:700}}>
                {r.ok ? "OK " + r.status : "FAIL: " + (r.code||r.error||r.status)}
              </span>
            </div>
          ))}
          {result.allOk === false && !result.error && (
            <div style={{fontSize:9,color:"#facc15",marginTop:6,lineHeight:1.7}}>
              Some APIs are blocked. Check Hostinger firewall — allow outbound HTTPS (port 443).
              The bot needs to reach: api.open-meteo.com and gamma-api.polymarket.com
            </div>
          )}
          {result.allOk === true && (
            <div style={{fontSize:9,color:"#4ade80",marginTop:6}}>All APIs reachable. If scan still fails, check the LOG tab for details.</div>
          )}
        </div>
      )}
    </div>
  );
}


function MultiOppRow({o, color}) {
  return (
    <div style={{padding:"10px 14px",borderBottom:"1px solid #111",borderLeft:"3px solid "+(color||"#0ea5e9")}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
        <div style={{fontSize:10,color:"#94a3b8",flex:1,lineHeight:1.4,paddingRight:12}}>{o.question}</div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:12,fontWeight:800,color:o.netEdge>0?"#4ade80":"#f87171",fontFamily:"monospace"}}>
            {o.direction}
          </div>
          <div style={{fontSize:10,color:color||"#0ea5e9",fontFamily:"monospace"}}>
            +{Number(o.netEdge||0).toFixed(1)}% net
          </div>
        </div>
      </div>
      <div style={{fontSize:9,color:"#334155",lineHeight:1.7}}>
        {o.note}
        {o.fee===0&&<span style={{color:"#4ade80",marginLeft:6,fontWeight:700}}>★ 0% FEE</span>}
        {o.daysLeft&&<span style={{marginLeft:6}}>{o.daysLeft}d left</span>}
        {o.volume&&<span style={{marginLeft:6}}>Vol: ${Number(o.volume).toLocaleString()}</span>}
      </div>
    </div>
  );
}

export default function App() {
  const [status,setStatus]    = useState(STATUS.IDLE);
  const [stations,setStns]    = useState([]);
  const [selIdx,setSelIdx]    = useState(0);
  const [scanData,setScanData]= useState({});
  const [loadingIds,setLdg]   = useState(new Set());
  const [opps,setOpps]        = useState([]);
  const [multiOpps,setMultiOpps] = useState([]);
  const [dbStats,setDbStats]     = useState(null);
  const [trades,setTrades]       = useState([]);
  const [scanActive,setScanActive] = useState(true);
  const [log,setLog]          = useState([]);
  const [stats,setStats]      = useState({edges:0,scanned:0,uptime:0,lastScan:null});
  const [tab,setTab]          = useState("live");
  const [health,setHealth]    = useState(null);
  const [minEdge,setMinEdge]  = useState(1.5);
  const [simMode,setSimMode]  = useState(true);
  const [wsOk,setWsOk]       = useState(false);

  const scanRef=useRef(null), uptRef=useRef(null), t0Ref=useRef(null), wsRef=useRef(null);

  const addLog=useCallback((msg,type)=>setLog(p=>[{id:Date.now()+Math.random(),time:now8(),msg,type:type||"info"},...p].slice(0,80)),[]);

  useEffect(()=>{
    fetch("/api/stations").then(r=>r.json()).then(d=>{setStns(d);addLog(`Loaded ${d.length} stations`,"success");}).catch(e=>addLog("Stations: "+e.message,"error"));
    fetch("/api/health").then(r=>r.json()).then(h=>{setHealth(h);addLog("Server OK | uptime "+Math.floor(h.uptime)+"s","success");}).catch(e=>addLog("Health: "+e.message,"error"));

    // Poll server for cached results every 30s
    // Server cron runs every 2min regardless of browser tab state
    const pollLatest = async () => {
      try {
        const r = await fetch("/api/latest");
        const d = await r.json();
        if (!d.stations || d.stations.length === 0) return;
        d.stations.forEach(st => {
          if (st.station) setScanData(p=>({...p,[st.station.stationId]:st}));
        });
        const allOpps = d.stations.flatMap(st=>
          (st.opportunities||[]).map(o=>({...o,city:st.station?.city,stationId:st.station?.stationId,ts:o.ts||new Date().toISOString().slice(11,19)}))
        );
        if (allOpps.length > 0) {
          setOpps(p=>{
            const seen = new Set(p.map(x=>x.marketId+x.stationId));
            const fresh = allOpps.filter(o=>!seen.has(o.marketId+o.stationId));
            if (fresh.length > 0) {
              setStats(s=>({...s,edges:s.edges+fresh.length}));
              fresh.forEach(o=>addLog(`EDGE [${o.stationId}] ${o.outcome} ${o.direction} net=${Number(o.netEdge).toFixed(1)}%`,"success"));
            }
            return [...fresh,...p].slice(0,50);
          });
        }
        if (d.lastScan) setStats(s=>({...s,lastScan:d.lastScan.slice(11,19),scanned:d.count}));
        // Multi-strategy opportunities from server
        if (d.multiOpps && d.multiOpps.length > 0) {
          setMultiOpps(d.multiOpps);
        }
        if (d.dbStats) setDbStats(d.dbStats);
        if (typeof d.scanActive === 'boolean') setScanActive(d.scanActive);
      } catch(e) {}
    };
    pollLatest();
    const pid = setInterval(pollLatest, 30000);
    return ()=>clearInterval(pid);
  },[addLog]);

  useEffect(()=>{
    const proto=window.location.protocol==="https:"?"wss:":"ws:";
    const ws=new WebSocket(`${proto}//${window.location.host}`);
    wsRef.current=ws;
    ws.onopen=()=>{setWsOk(true);addLog("WebSocket connected — live price relay active","live");};
    ws.onclose=()=>{setWsOk(false);addLog("WebSocket disconnected","warn");};
    ws.onmessage=evt=>{ try{ const d=JSON.parse(evt.data); if(d.event_type==="price_change") addLog("Price update received","live"); }catch(e){} };
    return ()=>ws.close();
  },[addLog]);

  const scanStation=useCallback(async(stationId)=>{
    setLdg(p=>new Set([...p,stationId]));
    addLog(`[${stationId}] Scanning...`,"info");
    try {
      const res=await fetch(`/api/scan/${stationId}?minEdge=${minEdge}`);
      const data=await res.json();
      if(data.error) throw new Error(data.error);
      setScanData(p=>({...p,[stationId]:data}));
      setStats(s=>({...s,scanned:s.scanned+1,lastScan:now8()}));
      addLog(`[${stationId}] ${data.modelsOk}/3 models | ${data.liveMarkets} markets | ${data.opportunities.length} edges`,"success");
      if(data.opportunities.length>0){
        setStatus(STATUS.FOUND);
        setTimeout(()=>setStatus(c=>c===STATUS.FOUND?STATUS.LIVE:c),3000);
        const newOpps=data.opportunities.map(o=>({...o,city:data.station.city,stationId,ts:now8()}));
        setOpps(p=>[...newOpps,...p].slice(0,30));
        setStats(s=>({...s,edges:s.edges+newOpps.length}));
        newOpps.forEach(o=>addLog(`EDGE [${stationId}] ${o.outcome} ${o.direction} net=${f2(o.netEdge)}%`,"success"));
      }
    } catch(e){ addLog(`[${stationId}] Error: ${e.message}`,"error"); }
    setLdg(p=>{ const n=new Set(p); n.delete(stationId); return n; });
  },[minEdge,addLog]);

  const scanAll=useCallback(async()=>{
    addLog("Full scan started...","info");
    for(const st of stations){ await scanStation(st.stationId); await new Promise(r=>setTimeout(r,500)); }
    addLog("Scan complete","success");
  },[stations,scanStation,addLog]);

  const start=useCallback(()=>{
    setStatus(STATUS.LIVE); t0Ref.current=Date.now();
    addLog("Bot LIVE — scanning every 6 minutes","success");
    scanAll();
    scanRef.current=setInterval(scanAll,6*60*1000);
    uptRef.current=setInterval(()=>setStats(s=>({...s,uptime:Math.floor((Date.now()-t0Ref.current)/1000)})),1000);
  },[scanAll,addLog]);

  const handleTrade=useCallback(async(opp)=>{
    if(simMode){
      // Execute as paper trade via server (persisted to DB)
      addLog(`[PAPER] Placing: ${opp.direction} "${opp.question?.slice(0,45)}" edge=+${Number(opp.netEdge).toFixed(1)}%`,"live");
      try {
        const r=await fetch("/api/paper-trade",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({direction:opp.direction,marketId:opp.marketId,question:opp.question,price:opp.polyProb||0.5,size:10})});
        const d=await r.json();
        if(d.error) addLog(`[PAPER] Failed: ${d.error}`,"error");
        else { addLog(`[PAPER] Trade placed! New balance: $${d.newBalance}`,"success"); setDbStats(s=>({...s,paperBalance:d.newBalance,totalTrades:(s?.totalTrades||0)+1})); }
      } catch(e){ addLog(`[PAPER] Error: ${e.message}`,"error"); }
      return;
    }
    addLog(`[TRADE] Placing: ${opp.direction} on "${opp.question?.slice(0,40)}"`,"live");
    try {
      const res=await fetch("/api/trade",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({marketId:opp.marketId,direction:opp.direction,price:opp.polyProb,size:10})});
      const d=await res.json();
      if(d.error) addLog(`[TRADE] Failed: ${d.error}`,"error");
      else addLog(`[TRADE] Order placed: ${d.orderId||d.id||"OK"}`,"success");
    } catch(e){ addLog(`[TRADE] Error: ${e.message}`,"error"); }
  },[simMode,addLog]);

  const stop=useCallback(()=>{ clearInterval(scanRef.current); clearInterval(uptRef.current); setStatus(STATUS.PAUSED); addLog("Paused","warn"); },[addLog]);
  const reset=useCallback(()=>{ clearInterval(scanRef.current); clearInterval(uptRef.current); setStatus(STATUS.IDLE); setOpps([]); setLog([]); setScanData({}); setStats({edges:0,scanned:0,uptime:0,lastScan:null}); addLog("Reset","info"); },[addLog]);
  useEffect(()=>()=>{ clearInterval(scanRef.current); clearInterval(uptRef.current); },[]);

  const isRunning=status===STATUS.LIVE||status===STATUS.FOUND;
  const selSt=stations[selIdx];
  const selData=selSt?scanData[selSt.stationId]:null;
  const selLoading=selSt?loadingIds.has(selSt.stationId):false;

  return (
    <div style={{background:"#060910",minHeight:"100vh",color:"#c9d1d9",fontFamily:"'Courier New',monospace",padding:18}}>
      <style>{"@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}} ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#0d1117} ::-webkit-scrollbar-thumb{background:#1e2a3a;border-radius:2px}"}</style>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div>
            <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",letterSpacing:2}}>POLYMARKET ARB BOT</div>
            <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginTop:2}}>OPEN-METEO + GAMMA API + CLOB WS | DOCKER</div>
          </div>
          <Pill status={status}/>
          <div style={{fontSize:8,fontFamily:"monospace",padding:"3px 7px",borderRadius:3,background:wsOk?"#0a2010":"#111",color:wsOk?"#4ade80":"#334155",border:`1px solid ${wsOk?"#4ade80":"#1e2a3a"}`}}>WS:{wsOk?"OK":"--"}</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {!isRunning
            ?<button onClick={start} style={{background:"#0ea5e9",color:"#000",border:"none",borderRadius:7,padding:"7px 16px",fontWeight:800,cursor:"pointer",fontSize:11,fontFamily:"monospace"}}>START LIVE</button>
            :<button onClick={stop}  style={{background:"#ca8a04",color:"#000",border:"none",borderRadius:7,padding:"7px 16px",fontWeight:800,cursor:"pointer",fontSize:11,fontFamily:"monospace"}}>PAUSE</button>
          }
          <button onClick={reset} style={{background:"#1e2a3a",color:"#64748b",border:"1px solid #1e2a3a",borderRadius:7,padding:"7px 10px",cursor:"pointer",fontSize:11}}>RESET</button>
        </div>
      </div>

      <div style={{background:simMode?"#1a0a2e":"#0a2010",border:"1px solid "+(simMode?"#7c3aed":"#22c55e"),borderRadius:7,padding:"8px 14px",marginBottom:10,fontSize:10,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        {simMode?(
          <>
            <strong style={{color:"#c084fc"}}>PAPER MODE</strong>
            <span style={{color:"#7c3aed"}}>Real weather + live prices. No orders placed.</span>
            <span style={{color:"#4a5568",fontSize:9}}>To trade live: add POLY_API_KEY + POLY_SECRET + POLY_PASSPHRASE to .env on server</span>
            <button onClick={()=>setSimMode(false)} style={{marginLeft:"auto",background:"#7c3aed",color:"#fff",border:"none",borderRadius:5,padding:"5px 14px",cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"monospace"}}>GO LIVE</button>
          </>
        ):(
          <>
            <strong style={{color:"#4ade80"}}>● LIVE TRADING ON</strong>
            <span style={{color:"#166534"}}>Bot will place real orders automatically on confirmed edges</span>
            <button onClick={()=>setSimMode(true)} style={{marginLeft:"auto",background:"transparent",color:"#4ade80",border:"1px solid #4ade80",borderRadius:5,padding:"5px 14px",cursor:"pointer",fontSize:10,fontFamily:"monospace"}}>BACK TO PAPER</button>
          </>
        )}
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <Stat label="STATIONS"    value={stations.length}      color="#38bdf8"/>
        <Stat label="SCANNED"     value={stats.scanned}        color="#38bdf8"/>
        <Stat label="EDGES FOUND" value={(dbStats?.totalTrades||0)+" trades"}          color="#4ade80"/>
        <Stat label="UPTIME"      value={fUp(stats.uptime)}    color="#94a3b8" sub="mm:ss"/>
        <Stat label="LAST SCAN"   value={stats.lastScan||"--"} color="#334155"/>
      </div>

      <div style={{background:"#0d1117",border:"1px solid #1e2a3a",borderRadius:10,overflow:"hidden"}}>
        <div style={{display:"flex",borderBottom:"1px solid #1e2a3a"}}>
          {[["live","LIVE STATIONS"],["opps","OPPORTUNITIES"],["portfolio","PORTFOLIO"],["log","LOG"],["config","CONFIG"]].map(([id,lb])=>(
            <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"10px 6px",fontSize:10,letterSpacing:1,cursor:"pointer",background:tab===id?"#131b2e":"transparent",color:tab===id?(id==="live"?"#0ea5e9":"#38bdf8"):"#4a5568",border:"none",fontFamily:"monospace",fontWeight:tab===id?700:400,borderBottom:tab===id?`2px solid ${id==="live"?"#0ea5e9":"#38bdf8"}`:"2px solid transparent"}}>{lb}</button>
          ))}
        </div>

        <div style={{padding:14}}>
          {tab==="live"&&(
            <div style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:14,minHeight:460}}>
              <div style={{borderRight:"1px solid #1a1a2a",paddingRight:12}}>
                <div style={{fontSize:8,color:"#334155",letterSpacing:2,marginBottom:8}}>RESOLUTION STATIONS</div>
                <button onClick={scanAll} style={{width:"100%",background:"#0ea5e9",color:"#000",border:"none",borderRadius:5,padding:"7px 0",fontWeight:800,cursor:"pointer",fontSize:9,letterSpacing:1,marginBottom:10,fontFamily:"monospace"}}>SCAN ALL NOW</button>
                {stations.map((st,i)=>{
                  const d=scanData[st.stationId], busy=loadingIds.has(st.stationId);
                  const edge=d?.opportunities?.length>0;
                  return (
                    <div key={st.stationId} onClick={()=>{setSelIdx(i);if(!d&&!busy)scanStation(st.stationId);}}
                      style={{padding:"7px 8px",borderRadius:7,cursor:"pointer",marginBottom:4,background:selIdx===i?"#131b2e":"transparent",border:`1px solid ${selIdx===i?"#0ea5e9":edge?"#22c55e":busy?"#ca8a04":"#1e2a3a"}`}}>
                      <div style={{fontSize:10,color:"#e2e8f0",fontWeight:600}}>{st.city}</div>
                      <div style={{fontSize:8,color:"#0ea5e9",fontFamily:"monospace"}}>[{st.stationId}]</div>
                      {busy&&<div style={{fontSize:8,color:"#ca8a04"}}>scanning...</div>}
                      {d&&!busy&&<div style={{fontSize:9,color:"#38bdf8",fontFamily:"monospace"}}>{d.conditions?.tempC}C</div>}
                      {edge&&<div style={{fontSize:8,color:"#4ade80",background:"#0a2010",padding:"1px 5px",borderRadius:3}}>EDGE</div>}
                      {!d&&!busy&&<div style={{fontSize:8,color:"#1e2a3a"}}>click to scan</div>}
                    </div>
                  );
                })}
              </div>
              <div style={{overflowY:"auto"}}>
                <StationDetail data={selData} loading={selLoading} onRefresh={()=>selSt&&scanStation(selSt.stationId)}/>
              </div>
            </div>
          )}

          {tab==="opps"&&(
            <div style={{maxHeight:520,overflowY:"auto"}}>

              {/* Geopolitics — 0% fee, highest priority */}
              {multiOpps.filter(o=>o.type==="geopolitics").length>0&&(
                <div>
                  <div style={{padding:"6px 14px",background:"#0a2010",fontSize:9,color:"#4ade80",letterSpacing:2,fontWeight:700,borderBottom:"1px solid #0a2a10"}}>
                    GEOPOLITICS — 0% FEE ({multiOpps.filter(o=>o.type==="geopolitics").length})
                  </div>
                  {multiOpps.filter(o=>o.type==="geopolitics").map((o,i)=>(
                    <MultiOppRow key={i} o={o} color="#4ade80"/>
                  ))}
                </div>
              )}

              {/* NegRisk — guaranteed profit */}
              {multiOpps.filter(o=>o.type==="negrisk").length>0&&(
                <div>
                  <div style={{padding:"6px 14px",background:"#0a1628",fontSize:9,color:"#0ea5e9",letterSpacing:2,fontWeight:700,borderBottom:"1px solid #0a1a28"}}>
                    NEGRISK REBALANCING ({multiOpps.filter(o=>o.type==="negrisk").length})
                  </div>
                  {multiOpps.filter(o=>o.type==="negrisk").map((o,i)=>(
                    <MultiOppRow key={i} o={o} color="#0ea5e9"/>
                  ))}
                </div>
              )}

              {/* Economics */}
              {multiOpps.filter(o=>o.type==="economics").length>0&&(
                <div>
                  <div style={{padding:"6px 14px",background:"#1a1200",fontSize:9,color:"#facc15",letterSpacing:2,fontWeight:700,borderBottom:"1px solid #1a1200"}}>
                    ECONOMICS / MACRO ({multiOpps.filter(o=>o.type==="economics").length})
                  </div>
                  {multiOpps.filter(o=>o.type==="economics").map((o,i)=>(
                    <MultiOppRow key={i} o={o} color="#facc15"/>
                  ))}
                </div>
              )}

              {/* Crypto lag */}
              {multiOpps.filter(o=>o.type==="crypto").length>0&&(
                <div>
                  <div style={{padding:"6px 14px",background:"#160a28",fontSize:9,color:"#a78bfa",letterSpacing:2,fontWeight:700,borderBottom:"1px solid #160a28"}}>
                    CRYPTO PRICE LAG ({multiOpps.filter(o=>o.type==="crypto").length})
                  </div>
                  {multiOpps.filter(o=>o.type==="crypto").map((o,i)=>(
                    <MultiOppRow key={i} o={o} color="#a78bfa"/>
                  ))}
                </div>
              )}

              {/* Weather */}
              {opps.length>0&&(
                <div>
                  <div style={{padding:"6px 14px",background:"#0a0a14",fontSize:9,color:"#38bdf8",letterSpacing:2,fontWeight:700,borderBottom:"1px solid #111"}}>
                    WEATHER EDGES ({opps.length})
                  </div>
                  {opps.map((o,i)=><OppRow key={i} o={o} onTrade={!simMode?handleTrade:null}/>)}
                </div>
              )}

              {opps.length===0&&multiOpps.length===0&&(
                <div style={{padding:40,textAlign:"center",color:"#1a1a2a",fontSize:12,lineHeight:2}}>
                  <div>No opportunities yet</div>
                  <div style={{fontSize:10,color:"#334155"}}>Server scans every 2 minutes automatically</div>
                  <div style={{fontSize:10,color:"#334155"}}>Click START LIVE or wait for next cron cycle</div>
                </div>
              )}
            </div>
          )}

          {tab==="log"&&(
            <div style={{maxHeight:460,overflowY:"auto"}}>
              {log.length===0?<div style={{padding:40,textAlign:"center",color:"#1a1a2a",fontSize:12}}>No log entries</div>:log.map(e=><LogLine key={e.id} e={e}/>)}
            </div>
          )}


          {/* PORTFOLIO */}
          {tab==="portfolio"&&(
            <div style={{maxHeight:520,overflowY:"auto"}}>

              {/* Balance + Stats */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:14}}>
                {[
                  {l:"PAPER BALANCE",  v:dbStats?"$"+dbStats.paperBalance.toFixed(2):"$1000.00", c:"#4ade80"},
                  {l:"TOTAL TRADES",   v:dbStats?.totalTrades||0,  c:"#38bdf8"},
                  {l:"WIN RATE",       v:dbStats?(dbStats.winRate+"%"):"--",  c:dbStats?.winRate>50?"#4ade80":"#f87171"},
                  {l:"TOTAL P&L",      v:dbStats?(dbStats.totalPnl>=0?"+":"")+"$"+(dbStats.totalPnl||0).toFixed(2):"$0.00", c:dbStats?.totalPnl>=0?"#4ade80":"#f87171"},
                ].map(s=>(
                  <div key={s.l} style={{background:"#0d1117",border:"1px solid #1e2a3a",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{fontSize:8,color:"#4a5568",letterSpacing:2,marginBottom:4}}>{s.l}</div>
                    <div style={{fontSize:18,fontWeight:800,color:s.c,fontFamily:"monospace"}}>{s.v}</div>
                  </div>
                ))}
              </div>

              {/* Controls */}
              <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
                <button onClick={async()=>{
                  const r=await fetch("/api/reset-paper",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount:1000})});
                  const d=await r.json();
                  if(d.success) setDbStats(s=>({...s,paperBalance:d.newBalance}));
                }} style={{background:"#1e2a3a",color:"#64748b",border:"1px solid #1e2a3a",borderRadius:5,padding:"6px 14px",cursor:"pointer",fontSize:10,fontFamily:"monospace"}}>
                  RESET TO $1000
                </button>
                <button onClick={async()=>{
                  const r=await fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scan_active:scanActive?"false":"true"})});
                  const d=await r.json();
                  setScanActive(d.settings?.scan_active==="true");
                }} style={{background:scanActive?"#0a2010":"#1a0808",color:scanActive?"#4ade80":"#f87171",border:"1px solid "+(scanActive?"#4ade80":"#f87171"),borderRadius:5,padding:"6px 14px",cursor:"pointer",fontSize:10,fontFamily:"monospace",fontWeight:700}}>
                  {scanActive?"● BOT RUNNING":"○ BOT PAUSED"}
                </button>
                <button onClick={async()=>{
                  const r=await fetch("/api/trades");
                  const d=await r.json();
                  setTrades(d.trades||[]);
                }} style={{background:"#0ea5e9",color:"#000",border:"none",borderRadius:5,padding:"6px 14px",cursor:"pointer",fontSize:10,fontFamily:"monospace",fontWeight:700}}>
                  LOAD TRADES
                </button>
              </div>

              {/* Trades table */}
              {trades.length>0&&(
                <div>
                  <div style={{fontSize:8,color:"#334155",letterSpacing:2,marginBottom:6}}>TRADE HISTORY ({trades.length})</div>
                  <div style={{background:"#0a0a14",border:"1px solid #1e2a3a",borderRadius:8,overflow:"hidden"}}>
                    <div style={{display:"grid",gridTemplateColumns:"60px 1fr 60px 60px 60px 60px",gap:4,padding:"6px 10px",borderBottom:"1px solid #111",fontSize:8,color:"#334155",letterSpacing:1}}>
                      <span>TIME</span><span>MARKET</span><span>DIR</span><span>SIZE</span><span>STATUS</span><span>P&L</span>
                    </div>
                    {trades.slice(0,30).map((t,i)=>(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"60px 1fr 60px 60px 60px 60px",gap:4,padding:"7px 10px",borderBottom:"1px solid #080808",fontSize:9,alignItems:"center",
                        background:t.status==="won"?"#080f0a":t.status==="lost"?"#0f0808":"#0a0a14"}}>
                        <span style={{color:"#334155",fontFamily:"monospace"}}>{t.ts?.slice(11,16)}</span>
                        <span style={{color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(t.question||t.marketId||"--").slice(0,45)}</span>
                        <span style={{color:t.direction?.includes("YES")?"#0ea5e9":"#f97316",fontFamily:"monospace",fontSize:8}}>{t.direction?.replace("BUY ","")}</span>
                        <span style={{color:"#64748b",fontFamily:"monospace"}}>${(t.size||0).toFixed(1)}</span>
                        <span style={{color:t.status==="won"?"#4ade80":t.status==="lost"?"#f87171":"#facc15",fontFamily:"monospace",fontSize:8,fontWeight:700}}>
                          {t.status?.toUpperCase()||"OPEN"}
                        </span>
                        <span style={{color:t.pnl>0?"#4ade80":t.pnl<0?"#f87171":"#334155",fontFamily:"monospace",fontWeight:700}}>
                          {t.pnl!=null?(t.pnl>=0?"+":"")+"$"+Number(t.pnl).toFixed(2):"--"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {trades.length===0&&(
                <div style={{padding:30,textAlign:"center",color:"#1e2a3a",fontSize:11}}>
                  Click LOAD TRADES to see history<br/>
                  <span style={{fontSize:9,color:"#0d1117"}}>Bot auto-trades paper money every 2 minutes when edges are found</span>
                </div>
              )}
            </div>
          )}

          {tab==="config"&&(
            <div style={{maxWidth:440}}>
              <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:14}}>CONFIGURATION</div>
              <div style={{marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span style={{fontSize:11,color:"#94a3b8"}}>Min Net Edge (%)</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#38bdf8"}}>{minEdge}</span>
                </div>
                <input type="range" min={0.5} max={5} step={0.1} value={minEdge} onChange={e=>setMinEdge(+e.target.value)} style={{width:"100%",accentColor:"#0ea5e9"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#334155",marginTop:2}}><span>0.5%</span><span>5.0%</span></div>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:"#1a0a2e",border:"1px solid #7c3aed",borderRadius:8,marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,color:"#a78bfa",fontWeight:700}}>Paper Trading Mode</div>
                  <div style={{fontSize:9,color:"#6d28d9",marginTop:2}}>No real orders placed</div>
                </div>
                <div onClick={()=>setSimMode(s=>!s)} style={{width:44,height:24,borderRadius:12,cursor:"pointer",position:"relative",background:simMode?"#7c3aed":"#1e2a3a",transition:"background 0.2s"}}>
                  <div style={{position:"absolute",top:3,left:simMode?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
                </div>
              </div>
              {health&&<div style={{padding:"12px 14px",background:"#080f1e",border:"1px solid #1e2a3a",borderRadius:8,fontSize:9,color:"#4a5568",lineHeight:1.9,marginBottom:12}}>
                <div style={{color:"#0ea5e9",fontWeight:700,marginBottom:6}}>SERVER STATUS</div>
                <div>Uptime: {Math.floor(health.uptime)}s</div>
                <div>WS Clients: {health.wsClients}</div>
                <div>Polymarket WS: {health.polyWsConnected?"Connected":"Disconnected"}</div>
              </div>}
              <DiagPanel />
              <div style={{padding:"12px 14px",background:"#080f1e",border:"1px solid #0ea5e9",borderRadius:8,fontSize:9,color:"#4a5568",lineHeight:1.9}}>
                <div style={{color:"#0ea5e9",fontWeight:700,marginBottom:6}}>DATA SOURCES</div>
                <div>Weather: Open-Meteo ECMWF+GFS+ICON (exact station coords)</div>
                <div>Markets: gamma-api.polymarket.com</div>
                <div>Prices: clob.polymarket.com (server-side proxy)</div>
                <div>Live feed: Polymarket CLOB WebSocket relay</div>
                <div style={{marginTop:8,color:"#334155"}}>Scan: every 6 min (model update cycle)</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
