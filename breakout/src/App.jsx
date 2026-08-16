import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Chart, { EquityCurve, C, fmtPrice } from "./Chart.jsx";

const api = (p, body) => fetch(p, body
  ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  : undefined).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || r.statusText); return d; });

const n0 = (x) => (x == null ? "--" : Number(x).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const n2 = (x, d = 2) => (x == null ? "--" : Number(x).toFixed(d));
const pctColor = (v) => (v == null ? C.dim : v > 0 ? C.up : v < 0 ? C.down : C.dim);
const ts = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

// ── Small UI atoms ──────────────────────────────────────────────
const Section = ({ title, children }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ fontSize: 9, letterSpacing: 1.4, color: C.dim, marginBottom: 6, fontWeight: 700 }}>{title}</div>
    <div style={{ display: "grid", gap: 6 }}>{children}</div>
  </div>
);

const Field = ({ label, value, onChange, step = 1, min, max, hint }) => (
  <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 10, color: C.text }}>
    <span title={hint} style={{ color: C.dim }}>{label}</span>
    <input type="number" value={value} step={step} min={min} max={max}
      onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      style={{ width: 68, background: "#0a0e16", border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: "3px 5px", fontSize: 10, fontFamily: "ui-monospace, monospace" }} />
  </label>
);

const Toggle = ({ label, value, onChange, hint }) => (
  <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, cursor: "pointer" }} title={hint}>
    <span style={{ color: C.dim }}>{label}</span>
    <span onClick={() => onChange(!value)} style={{
      width: 30, height: 16, borderRadius: 9, background: value ? C.up : "#1b2433",
      position: "relative", transition: "background .15s", flexShrink: 0,
    }}>
      <span style={{ position: "absolute", top: 2, left: value ? 16 : 2, width: 12, height: 12, borderRadius: 6, background: "#06070d", transition: "left .15s" }} />
    </span>
  </label>
);

const Select = ({ label, value, onChange, options }) => (
  <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 10 }}>
    <span style={{ color: C.dim }}>{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ background: "#0a0e16", border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: "3px 5px", fontSize: 10, fontFamily: "ui-monospace, monospace" }}>
      {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
    </select>
  </label>
);

const Stat = ({ label, value, color, sub }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", minWidth: 92 }}>
    <div style={{ fontSize: 8, letterSpacing: 1, color: C.dim }}>{label}</div>
    <div style={{ fontSize: 17, fontWeight: 800, color: color || C.text, fontFamily: "ui-monospace, monospace", lineHeight: 1.25 }}>{value}</div>
    {sub && <div style={{ fontSize: 8, color: C.dim, fontFamily: "ui-monospace, monospace" }}>{sub}</div>}
  </div>
);

const Bar = ({ pct, color }) => (
  <div style={{ height: 5, background: "#0a0e16", borderRadius: 3, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, height: "100%", background: color }} />
  </div>
);

// ── Backtest panel (the GG-Shot "real-time back-test" readout) ───
function StatsPanel({ stats, curve }) {
  if (!stats || !stats.trades) return <div style={{ color: C.dim, fontSize: 11, padding: 12 }}>No trades for these parameters.</div>;
  const s = stats;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat label="TRADES" value={s.trades} sub={`${s.wins}W / ${s.losses}L`} />
        <Stat label="WIN RATE" value={`${n2(s.winRate, 1)}%`} color={s.winRate >= 50 ? C.up : C.amber} />
        <Stat label="PROFIT FACTOR" value={s.profitFactor == null ? "∞" : n2(s.profitFactor)} color={(s.profitFactor ?? 9) >= 1.3 ? C.up : (s.profitFactor ?? 0) >= 1 ? C.amber : C.down} />
        <Stat label="NET P&L" value={`${s.netProfitPct > 0 ? "+" : ""}${n2(s.netProfitPct, 1)}%`} color={pctColor(s.netProfitPct)} sub={`$${n0(s.netProfit)}`} />
        <Stat label="EXPECTANCY" value={`${s.expectancyR > 0 ? "+" : ""}${n2(s.expectancyR)}R`} color={pctColor(s.expectancyR)} />
        <Stat label="MAX DD" value={`${n2(s.maxDrawdownPct, 1)}%`} color={C.rose} sub={`$${n0(s.maxDrawdown)}`} />
        <Stat label="SHARPE" value={n2(s.sharpe)} color={C.blue} sub={s.cagr != null ? `CAGR ${n2(s.cagr, 1)}%` : null} />
        <Stat label="COST / TRADE" value={`${n2(s.avgCostR)}R`} color={s.avgCostR >= 0.25 ? C.amber : C.dim}
          sub={`$${n0(s.fees)} total${s.cappedTrades ? ` · ${s.cappedTrades} size-capped` : ""}`} />
      </div>

      {s.avgCostR >= 0.25 && (
        <div style={{ fontSize: 10, color: C.amber, border: `1px solid ${C.amber}33`, background: "#1a1206",
          borderRadius: 6, padding: "6px 10px", marginBottom: 12, lineHeight: 1.5 }}>
          Costs are eating the edge: fees and slippage average <b>{n2(s.avgCostR)}R per trade</b>.
          The stop sits close to price, so risk-based sizing implies a large notional and the round-trip
          fee rivals the risk unit{s.cappedTrades ? ` (${s.cappedTrades} trades also hit the leverage cap)` : ""}.
          Widen the stop, lower the fee tier, or move to a higher timeframe.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.dim, marginBottom: 6 }}>TARGET HIT RATE</div>
          <div style={{ display: "grid", gap: 5 }}>
            {s.tpRates.map(tp => (
              <div key={tp.level} style={{ display: "grid", gridTemplateColumns: "42px 1fr 74px", alignItems: "center", gap: 8, fontSize: 10, fontFamily: "ui-monospace, monospace" }}>
                <span style={{ color: C.text }}>{tp.level} <span style={{ color: C.dim, fontSize: 8 }}>{tp.r}R</span></span>
                <Bar pct={tp.rate} color={C.up} />
                <span style={{ color: C.dim, textAlign: "right" }}>{n2(tp.rate, 1)}% · {tp.hits}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.dim, margin: "12px 0 6px" }}>EXITS</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 9, fontFamily: "ui-monospace, monospace" }}>
            {Object.entries(s.exitReasons).map(([k, v]) => (
              <span key={k} style={{ border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 6px", color: C.text }}>{k} <b style={{ color: C.blue }}>{v}</b></span>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.dim, marginBottom: 6 }}>DIRECTION</div>
          {[["LONG", s.long, C.up], ["SHORT", s.short, C.down]].map(([lbl, d, col]) => (
            <div key={lbl} style={{ display: "grid", gridTemplateColumns: "46px 1fr 118px", alignItems: "center", gap: 8, fontSize: 10, marginBottom: 5, fontFamily: "ui-monospace, monospace" }}>
              <span style={{ color: col }}>{lbl}</span>
              <Bar pct={d?.winRate} color={col} />
              <span style={{ color: C.dim, textAlign: "right" }}>{d?.trades || 0}t · {n2(d?.winRate, 1)}% · {n2(d?.avgR)}R</span>
            </div>
          ))}
          <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.dim, margin: "12px 0 6px" }}>EQUITY</div>
          <EquityCurve curve={curve} height={104} />
          <div style={{ display: "flex", gap: 10, fontSize: 9, color: C.dim, marginTop: 6, fontFamily: "ui-monospace, monospace", flexWrap: "wrap" }}>
            <span>avg win ${n0(s.avgWin)}</span><span>avg loss ${n0(s.avgLoss)}</span>
            <span>payoff {n2(s.payoff)}</span><span>streak +{s.maxWinStreak}/-{s.maxLossStreak}</span>
            <span>avg {n2(s.avgBars, 1)} bars</span><span>MFE {n2(s.avgMfe)}R</span><span>MAE {n2(s.avgMae)}R</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Trade blotter ───────────────────────────────────────────────
function TradesTable({ trades, selected, onSelect }) {
  if (!trades.length) return <div style={{ color: C.dim, fontSize: 11, padding: 12 }}>No trades.</div>;
  const th = { textAlign: "left", padding: "5px 8px", position: "sticky", top: 0, background: C.panel, borderBottom: `1px solid ${C.border}` };
  return (
    <div style={{ maxHeight: 300, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "ui-monospace, monospace", color: C.text }}>
        <thead style={{ color: C.dim, fontSize: 9 }}>
          <tr>{["#", "SIDE", "ENTRY TIME", "ENTRY", "STOP", "EXIT", "TPs", "R", "P&L", "BARS", "WHY OUT"].map(h => <th key={h} style={th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.id} onClick={() => onSelect(selected?.id === t.id ? null : t)}
              style={{ cursor: "pointer", background: selected?.id === t.id ? "#101a26" : "transparent", borderBottom: "1px solid #0f1621" }}>
              <td style={{ padding: "4px 8px", color: C.dim }}>{i + 1}</td>
              <td style={{ padding: "4px 8px", color: t.side === "long" ? C.up : C.down, fontWeight: 700 }}>{t.side.toUpperCase()}</td>
              <td style={{ padding: "4px 8px", color: C.dim }}>{ts(t.entryTime)}</td>
              <td style={{ padding: "4px 8px" }}>{fmtPrice(t.entryPrice)}</td>
              <td style={{ padding: "4px 8px", color: C.rose }}>{fmtPrice(t.sl)}</td>
              <td style={{ padding: "4px 8px" }}>{fmtPrice(t.exitPrice)}</td>
              <td style={{ padding: "4px 8px" }}>{t.tpHits.map((h, k) => <span key={k} style={{ color: h ? C.up : "#233044" }}>{h ? "●" : "○"}</span>)}</td>
              <td style={{ padding: "4px 8px", color: pctColor(t.r), fontWeight: 700 }}>{t.r > 0 ? "+" : ""}{n2(t.r)}</td>
              <td style={{ padding: "4px 8px", color: pctColor(t.pnl) }}>{t.pnl > 0 ? "+" : ""}{n2(t.pnl)}</td>
              <td style={{ padding: "4px 8px", color: C.dim }}>{t.bars}</td>
              <td style={{ padding: "4px 8px", color: C.dim }}>{t.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Rejected-signal audit ───────────────────────────────────────
function SignalAudit({ signals }) {
  const rejected = signals.filter(s => !s.accepted);
  const counts = {};
  for (const s of rejected) for (const r of s.reasons) counts[r] = (counts[r] || 0) + 1;
  const accepted = signals.length - rejected.length;
  return (
    <div style={{ fontSize: 10, color: C.text, fontFamily: "ui-monospace, monospace" }}>
      <div style={{ marginBottom: 8 }}>
        <b style={{ color: C.up }}>{accepted}</b> accepted / <b style={{ color: C.dim }}>{signals.length}</b> raw breakouts
        <span style={{ color: C.dim }}> — filters suppressed {rejected.length}</span>
      </div>
      <div style={{ display: "grid", gap: 5, maxWidth: 420 }}>
        {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "96px 1fr 34px", gap: 8, alignItems: "center" }}>
            <span style={{ color: C.dim }}>{k}</span>
            <Bar pct={(v / Math.max(1, signals.length)) * 100} color={C.amber} />
            <span style={{ textAlign: "right", color: C.dim }}>{v}</span>
          </div>
        ))}
        {!rejected.length && <span style={{ color: C.dim }}>Nothing filtered out — every breakout was taken.</span>}
      </div>
    </div>
  );
}

// ── Optimizer ───────────────────────────────────────────────────
function Optimizer({ symbol, tf, limit, params, source, onApply }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [objective, setObjective] = useState("robust");

  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api("/api/optimize", { symbol, tf, limit, params, objective, source })); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const cell = { padding: "4px 8px", whiteSpace: "nowrap" };
  return (
    <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <Select label="objective" value={objective} onChange={setObjective}
          options={[{ value: "robust", label: "expectancy x √n" }, { value: "profitFactor", label: "profit factor" }, { value: "netProfit", label: "net %" }, { value: "expectancy", label: "expectancy" }, { value: "sharpe", label: "sharpe" }]} />
        <button onClick={run} disabled={busy} style={{ background: busy ? C.dim : C.blue, color: "#04121a", border: "none", borderRadius: 5, padding: "5px 14px", fontWeight: 800, fontSize: 10, cursor: busy ? "wait" : "pointer" }}>
          {busy ? "SEARCHING…" : "RUN SEARCH"}
        </button>
        {err && <span style={{ color: C.down }}>{err}</span>}
      </div>
      {res && (
        <>
          <div style={{ color: C.dim, marginBottom: 8 }}>
            {res.tested} combinations · in-sample {res.split.inSampleBars} bars · out-of-sample {res.split.outOfSampleBars} bars
            <span style={{ marginLeft: 8, color: res.verdict === "positive_both" ? C.up : C.amber, fontWeight: 700 }}>
              {res.verdict.replace(/_/g, " ")}
            </span>
          </div>
          <div style={{ overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", color: C.text }}>
              <thead style={{ color: C.dim, fontSize: 9 }}>
                <tr>{["rangeLen", "buffer", "minAdx", "volMult", "trailTP", "IS trades", "IS PF", "IS exp", "OOS trades", "OOS PF", "OOS exp", "hold-up", ""].map(h =>
                  <th key={h} style={{ ...cell, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {res.leaderboard.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #0f1621" }}>
                    <td style={cell}>{row.params.rangeLen}</td>
                    <td style={cell}>{row.params.breakoutBufferAtr}</td>
                    <td style={cell}>{row.params.minAdx}</td>
                    <td style={cell}>{row.params.volMult}</td>
                    <td style={cell}>{row.params.trailAfterTp}</td>
                    <td style={cell}>{row.inSample.trades}</td>
                    <td style={cell}>{n2(row.inSample.profitFactor)}</td>
                    <td style={{ ...cell, color: pctColor(row.inSample.expectancyR) }}>{n2(row.inSample.expectancyR)}</td>
                    <td style={cell}>{row.outOfSample?.trades ?? "--"}</td>
                    <td style={cell}>{n2(row.outOfSample?.profitFactor)}</td>
                    <td style={{ ...cell, color: pctColor(row.outOfSample?.expectancyR) }}>{n2(row.outOfSample?.expectancyR)}</td>
                    <td style={{ ...cell, color: row.holdUp >= 0.6 ? C.up : C.amber }}>{row.holdUp ?? "--"}</td>
                    <td style={cell}>
                      <button onClick={() => onApply(row.params)} style={{ background: "transparent", border: `1px solid ${C.blue}`, color: C.blue, borderRadius: 4, padding: "1px 7px", fontSize: 9, cursor: "pointer" }}>apply</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ color: C.dim, marginTop: 8, maxWidth: 720, lineHeight: 1.5 }}>{res.note}</div>
        </>
      )}
    </div>
  );
}

// ── Multi-symbol scan ───────────────────────────────────────────
function Scan({ tf, limit, params, source }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setRows((await api("/api/scan", { tf, limit, params, source })).rows); }
    finally { setBusy(false); }
  };
  const cell = { padding: "5px 8px", whiteSpace: "nowrap" };
  return (
    <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}>
      <button onClick={run} disabled={busy} style={{ background: busy ? C.dim : C.blue, color: "#04121a", border: "none", borderRadius: 5, padding: "5px 14px", fontWeight: 800, fontSize: 10, cursor: busy ? "wait" : "pointer", marginBottom: 10 }}>
        {busy ? "SCANNING…" : "SCAN ALL SYMBOLS"}
      </button>
      {rows && (
        <table style={{ width: "100%", borderCollapse: "collapse", color: C.text }}>
          <thead style={{ color: C.dim, fontSize: 9 }}>
            <tr>{["symbol", "trades", "win%", "PF", "net%", "maxDD%", "exp R", "last signal"].map(h =>
              <th key={h} style={{ ...cell, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.symbol} style={{ borderBottom: "1px solid #0f1621" }}>
                <td style={{ ...cell, fontWeight: 700 }}>{r.symbol}</td>
                {r.error ? <td colSpan={7} style={{ ...cell, color: C.down }}>{r.error}</td> : (
                  <>
                    <td style={cell}>{r.stats.trades}</td>
                    <td style={cell}>{n2(r.stats.winRate, 1)}</td>
                    <td style={cell}>{n2(r.stats.profitFactor)}</td>
                    <td style={{ ...cell, color: pctColor(r.stats.netProfitPct) }}>{n2(r.stats.netProfitPct, 1)}</td>
                    <td style={{ ...cell, color: C.rose }}>{n2(r.stats.maxDrawdownPct, 1)}</td>
                    <td style={{ ...cell, color: pctColor(r.stats.expectancyR) }}>{n2(r.stats.expectancyR)}</td>
                    <td style={{ ...cell, color: r.lastSignal ? (r.lastSignal.side === "long" ? C.up : C.down) : C.dim }}>
                      {r.lastSignal ? `${r.lastSignal.side} @ ${fmtPrice(r.lastSignal.level)} · ${r.lastSignal.barsAgo} bars ago` : "none"}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────
export default function App() {
  const [cfg, setCfg] = useState(null);
  const [symbol, setSymbol] = useState("BTC-USD");
  const [tf, setTf] = useState("15m");
  const [limit, setLimit] = useState(1500);
  const [source, setSource] = useState("");            // "" = live w/ fallback, "synthetic" = demo
  const [params, setParams] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState("trades");
  const [auto, setAuto] = useState(true);
  const [opts, setOpts] = useState({ boxes: true, rejected: false, allTrades: true, ema: false });
  const debounce = useRef(null);

  useEffect(() => { api("/api/config").then(c => { setCfg(c); setParams(c.defaults); }).catch(e => setErr(e.message)); }, []);

  const set = (k, v) => setParams(p => ({ ...p, [k]: v }));

  const run = useCallback(async (override) => {
    const p = override || params;
    if (!p) return;
    setBusy(true); setErr(null);
    try {
      const r = await api("/api/backtest", { symbol, tf, limit, params: p, source: source || undefined });
      setResult(r); setSelected(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [params, symbol, tf, limit, source]);

  // Initial run once defaults land.
  useEffect(() => { if (params && !result && !busy) run(); /* eslint-disable-next-line */ }, [params]);

  // Auto re-run on parameter edits, debounced so dragging a value is not a request storm.
  useEffect(() => {
    if (!auto || !params || !result) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => run(), 450);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line
  }, [params, symbol, tf, limit, source, auto]);

  const applyPreset = (key) => {
    const pre = cfg.presets[key];
    setTf(pre.tf);
    setParams(p => ({ ...p, ...pre.params }));
  };

  const trades = result?.trades || [];
  const signals = result?.signals || [];
  const accepted = useMemo(() => signals.filter(s => s.accepted).length, [signals]);

  if (!cfg || !params) {
    return <div style={{ color: C.dim, fontFamily: "ui-monospace, monospace", padding: 24 }}>{err ? `Error: ${err}` : "Loading…"}</div>;
  }

  const btn = (active) => ({
    background: active ? "#101a26" : "transparent", color: active ? C.blue : C.dim,
    border: `1px solid ${active ? C.blue : C.border}`, borderRadius: 5, padding: "4px 12px",
    fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "ui-monospace, monospace",
  });

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width: 244, flexShrink: 0, borderRight: `1px solid ${C.border}`, padding: 12, overflowY: "auto", maxHeight: "100vh" }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.5, marginBottom: 2 }}>
          BREAKOUT<span style={{ color: C.blue }}>·</span>LAB
        </div>
        <div style={{ fontSize: 8, color: C.dim, marginBottom: 14, letterSpacing: 1 }}>RANGE BREAK · VISUAL BACKTEST</div>

        <Section title="MARKET">
          <Select label="symbol" value={symbol} onChange={setSymbol} options={cfg.symbols.map(s => ({ value: s.id, label: s.label }))} />
          <Select label="timeframe" value={tf} onChange={setTf} options={cfg.timeframes.map(t => t.id)} />
          <Field label="bars" value={limit} step={100} min={200} max={3000} onChange={setLimit} />
          <Select label="data" value={source} onChange={setSource} options={[{ value: "", label: "live (coinbase)" }, { value: "synthetic", label: "synthetic demo" }]} />
          <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
            {Object.entries(cfg.presets).map(([k, v]) => (
              <button key={k} onClick={() => applyPreset(k)} style={{ ...btn(false), flex: 1, padding: "3px 0", fontSize: 8 }}>{v.label}</button>
            ))}
          </div>
        </Section>

        <Section title="RANGE / BREAK">
          <Field label="range bars" value={params.rangeLen} min={5} max={100} onChange={v => set("rangeLen", v)} hint="Bars of range whose boundary must break" />
          <Field label="break buffer (ATR)" value={params.breakoutBufferAtr} step={0.05} onChange={v => set("breakoutBufferAtr", v)} hint="How far past the level the close must be" />
          <Field label="max width (ATR)" value={params.maxRangeWidthAtr} step={0.5} onChange={v => set("maxRangeWidthAtr", v)} />
          <Field label="pivot L/R" value={params.pivotLeft} min={1} max={20} onChange={v => setParams(p => ({ ...p, pivotLeft: v, pivotRight: v }))} hint="Fractal geometry for the drawn key levels" />
          <Toggle label="close beyond level" value={params.closeBeyondLevel} onChange={v => set("closeBeyondLevel", v)} hint="Off = wicks count as a break" />
        </Section>

        <Section title="FILTERS">
          <Toggle label="volume filter" value={params.volFilter} onChange={v => set("volFilter", v)} />
          <Field label="vol multiple" value={params.volMult} step={0.1} onChange={v => set("volMult", v)} hint="Breakout bar volume vs its 20-bar baseline" />
          <Toggle label="flat-market filter" value={params.flatFilter} onChange={v => set("flatFilter", v)} />
          <Field label="min ADX" value={params.minAdx} step={1} onChange={v => set("minAdx", v)} />
          <Field label="min ATR rank" value={params.minAtrRank} step={0.05} min={0} max={1} onChange={v => set("minAtrRank", v)} />
          <Toggle label="trend filter (EMA)" value={params.trendFilter} onChange={v => set("trendFilter", v)} />
          <Field label="trend EMA len" value={params.trendEmaLen} step={10} onChange={v => set("trendEmaLen", v)} />
          <Select label="direction" value={params.direction} onChange={v => set("direction", v)} options={["both", "long", "short"]} />
        </Section>

        <Section title="ENTRY">
          <Select label="fill" value={params.entryMode} onChange={v => set("entryMode", v)}
            options={[{ value: "nextOpen", label: "next bar open" }, { value: "close", label: "signal close" }, { value: "retest", label: "retest limit" }]} />
          <Field label="retest bars" value={params.retestBars} min={1} max={30} onChange={v => set("retestBars", v)} />
          <Field label="cooldown bars" value={params.cooldownBars} min={0} max={50} onChange={v => set("cooldownBars", v)} />
        </Section>

        <Section title="RISK">
          <Select label="stop" value={params.slMode} onChange={v => set("slMode", v)}
            options={[{ value: "level", label: "under broken level" }, { value: "range", label: "opposite boundary" }, { value: "atr", label: "ATR distance" }]} />
          <Field label="stop ATR mult" value={params.slAtrMult} step={0.1} onChange={v => set("slAtrMult", v)} />
          <Field label="stop buffer (ATR)" value={params.slBufferAtr} step={0.05} onChange={v => set("slBufferAtr", v)} />
          <Field label="max risk (ATR)" value={params.maxRiskAtr} step={0.5} onChange={v => set("maxRiskAtr", v)} />
          <label style={{ fontSize: 10, color: C.dim }}>targets (R)</label>
          <div style={{ display: "flex", gap: 4 }}>
            {params.tpR.map((v, i) => (
              <input key={i} type="number" step={0.5} value={v}
                onChange={e => set("tpR", params.tpR.map((x, k) => (k === i ? Number(e.target.value) : x)))}
                style={{ width: "100%", minWidth: 0, background: "#0a0e16", border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: "3px 4px", fontSize: 10, fontFamily: "ui-monospace, monospace" }} />
            ))}
          </div>
          <Toggle label="BE stop after TP1" value={params.beAfterTp1} onChange={v => set("beAfterTp1", v)} />
          <Field label="trail after N TPs" value={params.trailAfterTp} min={0} max={4} onChange={v => set("trailAfterTp", v)} hint="0 disables the dynamic trailing exit" />
          <Field label="trail ATR mult" value={params.trailAtrMult} step={0.25} onChange={v => set("trailAtrMult", v)} />
          <Field label="max bars in trade" value={params.maxBars} step={10} onChange={v => set("maxBars", v)} />
        </Section>

        <Section title="ACCOUNT">
          <Field label="equity $" value={params.equity} step={1000} onChange={v => set("equity", v)} />
          <Field label="risk % / trade" value={params.riskPct} step={0.25} onChange={v => set("riskPct", v)} />
          <Field label="fee bps / fill" value={params.feeBps} step={1} onChange={v => set("feeBps", v)} />
          <Field label="slippage bps" value={params.slipBps} step={1} onChange={v => set("slipBps", v)} />
          <Toggle label="pessimistic fills" value={params.pessimisticFills} onChange={v => set("pessimisticFills", v)} hint="Ambiguous bars resolve stop-first" />
        </Section>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => run()} disabled={busy}
            style={{ flex: 1, background: busy ? C.dim : C.up, color: "#04120a", border: "none", borderRadius: 6, padding: "7px 0", fontWeight: 800, fontSize: 11, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "RUNNING…" : "RUN BACKTEST"}
          </button>
        </div>
        <div style={{ marginTop: 8 }}><Toggle label="auto re-run on change" value={auto} onChange={setAuto} /></div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: 14, overflowX: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "ui-monospace, monospace" }}>
            {symbol} <span style={{ color: C.dim, fontSize: 11 }}>{tf}</span>
          </div>
          {result && (
            <span style={{ fontSize: 9, color: result.source === "synthetic" ? C.amber : C.dim, border: `1px solid ${result.source === "synthetic" ? C.amber : C.border}`, borderRadius: 4, padding: "2px 7px", fontFamily: "ui-monospace, monospace" }}>
              {result.source === "synthetic" ? "SYNTHETIC DEMO DATA" : `COINBASE · ${result.bars.length} bars${result.cached ? " · cached" : ""}`}
            </span>
          )}
          {result?.dataError && <span style={{ fontSize: 9, color: C.amber }}>data: {result.dataError}</span>}
          <span style={{ fontSize: 9, color: C.dim, fontFamily: "ui-monospace, monospace" }}>{accepted} signals · {trades.length} trades</span>
          <div style={{ flex: 1 }} />
          {[["boxes", "ranges"], ["rejected", "filtered"], ["allTrades", "all trades"], ["ema", "EMA"]].map(([k, lbl]) => (
            <button key={k} onClick={() => setOpts(o => ({ ...o, [k]: !o[k] }))} style={btn(opts[k])}>{lbl}</button>
          ))}
          {err && <span style={{ color: C.down, fontSize: 10 }}>{err}</span>}
        </div>

        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 6, background: C.bg, marginBottom: 12 }}>
          <Chart bars={result?.bars || []} trades={trades} signals={signals} series={result?.series} tf={tf}
            selected={selected} onSelect={setSelected}
            showBoxes={opts.boxes} showRejected={opts.rejected} showAllTrades={opts.allTrades} showEma={opts.ema}
            height={430} />
          <div style={{ fontSize: 9, color: C.dim, padding: "4px 8px", fontFamily: "ui-monospace, monospace" }}>
            scroll = zoom · drag = pan · click a trade to pin its stop/target ladder
            {selected && <span style={{ color: C.blue }}> · pinned {selected.side} @ {fmtPrice(selected.entryPrice)} → {fmtPrice(selected.exitPrice)} ({n2(selected.r)}R)</span>}
          </div>
        </div>

        <StatsPanel stats={result?.stats} curve={result?.equityCurve || []} />

        <div style={{ display: "flex", gap: 6, margin: "16px 0 10px" }}>
          {[["trades", "TRADES"], ["signals", "SIGNAL AUDIT"], ["optimize", "OPTIMIZER"], ["scan", "SYMBOL SCAN"]].map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)} style={btn(tab === k)}>{lbl}</button>
          ))}
        </div>

        {tab === "trades" && <TradesTable trades={trades} selected={selected} onSelect={setSelected} />}
        {tab === "signals" && <SignalAudit signals={signals} />}
        {tab === "optimize" && <Optimizer symbol={symbol} tf={tf} limit={limit} params={params} source={source || undefined} onApply={p => { setParams(x => ({ ...x, ...p })); setTab("trades"); }} />}
        {tab === "scan" && <Scan tf={tf} limit={limit} params={params} source={source || undefined} />}

        <div style={{ marginTop: 18, fontSize: 9, color: C.dim, lineHeight: 1.6, maxWidth: 780 }}>
          Backtest only — no orders are placed anywhere. Fills assume next-bar-open entry, stop-first resolution
          of ambiguous bars, and the fees/slippage set in the sidebar. Past behaviour of a parameter set on
          historical bars is not a forecast; use the optimizer's out-of-sample column before believing a number.
        </div>
      </div>
    </div>
  );
}
