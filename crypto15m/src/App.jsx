import React, { useState, useEffect, useRef, useCallback } from "react";

const pc = (x) => (x == null ? "--" : (x * 100).toFixed(1) + "%");
const f = (x, d = 2) => (x == null ? "--" : Number(x).toFixed(d));
const mmss = (s) => (s == null ? "--:--" : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.max(0, s % 60)).padStart(2, "0")}`);
const now8 = () => new Date().toISOString().slice(11, 19);
const api = (p, opts) => fetch(p, opts).then(r => r.json());

const C = { bg: "#06070d", panel: "#0d1117", border: "#1b2433", up: "#22c55e", down: "#f97316", blue: "#38bdf8", dim: "#475569", text: "#cbd5e1", warn: "#facc15" };

function Chip({ s }) {
  const m = { "BUY UP": [C.up, "#06210f"], "BUY DOWN": [C.down, "#241206"], "—": [C.dim, "#11151c"] };
  const [fg, bgc] = m[s] || m["—"];
  return <span style={{ color: fg, background: bgc, border: `1px solid ${fg}`, borderRadius: 5, padding: "2px 8px", fontSize: 10, fontWeight: 800, fontFamily: "monospace" }}>{s}</span>;
}

function Bar({ v, color }) { // v in [-1,1]
  const pct = Math.min(100, Math.abs(v || 0) * 100);
  return (
    <div style={{ height: 6, background: "#0a0e16", borderRadius: 3, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#1b2433" }} />
      <div style={{ position: "absolute", top: 0, bottom: 0, [v >= 0 ? "left" : "right"]: "50%", width: pct / 2 + "%", background: color }} />
    </div>
  );
}

function AssetCard({ a, onTrade, paper }) {
  const tick = a._secs; // locally-ticked countdown
  const actionable = a.signal !== "—";
  const sideColor = a.side === "UP" ? C.up : a.side === "DOWN" ? C.down : C.dim;
  return (
    <div style={{ background: actionable ? "#08140c" : C.panel, border: `1px solid ${actionable ? C.up : C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{a.asset}</span>
          <span style={{ fontSize: 9, color: C.dim, marginLeft: 6 }}>{a.name}</span>
          <span style={{ fontSize: 8, color: a.mode === "A" ? C.blue : C.dim, marginLeft: 8, fontFamily: "monospace" }}>MODE {a.mode || "-"}</span>
        </div>
        <div style={{ fontFamily: "monospace", fontWeight: 800, color: tick <= 60 ? C.warn : C.blue, fontSize: 16 }}>{mmss(tick)}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 9, color: C.dim, marginBottom: 8 }}>
        <div>open <b style={{ color: C.text }}>{f(a.sOpen, a.sOpen > 100 ? 1 : 4)}</b></div>
        <div>ref <b style={{ color: C.text }}>{f(a.ref, a.ref > 100 ? 1 : 4)}</b></div>
        <div>lead <b style={{ color: (a.leadBps || 0) >= 0 ? C.up : C.down }}>{f(a.leadBps, 1)}bps</b></div>
        <div>z <b style={{ color: C.text }}>{f(a.z, 2)}</b></div>
        <div>σ/s <b style={{ color: C.text }}>{a.sigmaPerSec ? (a.sigmaPerSec * 1e4).toFixed(2) + "bp" : "--"}</b></div>
        <div>ref <b style={{ color: C.text }}>{a.refSource || "--"}</b></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 9, marginBottom: 8 }}>
        <Box label="P model" v={pc(a.pModel)} c={C.blue} />
        <Box label="P used" v={pc(a.pUsed)} c="#a78bfa" />
        <Box label="Poly Up" v={pc(a.pMarketUp)} c={C.warn} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontSize: 9, color: C.dim }}>
          edge <b style={{ color: (a.rawEdge || 0) > 0 ? C.up : C.down }}>{a.rawEdge != null ? (a.rawEdge * 100).toFixed(1) + "%" : "--"}</b>
          {"  "}net <b style={{ color: (a.netEdge || 0) > 0 ? C.up : C.down }}>{a.netEdge != null ? (a.netEdge * 100).toFixed(1) + "%" : "--"}</b>
          {"  "}fee <span style={{ color: C.dim }}>{a.feeFrac != null ? (a.feeFrac * 100).toFixed(1) + "%" : "--"}</span>
        </div>
        <Chip s={a.signal} />
      </div>

      {actionable ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: sideColor, fontFamily: "monospace" }}>stake ${f(a.stake)} @ {f(a.q, 3)}{a.placed ? " · placed ✓" : ""}</span>
          {paper && <button onClick={() => onTrade(a)} style={{ background: sideColor, color: "#000", border: "none", borderRadius: 5, padding: "4px 12px", cursor: "pointer", fontSize: 9, fontWeight: 800, fontFamily: "monospace" }}>PAPER {a.side}</button>}
        </div>
      ) : (
        <div style={{ fontSize: 8, color: C.dim, fontFamily: "monospace", minHeight: 14 }}>{(a.reasons || []).join(" · ") || "evaluating…"}</div>
      )}
    </div>
  );
}
const Box = ({ label, v, c }) => (
  <div style={{ background: "#0a0e16", border: "1px solid #131b27", borderRadius: 6, padding: "5px 7px" }}>
    <div style={{ fontSize: 7, color: C.dim, letterSpacing: 1 }}>{label}</div>
    <div style={{ fontSize: 12, fontWeight: 800, color: c, fontFamily: "monospace" }}>{v}</div>
  </div>
);

export default function App() {
  const [live, setLive] = useState({ assets: [], stats: null, settings: {} });
  const [trades, setTrades] = useState([]);
  const [calibration, setCalibration] = useState(null);
  const [bt, setBt] = useState(null);
  const [btLoading, setBtLoading] = useState(false);
  const [tab, setTab] = useState("live");
  const [log, setLog] = useState([]);
  const [wsOk, setWsOk] = useState(false);
  const [tickNow, setTickNow] = useState(Date.now());
  const wsRef = useRef(null);

  const addLog = useCallback((msg, type) => setLog(p => [{ id: Date.now() + Math.random(), time: now8(), msg, type }, ...p].slice(0, 120)), []);

  // WebSocket live feed + polling fallback.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let stop = false;
    const connect = () => {
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { setWsOk(true); addLog("WebSocket connected", "live"); };
      ws.onclose = () => { setWsOk(false); if (!stop) setTimeout(connect, 3000); };
      ws.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.type === "live") setLive(l => ({ ...l, assets: d.assets || [], stats: d.stats || l.stats })); } catch {} };
    };
    connect();
    const poll = setInterval(() => api("/api/live").then(setLive).catch(() => {}), 15000);
    api("/api/live").then(setLive).catch(() => {});
    return () => { stop = true; clearInterval(poll); try { wsRef.current?.close(); } catch {} };
  }, [addLog]);

  useEffect(() => { const t = setInterval(() => setTickNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (tab === "trades") api("/api/trades").then(d => setTrades(d.trades || [])); if (tab === "calib") api("/api/calibration").then(setCalibration); if (tab === "backtest") api("/api/backtest").then(setBt); }, [tab]);

  const assets = (live.assets || []).map(a => ({ ...a, _secs: a.endDate ? Math.max(0, Math.round((Date.parse(a.endDate) - tickNow) / 1000)) : a.secsLeft }));
  const paper = (live.settings?.paper_enabled ?? "true") === "true";
  const scanActive = (live.settings?.scan_active ?? "true") === "true";

  const trade = async (a) => {
    addLog(`[PAPER] ${a.side} ${a.asset} @ ${f(a.q, 3)} stake $${f(a.stake)}`, "live");
    const d = await api("/api/paper-trade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marketId: a.marketId }) });
    addLog(d.success ? `[PAPER] placed ${d.tradeId}` : `[PAPER] ${d.error}`, d.success ? "success" : "error");
  };
  const setSetting = async (k, v) => { const d = await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [k]: v }) }); setLive(l => ({ ...l, settings: d.settings })); };
  const runBacktest = async () => { setBtLoading(true); addLog("Backtest started…", "info"); try { const r = await api("/api/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); setBt(r); addLog(`Backtest: best WR ${r.best?.winRate}% over ${r.best?.trades} trades`, "success"); } catch (e) { addLog("Backtest failed", "error"); } setBtLoading(false); };

  const s = live.stats || {};
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'Courier New',monospace", padding: 18 }}>
      <style>{"@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}} ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#1b2433;border-radius:3px}"}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 2 }}>15M CRYPTO IMBALANCE BOT</div>
          <div style={{ fontSize: 9, color: C.dim, letterSpacing: 1 }}>PYTH ORACLE + COINBASE WS + POLYMARKET CLOB · LEAD-LOCK-IN · PAPER</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 8, padding: "3px 8px", borderRadius: 4, background: wsOk ? "#06210f" : "#11151c", color: wsOk ? C.up : C.dim, border: `1px solid ${wsOk ? C.up : C.border}` }}>
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: wsOk ? C.up : C.dim, marginRight: 5, animation: wsOk ? "blink 1.4s infinite" : "none" }} />WS
          </span>
          <button onClick={() => setSetting("scan_active", scanActive ? "false" : "true")} style={{ background: scanActive ? "#06210f" : "#241206", color: scanActive ? C.up : C.down, border: `1px solid ${scanActive ? C.up : C.down}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 10, fontWeight: 700, fontFamily: "monospace" }}>{scanActive ? "● SCANNING" : "○ PAUSED"}</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {[["BALANCE", "$" + f(s.paperBalance), C.up], ["WIN RATE", (s.winRate ?? "--") + "%", (s.winRate || 0) >= 50 ? C.up : C.down], ["P&L", (s.totalPnl >= 0 ? "+" : "") + "$" + f(s.totalPnl), (s.totalPnl || 0) >= 0 ? C.up : C.down], ["TRADES", `${s.closedTrades || 0}/${s.totalTrades || 0}`, C.blue], ["OPEN", s.openTrades || 0, C.warn], ["AVG EV", (s.avgEv ?? "--") + "%", (s.avgEv || 0) >= 0 ? C.up : C.down]].map(([l, v, c]) => (
          <div key={l} style={{ flex: 1, minWidth: 90, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px" }}>
            <div style={{ fontSize: 8, color: C.dim, letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: c, fontFamily: "monospace" }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
          {[["live", "LIVE"], ["trades", "TRADES"], ["calib", "CALIBRATION"], ["backtest", "BACKTEST"], ["log", "LOG"], ["config", "CONFIG"]].map(([id, lb]) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "10px 4px", fontSize: 10, letterSpacing: 1, cursor: "pointer", background: tab === id ? "#131b2e" : "transparent", color: tab === id ? C.blue : C.dim, border: "none", borderBottom: tab === id ? `2px solid ${C.blue}` : "2px solid transparent", fontFamily: "monospace", fontWeight: tab === id ? 700 : 400 }}>{lb}</button>
          ))}
        </div>

        <div style={{ padding: 14 }}>
          {tab === "live" && (
            assets.length ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12 }}>
                {assets.map(a => <AssetCard key={a.asset} a={a} onTrade={trade} paper={paper} />)}
              </div>
            ) : <Empty msg="Waiting for live 15m windows… (feeds warm up ~5s)" />
          )}

          {tab === "trades" && (
            trades.length ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                  <thead><tr style={{ color: C.dim, textAlign: "left" }}>{["TIME", "ASSET", "SIDE", "ENTRY", "SIZE", "MODE", "STATUS", "P&L"].map(h => <th key={h} style={{ padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                  <tbody>{trades.map(t => (
                    <tr key={t.id} style={{ background: t.status === "won" ? "#08140c" : t.status === "lost" ? "#1a0a08" : "transparent" }}>
                      <td style={{ padding: "5px 8px", color: C.dim }}>{(t.ts || "").slice(11, 19)}</td>
                      <td style={{ padding: "5px 8px", fontWeight: 700 }}>{t.asset}</td>
                      <td style={{ padding: "5px 8px", color: t.side === "UP" ? C.up : C.down }}>{t.side}</td>
                      <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{f(t.entryPrice, 3)}</td>
                      <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>${f(t.size)}</td>
                      <td style={{ padding: "5px 8px", color: C.dim }}>{t.mode}</td>
                      <td style={{ padding: "5px 8px", color: t.status === "won" ? C.up : t.status === "lost" ? C.down : C.warn, fontWeight: 700 }}>{(t.status || "open").toUpperCase()}</td>
                      <td style={{ padding: "5px 8px", color: (t.pnl || 0) >= 0 ? C.up : C.down, fontFamily: "monospace", fontWeight: 700 }}>{t.pnl != null ? (t.pnl >= 0 ? "+" : "") + "$" + f(t.pnl) : "--"}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            ) : <Empty msg="No trades yet. The bot auto-trades qualifying late-window signals." />
          )}

          {tab === "calib" && (
            calibration && calibration.calibration?.n ? (
              <div>
                <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                  {[["SAMPLES", calibration.calibration.n], ["WIN RATE", calibration.calibration.winRate + "%"], ["BRIER", calibration.calibration.brier], ["LOG-LOSS", calibration.calibration.logloss], ["ECE", calibration.calibration.ece]].map(([l, v]) => (
                    <div key={l} style={{ background: "#0a0e16", border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 12px" }}><div style={{ fontSize: 8, color: C.dim }}>{l}</div><div style={{ fontSize: 15, fontWeight: 800, fontFamily: "monospace" }}>{v}</div></div>
                  ))}
                </div>
                <div style={{ fontSize: 9, color: C.dim, marginBottom: 6 }}>RELIABILITY (confidence vs realized accuracy)</div>
                {calibration.calibration.bins.map(b => (
                  <div key={b.range} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 70, fontSize: 9, color: C.dim }}>{b.range}</span>
                    <div style={{ flex: 1 }}><Bar v={(b.accuracy - 0.5) * 2} color={C.up} /></div>
                    <span style={{ width: 120, fontSize: 9, fontFamily: "monospace", color: C.text }}>acc {pc(b.accuracy)} / n{b.n}</span>
                  </div>
                ))}
              </div>
            ) : <Empty msg="Calibration appears after windows resolve." />
          )}

          {tab === "backtest" && (
            <div>
              <button onClick={runBacktest} disabled={btLoading} style={{ background: C.blue, color: "#000", border: "none", borderRadius: 6, padding: "7px 16px", cursor: "pointer", fontSize: 11, fontWeight: 800, fontFamily: "monospace", marginBottom: 12 }}>{btLoading ? "RUNNING… (pulls historical data)" : "RUN BACKTEST + AUTO-TUNE"}</button>
              {bt && bt.best ? (
                <div>
                  <div style={{ fontSize: 11, color: C.text, marginBottom: 8 }}>Tested <b>{bt.windowsTested}</b> resolved windows · target WR {Math.round((bt.target || 0) * 100)}%</div>
                  <div style={{ background: "#08140c", border: `1px solid ${C.up}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 9, color: C.dim }}>BEST THRESHOLDS (written to settings)</div>
                    <div style={{ fontFamily: "monospace", fontSize: 13, marginTop: 4 }}>MIN_P={bt.best.MIN_P} · MIN_Z={bt.best.MIN_Z} · LATE_WINDOW_S={bt.best.LATE_WINDOW_S} → <b style={{ color: C.up }}>WR {bt.best.winRate}%</b> over {bt.best.trades} trades</div>
                  </div>
                  {bt.calibration?.n ? <div style={{ fontSize: 10, color: C.dim, marginBottom: 10 }}>Model calibration — Brier {bt.calibration.brier} · log-loss {bt.calibration.logloss} · ECE {bt.calibration.ece}</div> : null}
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 6 }}>FRONTIER (top by win-rate)</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                    <thead><tr style={{ color: C.dim, textAlign: "left" }}>{["MIN_P", "MIN_Z", "LATE_S", "TRADES", "WR"].map(h => <th key={h} style={{ padding: "5px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                    <tbody>{bt.frontier.map((g, i) => <tr key={i}><td style={{ padding: "4px 8px" }}>{g.MIN_P}</td><td style={{ padding: "4px 8px" }}>{g.MIN_Z}</td><td style={{ padding: "4px 8px" }}>{g.LATE_WINDOW_S}</td><td style={{ padding: "4px 8px" }}>{g.trades}</td><td style={{ padding: "4px 8px", color: g.winRate >= 80 ? C.up : C.text }}>{g.winRate}%</td></tr>)}</tbody>
                  </table>
                  <div style={{ fontSize: 8, color: C.dim, marginTop: 10, fontStyle: "italic" }}>{bt.note}</div>
                </div>
              ) : <Empty msg="No backtest yet — click RUN to pull historical windows and tune." />}
            </div>
          )}

          {tab === "log" && (
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {log.length ? log.map(e => (
                <div key={e.id} style={{ display: "flex", gap: 8, padding: "2px 0", fontSize: 10, borderBottom: "1px solid #0a0d13" }}>
                  <span style={{ color: C.border, fontFamily: "monospace" }}>{e.time}</span>
                  <span style={{ color: e.type === "success" ? C.up : e.type === "error" ? C.down : e.type === "live" ? C.blue : e.type === "warn" ? C.warn : C.dim }}>{e.msg}</span>
                </div>
              )) : <Empty msg="No log entries." />}
            </div>
          )}

          {tab === "config" && (
            <div style={{ maxWidth: 520, fontSize: 11 }}>
              <Row label="Paper trading"><Toggle on={paper} onClick={() => setSetting("paper_enabled", paper ? "false" : "true")} /></Row>
              <Row label="Scanning"><Toggle on={scanActive} onClick={() => setSetting("scan_active", scanActive ? "false" : "true")} /></Row>
              <Row label="Drift signals (microstructure)"><Toggle on={(live.settings?.drift_enabled) === "true"} onClick={() => setSetting("drift_enabled", live.settings?.drift_enabled === "true" ? "false" : "true")} /></Row>
              <Row label="Min P (favorite)"><span style={{ fontFamily: "monospace", color: C.blue }}>{live.settings?.min_p}</span></Row>
              <Row label="Min |z|"><span style={{ fontFamily: "monospace", color: C.blue }}>{live.settings?.min_z}</span></Row>
              <Row label="Late window (s)"><span style={{ fontFamily: "monospace", color: C.blue }}>{live.settings?.late_window_s}</span></Row>
              <div style={{ marginTop: 14 }}>
                <button onClick={async () => { const d = await api("/api/reset-paper", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); setLive(l => ({ ...l, stats: { ...l.stats, paperBalance: d.newBalance } })); addLog("Paper balance reset", "info"); }} style={{ background: C.border, color: C.text, border: "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>RESET BALANCE</button>
              </div>
              <div style={{ marginTop: 16, padding: 12, background: "#0a0e16", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 9, color: C.dim, lineHeight: 1.8 }}>
                <div style={{ color: C.blue, fontWeight: 700, marginBottom: 4 }}>STRATEGY</div>
                Late-window lead-lock-in: P_up = Φ(L/(σ√τ)), shrunk toward the Poly price, trading favorites where taker fees are
                cheapest. Resolves on the Pyth oracle close vs open (≥ ⇒ Up). Microstructure drift is off by default until the
                backtest/calibration harness proves it helps. Paper only.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
const Empty = ({ msg }) => <div style={{ padding: 50, textAlign: "center", color: "#1f2937", fontSize: 12 }}>{msg}</div>;
const Row = ({ label, children }) => <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #0d1117" }}><span style={{ color: "#94a3b8" }}>{label}</span>{children}</div>;
const Toggle = ({ on, onClick }) => <div onClick={onClick} style={{ width: 42, height: 22, borderRadius: 11, cursor: "pointer", background: on ? "#16a34a" : "#1b2433", position: "relative", transition: ".15s" }}><div style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: ".15s" }} /></div>;
