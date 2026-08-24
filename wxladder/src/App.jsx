import React, { useState, useEffect, useRef, useCallback } from "react";

const pc = (x, d = 1) => (x == null ? "--" : (x * 100).toFixed(d) + "%");
const f = (x, d = 2) => (x == null ? "--" : Number(x).toFixed(d));
const sgn = (x, d = 2) => (x == null ? "--" : (x >= 0 ? "+" : "") + Number(x).toFixed(d));
const now8 = () => new Date().toISOString().slice(11, 19);
const api = (p, opts) => fetch(p, opts).then(r => r.json());

const C = { bg: "#06070d", panel: "#0d1117", border: "#1b2433", good: "#22c55e", bad: "#f97316",
            blue: "#38bdf8", dim: "#475569", text: "#cbd5e1", warn: "#facc15", violet: "#a78bfa" };
const REGIME = { tight: C.good, wide: C.bad, normal: C.blue, unknown: C.dim };

const Box = ({ label, v, c }) => (
  <div style={{ background: "#0a0e16", border: "1px solid #131b27", borderRadius: 6, padding: "5px 7px" }}>
    <div style={{ fontSize: 7, color: C.dim, letterSpacing: 1 }}>{label}</div>
    <div style={{ fontSize: 12, fontWeight: 800, color: c, fontFamily: "monospace" }}>{v}</div>
  </div>
);
const Empty = ({ msg }) => <div style={{ padding: 50, textAlign: "center", color: "#1f2937", fontSize: 12 }}>{msg}</div>;
const Row = ({ label, children }) => <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #0d1117" }}><span style={{ color: "#94a3b8" }}>{label}</span>{children}</div>;
const Toggle = ({ on, onClick }) => <div onClick={onClick} style={{ width: 42, height: 22, borderRadius: 11, cursor: "pointer", background: on ? "#16a34a" : "#1b2433", position: "relative", transition: ".15s" }}><div style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: ".15s" }} /></div>;

// Bucket distribution: model vs market, with the chosen rungs lit up. This is the whole
// strategy in one picture — where we think the temperature lands vs where the book does.
function Distribution({ dist, legs }) {
  if (!dist || !dist.length) return null;
  const picked = new Set((legs || []).filter(l => l.shares > 0).map(l => l.label));
  const max = Math.max(...dist.map(d => Math.max(d.prob || 0, d.pMarket || 0)), 0.05);
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 64, marginBottom: 6 }}>
      {dist.map((d, i) => {
        const on = picked.has(d.label);
        const hM = Math.max(2, (d.prob / max) * 46);
        const hK = Math.max(1, ((d.pMarket || 0) / max) * 46);
        const short = d.label.replace(/°[CF]/, "").replace(" or below", "-").replace(" or higher", "+");
        return (
          <div key={i} title={`${d.label}  model ${pc(d.pModel)} · market ${pc(d.pMarket)} · used ${pc(d.prob)} · ask ${d.ask ?? "--"}`}
               style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <div style={{ position: "relative", width: "100%", height: 48, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <div style={{ width: "72%", height: hM, background: on ? C.good : "#1e3a5f", borderRadius: "2px 2px 0 0" }} />
              <div style={{ position: "absolute", bottom: 0, width: "36%", height: hK, background: on ? "#0f766e" : "#334155", opacity: 0.9, borderRadius: "2px 2px 0 0" }} />
            </div>
            <div style={{ fontSize: 7, color: on ? C.good : C.dim, fontFamily: "monospace", whiteSpace: "nowrap" }}>{short}</div>
          </div>
        );
      })}
    </div>
  );
}

function LadderCard({ l, onTrade, paper }) {
  const live = l.signal !== "—";
  const rc = REGIME[l.regime] || C.dim;
  const funded = (l.legs || []).filter(x => x.shares > 0);
  return (
    <div style={{ background: live ? "#08140c" : C.panel, border: `1px solid ${live ? C.good : C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{l.city}</span>
          <span style={{ fontSize: 9, color: l.kind === "high" ? C.bad : C.blue, marginLeft: 6, fontWeight: 700 }}>{(l.kind || "").toUpperCase()}</span>
          <div style={{ fontSize: 8, color: C.dim, fontFamily: "monospace" }}>
            {l.station} · {l.stationName} · {l.date} · D+{l.leadDays}
          </div>
        </div>
        <span style={{ fontSize: 8, padding: "2px 7px", borderRadius: 4, color: rc, border: `1px solid ${rc}`, fontFamily: "monospace", whiteSpace: "nowrap" }}>
          {(l.regime || "?").toUpperCase()}{l.dispRatio != null ? ` ${f(l.dispRatio, 2)}` : ""}
        </span>
      </div>

      <Distribution dist={l.distribution} legs={l.legs} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 7 }}>
        <Box label="CENTER" v={`${f(l.center, 1)}°`} c={C.violet} />
        <Box label="BIAS" v={sgn(l.bias, 2)} c={Math.abs(l.bias || 0) > 0.5 ? C.warn : C.dim} />
        <Box label="SIGMA" v={f(l.sigma, 2)} c={C.blue} />
        <Box label="COVER" v={pc(l.coverProb)} c={(l.coverProb || 0) >= 0.75 ? C.good : C.dim} />
      </div>

      <div style={{ fontSize: 9, color: C.dim, marginBottom: 6, fontFamily: "monospace" }}>
        raw {f(l.rawCenter, 1)}° → corrected <b style={{ color: C.text }}>{f(l.center, 1)}°</b>
        {"  ·  "}cost <b style={{ color: (l.basketCost || 0) <= 0.7 ? C.good : C.warn }}>{f(l.basketCost, 3)}</b>
        {"  ·  "}EV <b style={{ color: (l.fillEv ?? l.basketEv ?? 0) > 0 ? C.good : C.bad }}>{pc(l.fillEv ?? l.basketEv)}</b>
        {"  ·  "}vig {l.overround != null ? f((l.overround - 1) * 100, 1) + "%" : "--"}
        {"  ·  "}bias n={l.biasSamples ?? 0}
      </div>

      {funded.length ? (
        <div style={{ marginBottom: 6 }}>
          {funded.map(g => (
            <div key={g.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "monospace", padding: "1px 0" }}>
              <span style={{ color: C.text }}>{g.label}</span>
              <span style={{ color: C.dim }}>
                p {pc(g.prob)} · ask {f(g.ask, 3)} · {f(g.shares, 0)}sh
                <b style={{ color: C.good, marginLeft: 6 }}>${f(g.dollars)}</b>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {live ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.good, fontFamily: "monospace" }}>
            {l.signal} · ${f(l.outlay)}{l.placed ? " · placed ✓" : ""}
          </span>
          {paper && <button onClick={() => onTrade(l)} style={{ background: C.good, color: "#000", border: "none", borderRadius: 5, padding: "4px 12px", cursor: "pointer", fontSize: 9, fontWeight: 800, fontFamily: "monospace" }}>PAPER BUY</button>}
        </div>
      ) : (
        <div style={{ fontSize: 8, color: C.dim, fontFamily: "monospace", minHeight: 14 }}>{(l.reasons || []).join(" · ") || "evaluating…"}</div>
      )}
    </div>
  );
}

export default function App() {
  const [live, setLive] = useState({ ladders: [], stats: null, settings: {} });
  const [baskets, setBaskets] = useState([]);
  const [stations, setStations] = useState(null);
  const [cal, setCal] = useState(null);
  const [bt, setBt] = useState(null);
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState("live");
  const [log, setLog] = useState([]);
  const [wsOk, setWsOk] = useState(false);
  const wsRef = useRef(null);

  const addLog = useCallback((msg, type) => setLog(p => [{ id: Date.now() + Math.random(), time: now8(), msg, type }, ...p].slice(0, 150)), []);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let stop = false;
    const connect = () => {
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { setWsOk(true); addLog("WebSocket connected", "live"); };
      ws.onclose = () => { setWsOk(false); if (!stop) setTimeout(connect, 3000); };
      ws.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.type === "live") setLive(l => ({ ...l, ladders: d.ladders || [], stats: d.stats || l.stats })); } catch {} };
    };
    connect();
    const poll = setInterval(() => api("/api/live").then(setLive).catch(() => {}), 30000);
    api("/api/live").then(setLive).catch(() => {});
    return () => { stop = true; clearInterval(poll); try { wsRef.current?.close(); } catch {} };
  }, [addLog]);

  useEffect(() => {
    if (tab === "baskets") api("/api/baskets").then(d => setBaskets(d.baskets || []));
    if (tab === "stations") api("/api/stations").then(setStations);
    if (tab === "calib") api("/api/calibration").then(setCal);
    if (tab === "backtest") api("/api/backtest").then(setBt);
  }, [tab]);

  const ladders = live.ladders || [];
  const actionable = ladders.filter(l => l.signal !== "—");
  const paper = (live.settings?.paper_enabled ?? "true") === "true";
  const scanActive = (live.settings?.scan_active ?? "true") === "true";
  const s = live.stats || {};

  const trade = async (l) => {
    const d = await api("/api/paper-trade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: l.eventId }) });
    addLog(d.success ? `[PAPER] ${l.city}/${l.kind} ladder placed ${d.basketId}` : `[PAPER] ${d.error}`, d.success ? "success" : "error");
  };
  const setSetting = async (k, v) => { const d = await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [k]: v }) }); setLive(l => ({ ...l, settings: d.settings })); };
  const runBacktest = async () => {
    setBusy("backtest"); addLog("Backtest started (pulls archived forecasts + station history)…", "info");
    try { const r = await api("/api/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setBt(r); addLog(r.error ? `Backtest: ${r.error}` : `Backtest: cover3 ${r.best?.cover3?.coverRate}% · break-even ${r.recommended?.maxBasketCost3}`, r.error ? "error" : "success");
    } catch { addLog("Backtest failed", "error"); }
    setBusy("");
  };
  const runSeed = async () => {
    setBusy("seed"); addLog("Seeding bias history from archives…", "info");
    try { const r = await api("/api/seed", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const n = (r.results || []).reduce((a, x) => a + (x.seeded || 0), 0);
      addLog(`Seeded ${n} forecast/observation pairs`, "success"); api("/api/stations").then(setStations);
    } catch { addLog("Seeding failed", "error"); }
    setBusy("");
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'Courier New',monospace", padding: 18 }}>
      <style>{"@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}} ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#1b2433;border-radius:3px}"}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 2 }}>TEMPERATURE LADDER BOT</div>
          <div style={{ fontSize: 9, color: C.dim, letterSpacing: 1 }}>
            ECMWF+GFS+ICON ENSEMBLE @ RESOLUTION STATION · BIAS-CORRECTED · UNDERDISPERSION-FILTERED · PAPER
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 8, padding: "3px 8px", borderRadius: 4, background: wsOk ? "#06210f" : "#11151c", color: wsOk ? C.good : C.dim, border: `1px solid ${wsOk ? C.good : C.border}` }}>
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: wsOk ? C.good : C.dim, marginRight: 5, animation: wsOk ? "blink 1.4s infinite" : "none" }} />WS
          </span>
          <button onClick={() => setSetting("scan_active", scanActive ? "false" : "true")} style={{ background: scanActive ? "#06210f" : "#241206", color: scanActive ? C.good : C.bad, border: `1px solid ${scanActive ? C.good : C.bad}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 10, fontWeight: 700, fontFamily: "monospace" }}>{scanActive ? "● SCANNING" : "○ PAUSED"}</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {[["BALANCE", "$" + f(s.paperBalance), C.good],
          ["HIT RATE", (s.hitRate ?? "--") + "%", (s.hitRate || 0) >= 70 ? C.good : C.bad],
          ["P&L", sgn(s.totalPnl) === "--" ? "--" : "$" + sgn(s.totalPnl), (s.totalPnl || 0) >= 0 ? C.good : C.bad],
          ["ROI", (s.roi ?? "--") + "%", (s.roi || 0) >= 0 ? C.good : C.bad],
          ["BASKETS", `${s.closedBaskets || 0}/${s.totalBaskets || 0}`, C.blue],
          ["OPEN", `${s.openBaskets || 0} ($${f(s.openExposure)})`, C.warn],
          ["SIGNALS", `${actionable.length}/${ladders.length}`, actionable.length ? C.good : C.dim]].map(([lb, v, c]) => (
          <div key={lb} style={{ flex: 1, minWidth: 92, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px" }}>
            <div style={{ fontSize: 8, color: C.dim, letterSpacing: 1 }}>{lb}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: c, fontFamily: "monospace" }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
          {[["live", "LIVE"], ["baskets", "BASKETS"], ["stations", "STATIONS"], ["calib", "CALIBRATION"], ["backtest", "BACKTEST"], ["log", "LOG"], ["config", "CONFIG"]].map(([id, lb]) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, minWidth: 90, padding: "10px 4px", fontSize: 10, letterSpacing: 1, cursor: "pointer", background: tab === id ? "#131b2e" : "transparent", color: tab === id ? C.blue : C.dim, border: "none", borderBottom: tab === id ? `2px solid ${C.blue}` : "2px solid transparent", fontFamily: "monospace", fontWeight: tab === id ? 700 : 400 }}>{lb}</button>
          ))}
        </div>

        <div style={{ padding: 14 }}>
          {tab === "live" && (ladders.length ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(330px,1fr))", gap: 12 }}>
              {ladders.map(l => <LadderCard key={l.eventId} l={l} onTrade={trade} paper={paper} />)}
            </div>
          ) : <Empty msg="No live D+1 ladders yet — the first scan pulls ~60 station forecasts and takes a minute." />)}

          {tab === "baskets" && (baskets.length ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead><tr style={{ color: C.dim, textAlign: "left" }}>{["DATE", "CITY", "KIND", "STN", "CENTER", "RUNGS", "COST", "OUTLAY", "OBS", "WIN", "STATUS", "P&L"].map(h => <th key={h} style={{ padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                <tbody>{baskets.map(b => (
                  <tr key={b.id} style={{ background: b.status === "won" ? "#08140c" : b.status === "lost" ? "#1a0a08" : "transparent" }}>
                    <td style={{ padding: "5px 8px", color: C.dim }}>{b.marketDate}</td>
                    <td style={{ padding: "5px 8px", fontWeight: 700 }}>{b.city}</td>
                    <td style={{ padding: "5px 8px", color: b.kind === "high" ? C.bad : C.blue }}>{b.kind}</td>
                    <td style={{ padding: "5px 8px", color: C.dim, fontFamily: "monospace" }}>{b.station}</td>
                    <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{f(b.center, 1)}°</td>
                    <td style={{ padding: "5px 8px", fontFamily: "monospace", color: C.dim }}>{(b.legs || []).map(l => l.label.replace(/°[CF]/, "")).join("/")}</td>
                    <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{f(b.basketCost, 3)}</td>
                    <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>${f(b.outlay)}</td>
                    <td style={{ padding: "5px 8px", fontFamily: "monospace", color: C.warn }}>{b.obsValue != null ? b.obsValue + "°" : "--"}</td>
                    <td style={{ padding: "5px 8px", fontFamily: "monospace", color: C.good }}>{b.winLabel || "--"}</td>
                    <td style={{ padding: "5px 8px", color: b.status === "won" ? C.good : b.status === "lost" ? C.bad : C.warn, fontWeight: 700 }}>{(b.status || "").toUpperCase()}</td>
                    <td style={{ padding: "5px 8px", color: (b.pnl || 0) >= 0 ? C.good : C.bad, fontFamily: "monospace", fontWeight: 700 }}>{b.pnl != null ? "$" + sgn(b.pnl) : "--"}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          ) : <Empty msg="No ladders placed yet." />)}

          {tab === "stations" && (stations ? (
            <div>
              <div style={{ fontSize: 10, color: C.dim, marginBottom: 10 }}>
                A station is only tradable once its bias fit has <b style={{ color: C.text }}>{stations.minBiasSamples}</b> forecast/observation pairs.
                The underdispersion filter additionally needs <b style={{ color: C.text }}>{stations.minDispSamples}</b> days of live ensemble spread —
                that one cannot be seeded, because Open-Meteo serves no ensemble members for past dates.
                <button onClick={runSeed} disabled={!!busy} style={{ marginLeft: 10, background: C.blue, color: "#000", border: "none", borderRadius: 5, padding: "4px 12px", cursor: "pointer", fontSize: 9, fontWeight: 800, fontFamily: "monospace" }}>{busy === "seed" ? "SEEDING…" : "SEED BIAS HISTORY"}</button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                  <thead><tr style={{ color: C.dim, textAlign: "left" }}>{["CITY", "STATION", "KIND", "N", "BIAS", "MAE RAW", "MAE CORR", "SPREAD N", "STATUS"].map(h => <th key={h} style={{ padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                  <tbody>{stations.stations.map((r, i) => (
                    <tr key={i} style={{ opacity: r.unsupported ? 0.45 : 1 }}>
                      <td style={{ padding: "4px 8px", fontWeight: 700 }}>{r.city}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace", color: C.dim }}>{r.station} · {r.name}</td>
                      <td style={{ padding: "4px 8px", color: r.kind === "high" ? C.bad : C.blue }}>{r.kind}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{r.biasSamples}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace", color: Math.abs(r.bias || 0) > 1 ? C.warn : C.text }}>{sgn(r.bias, 2)}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace", color: C.dim }}>{f(r.rmseUncorrected, 2)}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace", color: C.good }}>{f(r.rmse, 2)}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace", color: r.dispersionReady ? C.good : C.dim }}>{r.spreadSamples}</td>
                      <td style={{ padding: "4px 8px", fontSize: 9, color: r.unsupported ? C.dim : r.calibrated ? C.good : C.warn }}>
                        {r.unsupported ? "UNSUPPORTED (non-METAR resolver)" : r.calibrated ? "CALIBRATED" : "NEEDS DATA"}
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>
            </div>
          ) : <Empty msg="Loading stations…" />)}

          {tab === "calib" && (cal ? (
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                {[["RUNG SAMPLES", cal.legs?.n ?? 0], ["RUNG BRIER", cal.legs?.brier ?? "--"], ["RUNG ECE", cal.legs?.ece ?? "--"],
                  ["CLAIMED COVER", cal.cover?.claimedCover != null ? pc(cal.cover.claimedCover) : "--"],
                  ["REALIZED COVER", cal.cover?.realizedCover != null ? cal.cover.realizedCover + "%" : "--"],
                  ["CENTER MAE", cal.center?.mae ?? "--"], ["WITHIN 1°", cal.center?.within1 != null ? cal.center.within1 + "%" : "--"]].map(([l, v]) => (
                  <div key={l} style={{ background: "#0a0e16", border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 12px" }}>
                    <div style={{ fontSize: 8, color: C.dim }}>{l}</div><div style={{ fontSize: 15, fontWeight: 800, fontFamily: "monospace" }}>{v}</div>
                  </div>))}
              </div>
              {["byStation", "byRegime", "byLead"].map(k => (
                <div key={k} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 4, letterSpacing: 1 }}>{k.replace("by", "BY ").toUpperCase()}</div>
                  {Object.keys(cal[k] || {}).length ? (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                      <thead><tr style={{ color: C.dim, textAlign: "left" }}>{["KEY", "N", "HIT RATE", "CLAIMED", "P&L", "ROI"].map(h => <th key={h} style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                      <tbody>{Object.entries(cal[k]).map(([key, v]) => (
                        <tr key={key}>
                          <td style={{ padding: "3px 8px", fontWeight: 700 }}>{key}</td>
                          <td style={{ padding: "3px 8px", fontFamily: "monospace" }}>{v.n}</td>
                          <td style={{ padding: "3px 8px", fontFamily: "monospace", color: v.hitRate >= v.claimedCover ? C.good : C.warn }}>{v.hitRate}%</td>
                          <td style={{ padding: "3px 8px", fontFamily: "monospace", color: C.dim }}>{v.claimedCover}%</td>
                          <td style={{ padding: "3px 8px", fontFamily: "monospace", color: v.pnl >= 0 ? C.good : C.bad }}>${sgn(v.pnl)}</td>
                          <td style={{ padding: "3px 8px", fontFamily: "monospace", color: v.roi >= 0 ? C.good : C.bad }}>{v.roi}%</td>
                        </tr>))}</tbody>
                    </table>
                  ) : <div style={{ fontSize: 10, color: "#1f2937", padding: "6px 8px" }}>no settled baskets yet</div>}
                </div>
              ))}
            </div>
          ) : <Empty msg="Calibration appears once ladders settle." />)}

          {tab === "backtest" && (
            <div>
              <button onClick={runBacktest} disabled={!!busy} style={{ background: C.blue, color: "#000", border: "none", borderRadius: 6, padding: "7px 16px", cursor: "pointer", fontSize: 11, fontWeight: 800, fontFamily: "monospace", marginBottom: 12 }}>
                {busy === "backtest" ? "RUNNING… (pulls archived forecasts + station history)" : "RUN WALK-FORWARD BACKTEST"}
              </button>
              {bt && bt.best ? (
                <div>
                  <div style={{ fontSize: 11, marginBottom: 8 }}>{bt.datasets} station/kind sets · {bt.start} → {bt.end} · <b>{bt.best.n}</b> walk-forward days</div>
                  <div style={{ background: "#08140c", border: `1px solid ${C.good}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 9, color: C.dim }}>BEST PARAMETERS (written to settings)</div>
                    <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 4 }}>
                      SIGMA_MULT={bt.best.SIGMA_MULT} · HALFLIFE={bt.best.BIAS_HALFLIFE_DAYS}d · WINDOW={bt.best.BIAS_WINDOW_DAYS}d → log-loss <b style={{ color: C.good }}>{bt.best.logloss}</b>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, marginTop: 6, color: C.text }}>
                      bias correction: MAE <b style={{ color: C.bad }}>{bt.best.maeRaw}</b> → <b style={{ color: C.good }}>{bt.best.maeCorrected}</b> °
                      {"   ·   "}within 1°: {bt.best.within1}%
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, marginTop: 6 }}>
                      3-rung cover <b style={{ color: C.good }}>{bt.best.cover3?.coverRate}%</b> (claimed {bt.best.cover3?.claimed}%) → break-even cost <b style={{ color: C.warn }}>{bt.best.cover3?.breakEvenCost}</b><br />
                      4-rung cover <b style={{ color: C.good }}>{bt.best.cover4?.coverRate}%</b> (claimed {bt.best.cover4?.claimed}%) → break-even cost <b style={{ color: C.warn }}>{bt.best.cover4?.breakEvenCost}</b>
                    </div>
                  </div>
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 6 }}>PER STATION (sorted by 3-rung cover)</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, marginBottom: 12 }}>
                    <thead><tr style={{ color: C.dim, textAlign: "left" }}>{["CITY", "STN", "KIND", "N", "STATION BIAS", "MAE RAW", "MAE CORR", "COVER3", "COVER4"].map(h => <th key={h} style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                    <tbody>{bt.perStation.map((p, i) => (
                      <tr key={i}>
                        <td style={{ padding: "3px 8px", fontWeight: 700 }}>{p.city}</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace", color: C.dim }}>{p.station}</td>
                        <td style={{ padding: "3px 8px", color: C.dim }}>{p.kind}</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace" }}>{p.n}</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace", color: Math.abs(p.meanBias) > 1 ? C.warn : C.text }}>{sgn(p.meanBias)}</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace", color: C.bad }}>{p.maeRaw}</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace", color: C.good }}>{p.maeCorrected}</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace" }}>{p.cover3}%</td>
                        <td style={{ padding: "3px 8px", fontFamily: "monospace" }}>{p.cover4}%</td>
                      </tr>))}</tbody>
                  </table>
                  <div style={{ fontSize: 8, color: C.dim, fontStyle: "italic", lineHeight: 1.6 }}>{bt.note}</div>
                </div>
              ) : bt && bt.error ? <Empty msg={`Backtest: ${bt.error}`} /> : <Empty msg="No backtest yet — click RUN." />}
            </div>
          )}

          {tab === "log" && (
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {log.length ? log.map(e => (
                <div key={e.id} style={{ display: "flex", gap: 8, padding: "2px 0", fontSize: 10, borderBottom: "1px solid #0a0d13" }}>
                  <span style={{ color: C.border, fontFamily: "monospace" }}>{e.time}</span>
                  <span style={{ color: e.type === "success" ? C.good : e.type === "error" ? C.bad : e.type === "live" ? C.blue : C.dim }}>{e.msg}</span>
                </div>
              )) : <Empty msg="No log entries." />}
            </div>
          )}

          {tab === "config" && (
            <div style={{ maxWidth: 560, fontSize: 11 }}>
              <Row label="Paper trading"><Toggle on={paper} onClick={() => setSetting("paper_enabled", paper ? "false" : "true")} /></Row>
              <Row label="Scanning"><Toggle on={scanActive} onClick={() => setSetting("scan_active", scanActive ? "false" : "true")} /></Row>
              <Row label="Sit out when the ensemble is wide">
                <Toggle on={live.settings?.skip_when_wide === "true"} onClick={() => setSetting("skip_when_wide", live.settings?.skip_when_wide === "true" ? "false" : "true")} />
              </Row>
              <Row label="Sizing">
                <select value={live.settings?.sizing || "kelly"} onChange={e => setSetting("sizing", e.target.value)}
                        style={{ background: "#0a0e16", color: C.blue, border: `1px solid ${C.border}`, borderRadius: 5, padding: "4px 8px", fontFamily: "monospace", fontSize: 10 }}>
                  <option value="kelly">kelly (multi-outcome)</option>
                  <option value="prob">prob-weighted</option>
                  <option value="equal">equal shares</option>
                </select>
              </Row>
              {[["w_model", "Weight on model vs market"], ["min_basket_ev", "Min basket EV"], ["min_cover_prob", "Min cover probability"],
                ["max_basket_cost", "Max basket cost"], ["sigma_mult", "Sigma multiplier"], ["underdisp_lo", "Underdispersion threshold"],
                ["overdisp_hi", "Overdispersion threshold"]].map(([k, lb]) => (
                <Row key={k} label={lb}>
                  <input defaultValue={live.settings?.[k] ?? ""} onBlur={e => setSetting(k, e.target.value)}
                         style={{ width: 70, background: "#0a0e16", color: C.blue, border: `1px solid ${C.border}`, borderRadius: 5, padding: "4px 8px", fontFamily: "monospace", fontSize: 10, textAlign: "right" }} />
                </Row>
              ))}
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={async () => { const d = await api("/api/reset-paper", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); setLive(l => ({ ...l, stats: { ...l.stats, paperBalance: d.newBalance } })); addLog("Paper balance reset", "info"); }}
                        style={{ background: C.border, color: C.text, border: "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>RESET BALANCE</button>
                <button onClick={async () => { await api("/api/scan", { method: "POST" }); addLog("Manual scan triggered", "info"); }}
                        style={{ background: C.border, color: C.text, border: "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>SCAN NOW</button>
              </div>
              <div style={{ marginTop: 16, padding: 12, background: "#0a0e16", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 9, color: C.dim, lineHeight: 1.8 }}>
                <div style={{ color: C.blue, fontWeight: 700, marginBottom: 4 }}>STRATEGY</div>
                Buy 3-4 ADJACENT temperature buckets instead of guessing one. The cluster is centered on a
                bias-corrected forecast at the exact station the market resolves on (METAR, whole degrees), sized by
                multi-outcome Kelly, and only bought when the basket clears its fee-adjusted EV floor — a ladder is
                not free money, it costs the sum of its rungs plus the book's overround. Sigma is anchored on the
                station's own realized error; the underdispersion filter presses when today's ensemble is tighter than
                that station's norm and widens when it is not. Paper trading only.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
