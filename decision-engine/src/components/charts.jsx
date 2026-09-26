import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, MONO, FAMILIES, FAM_SHORT, num, arr, obj, clamp, fprice, pct, dday, dt, toMs, divColor, snum, usd } from "./ui.jsx";

// Measure container width so SVGs draw in real pixels (crisp text at any size).
export function useMeasure() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const set = () => setW(Math.max(0, Math.floor(el.getBoundingClientRect().width)));
    set();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", set); return () => window.removeEventListener("resize", set); }
    const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function emaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1); let e = null, cnt = 0, sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]; if (v == null) continue;
    if (e == null) { sum += v; cnt++; if (cnt === n) { e = sum / n; out[i] = e; } continue; }
    e = v * k + e * (1 - k); out[i] = e;
  }
  return out;
}

const niceTicks = (lo, hi, count = 5) => {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
};
const pathOf = (pts) => { let d = "", pen = false; for (const p of pts) { if (!p) { pen = false; continue; } d += (pen ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); pen = true; } return d; };

// ─── P(up) semicircle gauge ──────────────────────────────────────────────────
export function Gauge({ p, size = 64, label = "P(up)" }) {
  const v = num(p);
  const r = size / 2 - 5, cx = size / 2, cy = size / 2 + 2;
  const ang = (x) => Math.PI * (1 - x); // 0 → left, 1 → right
  const pt = (x, rr = r) => [cx + rr * Math.cos(ang(x)), cy - rr * Math.sin(ang(x))];
  const arc = (a, b, rr = r) => { const [x0, y0] = pt(a, rr), [x1, y1] = pt(b, rr); return `M${x0},${y0} A${rr},${rr} 0 0 1 ${x1},${y1}`; };
  const col = v == null ? C.dim : v >= 0.5 ? C.up : C.down;
  const [nx, ny] = pt(clamp(v ?? 0.5, 0, 1), r - 6);
  return (
    <svg width={size} height={size / 2 + 16} style={{ display: "block", overflow: "visible" }} aria-label={`${label} ${pct(v)}`}>
      <path d={arc(0, 1)} stroke={C.faint} strokeWidth={5} fill="none" strokeLinecap="round" />
      {v != null && <path d={v >= 0.5 ? arc(0.5, clamp(v, 0.5, 1)) : arc(clamp(v, 0, 0.5), 0.5)} stroke={col} strokeWidth={5} fill="none" strokeLinecap="round" />}
      <line x1={cx} y1={cy - r - 4} x2={cx} y2={cy - r + 4} stroke={C.sub} strokeWidth={1} />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.text} strokeWidth={1.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={2.5} fill={C.text} />
      <text x={cx} y={cy + 13} textAnchor="middle" fill={col} fontSize={11} fontWeight={700} fontFamily={MONO}>{v == null ? "—" : (v * 100).toFixed(0) + "%"}</text>
    </svg>
  );
}

// ─── Family strip: 9 tiny diverging columns ──────────────────────────────────
export function FamilyStrip({ families, height = 26, showLabels = true }) {
  const f = obj(families);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${FAMILIES.length}, 1fr)`, gap: 2 }}>
      {FAMILIES.map(k => {
        const e = f[k]; const s = num(e?.score); const has = e && s != null && (num(e?.n) ?? 1) > 0;
        const hh = has ? clamp(Math.abs(s), 0.04, 1) * (height / 2) : 0;
        return (
          <div key={k} title={`${k}: ${has ? snum(s) : "no data"}${e?.n != null ? ` · n=${e.n}` : ""}${e?.weight != null ? ` · w=${num(e.weight)?.toFixed(2)}` : ""}`}>
            <div style={{ height, position: "relative", background: C.inset, borderRadius: 2, border: `1px solid ${has ? C.border : "#0e131b"}` }}>
              <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: C.faint }} />
              {has && <div style={{ position: "absolute", left: 2, right: 2, [s >= 0 ? "bottom" : "top"]: "50%", height: hh, background: divColor(s), borderRadius: 1 }} />}
            </div>
            {showLabels && <div style={{ fontSize: 7, textAlign: "center", color: has ? C.dim : C.faint, fontFamily: MONO, marginTop: 2, letterSpacing: 0.2 }}>{FAM_SHORT[k]}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Candlestick chart with EMA overlays + risk lines + crosshair ───────────
export function CandleChart({ candles, levels = [], height = 300, decimals }) {
  const [ref, W] = useMeasure();
  const [hover, setHover] = useState(null);
  const data = useMemo(() => arr(candles).filter(c => c && num(c.c) != null && num(c.h) != null && num(c.l) != null).map(c => ({ t: toMs(c.t), o: num(c.o) ?? num(c.c), h: num(c.h), l: num(c.l), c: num(c.c), v: num(c.v) ?? 0 })), [candles]);
  const closes = useMemo(() => data.map(d => d.c), [data]);
  const e20 = useMemo(() => emaSeries(closes, 20), [closes]);
  const e50 = useMemo(() => emaSeries(closes, 50), [closes]);
  const volH = 42, padL = 6, padR = 64, padT = 10, padB = 20;
  const w = Math.max(W, 200);
  if (!data.length) return <div ref={ref} style={{ height, display: "grid", placeItems: "center", color: C.dim, fontFamily: MONO, fontSize: 11 }}>no candles</div>;
  const view = data.slice(-Math.max(30, Math.floor((w - padL - padR) / 4)));
  const off = data.length - view.length;
  const lv = levels.filter(l => num(l.v) != null);
  let lo = Math.min(...view.map(d => d.l)), hi = Math.max(...view.map(d => d.h));
  for (const l of lv) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
  const padP = (hi - lo) * 0.06 || hi * 0.01 || 1; lo -= padP; hi += padP;
  const plotH = height - padT - padB - volH;
  const x = (i) => padL + (i + 0.5) * ((w - padL - padR) / view.length);
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
  const bw = Math.max(1, ((w - padL - padR) / view.length) * 0.7);
  const vmax = Math.max(1, ...view.map(d => d.v));
  const vy0 = height - padB;
  const ticks = niceTicks(lo, hi, 5);
  const dec = decimals ?? (hi >= 1000 ? 0 : hi >= 10 ? 2 : 4);
  const onMove = (ev) => { const r = ev.currentTarget.getBoundingClientRect(); const px = ev.clientX - r.left; const i = Math.round((px - padL) / ((w - padL - padR) / view.length) - 0.5); setHover(i >= 0 && i < view.length ? i : null); };
  const h = hover != null ? view[hover] : view[view.length - 1];
  const hi20 = e20[off + (hover ?? view.length - 1)], hi50 = e50[off + (hover ?? view.length - 1)];
  const xLabels = [0, Math.floor(view.length / 3), Math.floor((2 * view.length) / 3), view.length - 1];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: C.sub, marginBottom: 4, minHeight: 14 }}>
        <span style={{ color: C.dim }}>{dt(h.t)}</span>
        <span>O <b style={{ color: C.text }}>{fprice(h.o)}</b></span><span>H <b style={{ color: C.text }}>{fprice(h.h)}</b></span>
        <span>L <b style={{ color: C.text }}>{fprice(h.l)}</b></span><span>C <b style={{ color: h.c >= h.o ? C.up : C.down }}>{fprice(h.c)}</b></span>
        <span style={{ color: C.blue }}>EMA20 {fprice(hi20)}</span><span style={{ color: C.violet }}>EMA50 {fprice(hi50)}</span>
      </div>
      <svg width={w} height={height} style={{ display: "block", touchAction: "pan-y" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map(t => <g key={t}><line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="#111823" /><text x={w - padR + 6} y={y(t) + 3} fill={C.dim} fontSize={9} fontFamily={MONO}>{t.toFixed(dec)}</text></g>)}
        {view.map((d, i) => { const up = d.c >= d.o; const col = up ? C.up : C.down; const yo = y(d.o), yc = y(d.c);
          return <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={1} opacity={0.9} />
            <rect x={x(i) - bw / 2} y={Math.min(yo, yc)} width={bw} height={Math.max(1, Math.abs(yc - yo))} fill={up ? col : col} fillOpacity={up ? 0.85 : 0.85} />
            <rect x={x(i) - bw / 2} y={vy0 - (d.v / vmax) * volH} width={bw} height={(d.v / vmax) * volH} fill={col} opacity={0.22} />
          </g>; })}
        <path d={pathOf(view.map((_, i) => e20[off + i] != null ? [x(i), y(e20[off + i])] : null))} stroke={C.blue} strokeWidth={1.5} fill="none" />
        <path d={pathOf(view.map((_, i) => e50[off + i] != null ? [x(i), y(e50[off + i])] : null))} stroke={C.violet} strokeWidth={1.5} fill="none" />
        {lv.map((l, k) => (
          <g key={k}>
            <line x1={padL} x2={w - padR} y1={y(l.v)} y2={y(l.v)} stroke={l.color} strokeDasharray={l.dash || "5 4"} strokeWidth={1.2} opacity={0.9} />
            <rect x={w - padR + 1} y={y(l.v) - 7} width={padR - 2} height={14} rx={2} fill={l.color} />
            <text x={w - padR + 4} y={y(l.v) + 3} fill="#050709" fontSize={8.5} fontWeight={700} fontFamily={MONO}>{l.label} {l.v.toFixed(dec)}</text>
          </g>
        ))}
        {hover != null && <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={vy0} stroke={C.sub} strokeDasharray="2 3" />
          <line x1={padL} x2={w - padR} y1={y(view[hover].c)} y2={y(view[hover].c)} stroke={C.sub} strokeDasharray="2 3" />
        </g>}
        {xLabels.map((i, k) => view[i] && <text key={k} x={clamp(x(i), 24, w - padR - 24)} y={height - 5} fill={C.dim} fontSize={9} textAnchor="middle" fontFamily={MONO}>{dday(view[i].t)}</text>)}
      </svg>
    </div>
  );
}

// ─── Generic multi-series line chart (equity curves, histories) ─────────────
// series: [{ name, color, points:[{t, v}], dash, fill }]; yFmt formatter; refLines:[{v,color,label}]
export function LineChart({ series, height = 200, yFmt = (v) => v.toFixed(2), yDomain, refLines = [], legend = true, xFmt = dday }) {
  const [ref, W] = useMeasure();
  const [hover, setHover] = useState(null);
  const S = arr(series).map(s => ({ ...s, points: arr(s.points).map(p => ({ t: toMs(p.t), v: num(p.v) })).filter(p => p.t != null && p.v != null).sort((a, b) => a.t - b.t) })).filter(s => s.points.length);
  const w = Math.max(W, 200);
  if (!S.length) return <div ref={ref} style={{ height, display: "grid", placeItems: "center", color: C.dim, fontFamily: MONO, fontSize: 11 }}>no data yet</div>;
  const padL = 8, padR = 58, padT = 8, padB = 20;
  const all = S.flatMap(s => s.points);
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
  let lo = yDomain ? yDomain[0] : Math.min(...all.map(p => p.v)), hi = yDomain ? yDomain[1] : Math.max(...all.map(p => p.v));
  if (!yDomain) { for (const r of refLines) if (num(r.v) != null) { lo = Math.min(lo, r.v); hi = Math.max(hi, r.v); } const pd = (hi - lo) * 0.08 || Math.abs(hi) * 0.02 || 1; lo -= pd; hi += pd; }
  const x = (t) => padL + (t1 > t0 ? (t - t0) / (t1 - t0) : 0.5) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (height - padT - padB);
  const ticks = niceTicks(lo, hi, 4);
  const onMove = (ev) => { const r = ev.currentTarget.getBoundingClientRect(); const px = ev.clientX - r.left; const t = t0 + ((px - padL) / (w - padL - padR)) * (t1 - t0); setHover(clamp(t, t0, t1)); };
  const nearest = (pts, t) => { let best = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; return best; };
  const hv = hover != null ? S.map(s => ({ s, p: nearest(s.points, hover) })) : null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {legend && S.length > 1 && <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: C.sub, marginBottom: 4 }}>
        {S.map(s => <span key={s.name}><span style={{ display: "inline-block", width: 10, height: 2, background: s.color, verticalAlign: "middle", marginRight: 5, borderTop: s.dash ? `2px dashed ${s.color}` : "none" }} />{s.name}</span>)}
      </div>}
      <svg width={w} height={height} style={{ display: "block", touchAction: "pan-y" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map(t => <g key={t}><line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="#111823" /><text x={w - padR + 6} y={y(t) + 3} fill={C.dim} fontSize={9} fontFamily={MONO}>{yFmt(t)}</text></g>)}
        {refLines.filter(r => num(r.v) != null).map((r, i) => <g key={i}><line x1={padL} x2={w - padR} y1={y(r.v)} y2={y(r.v)} stroke={r.color || C.sub} strokeDasharray="4 4" opacity={0.8} />{r.label && <text x={padL + 4} y={y(r.v) - 3} fill={r.color || C.sub} fontSize={8.5} fontFamily={MONO}>{r.label}</text>}</g>)}
        {S.map(s => {
          const pts = s.points.map(p => [x(p.t), y(p.v)]);
          return <g key={s.name}>
            {s.fill && <path d={pathOf(pts) + `L${pts[pts.length - 1][0]},${height - padB}L${pts[0][0]},${height - padB}Z`} fill={s.color} opacity={0.08} />}
            <path d={pathOf(pts)} stroke={s.color} strokeWidth={s.width || 1.8} fill="none" strokeDasharray={s.dash} strokeLinejoin="round" />
            {s.dots && s.points.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2} fill={s.color} />)}
          </g>;
        })}
        <text x={padL} y={height - 5} fill={C.dim} fontSize={9} fontFamily={MONO}>{xFmt(t0)}</text>
        <text x={w - padR} y={height - 5} fill={C.dim} fontSize={9} fontFamily={MONO} textAnchor="end">{xFmt(t1)}</text>
        {hv && <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={height - padB} stroke={C.sub} strokeDasharray="2 3" />
          {hv.map(({ s, p }) => <circle key={s.name} cx={x(p.t)} cy={y(p.v)} r={4} fill={s.color} stroke={C.panel} strokeWidth={2} />)}
        </g>}
      </svg>
      {hv && <div style={{ position: "absolute", top: legend && S.length > 1 ? 20 : 2, left: clamp(x(hover) + 10, 0, w - 170), background: "#0b1119ee", border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: "5px 8px", fontFamily: MONO, fontSize: 10, pointerEvents: "none", minWidth: 120 }}>
        <div style={{ color: C.dim, marginBottom: 2 }}>{dt(hv[0].p.t)}</div>
        {hv.map(({ s, p }) => <div key={s.name} style={{ color: C.text, display: "flex", justifyContent: "space-between", gap: 10 }}><span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: s.color, marginRight: 5 }} />{s.name}</span><b>{yFmt(p.v)}</b></div>)}
      </div>}
    </div>
  );
}

// ─── Reliability diagram ─────────────────────────────────────────────────────
// bins: [{ p (mean predicted), y (realized freq), n, lo, hi }] — normalized by normBins().
export function normBins(raw) {
  return arr(raw).map((b, i, a) => {
    if (Array.isArray(b)) return { p: num(b[0]), y: num(b[1]), n: num(b[2]) ?? 0 };
    const lo = num(b?.lo ?? b?.min ?? b?.from), hi = num(b?.hi ?? b?.max ?? b?.to);
    const p = num(b?.p ?? b?.pMean ?? b?.meanP ?? b?.avgP ?? b?.predicted ?? b?.pred ?? b?.mean ?? b?.conf) ?? (lo != null && hi != null ? (lo + hi) / 2 : (i + 0.5) / a.length);
    const y = num(b?.y ?? b?.yRate ?? b?.realized ?? b?.observed ?? b?.obs ?? b?.freq ?? b?.hitRate ?? b?.actual ?? b?.frac);
    return { p, y, n: num(b?.n ?? b?.count) ?? 0, lo, hi };
  }).filter(b => b.p != null);
}
export function binPairs(pairs, k = 10) {
  const bins = Array.from({ length: k }, (_, i) => ({ lo: i / k, hi: (i + 1) / k, sp: 0, sy: 0, n: 0 }));
  for (const q of arr(pairs)) { const p = num(q?.p), yy = num(q?.y); if (p == null || yy == null) continue; const b = bins[clamp(Math.floor(p * k), 0, k - 1)]; b.sp += p; b.sy += yy; b.n++; }
  return bins.filter(b => b.n > 0).map(b => ({ p: b.sp / b.n, y: b.sy / b.n, n: b.n, lo: b.lo, hi: b.hi }));
}
export function calibStats(pairs) {
  const P = arr(pairs).map(q => ({ p: num(q?.p), y: num(q?.y) })).filter(q => q.p != null && q.y != null);
  if (!P.length) return { n: 0 };
  const eps = 1e-6; let brier = 0, ll = 0;
  for (const q of P) { brier += (q.p - q.y) ** 2; const pp = clamp(q.p, eps, 1 - eps); ll -= q.y * Math.log(pp) + (1 - q.y) * Math.log(1 - pp); }
  const bins = binPairs(P); const ece = bins.reduce((s, b) => s + (b.n / P.length) * Math.abs(b.p - b.y), 0);
  return { n: P.length, brier: brier / P.length, logloss: ll / P.length, ece, bins };
}

export function ReliabilityDiagram({ bins, size = 260 }) {
  const [ref, W] = useMeasure();
  const B = normBins(bins);
  const s = Math.min(Math.max(W, 160), size);
  const pad = 30, inner = s - pad - 10;
  const x = (v) => pad + clamp(v, 0, 1) * inner, y = (v) => 10 + (1 - clamp(v, 0, 1)) * inner;
  const nmax = Math.max(1, ...B.map(b => b.n));
  const [hv, setHv] = useState(null);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={s} height={s} style={{ display: "block", margin: "0 auto" }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} stroke="#111823" /><line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="#111823" />
          <text x={x(t)} y={s - 6} fill={C.dim} fontSize={8.5} textAnchor="middle" fontFamily={MONO}>{t}</text>
          <text x={pad - 4} y={y(t) + 3} fill={C.dim} fontSize={8.5} textAnchor="end" fontFamily={MONO}>{t}</text>
        </g>)}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke={C.sub} strokeDasharray="4 4" />
        <text x={x(0.98)} y={y(0.98) + 12} fill={C.dim} fontSize={8} textAnchor="end" fontFamily={MONO}>perfect</text>
        {B.filter(b => b.y != null).map((b, i) => <line key={"g" + i} x1={x(b.p)} x2={x(b.p)} y1={y(b.p)} y2={y(b.y)} stroke={Math.abs(b.p - b.y) > 0.1 ? C.down : C.faint} strokeWidth={1} />)}
        <path d={pathOf(B.filter(b => b.y != null).sort((a, b) => a.p - b.p).map(b => [x(b.p), y(b.y)]))} stroke={C.blue} strokeWidth={1.8} fill="none" />
        {B.filter(b => b.y != null).map((b, i) => <circle key={i} cx={x(b.p)} cy={y(b.y)} r={3 + 5 * Math.sqrt(b.n / nmax)} fill={C.blue} fillOpacity={0.35} stroke={C.blue} strokeWidth={1.5}
          onMouseEnter={() => setHv(b)} onMouseLeave={() => setHv(null)} style={{ cursor: "default" }} />)}
      </svg>
      <div style={{ textAlign: "center", fontSize: 9, color: C.dim, fontFamily: MONO }}>predicted P(up) → realized frequency ↑ · dot size ∝ n</div>
      {hv && <div style={{ position: "absolute", top: 6, right: 6, background: "#0b1119ee", border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: "5px 8px", fontFamily: MONO, fontSize: 10, color: C.text }}>
        pred <b>{pct(hv.p)}</b> · real <b>{pct(hv.y)}</b> · n <b>{hv.n}</b>
      </div>}
      {!B.length && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: C.dim, fontFamily: MONO, fontSize: 11 }}>no resolved outcomes yet</div>}
    </div>
  );
}

// ─── History sparkline: P(up) + confidence in [0,1] ─────────────────────────
export function HistorySpark({ history, minConf, height = 110 }) {
  const H = arr(history);
  return <LineChart height={height} yDomain={[0, 1]} yFmt={(v) => (v * 100).toFixed(0) + "%"} xFmt={dt}
    refLines={[{ v: 0.5, color: C.faint }, ...(num(minConf) != null ? [{ v: minConf, color: C.warn, label: "min conf" }] : [])]}
    series={[
      { name: "P(up)", color: C.up, points: H.map(h => ({ t: h.ts ?? h.t, v: h.pUp })) },
      { name: "confidence", color: C.blue, points: H.map(h => ({ t: h.ts ?? h.t, v: h.confidence })), dash: "4 3" },
    ]} />;
}

export const moneyFmt = (v) => usd(v, 0);
