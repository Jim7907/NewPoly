import React, { useState } from "react";
import { C, MONO, Panel, Stat, Loading, ErrorBox, Table, Tag, Empty, Btn, inputStyle, Chip, ACTIONS, api, useLoad, num, pct, fx, arr, obj, pick, divColor, ago } from "./ui.jsx";
import { ReliabilityDiagram, normBins } from "./charts.jsx";
import { RateBar } from "./DecisionBoard.jsx";

// Accept { key: {...} } or [{ id|key|name, ... }] → [{ _k, ...stats }]
export const entries = (x, keyNames = ["id", "key", "name", "action", "family"]) => Array.isArray(x)
  ? x.filter(Boolean).map((r, i) => ({ ...obj(r), _k: String(pick(r, ...keyNames) ?? i) }))
  : Object.entries(obj(x)).map(([k, v]) => (v && typeof v === "object" ? { ...v, _k: k } : { value: v, _k: k }));

const isRate = (k) => /rate|hit|acc|pct|share|brier|ece|ret|frac|win/i.test(k);
const fmtStat = (k, v) => { const n = num(v); if (n == null) return v == null ? "—" : String(v); if (/^n$|count|trades|^num/i.test(k)) return n.toFixed(0); if (/brier|ece|logloss/i.test(k)) return n.toFixed(3); if (isRate(k) && Math.abs(n) <= 1.5) return (n * 100).toFixed(1) + "%"; return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(3); };

export function StatsTable({ data, keyLabel, renderKey }) {
  const rows = entries(data);
  if (!rows.length) return <Empty>no resolved outcomes yet</Empty>;
  const keys = [...new Set(rows.flatMap(r => Object.keys(r).filter(k => k !== "_k" && (num(r[k]) != null || typeof r[k] === "string"))))].slice(0, 8);
  return <Table dense rows={rows} rowKey={r => r._k} initialSort={keys.includes("n") ? { key: "n", dir: "desc" } : null} cols={[
    { key: "_k", label: keyLabel, sort: r => r._k, render: r => (renderKey ? renderKey(r._k) : <b>{r._k}</b>) },
    ...keys.map(k => ({ key: k, label: k, align: "right", sort: r => num(r[k]) ?? r[k], render: r => {
      const n = num(r[k]); const good = /hit|win|acc/i.test(k) && n != null ? (n >= 0.5 ? C.up : C.down) : /ret|pnl/i.test(k) && n != null ? (n >= 0 ? C.up : C.down) : C.text;
      return <span style={{ color: good }}>{fmtStat(k, r[k])}</span>;
    } })),
  ]} />;
}

function WeightsTable({ weights }) {
  const [q, setQ] = useState("");
  const [fam, setFam] = useState("all");
  const rows = entries(weights).map(r => ({ ...r, _w: num(pick(r, "w", "weight")), _n: num(pick(r, "n", "count")), _h: num(pick(r, "hitRate", "hit", "acc")), _f: String(r.family || r._k.split(".")[0] || "") }));
  const fams = [...new Set(rows.map(r => r._f))].sort();
  const shown = rows.filter(r => (fam === "all" || r._f === fam) && (!q || r._k.toLowerCase().includes(q.toLowerCase())));
  const maxDev = Math.max(0.05, ...rows.map(r => Math.abs(Math.log(r._w || 1))));
  return (
    <Panel title={`Learned signal weights · ${rows.length}`} pad={10} right={<input value={q} onChange={e => setQ(e.target.value)} placeholder="search id" style={{ ...inputStyle, width: 140 }} />}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <Btn small active={fam === "all"} onClick={() => setFam("all")}>all</Btn>
        {fams.map(f => <Btn small key={f} active={fam === f} onClick={() => setFam(f)}>{f}</Btn>)}
      </div>
      <Table dense maxHeight={480} rows={shown} rowKey={r => r._k} empty="no learned weights yet (all start at 1.0)" initialSort={{ key: "w", dir: "desc" }} cols={[
        { key: "id", label: "signal id", sort: r => r._k, render: r => <span title={r._k}>{r._k}</span>, maxWidth: 260 },
        { key: "w", label: "weight (log-scale, 1.0 = neutral)", sort: r => r._w, render: r => {
          const lg = Math.log(r._w || 1) / maxDev;
          return <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 150 }}>
            <div style={{ flex: 1, height: 6, background: C.inset, position: "relative", borderRadius: 2 }}>
              <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: C.faint }} />
              <div style={{ position: "absolute", top: 0, bottom: 0, [lg >= 0 ? "left" : "right"]: "50%", width: Math.min(50, Math.abs(lg) * 50) + "%", background: divColor(lg), borderRadius: 2 }} />
            </div>
            <b style={{ width: 38, textAlign: "right", color: (r._w ?? 1) >= 1 ? C.up : C.down }}>{fx(r._w, 2)}</b>
          </div>;
        } },
        { key: "n", label: "n", align: "right", sort: r => r._n, render: r => r._n ?? "—" },
        { key: "hit", label: "hit rate", align: "right", sort: r => r._h, render: r => <span style={{ color: r._h == null ? C.dim : r._h >= 0.5 ? C.up : C.down }}>{pct(r._h, 1)}</span> },
      ]} />
    </Panel>
  );
}

// ─── Direction accuracy (the always-on UP/DOWN forecast) ──────────────────────
const fr = (x) => { const n = num(x); return n == null ? null : Math.abs(n) > 1.5 ? n / 100 : n; };
export function wilson(h, n, z = 1.96) {
  if (!(n > 0) || h == null) return null;
  const p = h / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}
// `div` > 1 = overlapping labels (horizon > 1 bar): the CI uses n_eff = n / div.
const rateOf = (o, div = 1) => {
  const x = obj(o); const n = num(x.n); const hits = num(x.hits);
  const hitRate = fr(x.hitRate ?? x.hit) ?? (n && hits != null ? hits / n : null);
  const h = hits ?? (hitRate != null && n ? hitRate * n : null);
  const ci = Array.isArray(x.ci95) && x.ci95.length === 2 && num(x.ci95[0]) != null && num(x.ci95[1]) != null ? x.ci95.map(fr)
    : n && h != null ? wilson(h / div, n / div) : null;
  return { n, hits, hitRate, ci, baseRate: fr(x.baseRate), lift: fr(x.lift) };
};
const bucketLo = (k) => { const m = /(\d+(?:\.\d+)?)/.exec(String(k)); return m ? Number(m[1]) : Infinity; };
const ORDER_STRENGTH = ["strong", "moderate", "weak"];
const ppFmt = (x) => { const n = num(x); return n == null ? "—" : (n > 0 ? "+" : "") + (n * 100).toFixed(1) + "pp"; };
// n-weighted base rate across historical cells (the historical mix of UP/DOWN calls), used as the reference
// for live buckets that mix directions. cells: [{ n, baseRate }]
const wBase = (cells) => { let n = 0, s = 0; for (const c of cells) { const cn = num(c?.n), b = fr(c?.baseRate); if (cn && b != null) { n += cn; s += cn * b; } } return n ? s / n : null; };

function histCells(hist, pick) {
  const out = [];
  const t = obj(hist?.table);
  for (const cls of Object.keys(t)) for (const dir of Object.keys(obj(t[cls]))) { const c = pick(obj(t[cls][dir]), cls, dir); if (c) out.push(c); }
  return out;
}
function histStrengthCells(hist, st) {
  const out = []; const t = obj(hist?.byStrength);
  for (const cls of Object.keys(t)) for (const dir of Object.keys(obj(t[cls]))) { const c = obj(t[cls][dir])[st]; if (c) out.push(c); }
  return out;
}

function RateRows({ rows, dom, empty = "no data" }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div style={{ display: "grid", gap: 7 }}>
      {rows.map(r => (
        <div key={r.key} style={{ display: "grid", gridTemplateColumns: "62px minmax(50px, 1fr) 46px 74px 38px", gap: 8, alignItems: "center", fontFamily: MONO, fontSize: 10.5 }}>
          <span style={{ color: r.color || C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
          <RateBar v={r.hitRate} base={r.base} ci={r.ci} dom={dom} title={`${r.label}: hit ${pct(r.hitRate, 1)}${r.ci ? ` (95% CI ${pct(r.ci[0], 1)}–${pct(r.ci[1], 1)})` : ""} · n=${r.n ?? 0}${r.base != null ? ` · base ${pct(r.base, 1)}${r.baseSrc ? ` (${r.baseSrc})` : ""}` : ""}`} />
          <b style={{ textAlign: "right", color: r.hitRate == null ? C.dim : C.text }}>{pct(r.hitRate, 1)}</b>
          <span style={{ textAlign: "right", color: C.dim, fontSize: 9 }}>{r.ci ? `${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}%` : "—"}</span>
          <span style={{ textAlign: "right", color: C.sub, fontSize: 9.5 }}>{r.n ?? 0}</span>
        </div>
      ))}
    </div>
  );
}
const domOf = (rows) => Math.min(0.5, Math.max(0.1, ...rows.flatMap(r => [r.hitRate, r.base, ...(r.ci || [])].filter(v => num(v) != null).map(v => Math.abs(v - 0.5)))) * 1.12);
const RowsHead = () => (
  <div style={{ display: "grid", gridTemplateColumns: "62px minmax(50px, 1fr) 46px 74px 38px", gap: 8, fontFamily: MONO, fontSize: 8.5, color: C.dim, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
    <span /><span>hit rate vs 50%</span><span style={{ textAlign: "right" }}>hit</span><span style={{ textAlign: "right" }}>95% CI</span><span style={{ textAlign: "right" }}>n</span>
  </div>
);
const Legend = ({ ci = true, base = true, baseLabel = "base rate" }) => (
  <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
    <span><span style={{ color: C.sub }}>│</span> 50% coin flip</span>
    {base && <span><span style={{ color: C.warn }}>┃</span> {baseLabel}</span>}
    {ci && <span><span style={{ color: C.text }}>─</span> 95% CI</span>}
    <span><span style={{ color: C.up }}>■</span> ≥ base <span style={{ color: C.amber }}>■</span> &lt; base, ≥ 50% <span style={{ color: C.down }}>■</span> &lt; base and &lt; 50%</span>
  </div>
);

function HistCell({ c, div, dom }) {
  const r = rateOf(c, div);
  if (!r.n) return <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.faint }}>—</div>;
  const thin = r.n < 30;
  const lift = r.lift ?? (r.hitRate != null && r.baseRate != null ? r.hitRate - r.baseRate : null);
  return (
    <div style={{ minWidth: 0, opacity: thin ? 0.5 : 1 }} title={`hit ${pct(r.hitRate, 1)} vs base ${pct(r.baseRate, 1)} · lift ${ppFmt(lift)} · n=${r.n}${r.ci ? ` · 95% CI ${pct(r.ci[0], 1)}–${pct(r.ci[1], 1)} (n_eff)` : ""}${thin ? " · n < 30: not used for live track records" : ""}`}>
      <RateBar v={r.hitRate} base={r.baseRate} ci={r.ci} dom={dom} h={6} />
      <div style={{ display: "flex", gap: 6, fontFamily: MONO, fontSize: 9.5, marginTop: 3, flexWrap: "wrap", alignItems: "baseline" }}>
        <b style={{ color: C.text }}>{pct(r.hitRate, 1)}</b>
        <span style={{ color: C.dim }}>vs {pct(r.baseRate, 1)}</span>
        <span style={{ color: lift == null ? C.dim : lift > 0 ? C.up : C.amber }}>{ppFmt(lift)}</span>
        <span style={{ color: C.dim, marginLeft: "auto" }}>n {r.n >= 1e4 ? (r.n / 1000).toFixed(1) + "k" : r.n.toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}

function HistoricalTable({ hist }) {
  const h = obj(hist);
  const table = obj(h.table);
  const classes = Object.keys(table).sort((a, b) => ["stock", "crypto"].indexOf(a) - ["stock", "crypto"].indexOf(b));
  if (!classes.length) return <Empty>historical table is empty</Empty>;
  const bk = arr(h.buckets).length ? arr(h.buckets).map(String)
    : [...new Set(classes.flatMap(c => Object.values(obj(table[c])).flatMap(t => Object.keys(obj(t)))))].filter(k => k !== "all").sort((a, b) => bucketLo(a) - bucketLo(b));
  const dirs = ["UP", "DOWN"];
  const baseRates = obj(h.baseRates);
  const div = Math.max(1, num(h.ahead) ?? 1);
  // One scale for every cell so bars are comparable across classes, directions and buckets.
  const dom = domOf(classes.flatMap(cls => Object.values(obj(table[cls])).flatMap(t => Object.values(obj(t))))
    .map(c => rateOf(c, div)).filter(r => r.n >= 30).map(r => ({ hitRate: r.hitRate, base: r.baseRate, ci: r.ci })));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 10 }}>
      {classes.map(cls => {
        const t = obj(table[cls]);
        const hasAll = dirs.some(d => obj(t[d]).all);
        const keys = [...(hasAll ? ["all"] : []), ...bk];
        return (
          <div key={cls} style={{ background: C.inset, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <b style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.5, color: C.text }}>{cls.toUpperCase()}</b>
              {num(baseRates[cls]) != null && <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>P(up) base {pct(baseRates[cls], 1)}</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "54px minmax(0, 1fr) minmax(0, 1fr)", columnGap: 12, rowGap: 8, alignItems: "center" }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.dim, letterSpacing: 1 }}>ALIGNED</span>
              {dirs.map(d => <span key={d} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 800, color: d === "UP" ? C.up : C.down }}>{d === "UP" ? "▲ UP" : "▼ DOWN"} calls</span>)}
              {keys.map(k => (
                <React.Fragment key={k}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: k === "all" ? C.text : C.sub, fontWeight: k === "all" ? 800 : 400 }}>{k === "all" ? "ALL" : k}</span>
                  {dirs.map(d => <HistCell key={d} c={obj(t[d])[k]} div={div} dom={dom} />)}
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DirectionSection({ dir, horizon }) {
  const D = dir && typeof dir === "object" ? dir : null;
  const live = obj(D?.live);
  const hist = D?.historical && typeof D.historical === "object" ? D.historical : null;
  const L = rateOf(live);
  const hasLive = (L.n ?? 0) > 0;
  const histAllBase = hist ? wBase(histCells(hist, t => t.all)) : null;
  const histAll = (() => { if (!hist) return null; let n = 0, h = 0; for (const c of histCells(hist, t => t.all)) { const cn = num(c.n), ch = num(c.hits); if (cn && ch != null) { n += cn; h += ch; } } return n ? { n, hits: h } : null; })();
  const baseSrc = "historical mix";

  const strengthRows = entries(live.byStrength, ["strength", "key", "id", "name"])
    .sort((a, b) => (ORDER_STRENGTH.indexOf(a._k) + 1 || 9) - (ORDER_STRENGTH.indexOf(b._k) + 1 || 9))
    .map(o => { const r = rateOf(o); const hb = hist ? wBase(histStrengthCells(hist, o._k)) : null; return { key: o._k, label: o._k, ...r, base: r.baseRate ?? fr(live.baseRate) ?? hb ?? histAllBase, baseSrc: r.baseRate != null ? null : baseSrc }; })
    .filter(r => r.n);
  const alignRows = entries(live.byAlignment, ["bucket", "key", "id", "name"])
    .sort((a, b) => bucketLo(a._k) - bucketLo(b._k))
    .map(o => { const r = rateOf(o); const hb = hist ? wBase(histCells(hist, t => t[o._k])) : null; return { key: o._k, label: o._k, ...r, base: r.baseRate ?? fr(live.baseRate) ?? hb ?? histAllBase, baseSrc: r.baseRate != null ? null : baseSrc }; })
    .filter(r => r.n);
  const classRows = entries(live.byClass, ["assetClass", "class", "key", "id", "name"])
    .map(o => { const r = rateOf(o); const hb = hist ? wBase(histCells(hist, (t, cls) => (cls === o._k ? t.all : null))) : null; return { key: o._k, label: o._k, ...r, base: r.baseRate ?? hb, baseSrc: r.baseRate != null ? null : baseSrc }; })
    .filter(r => r.n);
  const liveBase = L.baseRate ?? fr(live.baseRate) ?? histAllBase;
  const liveLift = L.hitRate != null && liveBase != null ? L.hitRate - liveBase : null;
  const anyBase = [...strengthRows, ...alignRows, ...classRows].some(r => r.base != null);
  const waitMsg = <>no resolved direction calls yet — first live outcomes resolve after the <b style={{ color: C.text }}>{horizon || "forecast"}</b> horizon</>;

  return (
    <Panel title="Direction accuracy" pad={10}
      right={<span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {hasLive ? <Tag color={C.blue}>live · n={L.n}</Tag> : <Tag color={C.dim}>live · awaiting outcomes</Tag>}
        {hist ? <Tag color={C.violet}>historical · {num(hist.rows) != null ? Number(hist.rows).toLocaleString("en-US") + " rows" : "ready"}</Tag> : <Tag color={C.dim}>historical · not built</Tag>}
      </span>}>
      <div style={{ fontSize: 10.5, color: C.sub, lineHeight: 1.5, marginBottom: 10 }}>
        The forecast is always <b style={{ color: C.up }}>▲ UP</b> or <b style={{ color: C.down }}>▼ DOWN</b> (the signals' consensus), independent of the gated trade action. A hit = the price moved that way over the horizon. The fair yardstick is the <b style={{ color: C.warn }}>base rate</b> (how often that direction happens anyway), not 50%.
      </div>
      {!D ? <Empty>direction tracking not reported by the engine yet — first live outcomes resolve after the {horizon || "forecast"} horizon</Empty> : <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 6 }}>
          <Stat label="live hit rate" value={pct(L.hitRate, 1)} color={L.hitRate == null ? C.text : liveBase != null ? (L.hitRate > liveBase ? C.up : L.hitRate >= 0.5 ? C.amber : C.down) : L.hitRate >= 0.5 ? C.up : C.down}
            sub={L.ci ? `95% CI ${pct(L.ci[0], 1)}–${pct(L.ci[1], 1)}` : hasLive ? "CI n/a" : "awaiting outcomes"} title="Wilson score interval" />
          <Stat label="resolved calls" value={L.n ?? 0} sub={L.hits != null ? `${L.hits} hits` : null} />
          <Stat label="vs base rate" value={ppFmt(liveLift)} color={liveLift == null ? C.text : liveLift > 0 ? C.up : C.amber} sub={liveBase != null ? `base ${pct(liveBase, 1)}${L.baseRate == null ? " (hist. mix)" : ""}` : "no base rate yet"} />
          <Stat label="vs coin flip" value={ppFmt(L.hitRate != null ? L.hitRate - 0.5 : null)} color={L.hitRate == null ? C.text : L.hitRate > 0.5 ? C.up : C.down} />
          {histAll && <Stat label="historical hit rate" value={pct(histAll.hits / histAll.n, 1)} sub={histAllBase != null ? `base ${pct(histAllBase, 1)} · n ${histAll.n.toLocaleString("en-US")}` : `n ${histAll.n.toLocaleString("en-US")}`} color={C.violet} title="all historical out-of-sample calls, both classes and directions" />}
        </div>

        {!hasLive
          ? <div style={{ marginTop: 10 }}><Empty>{waitMsg}</Empty></div>
          : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12, marginTop: 12 }}>
            {[["By strength", strengthRows], ["By alignment", alignRows], ["By class", classRows]].map(([t, rows]) => (
              <div key={t} style={{ minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: C.sub, fontWeight: 700, marginBottom: 6 }}>{t.toUpperCase()}</div>
                <RowsHead />
                <RateRows rows={rows} dom={domOf([...strengthRows, ...alignRows, ...classRows])} empty="no resolved calls in any bucket yet" />
              </div>
            ))}
          </div>}
        {hasLive && <Legend base={anyBase} baseLabel={anyBase && !alignRows.some(r => r.baseRate != null) ? "base rate (historical UP/DOWN mix)" : "base rate"} />}

        <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, color: C.sub, fontWeight: 700 }}>HISTORICAL OUT-OF-SAMPLE · CLASS × DIRECTION × ALIGNMENT</span>
            {hist && <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{[hist.horizon && `horizon ${hist.horizon}`, num(hist.rows) != null && `${Number(hist.rows).toLocaleString("en-US")} rows`, num(hist.ahead) != null && `${hist.ahead}-bar labels`, hist.built && `built ${ago(hist.built)}`].filter(Boolean).join(" · ")}</span>}
          </div>
          {!hist ? <Empty>historical track record not built yet — it is computed from the point-in-time research panel shortly after the engine starts</Empty> : <>
            <HistoricalTable hist={hist} />
            <Legend base baseLabel="base rate (how often that direction happens in the class)" />
            <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
              {hist.basis && <div>basis: {String(hist.basis)}</div>}
              <div>Faded cells have n &lt; 30 and are not used for live track records.{num(hist.ahead) > 1 ? ` Labels overlap (${hist.ahead}-bar horizon), so n overstates independent outcomes ≈ ${hist.ahead}×; CIs use n/${hist.ahead}.` : ""}</div>
            </div>
          </>}
        </div>
      </>}
    </Panel>
  );
}

export default function PerformanceTab({ refreshKey }) {
  const { data, err, loading, reload } = useLoad(() => api("/api/performance"), [refreshKey], { interval: 60000 });
  if (loading && !data) return <Loading label="performance" />;
  if (err && !data) return <ErrorBox err={err} onRetry={reload} />;
  const d = obj(data);
  const cal = obj(d.calibration);
  const bins = normBins(cal.bins);
  const reliable = cal.reliable;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {err && <ErrorBox err={"refresh failed: " + err} onRetry={reload} />}
      <DirectionSection dir={d.direction} horizon={d.horizon} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 10 }}>
        <Panel title="Reliability diagram" pad={10} right={reliable === false ? <Tag color={C.warn}>n &lt; 30 · not yet reliable</Tag> : reliable ? <Tag color={C.up}>calibrator active</Tag> : null}>
          <ReliabilityDiagram bins={bins} size={320} />
        </Panel>
        <Panel title="Probability quality" pad={10}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
            <Stat label="resolved n" value={cal.n ?? "—"} />
            <Stat label="Brier" value={fx(cal.brier, 4)} sub="0.25 = coin flip · lower better" color={num(cal.brier) != null ? (cal.brier < 0.25 ? C.up : C.down) : C.text} />
            <Stat label="ECE" value={fx(cal.ece, 4)} sub="expected calibration error" color={num(cal.ece) != null ? (cal.ece < 0.05 ? C.up : cal.ece < 0.1 ? C.warn : C.down) : C.text} />
            <Stat label="log loss" value={fx(cal.logloss, 4)} sub="0.693 = coin flip" color={num(cal.logloss) != null ? (cal.logloss < 0.693 ? C.up : C.down) : C.text} />
            {cal.method && <Stat label="method" value={String(cal.method)} />}
            {num(cal.auc) != null && <Stat label="AUC" value={fx(cal.auc, 3)} />}
          </div>
          <div style={{ fontSize: 10.5, color: C.sub, lineHeight: 1.5, marginTop: 10 }}>
            When the engine says 70%, it should be right ~70% of the time. Points on the dashed diagonal are perfectly calibrated; below it = over-confident, above = under-confident.
          </div>
          {bins.length > 0 && <div style={{ marginTop: 10 }}><Table dense rows={bins} rowKey={(b, i) => i} cols={[
            { key: "p", label: "pred", align: "right", render: b => pct(b.p, 1) },
            { key: "y", label: "realized", align: "right", render: b => pct(b.y, 1) },
            { key: "gap", label: "gap", align: "right", render: b => <span style={{ color: b.y == null ? C.dim : Math.abs(b.y - b.p) > 0.1 ? C.down : C.sub }}>{b.y == null ? "—" : ((b.y - b.p) * 100).toFixed(1) + "pp"}</span> },
            { key: "n", label: "n", align: "right", render: b => b.n },
          ]} /></div>}
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 10 }}>
        <Panel title="By action" pad={10}><StatsTable data={d.byAction} keyLabel="action" renderKey={k => (ACTIONS[k] ? <Chip action={k} size="sm" /> : <b>{k}</b>)} /></Panel>
        <Panel title="By family" pad={10}><StatsTable data={d.byFamily} keyLabel="family" /></Panel>
      </div>

      <WeightsTable weights={d.weights} />
      <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>Weights: Hedge multiplicative updates on resolved outcomes, clamped to [0.5, 2], slow decay toward 1.</div>
    </div>
  );
}
