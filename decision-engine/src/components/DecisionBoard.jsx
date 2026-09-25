import React, { useState } from "react";
import { C, MONO, Chip, Tag, MeterBar, Empty, Table, Btn, inputStyle, actionMeta, isActionable, isBullish, isBearish,
  num, pct, spct, fx, fprice, ago, arr, obj, colorSign } from "./ui.jsx";
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
          <Chip action={d.action} />
          <div style={{ fontSize: 9, color: C.dim, fontFamily: MONO, marginTop: 5 }}>{ago(d.ts, now)}</div>
        </div>
      </div>

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
  let list = arr(decisions).filter(d => d && typeof d === "object");
  if (filter === "act") list = list.filter(d => isActionable(d.action));
  if (filter === "long") list = list.filter(d => isBullish(d.action));
  if (filter === "short") list = list.filter(d => isBearish(d.action));
  if (q) list = list.filter(d => String(d.symbol || d.assetId || "").toLowerCase().includes(q.toLowerCase()));
  const crypto = sortDecisions(list.filter(d => d.assetClass === "crypto"));
  const stocks = sortDecisions(list.filter(d => d.assetClass !== "crypto"));
  const all = arr(decisions);
  const counts = { buy: all.filter(d => isBullish(d?.action)).length, sell: all.filter(d => isBearish(d?.action)).length, hold: all.filter(d => d && !isActionable(d.action)).length };
  const avgConf = all.length ? all.reduce((s, d) => s + (num(d?.confidence) ?? 0), 0) / all.length : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 6, fontFamily: MONO, fontSize: 10 }}>
          <span style={{ color: C.up, border: `1px solid ${C.up}55`, borderRadius: 4, padding: "3px 7px" }}>▲ {counts.buy} LONG</span>
          <span style={{ color: C.down, border: `1px solid ${C.down}55`, borderRadius: 4, padding: "3px 7px" }}>▼ {counts.sell} SHORT/EXIT</span>
          <span style={{ color: C.hold, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 7px" }}>■ {counts.hold} HOLD</span>
          <span style={{ color: C.sub, padding: "3px 4px" }}>avg conf <b style={{ color: C.text }}>{pct(avgConf, 0)}</b></span>
        </div>
        <div style={{ flex: 1 }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter symbol" style={{ ...inputStyle, width: 110 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {[["all", "ALL"], ["act", "ACTIONABLE"], ["long", "LONG"], ["short", "SHORT"]].map(([k, l]) => <Btn key={k} small active={filter === k} onClick={() => setFilter(k)}>{l}</Btn>)}
        </div>
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

