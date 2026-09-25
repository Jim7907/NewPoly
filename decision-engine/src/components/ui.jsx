import React, { useEffect, useState } from "react";

// ─── Theme ────────────────────────────────────────────────────────────────────
export const C = {
  bg: "#06070d", panel: "#0c1016", panel2: "#0a0e15", inset: "#070a10",
  border: "#1a2230", borderHi: "#263244",
  text: "#d3dbe6", sub: "#8b98ab", dim: "#56637a", faint: "#2a3444",
  up: "#22c55e", upBg: "#062012", strongUp: "#4ade80",
  down: "#f25f4c", downBg: "#260b08", strongDown: "#ff7a66",
  hold: "#64748b", holdBg: "#10141b",
  blue: "#38bdf8", violet: "#a78bfa", warn: "#facc15", amber: "#f59e0b",
};
export const MONO = "'JetBrains Mono','SF Mono',ui-monospace,Menlo,Consolas,monospace";
export const SANS = "Inter,'Segoe UI',system-ui,-apple-system,sans-serif";

export const FAMILIES = ["technical", "fundamental", "sentiment", "macro", "ml", "regime", "derivatives", "microstructure", "llm"];
export const FAM_SHORT = { technical: "TEC", fundamental: "FUN", sentiment: "SEN", macro: "MAC", ml: "ML", regime: "REG", derivatives: "DER", microstructure: "MIC", llm: "LLM" };

export const ACTIONS = {
  STRONG_BUY:  { fg: "#04130a", bg: C.strongUp, bd: C.strongUp, label: "STRONG BUY", rank: 2 },
  BUY:         { fg: C.up, bg: C.upBg, bd: C.up, label: "BUY", rank: 1 },
  HOLD:        { fg: C.hold, bg: C.holdBg, bd: "#2a3342", label: "HOLD", rank: 0 },
  SELL:        { fg: C.down, bg: C.downBg, bd: C.down, label: "SELL", rank: -1 },
  STRONG_SELL: { fg: "#1a0503", bg: C.strongDown, bd: C.strongDown, label: "STRONG SELL", rank: -2 },
};
export const actionMeta = (a) => ACTIONS[a] || ACTIONS.HOLD;
export const isActionable = (a) => a && a !== "HOLD" && ACTIONS[a];
export const isBullish = (a) => a === "BUY" || a === "STRONG_BUY";
export const isBearish = (a) => a === "SELL" || a === "STRONG_SELL";

// ─── Safe formatters (every input may be null/undefined/NaN/string) ──────────
export const num = (x) => { const n = typeof x === "string" ? Number(x) : x; return typeof n === "number" && Number.isFinite(n) ? n : null; };
export const fx = (x, d = 2) => { const n = num(x); return n == null ? "—" : n.toFixed(d); };
export const pct = (x, d = 1) => { const n = num(x); return n == null ? "—" : (n * 100).toFixed(d) + "%"; };
export const spct = (x, d = 2) => { const n = num(x); return n == null ? "—" : (n > 0 ? "+" : "") + (n * 100).toFixed(d) + "%"; };
export const snum = (x, d = 2) => { const n = num(x); return n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(d); };
export const priceDec = (p) => { const n = Math.abs(num(p) ?? 0); return n >= 1000 ? 2 : n >= 10 ? 2 : n >= 1 ? 3 : n >= 0.01 ? 4 : 6; };
export const fprice = (p) => { const n = num(p); return n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: priceDec(n), maximumFractionDigits: priceDec(n) }); };
export const usd = (x, d = 0) => { const n = num(x); return n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); };
export const susd = (x, d = 0) => { const n = num(x); return n == null ? "—" : (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); };
export const compact = (x) => { const n = num(x); if (n == null) return "—"; const a = Math.abs(n); return a >= 1e12 ? (n / 1e12).toFixed(2) + "T" : a >= 1e9 ? (n / 1e9).toFixed(2) + "B" : a >= 1e6 ? (n / 1e6).toFixed(2) + "M" : a >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(0); };
export const toMs = (t) => { if (t == null) return null; if (typeof t === "number") return t < 1e11 ? t * 1000 : t; const p = Date.parse(t); return Number.isFinite(p) ? p : null; };
export const ago = (t, now = Date.now()) => { const ms = toMs(t); if (ms == null) return "—"; const s = Math.max(0, Math.round((now - ms) / 1000)); return s < 60 ? s + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago"; };
export const dt = (t) => { const ms = toMs(t); if (ms == null) return "—"; const d = new Date(ms); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }); };
export const dday = (t) => { const ms = toMs(t); if (ms == null) return "—"; return new Date(ms).toLocaleDateString("en-US", { year: "2-digit", month: "short", day: "numeric" }); };
export const arr = (x) => (Array.isArray(x) ? x : []);
export const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const pick = (o, ...keys) => { if (!o) return undefined; for (const k of keys) if (o[k] != null) return o[k]; return undefined; };
export const colorSign = (x) => { const n = num(x); return n == null || n === 0 ? C.sub : n > 0 ? C.up : C.down; };
export const divColor = (s, alpha = 1) => { // diverging: red ← gray → green
  const n = clamp(num(s) ?? 0, -1, 1); const a = Math.abs(n);
  const base = n >= 0 ? [34, 197, 94] : [242, 95, 76]; const g = [71, 85, 105];
  const mix = base.map((v, i) => Math.round(g[i] + (v - g[i]) * Math.min(1, a * 1.6)));
  return `rgba(${mix[0]},${mix[1]},${mix[2]},${alpha})`;
};

// ─── Networking ──────────────────────────────────────────────────────────────
export async function api(path, opts) {
  const init = opts && opts.body && typeof opts.body !== "string"
    ? { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, body: JSON.stringify(opts.body) }
    : opts;
  const r = await fetch(path, init);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${r.status}`);
  if (data && data.error && Object.keys(data).length <= 2) throw new Error(data.error);
  return data;
}

// Generic loader hook: { data, err, loading, reload }.
export function useLoad(fn, deps, { interval } = {}) {
  const [state, set] = useState({ data: null, err: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = (quiet) => {
      if (!quiet) set(s => ({ ...s, loading: true }));
      Promise.resolve().then(fn).then(
        d => alive && set({ data: d, err: null, loading: false }),
        e => alive && set(s => ({ data: s.data, err: e?.message || String(e), loading: false })));
    };
    run(false);
    const t = interval ? setInterval(() => run(true), interval) : null;
    return () => { alive = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce(n => n + 1) };
}

export function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1280);
  useEffect(() => { const h = () => setW(window.innerWidth); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  return w;
}

// ─── Primitives ──────────────────────────────────────────────────────────────
export function Chip({ action, size = "md" }) {
  const m = actionMeta(action);
  const fs = size === "lg" ? 12 : size === "sm" ? 9 : 10;
  return <span style={{ display: "inline-block", color: m.fg, background: m.bg, border: `1px solid ${m.bd}`, borderRadius: 4, padding: size === "lg" ? "4px 10px" : "2px 7px", fontSize: fs, fontWeight: 800, fontFamily: MONO, letterSpacing: 0.6, whiteSpace: "nowrap" }}>{m.label}</span>;
}

export function Tag({ children, color = C.sub, title }) {
  return <span title={title} style={{ display: "inline-block", color, border: `1px solid ${C.border}`, background: C.inset, borderRadius: 3, padding: "1px 5px", fontSize: 9, fontFamily: MONO, letterSpacing: 0.4, whiteSpace: "nowrap" }}>{children}</span>;
}

export const Panel = ({ title, right, children, style, pad = 12 }) => (
  <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: pad, minWidth: 0, ...style }}>
    {(title || right) && (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {title && <h3 style={{ margin: 0, fontSize: 10, letterSpacing: 1.6, color: C.sub, fontWeight: 700, fontFamily: MONO, textTransform: "uppercase" }}>{title}</h3>}
        {right}
      </div>
    )}
    {children}
  </section>
);

export const Stat = ({ label, value, color = C.text, sub, title }) => (
  <div title={title} style={{ background: C.inset, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 9px", minWidth: 0 }}>
    <div style={{ fontSize: 8.5, color: C.dim, letterSpacing: 1.2, fontFamily: MONO, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
    <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: MONO, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
    {sub != null && <div style={{ fontSize: 9, color: C.dim, fontFamily: MONO, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
  </div>
);

// Diverging bar for a value in [-1, 1] (or scaled by `max`).
export function DivBar({ v, max = 1, h = 6, color, w = "100%" }) {
  const n = num(v) ?? 0;
  const p = clamp(Math.abs(n) / (max || 1), 0, 1) * 50;
  const col = color || divColor(n / (max || 1));
  return (
    <div style={{ height: h, width: w, background: C.inset, borderRadius: 2, position: "relative", overflow: "hidden", border: `1px solid ${C.border}` }}>
      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: C.faint }} />
      <div style={{ position: "absolute", top: 0, bottom: 0, [n >= 0 ? "left" : "right"]: "50%", width: p + "%", background: col, borderRadius: 1 }} />
    </div>
  );
}

// Unipolar bar in [0,1] with optional threshold marker.
export function MeterBar({ v, threshold, h = 6, color = C.blue, title }) {
  const n = clamp(num(v) ?? 0, 0, 1);
  const t = num(threshold);
  const pass = t == null || n >= t;
  return (
    <div title={title} style={{ height: h, background: C.inset, borderRadius: 2, position: "relative", border: `1px solid ${C.border}` }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: n * 100 + "%", background: pass ? color : C.hold, borderRadius: 1, transition: "width .4s ease" }} />
      {t != null && <div style={{ position: "absolute", left: `calc(${clamp(t, 0, 1) * 100}% - 1px)`, top: -3, bottom: -3, width: 2, background: C.warn, borderRadius: 1 }} />}
    </div>
  );
}

export const Loading = ({ label = "loading" }) => (
  <div style={{ padding: 24, textAlign: "center", color: C.dim, fontFamily: MONO, fontSize: 11 }}>
    <span className="de-pulse">●</span> {label}…
  </div>
);
export const ErrorBox = ({ err, onRetry }) => (
  <div style={{ padding: 12, border: `1px solid #4a1d17`, background: "#170806", color: "#fca5a5", borderRadius: 6, fontFamily: MONO, fontSize: 11, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
    <span>⚠ {String(err)}</span>
    {onRetry && <Btn onClick={onRetry} small>retry</Btn>}
  </div>
);
export const Empty = ({ children }) => <div style={{ padding: 18, textAlign: "center", color: C.dim, fontFamily: MONO, fontSize: 11 }}>{children}</div>;

export function Btn({ children, onClick, active, small, disabled, color = C.blue, title, type = "button", style }) {
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled} className="de-btn" style={{
      background: active ? color : "transparent", color: active ? "#041018" : disabled ? C.dim : C.text,
      border: `1px solid ${active ? color : C.borderHi}`, borderRadius: 5, padding: small ? "3px 8px" : "6px 12px",
      fontSize: small ? 10 : 11, fontWeight: 700, fontFamily: MONO, cursor: disabled ? "default" : "pointer", letterSpacing: 0.5, whiteSpace: "nowrap", ...style,
    }}>{children}</button>
  );
}

export const inputStyle = { background: C.inset, color: C.text, border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: "6px 8px", fontSize: 11, fontFamily: MONO, outline: "none", minWidth: 0 };

// Sortable table. cols: [{ key, label, render(row), sort(row) -> value, align, width }]
export function Table({ cols, rows, initialSort, maxHeight, empty = "no rows", dense, rowKey, onRowClick }) {
  const [sort, setSort] = useState(initialSort || null); // { key, dir }
  const list = arr(rows);
  let sorted = list;
  if (sort) {
    const col = cols.find(c => c.key === sort.key);
    if (col && col.sort) {
      sorted = [...list].sort((a, b) => {
        const va = col.sort(a), vb = col.sort(b);
        if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
        const r = typeof va === "string" ? va.localeCompare(vb) : va - vb;
        return sort.dir === "asc" ? r : -r;
      });
    }
  }
  const pad = dense ? "4px 6px" : "6px 8px";
  return (
    <div style={{ overflow: "auto", maxHeight, border: `1px solid ${C.border}`, borderRadius: 6 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 10.5 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} onClick={() => c.sort && setSort(s => ({ key: c.key, dir: s && s.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}
                style={{ position: "sticky", top: 0, background: "#0f141c", color: sort?.key === c.key ? C.text : C.dim, textAlign: c.align || "left", padding: pad, fontWeight: 600, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, cursor: c.sort ? "pointer" : "default", whiteSpace: "nowrap", width: c.width, zIndex: 1 }}>
                {c.label}{sort?.key === c.key ? (sort.dir === "desc" ? " ▾" : " ▴") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <tr><td colSpan={cols.length} style={{ padding: 14, color: C.dim, textAlign: "center" }}>{empty}</td></tr>}
          {sorted.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : i} className="de-row" onClick={onRowClick ? () => onRowClick(r) : undefined} style={{ cursor: onRowClick ? "pointer" : "default" }}>
              {cols.map(c => <td key={c.key} style={{ padding: pad, borderBottom: `1px solid #121925`, color: C.text, textAlign: c.align || "left", verticalAlign: "middle", whiteSpace: c.wrap ? "normal" : "nowrap", maxWidth: c.maxWidth }}>{c.render ? c.render(r) : String(r?.[c.key] ?? "—")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) return <div style={{ padding: 12 }}><ErrorBox err={"render error: " + (this.state.err?.message || this.state.err)} onRetry={() => this.setState({ err: null })} /></div>;
    return this.props.children;
  }
}

// Global CSS (keyframes, scrollbars, hover) — inline <style>, no CSS files.
export const GLOBAL_CSS = `
*{box-sizing:border-box}
html,body{background:${C.bg};color:${C.text};font-family:${SANS};-webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#1f2937;border-radius:4px}::-webkit-scrollbar-track{background:transparent}
@keyframes deFlashUp{0%{background:rgba(34,197,94,.22);color:#bbf7d0}100%{background:transparent}}
@keyframes deFlashDn{0%{background:rgba(242,95,76,.22);color:#fecaca}100%{background:transparent}}
@keyframes dePulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes deIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.de-flash-up{animation:deFlashUp .6s ease-out}
.de-flash-dn{animation:deFlashDn .6s ease-out}
.de-pulse{animation:dePulse 1.4s ease-in-out infinite}
.de-in{animation:deIn .25s ease-out}
.de-card{transition:border-color .15s, background .15s, transform .15s}
.de-card:hover{border-color:${C.borderHi} !important;background:#0f141c !important}
.de-row:hover td{background:#0f1520}
.de-btn:hover:not(:disabled){filter:brightness(1.2);border-color:${C.sub} !important}
.de-tab{transition:color .15s,border-color .15s}
.de-tab:hover{color:${C.text} !important}
input[type=range]{accent-color:${C.warn}}
button{font-family:inherit}
`;
