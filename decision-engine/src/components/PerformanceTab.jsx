import React, { useState } from "react";
import { C, MONO, Panel, Stat, Loading, ErrorBox, Table, Tag, Empty, Btn, inputStyle, Chip, ACTIONS, api, useLoad, num, pct, fx, arr, obj, pick, divColor } from "./ui.jsx";
import { ReliabilityDiagram, normBins } from "./charts.jsx";

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
