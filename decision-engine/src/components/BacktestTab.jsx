import React, { useEffect, useMemo, useState } from "react";
import { C, MONO, Panel, Stat, Loading, ErrorBox, Table, Tag, Empty, Btn, inputStyle, Chip, ACTIONS, api, num, pct, spct, fx, fprice, dt, arr, obj, pick, colorSign, toMs } from "./ui.jsx";
import { LineChart, ReliabilityDiagram, calibStats, normBins } from "./charts.jsx";
import { normCurve, normTrade } from "./PortfolioTab.jsx";

const tfFor = (h) => (h === "intraday" ? 900 : 86400);

// Buy-and-hold curve: prefer server-provided, else derive from candles scaled to strategy's first equity value.
function useBuyHold(res, assetId, horizon) {
  const [bh, setBh] = useState(null);
  useEffect(() => {
    setBh(null);
    if (!res) return;
    const given = normCurve(pick(res, "buyHold", "buyAndHold", "benchmark", "bhEquity") ?? pick(obj(res.metrics), "buyHoldCurve"));
    if (given.length) { setBh(given); return; }
    const eq = normCurve(res.equity);
    if (!eq.length) return;
    let alive = true;
    api(`/api/candles/${encodeURIComponent(assetId)}?tf=${tfFor(horizon)}&limit=2000`).then(r => {
      if (!alive) return;
      const cs = arr(r?.candles ?? r).filter(c => num(c?.c) != null);
      const t0 = toMs(eq[0].t), t1 = toMs(eq[eq.length - 1].t);
      const win = cs.filter(c => toMs(c.t) >= t0 && toMs(c.t) <= t1);
      if (win.length < 2) return;
      const base = num(win[0].c), v0 = num(eq[0].v);
      setBh(win.map(c => ({ t: c.t, v: (v0 * num(c.c)) / base })));
    }, () => {});
    return () => { alive = false; };
  }, [res, assetId, horizon]);
  return bh;
}

export default function BacktestTab({ decisions, defaultHorizon }) {
  const assets = useMemo(() => arr(decisions).map(d => ({ id: d?.assetId, sym: d?.symbol, cls: d?.assetClass })).filter(a => a.id), [decisions]);
  const [assetId, setAssetId] = useState("");
  const [custom, setCustom] = useState("");
  const [horizon, setHorizon] = useState(defaultHorizon || "swing");
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [running, setRunning] = useState(false);
  const [t0, setT0] = useState(0);
  const [, force] = useState(0);
  useEffect(() => { if (!assetId && assets.length) setAssetId(assets[0].id); }, [assets, assetId]);
  useEffect(() => { if (!running) return; const t = setInterval(() => force(x => x + 1), 250); return () => clearInterval(t); }, [running]);

  const target = custom.trim() ? (custom.includes(":") ? custom.trim().toUpperCase() : `STOCK:${custom.trim().toUpperCase()}`) : assetId;
  const [ran, setRan] = useState({ id: null, horizon: null });
  const run = async () => {
    if (!target) return;
    setRunning(true); setErr(null); setT0(Date.now());
    try {
      const r = await api("/api/backtest", { method: "POST", body: { assetId: target, horizon } });
      setRes(r?.result && !r.metrics ? r.result : r); setRan({ id: target, horizon });
    } catch (e) { setErr(e.message); } finally { setRunning(false); }
  };

  const bh = useBuyHold(res, ran.id, ran.horizon);
  const r = obj(res);
  const m = obj(r.metrics);
  const eq = normCurve(r.equity);
  const trades = arr(r.trades).map(t => ({ ...normTrade(t), _p: num(pick(t, "pUp", "p")), _a: pick(t, "action") }));
  const cal = calibStats(r.calibrationPairs);
  const bins = arr(r.calibrationPairs).length ? cal.bins : normBins(r.calibration?.bins);
  const bhRet = bh && bh.length > 1 ? num(bh[bh.length - 1].v) / num(bh[0].v) - 1 : num(pick(m, "buyHoldReturn", "bhReturn") ?? (m.buyHold && typeof m.buyHold === "object" ? m.buyHold.totalReturn : m.buyHold));
  const stratRet = num(pick(m, "totalReturn")) ?? (eq.length > 1 ? num(eq[eq.length - 1].v) / num(eq[0].v) - 1 : null);
  const eqScale = eq.length && num(eq[0].v) > 10 ? "usd" : "x";
  const yFmt = eqScale === "usd" ? (v) => "$" + (Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + "k" : v.toFixed(0)) : (v) => v.toFixed(2) + "×";
  const sigStats = Object.entries(obj(r.signalStats)).map(([id, s]) => ({ id, n: num(s?.n), hits: num(s?.hits), hr: num(s?.n) ? num(s?.hits) / num(s?.n) : null }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Panel title="Walk-forward backtest" pad={10}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={assetId} onChange={e => { setAssetId(e.target.value); setCustom(""); }} style={{ ...inputStyle, minWidth: 140 }} aria-label="asset">
            {!assets.length && <option value="">— no assets —</option>}
            {assets.map(a => <option key={a.id} value={a.id}>{a.sym} · {a.cls}</option>)}
          </select>
          <span style={{ color: C.dim, fontFamily: MONO, fontSize: 10 }}>or</span>
          <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="STOCK:IBM / CRYPTO:ETH" style={{ ...inputStyle, width: 170 }} onKeyDown={e => e.key === "Enter" && run()} />
          <select value={horizon} onChange={e => setHorizon(e.target.value)} style={inputStyle} aria-label="horizon">
            <option value="intraday">intraday · 2h</option><option value="swing">swing · 5d</option><option value="position">position · 20d</option>
          </select>
          <Btn onClick={run} disabled={running || !target} active color={C.up}>{running ? "RUNNING…" : "▶ RUN"}</Btn>
          {running && <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}><span className="de-pulse">●</span> {((Date.now() - t0) / 1000).toFixed(1)}s — bar-by-bar, no lookahead</span>}
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 8, fontFamily: MONO }}>Technical + regime + ML families only (others lack point-in-time history). Enters next bar open; exits at stop / target / horizon; fees + slippage applied.</div>
      </Panel>

      {err && <ErrorBox err={err} onRetry={run} />}
      {running && !res && <Loading label="running backtest" />}
      {!res && !running && !err && <Empty>choose an asset and horizon, then run</Empty>}

      {res && <>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: MONO, fontSize: 11 }}>
          <b>{ran.id}</b><Tag>{ran.horizon}</Tag>{running && <span className="de-pulse" style={{ color: C.dim }}>re-running…</span>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))", gap: 8 }}>
          <Stat label="strategy ret" value={spct(stratRet, 1)} color={colorSign(stratRet)} />
          <Stat label="buy & hold" value={spct(bhRet, 1)} color={colorSign(bhRet)} />
          <Stat label="CAGR" value={spct(m.cagr, 1)} color={colorSign(m.cagr)} />
          <Stat label="sharpe" value={fx(m.sharpe, 2)} color={colorSign(m.sharpe)} />
          <Stat label="sortino" value={fx(m.sortino, 2)} color={colorSign(m.sortino)} />
          <Stat label="max DD" value={num(m.maxDD) == null ? "—" : pct(-Math.abs(m.maxDD), 1)} color={C.down} />
          <Stat label="hit rate" value={pct(m.hitRate, 1)} color={(num(m.hitRate) ?? 0) >= 0.5 ? C.up : C.text} />
          <Stat label="trades" value={m.nTrades ?? trades.length} />
          <Stat label="avg win" value={spct(m.avgWin, 2)} color={C.up} />
          <Stat label="avg loss" value={spct(num(m.avgLoss) == null ? null : -Math.abs(m.avgLoss), 2)} color={C.down} />
          <Stat label="profit factor" value={fx(m.profitFactor, 2)} color={(num(m.profitFactor) ?? 0) >= 1 ? C.up : C.down} />
          <Stat label="exposure" value={pct(m.exposure, 0)} />
          <Stat label="Brier" value={fx(m.brier ?? cal.brier, 4)} />
          <Stat label="ECE" value={fx(m.ece ?? cal.ece, 4)} />
        </div>

        <Panel title="Equity · strategy vs buy & hold" pad={10}>
          <LineChart height={240} yFmt={yFmt} series={[
            { name: "strategy", color: C.blue, points: eq, fill: true },
            ...(bh ? [{ name: "buy & hold", color: C.sub, points: bh, dash: "5 4", width: 1.4 }] : []),
          ]} />
        </Panel>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 10 }}>
          <Panel title="Out-of-sample calibration" pad={10} right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>n={cal.n || "—"} · brier {fx(cal.brier, 3)} · ece {fx(cal.ece, 3)}</span>}>
            <ReliabilityDiagram bins={bins} size={300} />
          </Panel>
          <Panel title={`Signal hit rates · ${sigStats.length}`} pad={10}>
            <Table dense maxHeight={330} rows={sigStats} rowKey={s => s.id} empty="no signal stats" initialSort={{ key: "n", dir: "desc" }} cols={[
              { key: "id", label: "signal", sort: s => s.id, render: s => s.id, maxWidth: 220 },
              { key: "n", label: "n", align: "right", sort: s => s.n, render: s => s.n ?? "—" },
              { key: "hr", label: "hit", align: "right", sort: s => s.hr, render: s => <span style={{ color: s.hr == null ? C.dim : s.hr >= 0.5 ? C.up : C.down }}>{pct(s.hr, 1)}</span> },
            ]} />
          </Panel>
        </div>

        <Panel title={`Trades · ${trades.length}`} pad={10}>
          <Table dense maxHeight={420} rows={trades} empty="no trades — the engine abstained throughout" rowKey={(t, i) => i} cols={[
            { key: "open", label: "entry time", sort: t => toMs(t._open), render: t => <span style={{ color: C.dim }}>{dt(t._open)}</span> },
            { key: "side", label: "side", render: t => (t._a && ACTIONS[t._a] ? <Chip action={t._a} size="sm" /> : <Tag color={t._short ? C.down : C.up}>{t._short ? "SHORT" : "LONG"}</Tag>) },
            { key: "p", label: "P(up)", align: "right", sort: t => t._p, render: t => pct(t._p, 1) },
            { key: "entry", label: "entry", align: "right", render: t => fprice(t._entry) },
            { key: "exit", label: "exit", align: "right", render: t => fprice(t._exit) },
            { key: "ret", label: "return", align: "right", sort: t => t._ret, render: t => <b style={{ color: colorSign(t._ret) }}>{spct(t._ret)}</b> },
            { key: "close", label: "exit time", sort: t => toMs(t._close), render: t => <span style={{ color: C.dim }}>{dt(t._close)}</span> },
            { key: "why", label: "exit", render: t => <span style={{ color: C.sub }}>{t._reason || "—"}</span> },
          ]} />
        </Panel>
      </>}
    </div>
  );
}
