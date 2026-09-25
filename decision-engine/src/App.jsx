import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C, MONO, GLOBAL_CSS, Btn, ErrorBoundary, inputStyle, api, arr, num, fprice, useWidth } from "./components/ui.jsx";
import Header from "./components/Header.jsx";
import DecisionBoard from "./components/DecisionBoard.jsx";
import DetailPanel from "./components/DetailPanel.jsx";
import PortfolioTab from "./components/PortfolioTab.jsx";
import PerformanceTab from "./components/PerformanceTab.jsx";
import BacktestTab from "./components/BacktestTab.jsx";
import RankingsTab from "./components/RankingsTab.jsx";
import LabTab from "./components/LabTab.jsx";

// ─── Settings normalization (server may store strings) ───────────────────────
const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";
function normSettings(s) {
  if (!s || typeof s !== "object") return {};
  const o = {};
  const h = s.horizon ?? s.HORIZON; if (typeof h === "string") o.horizon = h;
  const mc = num(s.min_confidence ?? s.minConfidence ?? s.MIN_CONFIDENCE); if (mc != null) o.min_confidence = mc;
  const pe = num(s.min_prob_edge ?? s.minProbEdge ?? s.MIN_PROB_EDGE); if (pe != null) o.min_prob_edge = pe;
  const at = s.auto_trade ?? s.autoTrade ?? s.AUTO_TRADE; if (at != null) o.auto_trade = toBool(at);
  return o;
}
const DEFAULT_SETTINGS = { horizon: "swing", min_confidence: 0.65, auto_trade: false };

// ─── WebSocket with exponential backoff + tick batching ─────────────────────
function useEngineSocket(handlers) {
  const [state, setState] = useState("connecting");
  const h = useRef(handlers); h.current = handlers;
  useEffect(() => {
    let ws, stop = false, attempt = 0, timer;
    const connect = () => {
      setState("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      try { ws = new WebSocket(`${proto}//${location.host}/ws`); } catch { schedule(); return; }
      ws.onopen = () => { attempt = 0; setState("open"); h.current.onOpen?.(); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } try { h.current.onMessage?.(m); } catch (err) { console.warn("ws handler", err); } };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onclose = () => { setState("closed"); if (!stop) schedule(); };
    };
    const schedule = () => { const d = Math.min(30000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5); attempt++; clearTimeout(timer); timer = setTimeout(connect, d); };
    connect();
    return () => { stop = true; clearTimeout(timer); try { ws && ws.close(); } catch {} };
  }, []);
  return state;
}

const TABS = [["decisions", "DECISIONS"], ["rankings", "RANKINGS"], ["portfolio", "PORTFOLIO"], ["performance", "PERFORMANCE"], ["backtest", "BACKTEST"], ["lab", "LAB"]];

function AnalyzeBox({ onResult, compact }) {
  const [sym, setSym] = useState("");
  const [cls, setCls] = useState("stock");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async (e) => {
    e?.preventDefault();
    const s = sym.trim().toUpperCase().replace(/^(STOCK|CRYPTO):/, "");
    if (!s || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api("/api/analyze", { method: "POST", body: { symbol: s, assetClass: cls } });
      const d = r?.decision && !r.action ? { ...r.decision, history: r.history } : r;
      if (!d || !d.action) throw new Error("no decision returned");
      onResult(d);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={go} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1.5 }}>ANALYZE</span>
      <input value={sym} onChange={e => setSym(e.target.value)} placeholder="ticker e.g. AMD" aria-label="ticker" style={{ ...inputStyle, width: compact ? 100 : 120, textTransform: "uppercase" }} />
      <select value={cls} onChange={e => setCls(e.target.value)} style={inputStyle} aria-label="asset class"><option value="stock">stock</option><option value="crypto">crypto</option></select>
      <Btn type="submit" disabled={busy || !sym.trim()} active color={C.violet}>{busy ? <span className="de-pulse">ANALYZING…</span> : "RUN"}</Btn>
      {err && <span style={{ color: "#fca5a5", fontFamily: MONO, fontSize: 10 }} title={err}>⚠ {err.length > 48 ? err.slice(0, 48) + "…" : err}</span>}
    </form>
  );
}

export default function App() {
  const width = useWidth();
  const narrow = width < 720;
  const split = width >= 1180;

  const [tab, setTab] = useState(() => { try { return localStorage.getItem("de.tab") || "decisions"; } catch { return "decisions"; } });
  useEffect(() => { try { localStorage.setItem("de.tab", tab); } catch {} }, [tab]);

  const [decisions, setDecisions] = useState([]);
  const [decLoading, setDecLoading] = useState(true);
  const [decErr, setDecErr] = useState(null);
  const [health, setHealth] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [savingKey, setSavingKey] = useState(null);
  const [ticks, setTicks] = useState({});
  const [selected, setSelected] = useState(null); // { id, provided? }
  const [toasts, setToasts] = useState([]);
  const [portfolioKey, setPortfolioKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  const toast = useCallback((msg, color = C.blue) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t.slice(-3), { id, msg, color }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  const loadDecisions = useCallback(() => api("/api/decisions").then(r => { setDecisions(arr(r?.decisions ?? r)); setDecErr(null); }, e => setDecErr(e.message)).finally(() => setDecLoading(false)), []);
  const loadHealth = useCallback(() => api("/api/health").then(h => { setHealth(h); const s = normSettings(h?.settings); if (Object.keys(s).length) setSettings(p => ({ ...p, ...s })); }, () => setHealth(p => p)), []);

  useEffect(() => {
    loadDecisions(); loadHealth();
    api("/api/settings").then(s => { const n = normSettings(s?.settings ?? s); if (Object.keys(n).length) setSettings(p => ({ ...p, ...n })); }, () => {});
    const t = setInterval(loadHealth, 30000);
    return () => clearInterval(t);
  }, [loadDecisions, loadHealth]);

  // Tick batching: coalesce high-frequency ticks into ≤4 renders/sec.
  const tickBuf = useRef({});
  useEffect(() => {
    const t = setInterval(() => {
      const buf = tickBuf.current; const keys = Object.keys(buf); if (!keys.length) return;
      tickBuf.current = {};
      setTicks(prev => {
        const next = { ...prev };
        for (const k of keys) {
          const p = buf[k].price, old = prev[k]?.price;
          const dir = old == null || p === old ? 0 : p > old ? 1 : -1;
          next[k] = { price: p, ts: buf[k].ts, dir: dir || prev[k]?.dir || 0, seq: dir ? (prev[k]?.seq || 0) + 1 : prev[k]?.seq || 0 };
        }
        return next;
      });
    }, 250);
    return () => clearInterval(t);
  }, []);

  const wsState = useEngineSocket({
    onOpen: () => loadDecisions(),
    onMessage: (m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "decisions" && Array.isArray(m.decisions)) { setDecisions(m.decisions); setDecLoading(false); }
      else if (m.type === "decision" && m.decision && m.decision.assetId) {
        const d = m.decision;
        setDecisions(list => { const i = list.findIndex(x => x?.assetId === d.assetId); if (i < 0) return [...list, d]; const n = list.slice(); n[i] = { ...list[i], ...d }; return n; });
      } else if (m.type === "tick" && m.symbol && num(m.price) != null) {
        tickBuf.current[m.symbol] = { price: num(m.price), ts: m.ts };
      } else if (m.type === "trade" && m.trade) {
        const t = m.trade; const side = String(t.side || t.action || "").toUpperCase();
        const closing = t.pnl != null || t.exit != null || t.exitPrice != null;
        toast(`${closing ? "CLOSED" : "OPENED"} ${side} ${t.symbol || t.assetId || ""} @ ${fprice(t.exit ?? t.exitPrice ?? t.entry ?? t.entryPrice ?? t.price)}${t.pnl != null ? ` · P&L ${num(t.pnl) >= 0 ? "+" : ""}${num(t.pnl)?.toFixed(2)}` : ""}`, /SELL|SHORT/.test(side) ? C.down : C.up);
        setPortfolioKey(k => k + 1);
      } else if (m.type === "settings" && m.settings) {
        setSettings(p => ({ ...p, ...normSettings(m.settings) }));
      }
    },
  });

  // Polling fallback while the socket is down.
  useEffect(() => { if (wsState === "open") return; const t = setInterval(loadDecisions, 20000); return () => clearInterval(t); }, [wsState, loadDecisions]);

  const onSetting = useCallback(async (patch) => {
    const key = Object.keys(patch)[0];
    const prev = settings;
    setSettings(s => ({ ...s, ...patch })); setSavingKey(key);
    try {
      const r = await api("/api/settings", { method: "POST", body: patch });
      const n = normSettings(r?.settings ?? r); if (Object.keys(n).length) setSettings(s => ({ ...s, ...n }));
      if (key === "horizon") { toast(`horizon → ${patch.horizon}; re-deciding…`); setDecLoading(true); loadDecisions(); }
    } catch (e) { setSettings(prev); toast(`settings failed: ${e.message}`, C.down); }
    finally { setSavingKey(null); }
  }, [settings, toast, loadDecisions]);

  useEffect(() => { const h = (e) => e.key === "Escape" && setSelected(null); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);
  useEffect(() => { if (selected && !split) document.body.style.overflow = "hidden"; else document.body.style.overflow = ""; return () => { document.body.style.overflow = ""; }; }, [selected, split]);

  const decMap = useMemo(() => { const m = {}; for (const d of decisions) if (d?.assetId) m[d.assetId] = d; return m; }, [decisions]);
  const sel = selected ? { seed: decMap[selected.id], live: decMap[selected.id] } : null;
  const selSym = selected ? (selected.provided?.symbol || decMap[selected.id]?.symbol) : null;
  const minConf = settings.min_confidence;

  const onAnalyzed = (d) => { setTab("decisions"); setSelected({ id: d.assetId || `${d.assetClass === "crypto" ? "CRYPTO" : "STOCK"}:${d.symbol}`, provided: d }); };
  const detail = selected && (
    <ErrorBoundary resetKey={selected.id}>
      <DetailPanel key={selected.id + (selected.provided ? ":a" : "")} assetId={selected.id} provided={selected.provided} seed={sel.seed} live={selected.provided ? null : sel.live}
        tick={selSym ? ticks[selSym] : null} minConf={minConf} onClose={() => setSelected(null)} overlay={!split} />
    </ErrorBoundary>
  );

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      <style>{GLOBAL_CSS}</style>
      <Header wsState={wsState} health={health} settings={settings} onSetting={onSetting} savingKey={savingKey} narrow={narrow} wide={width >= 1560} />

      <nav style={{ display: "flex", alignItems: "center", gap: 4, padding: narrow ? "0 10px" : "0 16px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap", rowGap: 6 }}>
        <div style={{ display: "flex", gap: 2, overflowX: "auto", maxWidth: "100%" }}>
          {TABS.map(([k, l]) => (
            <button key={k} className="de-tab" onClick={() => setTab(k)} style={{ background: "none", border: "none", borderBottom: `2px solid ${tab === k ? C.blue : "transparent"}`, color: tab === k ? C.text : C.dim, padding: narrow ? "10px 8px" : "11px 14px", fontFamily: MONO, fontSize: narrow ? 10 : 11, fontWeight: 700, letterSpacing: 1.5, cursor: "pointer", whiteSpace: "nowrap" }}>{l}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ padding: "6px 0" }}><AnalyzeBox onResult={onAnalyzed} compact={narrow} /></div>
      </nav>

      <main style={{ flex: 1, padding: narrow ? 10 : 16, width: "100%", maxWidth: 1920, margin: "0 auto" }}>
        <ErrorBoundary resetKey={tab}>
          {tab === "decisions" && (
            <div style={{ display: "grid", gridTemplateColumns: split && selected ? "minmax(0, 1fr) minmax(0, 1.3fr)" : "minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
              <DecisionBoard decisions={decisions} ticks={ticks} minConf={minConf} selectedId={selected?.id} onSelect={(d) => setSelected(s => (s?.id === d.assetId && !s.provided ? null : { id: d.assetId }))} loading={decLoading} err={decErr} now={now} />
              {split && detail}
            </div>
          )}
          {tab === "portfolio" && <PortfolioTab ticks={ticks} refreshKey={portfolioKey} />}
          {tab === "performance" && <PerformanceTab refreshKey={0} />}
          {tab === "backtest" && <BacktestTab decisions={decisions} defaultHorizon={settings.horizon} />}
          {tab === "rankings" && <RankingsTab defaultHorizon={settings.horizon} decisions={decisions} onSelect={(id) => { setTab("decisions"); setSelected({ id }); }} onOpenLab={() => setTab("lab")} />}
          {tab === "lab" && <LabTab defaultHorizon={settings.horizon} />}
        </ErrorBoundary>
        {!split && tab === "decisions" && detail}
      </main>

      <footer style={{ borderTop: `1px solid ${C.border}`, background: "#080a11", padding: narrow ? "12px 10px" : "14px 16px", display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: C.warn, border: `1px solid ${C.warn}66`, borderRadius: 4, padding: "2px 7px", fontFamily: MONO, fontSize: 9, fontWeight: 800, letterSpacing: 1.5, flex: "none" }}>PAPER</span>
          <span style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.45 }}><b style={{ color: C.text }}>Paper trading only. Not financial advice.</b> Probabilities are model estimates, calibrated on past data.</span>
        </div>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>
          {health?.status ? `engine ${health.status}` : "engine —"}{num(health?.uptime) != null ? ` · up ${Math.floor(health.uptime / 3600)}h${Math.floor((health.uptime % 3600) / 60)}m` : ""}{health?.assets != null ? ` · ${Array.isArray(health.assets) ? health.assets.length : health.assets} assets` : ""}
        </span>
      </footer>

      <div style={{ position: "fixed", right: 12, bottom: 12, zIndex: 60, display: "grid", gap: 6, maxWidth: "calc(100vw - 24px)" }}>
        {toasts.map(t => <div key={t.id} className="de-in" style={{ background: "#0d131c", border: `1px solid ${t.color}`, borderLeft: `3px solid ${t.color}`, borderRadius: 6, padding: "8px 12px", fontFamily: MONO, fontSize: 11, color: C.text, boxShadow: "0 6px 24px rgba(0,0,0,.5)" }}>{t.msg}</div>)}
      </div>
    </div>
  );
}
