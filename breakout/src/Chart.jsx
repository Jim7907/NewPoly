import React, { useRef, useEffect, useState, useCallback } from "react";

// Canvas candlestick chart with the strategy's own annotations drawn on top: consolidation
// boxes, the broken level, entry/stop/target ladders and per-trade outcome markers.
// Deliberately dependency-free — the whole repo avoids chart libraries.

export const C = {
  bg: "#06070d", panel: "#0d1117", grid: "#121a26", border: "#1b2433",
  up: "#22c55e", down: "#ef4444", text: "#cbd5e1", dim: "#64748b",
  blue: "#38bdf8", amber: "#f59e0b", violet: "#a78bfa", rose: "#fb7185",
};

const PAD = { l: 8, r: 64, t: 10, b: 24 };
const VOL_H = 54;

export const decimalsFor = (p) => (p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 6);
export const fmtPrice = (p) => (p == null || !isFinite(p) ? "--" : Number(p).toFixed(decimalsFor(Math.abs(p))));
const fmtTime = (t, tf) => {
  const d = new Date(t * 1000);
  const day = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return ["1d", "6h"].includes(tf) ? day : `${day} ${hm}`;
};

function dashedLine(ctx, x1, y, x2, dash = [4, 4]) {
  ctx.save(); ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  ctx.restore();
}

export default function Chart({
  bars = [], trades = [], signals = [], series = null, tf = "15m",
  selected = null, onSelect = () => {},
  showBoxes = true, showRejected = false, showAllTrades = true, showEma = false,
  height = 460,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 900, h: height });
  const [view, setView] = useState(null);                 // {start, end} bar indices
  const [cursor, setCursor] = useState(null);             // {x, y, i}
  const drag = useRef(null);

  // Reset the viewport when a different dataset arrives.
  useEffect(() => {
    if (!bars.length) { setView(null); return; }
    setView({ start: Math.max(0, bars.length - 220), end: bars.length });
  }, [bars.length, tf]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: height }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: height });
    return () => ro.disconnect();
  }, [height]);

  // Center the viewport on a trade when one is selected from the list.
  useEffect(() => {
    if (!selected || !bars.length) return;
    setView(v => {
      const span = v ? v.end - v.start : 220;
      const mid = (selected.entryIndex + selected.exitIndex) / 2;
      const pad = Math.max(span, (selected.exitIndex - selected.entryIndex) * 1.8 + 40);
      const start = Math.max(0, Math.round(mid - pad / 2));
      return { start, end: Math.min(bars.length, start + Math.round(pad)) };
    });
  }, [selected, bars.length]);

  const plot = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !view || !bars.length) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

    const start = Math.max(0, Math.floor(view.start));
    const end = Math.min(bars.length, Math.ceil(view.end));
    const n = Math.max(1, end - start);
    const plotW = w - PAD.l - PAD.r;
    const priceH = h - PAD.t - PAD.b - VOL_H;
    const cw = plotW / n;
    const bw = Math.max(1, Math.min(cw * 0.7, 14));

    const vis = bars.slice(start, end);
    let lo = Math.min(...vis.map(b => b.l));
    let hi = Math.max(...vis.map(b => b.h));
    // Keep the selected trade's whole ladder on screen.
    if (selected && selected.entryIndex < end && selected.exitIndex >= start) {
      const lvls = [selected.sl, ...selected.tps, selected.entryPrice];
      lo = Math.min(lo, ...lvls); hi = Math.max(hi, ...lvls);
    }
    const padP = (hi - lo) * 0.06 || hi * 0.01 || 1;
    lo -= padP; hi += padP;

    const x = (i) => PAD.l + (i - start + 0.5) * cw;
    const y = (p) => PAD.t + ((hi - p) / (hi - lo)) * priceH;
    const volTop = PAD.t + priceH + 8;
    const maxVol = Math.max(...vis.map(b => b.v), 1);
    const vy = (v) => volTop + VOL_H - (v / maxVol) * VOL_H;

    // ── Grid + price axis ──
    ctx.font = "10px ui-monospace, monospace";
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const ticks = 6;
    for (let k = 0; k <= ticks; k++) {
      const p = lo + ((hi - lo) * k) / ticks;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w - PAD.r, yy); ctx.stroke();
      ctx.fillStyle = C.dim; ctx.textAlign = "left";
      ctx.fillText(fmtPrice(p), w - PAD.r + 6, yy + 3);
    }

    // ── Consolidation boxes + broken levels ──
    if (showBoxes) {
      for (const s of signals) {
        if (!s.accepted || s.i < start - 5 || s.i > end) continue;
        const x1 = x(Math.max(s.range.start, start - 1)), x2 = x(s.i);
        const yTop = y(s.range.high), yBot = y(s.range.low);
        ctx.fillStyle = s.side === "long" ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)";
        ctx.fillRect(x1, yTop, x2 - x1, yBot - yTop);
        ctx.strokeStyle = s.side === "long" ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)";
        ctx.strokeRect(x1, yTop, x2 - x1, yBot - yTop);
        // The broken boundary, extended a few bars past the break.
        ctx.strokeStyle = s.side === "long" ? C.up : C.down;
        ctx.lineWidth = 1.2;
        dashedLine(ctx, x1, y(s.keyLevel ?? s.level), x(Math.min(s.i + 6, end)), [5, 3]);
        ctx.lineWidth = 1;
      }
    }

    // ── Trend EMA ──
    if (showEma && series?.trendEma) {
      ctx.strokeStyle = C.violet; ctx.lineWidth = 1.2; ctx.beginPath();
      let began = false;
      for (let i = start; i < end; i++) {
        const v = series.trendEma[i];
        if (v == null) { began = false; continue; }
        if (!began) { ctx.moveTo(x(i), y(v)); began = true; } else ctx.lineTo(x(i), y(v));
      }
      ctx.stroke(); ctx.lineWidth = 1;
    }

    // ── Candles + volume ──
    for (let i = start; i < end; i++) {
      const b = bars[i];
      const up = b.c >= b.o;
      const col = up ? C.up : C.down;
      const cx = x(i);
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y(b.h));
      ctx.lineTo(Math.round(cx) + 0.5, y(b.l));
      ctx.stroke();
      const yo = y(b.o), yc = y(b.c);
      ctx.fillStyle = col;
      ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      ctx.fillStyle = up ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)";
      ctx.fillRect(cx - bw / 2, vy(b.v), bw, volTop + VOL_H - vy(b.v));
    }

    // ── Trades ──
    const drawLadder = (t) => {
      const xe = x(t.entryIndex), xx = x(t.exitIndex);
      const x2 = Math.max(xx, xe + cw);
      // Risk band (entry → stop) and reward band (entry → last target).
      ctx.fillStyle = "rgba(239,68,68,0.13)";
      ctx.fillRect(xe, y(t.entryPrice), x2 - xe, y(t.sl) - y(t.entryPrice));
      ctx.fillStyle = "rgba(34,197,94,0.10)";
      ctx.fillRect(xe, y(t.tps[t.tps.length - 1]), x2 - xe, y(t.entryPrice) - y(t.tps[t.tps.length - 1]));
      ctx.strokeStyle = C.down; dashedLine(ctx, xe, y(t.sl), x2, [3, 3]);
      ctx.strokeStyle = C.blue;
      ctx.beginPath(); ctx.moveTo(xe, y(t.entryPrice)); ctx.lineTo(x2, y(t.entryPrice)); ctx.stroke();
      t.tps.forEach((tp, k) => {
        ctx.strokeStyle = t.tpHits[k] ? C.up : "rgba(34,197,94,0.45)";
        dashedLine(ctx, xe, y(tp), x2, t.tpHits[k] ? [] : [3, 4]);
        ctx.fillStyle = t.tpHits[k] ? C.up : "rgba(148,163,184,0.7)";
        ctx.textAlign = "left";
        ctx.fillText(`TP${k + 1}`, x2 + 3, y(tp) + 3);
      });
      ctx.fillStyle = C.down; ctx.fillText("SL", x2 + 3, y(t.sl) + 3);
    };

    const marker = (t) => {
      const xe = x(t.entryIndex), ye = y(t.entryPrice);
      const up = t.side === "long";
      ctx.fillStyle = up ? C.up : C.down;
      ctx.beginPath();
      const d = 5, base = up ? ye + 9 : ye - 9;
      ctx.moveTo(xe, up ? ye + 2 : ye - 2);
      ctx.lineTo(xe - d, base); ctx.lineTo(xe + d, base);
      ctx.closePath(); ctx.fill();
      // Outcome connector: entry price → average exit price.
      ctx.strokeStyle = t.pnl >= 0 ? "rgba(34,197,94,0.8)" : "rgba(239,68,68,0.8)";
      dashedLine(ctx, xe, y(t.entryPrice), x(t.exitIndex), [2, 3]);
      ctx.fillStyle = t.pnl >= 0 ? C.up : C.down;
      ctx.beginPath(); ctx.arc(x(t.exitIndex), y(t.exitPrice), 3, 0, Math.PI * 2); ctx.fill();
    };

    for (const t of trades) {
      if (t.exitIndex < start || t.entryIndex > end) continue;
      if (showAllTrades || selected?.id === t.id) marker(t);
    }
    if (selected && selected.exitIndex >= start && selected.entryIndex <= end) drawLadder(selected);

    // ── Filtered-out signals ──
    if (showRejected) {
      ctx.strokeStyle = "rgba(148,163,184,0.55)";
      for (const s of signals) {
        if (s.accepted || s.i < start || s.i >= end) continue;
        const cx = x(s.i), cy = s.side === "long" ? y(bars[s.i].h) - 8 : y(bars[s.i].l) + 8;
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 3); ctx.lineTo(cx + 3, cy + 3);
        ctx.moveTo(cx + 3, cy - 3); ctx.lineTo(cx - 3, cy + 3);
        ctx.stroke();
      }
    }

    // ── Time axis ──
    ctx.fillStyle = C.dim; ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = start; i < end; i += step) ctx.fillText(fmtTime(bars[i].t, tf), x(i), h - 8);

    // ── Crosshair ──
    if (cursor && cursor.i >= start && cursor.i < end) {
      ctx.strokeStyle = "rgba(148,163,184,0.35)";
      dashedLine(ctx, PAD.l, cursor.y, w - PAD.r, [2, 3]);
      ctx.save(); ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x(cursor.i), PAD.t); ctx.lineTo(x(cursor.i), PAD.t + priceH); ctx.stroke();
      ctx.restore();
      const p = hi - ((cursor.y - PAD.t) / priceH) * (hi - lo);
      ctx.fillStyle = C.panel; ctx.fillRect(w - PAD.r, cursor.y - 8, PAD.r, 16);
      ctx.fillStyle = C.text; ctx.textAlign = "left";
      ctx.fillText(fmtPrice(p), w - PAD.r + 6, cursor.y + 3);
    }
  }, [bars, trades, signals, series, view, size, selected, showBoxes, showRejected, showAllTrades, showEma, cursor, tf]);

  useEffect(() => { plot(); }, [plot]);

  // ── Interaction ──
  const idxAt = (clientX) => {
    const cv = canvasRef.current;
    if (!cv || !view) return null;
    const rect = cv.getBoundingClientRect();
    const plotW = size.w - PAD.l - PAD.r;
    const n = view.end - view.start;
    return Math.round(view.start + ((clientX - rect.left - PAD.l) / plotW) * n - 0.5);
  };

  const onWheel = (e) => {
    if (!view) return;
    e.preventDefault();
    const anchor = idxAt(e.clientX);
    const n = view.end - view.start;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(30, Math.min(bars.length, Math.round(n * factor)));
    const frac = n > 0 ? (anchor - view.start) / n : 0.5;
    let start = Math.round(anchor - frac * next);
    start = Math.max(0, Math.min(bars.length - next, start));
    setView({ start, end: start + next });
  };

  const onDown = (e) => { drag.current = { x: e.clientX, view }; };
  const onUp = () => { drag.current = null; };
  const onMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    if (drag.current && view) {
      const n = drag.current.view.end - drag.current.view.start;
      const plotW = size.w - PAD.l - PAD.r;
      const shift = Math.round(((drag.current.x - e.clientX) / plotW) * n);
      let start = Math.max(0, Math.min(bars.length - n, drag.current.view.start + shift));
      setView({ start, end: start + n });
      return;
    }
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top, i: idxAt(e.clientX) });
  };

  const onClick = (e) => {
    const i = idxAt(e.clientX);
    if (i == null) return;
    const hit = trades.find(t => i >= t.entryIndex - 1 && i <= t.exitIndex + 1);
    onSelect(hit || null);
  };

  const hoverBar = cursor && bars[cursor.i];

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", cursor: drag.current ? "grabbing" : "crosshair", borderRadius: 8 }}
        onWheel={onWheel} onMouseDown={onDown} onMouseUp={onUp} onMouseLeave={() => { onUp(); setCursor(null); }}
        onMouseMove={onMove} onClick={onClick}
      />
      {hoverBar && (
        <div style={{
          position: "absolute", top: 8, left: 12, pointerEvents: "none", fontFamily: "ui-monospace, monospace",
          fontSize: 10, color: C.text, background: "rgba(6,7,13,0.82)", border: `1px solid ${C.border}`,
          borderRadius: 6, padding: "4px 8px", display: "flex", gap: 10,
        }}>
          <span style={{ color: C.dim }}>{fmtTime(hoverBar.t, tf)}</span>
          <span>O {fmtPrice(hoverBar.o)}</span>
          <span>H {fmtPrice(hoverBar.h)}</span>
          <span>L {fmtPrice(hoverBar.l)}</span>
          <span style={{ color: hoverBar.c >= hoverBar.o ? C.up : C.down }}>C {fmtPrice(hoverBar.c)}</span>
          <span style={{ color: C.dim }}>V {Math.round(hoverBar.v)}</span>
        </div>
      )}
    </div>
  );
}

// Compact equity curve for the stats panel.
export function EquityCurve({ curve = [], height = 120 }) {
  const ref = useRef(null);
  const wrapRef = useRef(null);
  useEffect(() => {
    const cv = ref.current, wrap = wrapRef.current;
    if (!cv || !wrap || curve.length < 2) return;
    const w = wrap.clientWidth, h = height;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

    const eq = curve.map(p => p.equity);
    const lo = Math.min(...eq), hi = Math.max(...eq);
    const span = hi - lo || Math.abs(hi) * 0.01 || 1;
    const x = (i) => 6 + (i / (curve.length - 1)) * (w - 12);
    const y = (v) => 8 + ((hi - v) / span) * (h - 20);

    // Drawdown shading under the running peak.
    let peak = eq[0];
    ctx.beginPath(); ctx.moveTo(x(0), y(eq[0]));
    for (let i = 0; i < eq.length; i++) { peak = Math.max(peak, eq[i]); ctx.lineTo(x(i), y(peak)); }
    for (let i = eq.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(eq[i]));
    ctx.closePath(); ctx.fillStyle = "rgba(239,68,68,0.14)"; ctx.fill();

    ctx.strokeStyle = eq[eq.length - 1] >= eq[0] ? C.up : C.down;
    ctx.lineWidth = 1.6; ctx.beginPath();
    eq.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();

    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    dashedLine(ctx, 6, y(eq[0]), w - 6, [3, 3]);

    // Labels sit on a chip so they stay readable where the curve runs through them.
    ctx.font = "9px ui-monospace, monospace"; ctx.textAlign = "left";
    const label = (text, ty) => {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(6,7,13,0.85)";
      ctx.fillRect(6, ty - 8, tw + 6, 11);
      ctx.fillStyle = C.dim;
      ctx.fillText(text, 9, ty);
    };
    label(fmtPrice(hi), 12);
    label(fmtPrice(lo), h - 5);
  }, [curve, height]);

  return <div ref={wrapRef} style={{ width: "100%" }}><canvas ref={ref} style={{ display: "block", borderRadius: 6 }} /></div>;
}
