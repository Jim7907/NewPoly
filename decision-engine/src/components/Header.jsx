import React, { useEffect, useState } from "react";
import { C, MONO, pct } from "./ui.jsx";

// NYSE regular session, America/New_York, weekdays 09:30–16:00 (holidays not handled client-side).
export function nyseOpen(now = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now).map(p => [p.type, p.value]));
    if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
    const m = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    return m >= 570 && m < 960;
  } catch { return null; }
}

const Dot = ({ on, warn, pulse }) => <span className={pulse ? "de-pulse" : undefined} style={{ display: "inline-block", width: 8, height: 8, borderRadius: 5, background: on ? C.up : warn ? C.warn : C.down, boxShadow: on ? `0 0 8px ${C.up}` : "none", flex: "none" }} />;
const Pill = ({ children, title }) => <div title={title} style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${C.border}`, background: C.panel2, borderRadius: 6, padding: "5px 9px", fontFamily: MONO, fontSize: 10, color: C.sub, whiteSpace: "nowrap" }}>{children}</div>;

export default function Header({ wsState, health, settings, onSetting, savingKey, narrow, wide }) {
  const [now, setNow] = useState(new Date());
  const [conf, setConf] = useState(settings.min_confidence ?? 0.65);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (settings.min_confidence != null) setConf(settings.min_confidence); }, [settings.min_confidence]);
  // Debounced push of the slider value.
  useEffect(() => {
    if (conf == null || Math.abs(conf - (settings.min_confidence ?? -1)) < 1e-9) return;
    const t = setTimeout(() => onSetting({ min_confidence: Number(conf.toFixed(2)) }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conf]);

  const mOpen = typeof health?.marketOpen === "boolean" ? health.marketOpen : typeof health?.market?.open === "boolean" ? health.market.open : nyseOpen(now);
  const llm = health?.llm;
  const llmOn = llm === true || (llm && typeof llm === "object" && (llm.enabled ?? llm.on ?? llm.active ?? false)) || llm === "on" || llm === "enabled";
  const llmTitle = llm && typeof llm === "object" ? JSON.stringify(llm) : String(llm ?? "unknown");
  const wsLabel = wsState === "open" ? "LIVE" : wsState === "connecting" ? "CONNECTING" : "OFFLINE";
  const horizons = [["intraday", "INTRADAY · 2h"], ["swing", "SWING · 5d"], ["position", "POSITION · 20d"]];
  const utc = now.toISOString().slice(11, 19);
  const ny = (() => { try { return now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }); } catch { return "—"; } })();

  return (
    <header style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(6,7,13,.92)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: narrow ? "8px 10px" : "10px 16px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 6 }}>
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden><rect x="1" y="1" width="20" height="20" rx="5" fill="none" stroke={C.blue} strokeWidth="1.5" /><path d="M5 15 L9 10 L12 12.5 L17 6" stroke={C.up} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div>
            <div style={{ fontFamily: MONO, fontWeight: 800, fontSize: 14, letterSpacing: 3, color: C.text }}>DECISION ENGINE</div>
            <div style={{ fontFamily: MONO, fontSize: 8.5, color: C.dim, letterSpacing: 1.5 }}>CALIBRATED · CONFIDENCE-GATED · PAPER</div>
          </div>
        </div>

        <Pill title={`WebSocket: ${wsState}`}><Dot on={wsState === "open"} warn={wsState === "connecting"} pulse={wsState !== "open"} /><b style={{ color: wsState === "open" ? C.up : wsState === "connecting" ? C.warn : C.down }}>{wsLabel}</b></Pill>
        <Pill title="NYSE regular session (09:30–16:00 ET, Mon–Fri)"><Dot on={mOpen === true} warn={mOpen == null} />STOCKS <b style={{ color: mOpen ? C.up : C.sub }}>{mOpen == null ? "?" : mOpen ? "OPEN" : "CLOSED"}</b></Pill>
        <Pill title={`LLM analyst: ${llmTitle}`}><span style={{ color: llmOn ? C.violet : C.dim, fontWeight: 800 }}>◆</span>LLM <b style={{ color: llmOn ? C.violet : C.dim }}>{llmOn ? "ON" : "OFF"}</b></Pill>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", border: `1px solid ${C.borderHi}`, borderRadius: 6, overflow: "hidden" }} role="group" aria-label="horizon">
          {horizons.map(([k, l]) => {
            const on = settings.horizon === k;
            return <button key={k} onClick={() => !on && onSetting({ horizon: k })} disabled={savingKey === "horizon"} style={{ background: on ? C.blue : "transparent", color: on ? "#041018" : C.sub, border: "none", borderRight: k !== "position" ? `1px solid ${C.borderHi}` : "none", padding: "6px 10px", fontFamily: MONO, fontSize: 10, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5 }}>{narrow ? l.split(" · ")[0] : l}</button>;
          })}
        </div>

        <Pill title="Minimum calibrated confidence required to act (otherwise HOLD)">
          <span>MIN CONF</span>
          <input type="range" min={0.4} max={0.95} step={0.01} value={conf ?? 0.65} onChange={e => setConf(Number(e.target.value))} style={{ width: narrow ? 80 : 110 }} aria-label="minimum confidence" />
          <b style={{ color: C.warn, minWidth: 34 }}>{pct(conf, 0)}</b>
          {savingKey === "min_confidence" && <span className="de-pulse" style={{ color: C.dim }}>●</span>}
        </Pill>

        <Pill title="Auto paper-trade actionable decisions">
          <span>AUTO PAPER</span>
          <button role="switch" aria-checked={!!settings.auto_trade} onClick={() => onSetting({ auto_trade: !settings.auto_trade })} style={{ width: 32, height: 17, borderRadius: 9, border: `1px solid ${settings.auto_trade ? C.up : C.borderHi}`, background: settings.auto_trade ? "#0b3a1c" : C.inset, position: "relative", cursor: "pointer", padding: 0 }}>
            <span style={{ position: "absolute", top: 2, left: settings.auto_trade ? 16 : 2, width: 11, height: 11, borderRadius: 6, background: settings.auto_trade ? C.up : C.dim, transition: "left .15s" }} />
          </button>
        </Pill>

        <Pill title="UTC / New York"><span style={{ color: C.text, fontWeight: 700 }}>{utc}</span><span>UTC</span>{wide && <><span style={{ color: C.faint }}>|</span><span style={{ color: C.text }}>{ny}</span><span>NY</span></>}</Pill>
      </div>
    </header>
  );
}

