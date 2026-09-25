import React, { useState } from "react";
import { C, MONO, Chip, Tag, MeterBar, Empty, Table, Btn, inputStyle, actionMeta, isActionable, isBullish, isBearish,
  num, pct, spct, fx, fprice, ago, arr, obj, clamp, colorSign } from "./ui.jsx";
import { Gauge, FamilyStrip } from "./charts.jsx";

export const regimeLabel = (r) => (r == null ? null : typeof r === "string" ? r : r.label || [r.trend, r.vol].filter(Boolean).join("/") || null);
const regimeColor = (label) => { const l = String(label || ""); return l.includes("up") ? C.up : l.includes("down") ? C.down : l.includes("range") ? C.blue : C.sub; };

export function sortDecisions(list) {
  return [...arr(list)].sort((a, b) => {
    const aa = isActionable(a?.action) ? 1 : 0, ba = isActionable(b?.action) ? 1 : 0;
    if (aa !== ba) return ba - aa;
    return (num(b?.confidence) ?? -1) - (num(a?.confidence) ?? -1);
  });
}

function Price({ d, tick }) {
  const p = tick?.price ?? d.price;
  const cls = tick?.dir > 0 ? "de-flash-up" : tick?.dir < 0 ? "de-flash-dn" : undefined;
  return <span key={tick?.seq ?? 0} className={cls} style={{ fontFamily: MONO, fontWeight: 700, fontSize: 15, color: C.text, padding: "0 3px", borderRadius: 3 }}>{fprice(p)}</span>;
}

// ─── Directional forecast (always UP/DOWN; separate from the confidence-gated trade action) ──
// Every field is optional: older decisions have no `forecast`; ranking rows carry flat direction/alignment/strength.
const frac = (x) => { const n = num(x); return n == null ? null : Math.abs(n) > 1.5 ? n / 100 : n; };
export function normDir(x) {
  if (x == null) return null;
  if (typeof x === "number") return x > 0 ? "UP" : x < 0 ? "DOWN" : null;
  const s = String(x).trim().toUpperCase();
  if (["UP", "LONG", "BULL", "BULLISH", "▲", "+1", "1"].includes(s)) return "UP";
  if (["DOWN", "SHORT", "BEAR", "BEARISH", "▼", "-1"].includes(s)) return "DOWN";
  return null;
}
const STRENGTHS = ["strong", "moderate", "weak"];
export function getForecast(d) {
  if (!d || typeof d !== "object") return null;
  const f = d.forecast && typeof d.forecast === "object" ? d.forecast : null;
  const dir = normDir(f ? f.direction : d.direction);
  if (!dir) return null;
  const src = f || d;
  const h = f && f.historical && typeof f.historical === "object" ? f.historical : null;
  const v = f && f.votes && typeof f.votes === "object" ? f.votes : null;
  const st = src.strength == null ? null : String(src.strength).toLowerCase();
  const hit = h ? frac(h.hitRate) : null, base = h ? frac(h.baseRate) : null;
  return {
    dir, up: dir === "UP", col: dir === "UP" ? C.up : C.down,
    strength: st, alignment: frac(src.alignment),
    pSignal: f ? frac(f.pSignal) : null, pDirection: f ? frac(f.pDirection) : null,
    votes: v ? { up: num(v.up) ?? 0, down: num(v.down) ?? 0, neutral: num(v.neutral) ?? 0 } : null,
    topFor: f ? arr(f.topFor).filter(Boolean) : [], topAgainst: f ? arr(f.topAgainst).filter(Boolean) : [],
    hist: h ? {
      hitRate: hit, n: num(h.n), baseRate: base, lift: frac(h.lift) ?? (hit != null && base != null ? hit - base : null),
      ci95: Array.isArray(h.ci95) && h.ci95.length === 2 ? h.ci95.map(frac) : null, bucket: h.bucket || null,
      strengthHitRate: frac(h.strengthHitRate), strengthN: num(h.strengthN),
      horizon: h.horizon || null, assetClass: h.assetClass || null, basis: h.basis || null,
    } : null,
    agrees: typeof (f && f.agreesWithAction) === "boolean" ? f.agreesWithAction : null,
    text: f && typeof f.text === "string" && f.text ? f.text : null,
    note: f && typeof f.note === "string" && f.note ? f.note : null,
  };
}
// Signed alignment for sorting: +0.9 = strongly UP … −0.9 = strongly DOWN.
export const signedAlign = (f) => (f ? (f.up ? 1 : -1) * (f.alignment ?? 0.5) : null);
const pipsOf = (s) => (s === "strong" ? 3 : s === "moderate" ? 2 : s === "weak" ? 1 : 0);

// Forecast badge: a rounded pill with an arrow, deliberately unlike the square filled action Chip.
export function DirBadge({ f, size = "md", title }) {
  if (!f) return null;
  const fs = size === "lg" ? 13 : size === "sm" ? 9.5 : 11;
  return <span title={title ?? `forecast ${f.dir}${f.strength ? " · " + f.strength : ""}${f.alignment != null ? ` · ${pct(f.alignment, 0)} of signal weight aligned` : ""}`}
    style={{ display: "inline-flex", alignItems: "center", gap: 4, color: f.col, background: f.up ? "rgba(34,197,94,.08)" : "rgba(242,95,76,.08)", border: `1px solid ${f.col}aa`, borderRadius: 999, padding: size === "lg" ? "3px 11px" : size === "sm" ? "0 7px" : "1px 9px", fontSize: fs, fontWeight: 800, fontFamily: MONO, letterSpacing: 0.6, whiteSpace: "nowrap", lineHeight: 1.5 }}>
    <span style={{ fontSize: fs * 0.85 }}>{f.up ? "▲" : "▼"}</span>{f.dir}
  </span>;
}

// Strength as 3 pips + word.
export function StrengthPips({ f, showWord = true }) {
  if (!f || !f.strength) return null;
  const k = pipsOf(f.strength);
  return <span title={`forecast strength: ${f.strength}`} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: MONO, fontSize: 9, color: k === 3 ? C.text : k === 2 ? C.sub : C.dim, whiteSpace: "nowrap" }}>
    <span style={{ display: "inline-flex", gap: 1.5, alignItems: "flex-end" }}>
      {[1, 2, 3].map(i => <span key={i} style={{ width: 3, height: 3 + i * 2, borderRadius: 1, background: i <= k ? f.col : C.faint }} />)}
    </span>
    {showWord && f.strength}
  </span>;
}

// Tug-of-war bar: DOWN share on the left (red), UP share on the right (green); the forecast side is solid.
// The tick marks the 50/50 split.
export function AlignBar({ f, h = 6, title }) {
  const a = f ? f.alignment : null;
  const upShare = a == null ? null : clamp(f.up ? a : 1 - a, 0, 1);
  return (
    <div title={title ?? (a == null ? "no alignment reported" : `${pct(a, 0)} of weighted signal evidence points ${f.dir}; ${pct(1 - a, 0)} points the other way`)}
      style={{ height: h, position: "relative", background: C.inset, border: `1px solid ${C.border}`, borderRadius: 2, overflow: "hidden" }}>
      {upShare != null && <>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `calc(${(1 - upShare) * 100}% - 1px)`, background: C.down, opacity: f.up ? 0.28 : 1, transition: "width .4s ease" }} />
        <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `calc(${upShare * 100}% - 1px)`, background: C.up, opacity: f.up ? 1 : 0.28, transition: "width .4s ease" }} />
      </>}
      <div style={{ position: "absolute", left: "calc(50% - 0.5px)", top: 0, bottom: 0, width: 1, background: C.text, opacity: 0.55 }} />
    </div>
  );
}

// Hit-rate bar diverging from 50% (coin flip), with an optional base-rate tick and 95% CI whisker.
export function RateBar({ v, base, ci, dom = 0.2, h = 8, title }) {
  const n = num(v), b = num(base);
  const X = (x) => clamp(((x - (0.5 - dom)) / (2 * dom)) * 100, 0, 100);
  const lo = ci && num(ci[0]) != null ? X(ci[0]) : null, hi = ci && num(ci[1]) != null ? X(ci[1]) : null;
  const col = n == null ? C.dim : b != null ? (n >= b ? C.up : n >= 0.5 ? C.amber : C.down) : n >= 0.5 ? C.up : C.down;
  return (
    <div title={title} style={{ height: h, position: "relative", background: C.inset, border: `1px solid ${C.border}`, borderRadius: 2 }}>
      {n != null && <div style={{ position: "absolute", top: 1, bottom: 1, left: Math.min(X(0.5), X(n)) + "%", width: Math.max(0.6, Math.abs(X(n) - X(0.5))) + "%", background: col, borderRadius: 1, transition: "width .4s ease, left .4s ease" }} />}
      {lo != null && hi != null && <div style={{ position: "absolute", left: lo + "%", width: Math.max(0.5, hi - lo) + "%", top: "50%", height: 1, marginTop: -0.5, background: C.text, opacity: 0.7 }} />}
      <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: C.sub }} />
      {b != null && <div style={{ position: "absolute", left: `calc(${X(b)}% - 1px)`, top: -3, bottom: -3, width: 2, background: C.warn, borderRadius: 1 }} />}
    </div>
  );
}

function ForecastStrip({ d, f }) {
  const act = isActionable(d.action);
  const h = f.hist;
  const disagree = act && f.agrees === false;
  return (
    <div title={f.text || undefined} style={{ marginTop: 8, padding: "5px 7px", background: C.inset, border: `1px solid ${f.col}40`, borderLeft: `2px solid ${f.col}`, borderRadius: 5, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 7.5, color: C.dim, letterSpacing: 1.2 }}>FORECAST</span>
        <DirBadge f={f} />
        <StrengthPips f={f} />
        {f.alignment != null ? <>
          <div style={{ flex: 1, minWidth: 28 }}><AlignBar f={f} h={5} /></div>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.text, whiteSpace: "nowrap" }}><b>{pct(f.alignment, 0)}</b><span style={{ color: C.dim, fontSize: 8.5 }}> aligned</span></span>
        </> : <span style={{ flex: 1 }} />}
      </div>
      {(h || disagree) && <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, fontFamily: MONO, fontSize: 9, color: C.dim, minWidth: 0 }}>
        {h && (h.hitRate != null
          ? <span title={`historically, ${h.assetClass || ""} ${f.dir} calls in the ${h.bucket || "?"} alignment bucket were right ${pct(h.hitRate, 1)} of the time (n=${h.n?.toLocaleString("en-US") ?? "?"}) vs a ${pct(h.baseRate, 1)} base rate${h.basis ? `\n${h.basis}` : ""}`} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              hist <b style={{ color: (h.lift ?? 0) > 0 ? C.up : C.amber }}>{pct(h.hitRate, 0)}</b> vs {pct(h.baseRate, 0)} base <span style={{ color: C.faint }}>· n {h.n != null ? h.n.toLocaleString("en-US") : "—"}</span>
            </span>
          : <span title={h.basis || undefined} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>hist: too few {h.bucket || ""} calls (n={h.n ?? 0})</span>)}
        <span style={{ flex: 1 }} />
        {disagree && <span title="the trade action points the other way from the signals' consensus" style={{ color: C.amber, border: `1px solid ${C.amber}66`, borderRadius: 3, padding: "0 4px", whiteSpace: "nowrap" }}>≠ action</span>}
      </div>}
    </div>
  );
}

const KV = ({ k, v, color = C.text, title }) => (
  <div title={title} style={{ display: "flex", justifyContent: "space-between", gap: 6, fontFamily: MONO, fontSize: 10, minWidth: 0 }}>
    <span style={{ color: C.dim, whiteSpace: "nowrap" }}>{k}</span><b style={{ color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</b>
  </div>
);

export function DecisionCard({ d, tick, minConf, selected, onClick, now }) {
  const m = actionMeta(d.action);
  const act = isActionable(d.action);
  const accent = isBullish(d.action) ? C.up : isBearish(d.action) ? C.down : C.border;
  const top = arr(d.drivers)[0];
  const rl = regimeLabel(d.regime);
  const rr = num(d.risk?.riskReward);
  const f = getForecast(d);
  return (
    <div className="de-card de-in" onClick={onClick} role="button" tabIndex={0} onKeyDown={e => (e.key === "Enter" || e.key === " ") && onClick()}
      style={{ background: selected ? "#0f1622" : C.panel, border: `1px solid ${selected ? C.blue : act ? accent + "88" : C.border}`, borderLeft: `3px solid ${act ? accent : C.faint}`, borderRadius: 8, padding: "10px 11px", cursor: "pointer", minWidth: 0, outline: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.text, fontFamily: MONO, letterSpacing: 0.5 }}>{d.symbol || d.assetId || "?"}</span>
            <Price d={d} tick={tick} />
          </div>
          <div style={{ display: "flex", gap: 5, marginTop: 3, flexWrap: "wrap" }}>
            <Tag>{d.horizonLabel || d.horizon || "—"}</Tag>
            {rl && <Tag color={regimeColor(rl)} title="market regime">{rl}</Tag>}
            {d.llm && <Tag color={C.violet} title="LLM analyst contributed">◆ LLM</Tag>}
          </div>
        </div>
        <div style={{ textAlign: "right", flex: "none" }}>
          <div style={{ fontFamily: MONO, fontSize: 7.5, color: C.dim, letterSpacing: 1.2, marginBottom: 2 }}>ACTION</div>
          <Chip action={d.action} />
          <div style={{ fontSize: 9, color: C.dim, fontFamily: MONO, marginTop: 5 }}>{ago(d.ts, now)}</div>
        </div>
      </div>

      {f && <ForecastStrip d={d} f={f} />}

      <div style={{ display: "grid", gridTemplateColumns: "68px 1fr", gap: 10, alignItems: "center", marginTop: 8 }}>
        <Gauge p={d.pUp} size={64} />
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 10, marginBottom: 3 }}>
              <span style={{ color: C.dim }}>confidence</span>
              <b style={{ color: (num(d.confidence) ?? 0) >= (minConf ?? 0) ? C.text : C.sub }}>{pct(d.confidence, 0)}</b>
            </div>
            <MeterBar v={d.confidence} threshold={minConf} color={act ? m.bd : C.blue} title={`confidence ${pct(d.confidence)} · threshold ${pct(minConf)}`} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 10, rowGap: 2 }}>
            <KV k="agree" v={pct(d.agreement, 0)} />
            <KV k="E[r]" v={spct(d.expectedReturn, 2)} color={colorSign(d.expectedReturn)} />
            <KV k="edge" v={pct(d.edge, 1)} />
            <KV k="R:R" v={rr == null ? "—" : rr.toFixed(2)} color={rr != null && rr >= 1.5 ? C.up : C.text} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.35, minHeight: 28, color: act ? C.text : C.sub, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {!act && d.abstainReason
          ? <span style={{ color: C.dim, fontStyle: "italic" }}>abstain: {d.abstainReason}</span>
          : top ? <><span style={{ color: (num(top.score) ?? 0) >= 0 ? C.up : C.down, fontFamily: MONO, fontSize: 9 }}>{(num(top.score) ?? 0) >= 0 ? "▲" : "▼"} </span>{top.reason || top.id}</>
          : <span style={{ color: C.dim }}>no dominant driver</span>}
      </div>

      <div style={{ marginTop: 7 }}><FamilyStrip families={d.families} height={20} /></div>
    </div>
  );
}

function Section({ title, list, ticks, minConf, selectedId, onSelect, now, count }) {
  if (!list.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 2px 8px" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.sub, fontWeight: 700 }}>{title}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{count}</span>
        <div style={{ flex: 1, height: 1, background: C.border }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 290px), 1fr))", gap: 8 }}>
        {list.map(d => <DecisionCard key={d.assetId || d.symbol} d={d} tick={ticks[d.symbol]} minConf={minConf} now={now} selected={selectedId === d.assetId} onClick={() => onSelect(d)} />)}
      </div>
    </div>
  );
}

function BoardTable({ list, ticks, minConf, onSelect, selectedId }) {
  const cols = [
    { key: "sym", label: "asset", sort: d => d.symbol, render: d => <b style={{ color: selectedId === d.assetId ? C.blue : C.text }}>{d.symbol}<span style={{ color: C.dim, fontWeight: 400, marginLeft: 5, fontSize: 9 }}>{d.assetClass === "crypto" ? "CRY" : "STK"}</span></b> },
    { key: "px", label: "price", align: "right", sort: d => num(ticks[d.symbol]?.price ?? d.price), render: d => <Price d={d} tick={ticks[d.symbol]} /> },
    { key: "act", label: "action", sort: d => actionMeta(d.action).rank, render: d => <Chip action={d.action} size="sm" /> },
    { key: "dir", label: "forecast", sort: d => signedAlign(getForecast(d)), render: d => { const f = getForecast(d); return f
      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><DirBadge f={f} size="sm" /><StrengthPips f={f} showWord={false} />{f.hist?.hitRate != null && <span title={`historical hit rate ${pct(f.hist.hitRate, 1)} vs base ${pct(f.hist.baseRate, 1)} (n=${f.hist.n ?? "?"}, ${f.hist.bucket || ""})`} style={{ color: C.dim, fontSize: 9 }}>h {pct(f.hist.hitRate, 0)}</span>}</span>
      : <span style={{ color: C.dim }}>—</span>; } },
    { key: "al", label: "aligned", sort: d => getForecast(d)?.alignment ?? null, render: d => { const f = getForecast(d); return f && f.alignment != null
      ? <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 92 }}><div style={{ flex: 1 }}><AlignBar f={f} h={5} /></div><span style={{ width: 30, textAlign: "right" }}>{pct(f.alignment, 0)}</span></div>
      : <span style={{ color: C.dim }}>—</span>; } },
    { key: "p", label: "P(up)", align: "right", sort: d => num(d.pUp), render: d => <span style={{ color: (num(d.pUp) ?? 0.5) >= 0.5 ? C.up : C.down }}>{pct(d.pUp, 1)}</span> },
    { key: "c", label: "conf", sort: d => num(d.confidence), render: d => <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 90 }}><div style={{ flex: 1 }}><MeterBar v={d.confidence} threshold={minConf} h={5} /></div><span>{pct(d.confidence, 0)}</span></div> },
    { key: "ag", label: "agree", align: "right", sort: d => num(d.agreement), render: d => pct(d.agreement, 0) },
    { key: "er", label: "E[r]", align: "right", sort: d => num(d.expectedReturn), render: d => <span style={{ color: colorSign(d.expectedReturn) }}>{spct(d.expectedReturn)}</span> },
    { key: "rr", label: "R:R", align: "right", sort: d => num(d.risk?.riskReward), render: d => fx(d.risk?.riskReward, 2) },
    { key: "rg", label: "regime", sort: d => regimeLabel(d.regime) || "", render: d => <span style={{ color: regimeColor(regimeLabel(d.regime)) }}>{regimeLabel(d.regime) || "—"}</span> },
    { key: "why", label: "top driver / abstain", wrap: true, maxWidth: 340, render: d => <span style={{ color: isActionable(d.action) ? C.text : C.dim, fontFamily: "inherit", fontSize: 10 }}>{isActionable(d.action) ? (arr(d.drivers)[0]?.reason || "—") : (d.abstainReason || arr(d.drivers)[0]?.reason || "—")}</span> },
  ];
  return <Table cols={cols} rows={list} rowKey={d => d.assetId || d.symbol} onRowClick={onSelect} dense />;
}

export default function DecisionBoard({ decisions, ticks, minConf, selectedId, onSelect, loading, err, now }) {
  const [view, setView] = useState("cards");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [fdir, setFdir] = useState("all");
  let list = arr(decisions).filter(d => d && typeof d === "object");
  const hasFc = list.some(d => getForecast(d));
  if (fdir !== "all" && hasFc) list = list.filter(d => getForecast(d)?.dir === fdir);
  if (filter === "act") list = list.filter(d => isActionable(d.action));
  if (filter === "long") list = list.filter(d => isBullish(d.action));
  if (filter === "short") list = list.filter(d => isBearish(d.action));
  if (q) list = list.filter(d => String(d.symbol || d.assetId || "").toLowerCase().includes(q.toLowerCase()));
  const crypto = sortDecisions(list.filter(d => d.assetClass === "crypto"));
  const stocks = sortDecisions(list.filter(d => d.assetClass !== "crypto"));
  const all = arr(decisions);
  const counts = { buy: all.filter(d => isBullish(d?.action)).length, sell: all.filter(d => isBearish(d?.action)).length, hold: all.filter(d => d && !isActionable(d.action)).length };
  const avgConf = all.length ? all.reduce((s, d) => s + (num(d?.confidence) ?? 0), 0) / all.length : null;
  const fc = all.map(getForecast).filter(Boolean);
  const fUp = fc.filter(f => f.up).length, fDn = fc.length - fUp;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 6, fontFamily: MONO, fontSize: 10 }}>
          <span style={{ color: C.up, border: `1px solid ${C.up}55`, borderRadius: 4, padding: "3px 7px" }}>▲ {counts.buy} LONG</span>
          <span style={{ color: C.down, border: `1px solid ${C.down}55`, borderRadius: 4, padding: "3px 7px" }}>▼ {counts.sell} SHORT/EXIT</span>
          <span style={{ color: C.hold, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 7px" }}>■ {counts.hold} HOLD</span>
          <span style={{ color: C.sub, padding: "3px 4px" }}>avg conf <b style={{ color: C.text }}>{pct(avgConf, 0)}</b></span>
          {fc.length > 0 && <span title="directional forecasts (signals' consensus), independent of the trade action" style={{ color: C.sub, border: `1px dashed ${C.borderHi}`, borderRadius: 999, padding: "3px 8px", whiteSpace: "nowrap" }}>
            forecast <b style={{ color: C.up }}>▲{fUp}</b> <b style={{ color: C.down }}>▼{fDn}</b>
          </span>}
        </div>
        <div style={{ flex: 1 }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter symbol" style={{ ...inputStyle, width: 110 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {[["all", "ALL"], ["act", "ACTIONABLE"], ["long", "LONG"], ["short", "SHORT"]].map(([k, l]) => <Btn key={k} small active={filter === k} onClick={() => setFilter(k)}>{l}</Btn>)}
        </div>
        {hasFc && <div style={{ display: "flex", gap: 4, alignItems: "center" }} title="filter by directional forecast (independent of the trade action)">
          <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.dim, letterSpacing: 1 }}>FCST</span>
          <Btn small active={fdir === "all"} onClick={() => setFdir("all")}>ANY</Btn>
          <Btn small active={fdir === "UP"} color={C.up} onClick={() => setFdir(v => (v === "UP" ? "all" : "UP"))}>▲ UP</Btn>
          <Btn small active={fdir === "DOWN"} color={C.down} onClick={() => setFdir(v => (v === "DOWN" ? "all" : "DOWN"))}>▼ DOWN</Btn>
        </div>}
        <div style={{ display: "flex", gap: 4 }}>
          <Btn small active={view === "cards"} onClick={() => setView("cards")} title="cards">▦</Btn>
          <Btn small active={view === "table"} onClick={() => setView("table")} title="table">≡</Btn>
        </div>
      </div>

      {!all.length && loading && <Empty><span className="de-pulse">●</span> waiting for first decisions…</Empty>}
      {!all.length && !loading && !err && <Empty>no decisions yet — the engine is warming up</Empty>}
      {err && !all.length && <Empty>⚠ {err}</Empty>}
      {all.length > 0 && !list.length && <Empty>nothing matches this filter</Empty>}

      {view === "cards" ? <>
        <Section title="CRYPTO · 24/7" count={crypto.length} list={crypto} ticks={ticks} minConf={minConf} selectedId={selectedId} onSelect={onSelect} now={now} />
        <Section title="STOCKS & ETFs" count={stocks.length} list={stocks} ticks={ticks} minConf={minConf} selectedId={selectedId} onSelect={onSelect} now={now} />
      </> : list.length > 0 && <BoardTable list={[...crypto, ...stocks]} ticks={ticks} minConf={minConf} onSelect={onSelect} selectedId={selectedId} />}
    </div>
  );
}

