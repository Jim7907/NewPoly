import React, { useEffect, useMemo, useState } from "react";
import { C, MONO, FAMILIES, Chip, Tag, Panel, Stat, DivBar, MeterBar, Loading, ErrorBox, Empty, Table, Btn, inputStyle,
  api, num, pct, spct, fx, snum, fprice, usd, ago, dt, arr, obj, colorSign, isActionable, isBearish, divColor, actionMeta } from "./ui.jsx";
import { CandleChart, Gauge, HistorySpark, FamilyStrip } from "./charts.jsx";
import { regimeLabel } from "./DecisionBoard.jsx";

const tfFor = (h) => (h === "intraday" ? 900 : 86400);
const KAPPA = 0.9;
const logit = (p) => Math.log(p / (1 - p));
// Approximate evidence of a raw signal when the server didn't attach a contribution (display only).
const approxImpact = (s) => { const sc = Math.max(-1, Math.min(1, num(s?.score) ?? 0)); return logit(0.5 + 0.5 * sc * KAPPA) * (num(s?.confidence) ?? 0); };

function DriverList({ title, items, color, maxAbs }) {
  const L = arr(items);
  return (
    <Panel title={title} pad={10}>
      {!L.length && <Empty>none</Empty>}
      <div style={{ display: "grid", gap: 8 }}>
        {L.map((d, i) => {
          const c = num(d.contribution) ?? approxImpact(d);
          return (
            <div key={(d.id || "") + i}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontFamily: MONO, fontSize: 10 }}>
                <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.id}>{d.id || "—"}</span>
                <span style={{ color, flex: "none" }}>{snum(c, 3)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "3px 0" }}>
                <Tag>{d.family || "?"}</Tag>
                <div style={{ flex: 1, height: 5, background: C.inset, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: Math.min(100, (Math.abs(c) / (maxAbs || 1)) * 100) + "%", height: "100%", background: color, borderRadius: 2 }} />
                </div>
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, flex: "none" }}>s {snum(d.score)} · c {fx(d.confidence, 2)}</span>
              </div>
              <div style={{ fontSize: 10.5, color: C.sub, lineHeight: 1.35 }}>{d.reason || ""}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function RiskBox({ d }) {
  const r = obj(d.risk);
  const px = num(d.price);
  const dist = (v) => (px && num(v) != null ? spct((num(v) - px) / px, 2) : null);
  const short = isBearish(d.action);
  return (
    <Panel title="Risk plan" right={<Tag color={isActionable(d.action) ? actionMeta(d.action).bd : C.dim}>{isActionable(d.action) ? (short ? "SHORT / EXIT" : "LONG") : "NO POSITION"}</Tag>} pad={10}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 6 }}>
        <Stat label="entry" value={fprice(d.price)} />
        <Stat label="stop" value={fprice(r.stop)} color={C.down} sub={dist(r.stop)} />
        <Stat label="target" value={fprice(r.target)} color={C.up} sub={dist(r.target)} />
        <Stat label="R:R" value={fx(r.riskReward, 2)} />
        <Stat label="ATR" value={fprice(r.atr)} sub={pct(r.atrPct, 2)} />
        <Stat label="size" value={usd(r.sizeUsd)} sub={pct(r.sizeFrac, 1) + " equity"} color={C.blue} />
        <Stat label="VaR 95" value={num(r.var95) != null && Math.abs(r.var95) < 1 ? pct(r.var95, 2) : usd(r.var95)} color={C.amber} />
        <Stat label="max loss" value={usd(r.maxLossUsd)} color={C.down} />
      </div>
    </Panel>
  );
}

function FamilyTable({ families }) {
  const f = obj(families);
  const rows = FAMILIES.map(k => ({ k, ...obj(f[k]) })).concat(Object.keys(f).filter(k => !FAMILIES.includes(k)).map(k => ({ k, ...obj(f[k]) })));
  const maxL = Math.max(0.01, ...rows.map(r => Math.abs(num(r.logodds) ?? 0)));
  return <Table dense rows={rows} rowKey={r => r.k} initialSort={{ key: "lo", dir: "desc" }} cols={[
    { key: "k", label: "family", sort: r => r.k, render: r => <span style={{ color: num(r.n) ? C.text : C.dim }}>{r.k}</span> },
    { key: "score", label: "score", sort: r => num(r.score), render: r => <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 110 }}><div style={{ flex: 1 }}><DivBar v={r.score} /></div><span style={{ color: colorSign(r.score), width: 38, textAlign: "right" }}>{snum(r.score)}</span></div> },
    { key: "w", label: "weight", align: "right", sort: r => num(r.weight), render: r => fx(r.weight, 2) },
    { key: "lo", label: "log-odds", sort: r => Math.abs(num(r.logodds) ?? 0), render: r => <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 100 }}><div style={{ flex: 1 }}><DivBar v={r.logodds} max={maxL} /></div><span style={{ color: colorSign(r.logodds), width: 42, textAlign: "right" }}>{snum(r.logodds, 2)}</span></div> },
    { key: "n", label: "n", align: "right", sort: r => num(r.n), render: r => r.n ?? "—" },
  ]} />;
}

function SignalTable({ d }) {
  const [fam, setFam] = useState("all");
  const [q, setQ] = useState("");
  const byId = useMemo(() => { const m = {}; for (const x of [...arr(d.drivers), ...arr(d.against)]) if (x?.id) m[x.id] = num(x.contribution); return m; }, [d]);
  const sigs = arr(d.signals).filter(s => s && typeof s === "object").map(s => {
    const exact = num(s.contribution) ?? byId[s.id];
    return { ...s, _impact: exact ?? approxImpact(s), _exact: exact != null };
  });
  const famCounts = {}; for (const s of sigs) famCounts[s.family || "?"] = (famCounts[s.family || "?"] || 0) + 1;
  const rows = sigs.filter(s => (fam === "all" || s.family === fam) && (!q || (String(s.id) + " " + String(s.reason)).toLowerCase().includes(q.toLowerCase())));
  const maxI = Math.max(0.01, ...sigs.map(s => Math.abs(s._impact)));
  return (
    <Panel title={`All signals · ${sigs.length}`} pad={10} right={<input value={q} onChange={e => setQ(e.target.value)} placeholder="search id / reason" style={{ ...inputStyle, width: 150 }} />}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <Btn small active={fam === "all"} onClick={() => setFam("all")}>all {sigs.length}</Btn>
        {Object.keys(famCounts).sort().map(k => <Btn small key={k} active={fam === k} onClick={() => setFam(k)}>{k} {famCounts[k]}</Btn>)}
      </div>
      {!sigs.length ? <Empty>no signal detail for this decision</Empty> :
        <Table dense maxHeight={460} rows={rows} rowKey={(s, i) => (s.id || "") + i} initialSort={{ key: "imp", dir: "desc" }} cols={[
          { key: "id", label: "signal", sort: s => String(s.id), render: s => <span title={s.id} style={{ color: C.text }}>{s.id || "—"}</span>, maxWidth: 220 },
          { key: "fam", label: "family", sort: s => s.family || "", render: s => <span style={{ color: C.sub }}>{s.family || "—"}</span> },
          { key: "score", label: "score", sort: s => num(s.score), render: s => <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 100 }}><div style={{ flex: 1 }}><DivBar v={s.score} h={5} /></div><span style={{ color: colorSign(s.score), width: 36, textAlign: "right" }}>{snum(s.score)}</span></div> },
          { key: "conf", label: "conf", sort: s => num(s.confidence), render: s => <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 64 }}><div style={{ flex: 1 }}><MeterBar v={s.confidence} h={4} color={C.sub} /></div><span style={{ width: 26, textAlign: "right" }}>{fx(s.confidence, 2)}</span></div> },
          { key: "imp", label: "|impact|", sort: s => Math.abs(s._impact), render: s => <div title={s._exact ? "ensemble contribution" : "approx. evidence = logit(0.5+0.45·score)·confidence (pre-weighting)"} style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 80 }}>
            <div style={{ flex: 1, height: 5, background: C.inset, borderRadius: 2 }}><div style={{ width: (Math.abs(s._impact) / maxI) * 100 + "%", height: "100%", background: divColor(s._impact / maxI), borderRadius: 2 }} /></div>
            <span style={{ color: s._exact ? C.text : C.sub, width: 42, textAlign: "right" }}>{snum(s._impact, 2)}{s._exact ? "" : "~"}</span></div> },
          { key: "hz", label: "hz", sort: s => s.horizon || "", render: s => <span style={{ color: C.dim }}>{s.horizon || "—"}</span> },
          { key: "reason", label: "reason", wrap: true, render: s => <span style={{ color: C.sub, fontFamily: "Inter, system-ui, sans-serif", fontSize: 10.5 }}>{s.reason || "—"}</span> },
        ]} />}
    </Panel>
  );
}

function LLMBox({ llm }) {
  if (!llm || typeof llm !== "object") return null;
  const risks = arr(llm.risks), cats = arr(llm.catalysts);
  if (!llm.narrative && !risks.length && !cats.length) return null;
  return (
    <Panel title="◆ LLM analyst" pad={12} style={{ borderColor: "#2e2250", background: "linear-gradient(180deg,#110d1d,#0c1016)" }}
      right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{[llm.model, llm.ts && ago(llm.ts)].filter(Boolean).join(" · ")}{num(llm.score) != null ? ` · view ${snum(llm.score)}` : ""}</span>}>
      {llm.narrative && <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.55, color: C.text, whiteSpace: "pre-wrap" }}>{String(llm.narrative)}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {cats.length > 0 && <div><div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: C.up, marginBottom: 4 }}>CATALYSTS</div>{cats.map((c, i) => <div key={i} style={{ fontSize: 11, color: C.sub, lineHeight: 1.45, paddingLeft: 12, position: "relative" }}><span style={{ position: "absolute", left: 0, color: C.up }}>+</span>{typeof c === "string" ? c : JSON.stringify(c)}</div>)}</div>}
        {risks.length > 0 && <div><div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: C.down, marginBottom: 4 }}>RISKS</div>{risks.map((c, i) => <div key={i} style={{ fontSize: 11, color: C.sub, lineHeight: 1.45, paddingLeft: 12, position: "relative" }}><span style={{ position: "absolute", left: 0, color: C.down }}>–</span>{typeof c === "string" ? c : JSON.stringify(c)}</div>)}</div>}
      </div>
    </Panel>
  );
}

// v2 model provenance / meta-label / relative rank (all optional).
function MetaChip({ meta }) {
  const m = obj(meta); const p = num(m.pSuccess ?? m.p); const t = num(m.threshold);
  if (p == null && t == null) return null;
  const pass = p != null && (t == null || p >= t);
  const col = p == null ? C.dim : pass ? C.up : C.amber;
  return <span title="meta-labeler: P(this call succeeds net of costs) vs its gating threshold" style={{ display: "inline-block", color: col, border: `1px solid ${col}88`, background: pass ? C.upBg : C.inset, borderRadius: 3, padding: "1px 6px", fontSize: 9, fontWeight: 800, fontFamily: MONO, letterSpacing: 0.5, whiteSpace: "nowrap" }}>
    {pass ? "✓" : "✗"} META-LABEL {pct(p, 0)}{t != null ? ` ${p != null && p >= t ? "≥" : "<"} ${pct(t, 0)}` : ""}
  </span>;
}
const modelTag = (m) => { const o = obj(m); if (!o.kind && o.version == null) return null; const v = o.version == null ? "" : /^v/i.test(String(o.version)) ? ` ${o.version}` : ` v${o.version}`; return `P(up) ← ${o.kind || "model"}${v}`; };
const relSub = (r) => { const o = obj(r); const rank = o.rank; const n = num(o.nPeers ?? o.n ?? o.of); const b = o.benchmark ? String(o.benchmark).split(":").pop() : null;
  return rank == null ? (b ? `vs ${b}` : null) : `#${rank}${n != null ? `/${n}` : ""}${b ? ` vs ${b}` : ""}`; };

export default function DetailPanel({ assetId, seed, provided, live, tick, minConf, onClose, overlay }) {
  const [full, setFull] = useState(provided || null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(!provided);
  const [candles, setCandles] = useState(null);
  const [cErr, setCErr] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setErr(null);
    if (provided) { setFull(provided); setLoading(false); return; }
    let alive = true; setLoading(true); setFull(null);
    api(`/api/decision/${encodeURIComponent(assetId)}`).then(d => { if (alive) { setFull(d?.decision && !d.action ? { ...d.decision, history: d.history ?? d.decision.history } : d); setLoading(false); } },
      e => { if (alive) { setErr(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [assetId, provided, nonce]);

  // Merge live WS decision updates into the detailed view (keep signals/history if the push lacks them).
  const d = useMemo(() => {
    const base = full || seed || null;
    if (!base) return null;
    if (live && live.assetId === base.assetId && live !== base && (!base.ts || !live.ts || live.ts >= base.ts)) {
      const hist = arr(base.history);
      const last = hist[hist.length - 1];
      const history = last && last.ts === live.ts ? hist : [...hist, { ts: live.ts, pUp: live.pUp, confidence: live.confidence, action: live.action, price: live.price }];
      return { ...base, ...live, signals: arr(live.signals).length ? live.signals : base.signals, llm: live.llm ?? base.llm, history };
    }
    return base;
  }, [full, seed, live]);

  const horizon = d?.horizon;
  useEffect(() => {
    if (!assetId) return;
    let alive = true; setCErr(null);
    api(`/api/candles/${encodeURIComponent(assetId)}?tf=${tfFor(horizon)}&limit=200`).then(r => alive && setCandles(arr(r?.candles ?? r)), e => alive && setCErr(e.message));
    return () => { alive = false; };
  }, [assetId, horizon, nonce]);

  // Append the live tick to the last candle so the chart breathes in real time.
  const liveCandles = useMemo(() => {
    const cs = arr(candles); const p = num(tick?.price);
    if (!cs.length || p == null) return cs;
    const last = cs[cs.length - 1];
    return [...cs.slice(0, -1), { ...last, c: p, h: Math.max(num(last.h) ?? p, p), l: Math.min(num(last.l) ?? p, p) }];
  }, [candles, tick]);

  const wrapStyle = overlay
    ? { position: "fixed", inset: 0, zIndex: 50, background: C.bg, overflowY: "auto", padding: 10 }
    : { position: "sticky", top: 70, maxHeight: "calc(100vh - 84px)", overflowY: "auto", paddingRight: 2 };

  if (!d) return (
    <div style={wrapStyle}>
      <Panel title={assetId} right={<Btn small onClick={onClose}>✕ close</Btn>}>
        {loading ? <Loading label={`loading ${assetId}`} /> : err ? <ErrorBox err={err} onRetry={() => setNonce(n => n + 1)} /> : <Empty>no decision</Empty>}
      </Panel>
    </div>
  );

  const r = obj(d.risk);
  const levels = [
    { v: num(d.price), label: "ENTRY", color: C.blue, dash: "2 3" },
    { v: num(r.stop), label: "STOP", color: C.down },
    { v: num(r.target), label: "TGT", color: C.up },
  ];
  const drivers = arr(d.drivers), against = arr(d.against);
  const maxAbs = Math.max(0.01, ...[...drivers, ...against].map(x => Math.abs(num(x.contribution) ?? approxImpact(x))));
  const act = isActionable(d.action);
  const livePx = tick?.price ?? d.price;
  const rl = regimeLabel(d.regime);

  return (
    <div style={wrapStyle} className="de-in">
      {overlay && <div style={{ position: "sticky", top: -10, zIndex: 5, margin: "-10px -10px 10px", padding: "8px 10px", background: "rgba(6,7,13,.95)", backdropFilter: "blur(6px)", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
        <Btn small onClick={onClose}>← BACK</Btn>
        <b style={{ fontFamily: MONO, fontSize: 13 }}>{d.symbol || assetId}</b><Chip action={d.action} size="sm" />
        <span style={{ flex: 1 }} /><span style={{ fontFamily: MONO, fontSize: 12 }}>{fprice(tick?.price ?? d.price)}</span>
      </div>}
      <div style={{ display: "grid", gap: 10 }}>
        {/* Title block */}
        <Panel pad={12} style={{ borderColor: act ? actionMeta(d.action).bd + "66" : C.border }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: "1 1 200px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, letterSpacing: 1 }}>{d.symbol || assetId}</span>
                <span key={tick?.seq ?? 0} className={tick?.dir > 0 ? "de-flash-up" : tick?.dir < 0 ? "de-flash-dn" : undefined} style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, padding: "0 4px", borderRadius: 3 }}>{fprice(livePx)}</span>
                <Chip action={d.action} size="lg" />
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                <Tag>{d.assetId || assetId}</Tag><Tag>{d.assetClass || "—"}</Tag><Tag>{d.horizon || "—"} · {d.horizonLabel || "—"}</Tag>
                {rl && <Tag color={C.blue}>regime {rl}</Tag>}
                {d.regime?.hmmState != null && <Tag>HMM {String(d.regime.hmmState)}</Tag>}
                {modelTag(d.model) && <Tag color={d.model.kind === "stacker" ? C.violet : C.sub} title={`which model produced P(up)${num(d.model.pooledPUp) != null ? ` · v1 pooled would say ${pct(d.model.pooledPUp, 1)}` : ""}`}>{modelTag(d.model)}</Tag>}
                {d.meta && typeof d.meta === "object" && <MetaChip meta={d.meta} />}
                <Tag color={C.dim}>{dt(d.ts)} · {ago(d.ts)}</Tag>
              </div>
            </div>
            <Gauge p={d.pUp} size={96} />
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Btn small onClick={() => { setNonce(n => n + 1); }} title="refresh">↻</Btn>
              <Btn small onClick={onClose}>✕</Btn>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", gap: 6, marginTop: 10 }}>
            <Stat label="P(up)" value={pct(d.pUp, 1)} color={(num(d.pUp) ?? 0.5) >= 0.5 ? C.up : C.down} sub={`raw ${pct(d.pRaw, 1)}`} />
            <div style={{ background: C.inset, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 9px" }}>
              <div style={{ fontSize: 8.5, color: C.dim, letterSpacing: 1.2, fontFamily: MONO }}>CONFIDENCE</div>
              <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, margin: "2px 0 5px" }}>{pct(d.confidence, 0)}</div>
              <MeterBar v={d.confidence} threshold={minConf} h={5} />
            </div>
            <Stat label="agreement" value={pct(d.agreement, 0)} />
            <Stat label="coverage" value={pct(d.coverage, 0)} />
            <Stat label="edge" value={pct(d.edge, 1)} />
            <Stat label="E[return]" value={spct(d.expectedReturn, 2)} color={colorSign(d.expectedReturn)} sub="fee-aware" />
            {d.relative && typeof d.relative === "object" && <Stat label="P(outperform)" value={pct(d.relative.pOutperform, 1)} color={num(d.relative.pOutperform) == null ? C.text : d.relative.pOutperform >= 0.5 ? C.up : C.down} sub={relSub(d.relative)} title="cross-sectional: P(excess return vs benchmark > 0)" />}
          </div>
          {!act && d.abstainReason && <div style={{ marginTop: 10, padding: "6px 10px", border: `1px dashed ${C.borderHi}`, borderRadius: 6, fontFamily: MONO, fontSize: 10.5, color: C.sub }}>ABSTAIN → {d.abstainReason}</div>}
          {d.summary && <p style={{ margin: "10px 0 0", fontSize: 12, lineHeight: 1.55, color: C.text }}>{d.summary}</p>}
          <div style={{ marginTop: 10 }}><FamilyStrip families={d.families} height={26} /></div>
        </Panel>

        <Panel title={`Price · ${tfFor(d.horizon) === 900 ? "15m" : "1d"} bars`} pad={10} right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}><span style={{ color: C.blue }}>━</span> EMA20 <span style={{ color: C.violet }}>━</span> EMA50 <span style={{ color: C.down }}>┅</span> stop <span style={{ color: C.up }}>┅</span> target</span>}>
          {cErr ? <ErrorBox err={cErr} onRetry={() => setNonce(n => n + 1)} /> : candles == null ? <Loading label="candles" /> : <CandleChart candles={liveCandles} levels={levels} height={overlay ? 260 : 300} />}
        </Panel>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 10 }}>
          <RiskBox d={d} />
          <Panel title="P(up) / confidence history" pad={10}>
            {arr(d.history).length > 1 ? <HistorySpark history={d.history} minConf={minConf} /> : <Empty>{arr(d.history).length ? "one observation so far" : "no history yet"}</Empty>}
          </Panel>
        </div>

        <LLMBox llm={d.llm} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 10 }}>
          <DriverList title={`Drivers for ${d.action && d.action !== "HOLD" ? d.action.replace("_", " ") : "the call"}`} items={drivers} color={isBearish(d.action) ? C.down : C.up} maxAbs={maxAbs} />
          <DriverList title="Against" items={against} color={C.amber} maxAbs={maxAbs} />
        </div>

        <Panel title="Family breakdown" pad={10}><FamilyTable families={d.families} /></Panel>

        <SignalTable d={d} />
      </div>
    </div>
  );
}
