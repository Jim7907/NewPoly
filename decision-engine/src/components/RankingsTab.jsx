import React, { useEffect, useMemo, useState } from "react";
import { C, MONO, Panel, Stat, Tag, Btn, Chip, ACTIONS, Loading, ErrorBox, Empty, num, pct, spct, ago, arr, obj, pick, clamp, divColor, colorSign } from "./ui.jsx";
import { useMeasure } from "./charts.jsx";
import { useSoft, Segmented, HORIZONS } from "./LabTab.jsx";

const CLASSES = [["stock", "STOCKS"], ["crypto", "CRYPTO"]];
const BENCH = { stock: "SPY", crypto: "BTC" };
const normAction = (a) => (a == null || a === "" ? null : String(a).toUpperCase().replace(/[\s-]+/g, "_"));

export function normRankings(data, cls) {
  const list = arr(data?.rankings ?? data?.ranking ?? data?.rows ?? data);
  let rows = list.filter(r => r && typeof r === "object").map(r => {
    const id = r.assetId ?? (r.symbol ? `${(r.assetClass || cls) === "crypto" ? "CRYPTO" : "STOCK"}:${r.symbol}` : null);
    const ac = r.assetClass ?? (/^CRYPTO:/i.test(String(id)) ? "crypto" : /^STOCK:/i.test(String(id)) ? "stock" : null);
    return {
      ...r, assetId: id, symbol: r.symbol ?? (id ? String(id).split(":").pop() : "?"), assetClass: ac,
      _p: num(r.pOutperform ?? r.pOut ?? r.p), _e: num(r.expExRet ?? r.expectedExcessReturn ?? r.expExcess), _rank: num(r.rank), _a: normAction(r.action),
    };
  });
  if (rows.some(r => r.assetClass)) rows = rows.filter(r => !r.assetClass || r.assetClass === cls);
  rows.sort((a, b) => (a._rank ?? Infinity) - (b._rank ?? Infinity) || (b._p ?? -1) - (a._p ?? -1));
  if (rows.every(r => r._rank == null)) rows.forEach((r, i) => { r._rank = i + 1; });
  return rows;
}

// Diverging bar around 50% (benchmark parity); `dom` = half-width of the visible domain.
function OutBar({ p, dom, h = 8 }) {
  const n = num(p);
  const X = (v) => clamp(((v - (0.5 - dom)) / (2 * dom)) * 100, 0, 100);
  return (
    <div style={{ height: h, position: "relative", background: C.inset, border: `1px solid ${C.border}`, borderRadius: 2 }} title={n == null ? "no estimate" : `P(outperform) ${pct(n, 1)}`}>
      {n != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: Math.min(X(0.5), X(n)) + "%", width: Math.max(0.5, Math.abs(X(n) - X(0.5))) + "%", background: divColor((n - 0.5) / dom), borderRadius: 1, transition: "width .4s ease, left .4s ease" }} />}
      <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: C.sub }} />
    </div>
  );
}

function ActionCell({ a, live }) {
  if (a && ACTIONS[a]) return <Chip action={a} size="sm" />;
  if (a) return <Tag color={/LONG|BUY|OVER/.test(a) ? C.up : /SHORT|SELL|UNDER/.test(a) ? C.down : C.sub}>{a.replace(/_/g, " ")}</Tag>;
  if (live && ACTIONS[live]) return <span title="live decision action (the ranking row has none)" style={{ opacity: 0.6 }}><Chip action={live} size="sm" /></span>;
  return <span style={{ color: C.dim, fontFamily: MONO, fontSize: 10 }}>—</span>;
}

export default function RankingsTab({ defaultHorizon, decisions, onSelect, onOpenLab }) {
  const [cls, setCls] = useState(() => { try { return localStorage.getItem("de.rank.cls") || "stock"; } catch { return "stock"; } });
  useEffect(() => { try { localStorage.setItem("de.rank.cls", cls); } catch {} }, [cls]);
  const [horizon, setHorizon] = useState(defaultHorizon || "swing");
  useEffect(() => { if (defaultHorizon) setHorizon(defaultHorizon); }, [defaultHorizon]);
  const [ref, W] = useMeasure();
  const narrow = W > 0 && W < 620;

  const { data, err, loading, reload } = useSoft(`/api/rankings?class=${encodeURIComponent(cls)}&horizon=${encodeURIComponent(horizon)}`, { interval: 60000 });
  const rows = useMemo(() => normRankings(data, cls), [data, cls]);
  const decMap = useMemo(() => { const m = {}; for (const d of arr(decisions)) if (d?.assetId) m[d.assetId] = d; return m; }, [decisions]);
  const dom = useMemo(() => Math.max(0.08, ...rows.map(r => (r._p == null ? 0 : Math.abs(r._p - 0.5)))) * 1.1, [rows]);
  const d = obj(data);
  const bench = d.benchmark ? String(d.benchmark).split(":").pop() : BENCH[cls];
  const nUp = rows.filter(r => r._p != null && r._p > 0.5).length;
  const third = Math.max(1, Math.floor(rows.length / 3));
  const withE = rows.filter(r => r._e != null);
  const mean = (a) => (a.length ? a.reduce((s, r) => s + r._e, 0) / a.length : null);
  const spread = withE.length >= 3 ? mean(withE.slice(0, third)) - mean(withE.slice(-third)) : null;
  const model = obj(d.model);
  const updated = pick(d, "ts", "built", "updatedAt", "asOf");

  const grid = narrow ? "30px minmax(0, 1fr) auto" : "46px minmax(96px, 170px) minmax(120px, 1fr) 62px 84px 112px";
  let crossed = false;

  return (
    <div ref={ref} style={{ display: "grid", gap: 10 }}>
      <Panel pad={12}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 240px", minWidth: 0 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, color: C.sub, fontWeight: 700 }}>CROSS-SECTIONAL RANKING · vs {bench}</div>
            <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.45, marginTop: 4 }}>
              Ranked by P(outperform {bench}) over the {horizon} horizon, from the champion <b style={{ color: C.text }}>yEx</b> stacker. The expected excess return is relative to the benchmark, not absolute.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Segmented value={cls} onChange={setCls} options={CLASSES} small={narrow} />
            <Segmented value={horizon} onChange={setHorizon} options={narrow ? HORIZONS.map(([k]) => [k, k.slice(0, 5).toUpperCase()]) : HORIZONS} small={narrow} />
            <Btn small onClick={reload} title="refresh">↻</Btn>
          </div>
        </div>
        {rows.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))", gap: 6, marginTop: 10 }}>
          <Stat label="ranked" value={rows.length} sub={cls} />
          <Stat label={`beat ${bench}`} value={`${nUp} / ${rows.length}`} sub="P(outperform) > 50%" color={nUp ? C.up : C.text} />
          <Stat label="top − bottom ⅓" value={spct(spread, 2)} color={colorSign(spread)} sub="E[excess] spread" />
          <Stat label="model" value={model.version != null ? `yEx v${model.version}` : "—"} sub={model.kind || null} />
          <Stat label="updated" value={updated ? ago(updated) : "—"} />
        </div>}
      </Panel>

      {err && <ErrorBox err={err} onRetry={reload} />}
      {data === undefined && loading && <Loading label="rankings" />}
      {data !== undefined && !rows.length && !err && (
        <Panel pad={18} style={{ borderStyle: "dashed", borderColor: C.borderHi }}>
          <div style={{ textAlign: "center", fontFamily: MONO, color: C.sub, fontSize: 12, lineHeight: 1.7 }}>
            <div style={{ fontSize: 22, color: C.faint, marginBottom: 4 }}>≡</div>
            <b style={{ color: C.text }}>No rankings yet: run a cycle.</b><br />
            <span style={{ fontSize: 10.5, color: C.dim }}>Rankings need a champion <b>yEx</b> (excess vs {bench}) stacker for {horizon}. The self-learning lab trains and promotes one.</span>
            {onOpenLab && <div style={{ marginTop: 12 }}><Btn active color={C.violet} onClick={onOpenLab}>OPEN LAB →</Btn></div>}
          </div>
        </Panel>
      )}

      {rows.length > 0 && (
        <Panel title={`${cls === "crypto" ? "Crypto" : "Stocks"} · ${horizon}`} pad={10} right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>bar centred on 50% = matches {bench}</span>}>
          {!narrow && <div style={{ display: "grid", gridTemplateColumns: grid, gap: 10, padding: "0 8px 6px", fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1, textTransform: "uppercase", borderBottom: `1px solid ${C.border}` }}>
            <span>rank</span><span>asset</span><span>P(outperform)</span><span style={{ textAlign: "right" }}>P</span><span style={{ textAlign: "right" }}>E[excess]</span><span style={{ textAlign: "right" }}>action</span>
          </div>}
          <div style={{ display: "grid" }}>
            {rows.map((r, i) => {
              const live = decMap[r.assetId];
              const click = live && onSelect ? () => onSelect(r.assetId) : null;
              const below = r._p != null && r._p <= 0.5;
              const sep = below && !crossed && i > 0;
              if (below) crossed = true;
              return (
                <React.Fragment key={r.assetId || i}>
                  {sep && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1 }}>
                    <div style={{ flex: 1, height: 1, background: C.borderHi }} />BELOW {bench}<div style={{ flex: 1, height: 1, background: C.borderHi }} />
                  </div>}
                  <div className="de-row" onClick={click || undefined} title={click ? "open decision detail" : undefined}
                    style={{ display: "grid", gridTemplateColumns: grid, gap: narrow ? 8 : 10, alignItems: "center", padding: narrow ? "8px 4px" : "7px 8px", borderBottom: `1px solid #121925`, cursor: click ? "pointer" : "default", fontFamily: MONO }}>
                    <span style={{ fontSize: narrow ? 11 : 12, fontWeight: 800, color: r._rank <= 3 ? C.text : C.sub }}>#{r._rank ?? "—"}</span>
                    {narrow ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "baseline" }}>
                          <b style={{ fontSize: 12, color: C.text }}>{r.symbol}</b>
                          <span style={{ fontSize: 10, color: C.text }}>{pct(r._p, 1)} <span style={{ color: colorSign(r._e) }}>{spct(r._e, 2)}</span></span>
                        </div>
                        <div style={{ marginTop: 4 }}><OutBar p={r._p} dom={dom} h={6} /></div>
                      </div>
                    ) : <>
                      <div style={{ minWidth: 0 }}>
                        <b style={{ fontSize: 12, color: C.text }}>{r.symbol}</b>
                        <div style={{ fontSize: 9, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.assetId}{live ? " · live" : ""}</div>
                      </div>
                      <OutBar p={r._p} dom={dom} />
                      <span style={{ fontSize: 11, textAlign: "right", color: C.text, fontWeight: 700 }}>{pct(r._p, 1)}</span>
                      <span style={{ fontSize: 11, textAlign: "right", color: colorSign(r._e) }}>{spct(r._e, 2)}</span>
                    </>}
                    <span style={{ textAlign: "right" }}><ActionCell a={r._a} live={live?.action} /></span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
            P(outperform) = calibrated P(excess return vs {bench} &gt; 0) over the horizon. E[excess] is the model's expected return net of the benchmark. Rows that are live on the board open their decision.
          </div>
        </Panel>
      )}
    </div>
  );
}
