import React from "react";
import { C, MONO, Panel, Stat, Loading, ErrorBox, Table, Tag, api, useLoad, num, pct, spct, fx, fprice, usd, susd, dt, ago, arr, obj, pick, colorSign, toMs } from "./ui.jsx";
import { LineChart } from "./charts.jsx";

const isShort = (side) => /short|sell/i.test(String(side || ""));

export function normPosition(p, ticks) {
  const sym = pick(p, "symbol") || String(pick(p, "assetId") || "").split(":").pop();
  const entry = num(pick(p, "entry", "entryPrice", "avgPrice", "openPrice"));
  const qty = num(pick(p, "qty", "quantity", "units", "size"));
  const live = num(ticks?.[sym]?.price);
  const mark = live ?? num(pick(p, "price", "mark", "last", "current", "markPrice"));
  const short = isShort(pick(p, "side", "direction", "action"));
  let upnl = num(pick(p, "unrealizedPnl", "unrealizedPnL", "upnl", "pnl"));
  if (live != null && entry != null && qty != null) upnl = (short ? entry - live : live - entry) * qty;
  let upct = num(pick(p, "unrealizedPct", "pnlPct", "upnlPct", "ret"));
  if (entry && mark != null) upct = (short ? entry - mark : mark - entry) / entry;
  const value = num(pick(p, "value", "notional", "marketValue")) ?? (qty != null && mark != null ? Math.abs(qty * mark) : null);
  return { ...p, _sym: sym, _entry: entry, _qty: qty, _mark: mark, _short: short, _upnl: upnl, _upct: upct, _value: value, _open: pick(p, "openedAt", "openTs", "ts", "entryTs", "t") };
}

export function normTrade(t) {
  return { ...t, _sym: pick(t, "symbol") || String(pick(t, "assetId") || "").split(":").pop(), _short: isShort(pick(t, "side", "direction", "action")),
    _entry: num(pick(t, "entry", "entryPrice", "openPrice")), _exit: num(pick(t, "exit", "exitPrice", "closePrice")),
    _qty: num(pick(t, "qty", "quantity", "units", "size")), _pnl: num(pick(t, "pnl", "realizedPnl", "pnlUsd")), _ret: num(pick(t, "pnlPct", "ret", "return", "returnPct")),
    _open: pick(t, "openedAt", "openTs", "entryTs", "entryT", "t0"), _close: pick(t, "closedAt", "closeTs", "exitTs", "exitT", "t1", "ts"), _reason: pick(t, "reason", "exitReason", "note") };
}
export const normCurve = (c) => arr(c).map(p => Array.isArray(p) ? { t: p[0], v: p[1] } : { t: pick(p, "t", "ts", "time", "date"), v: pick(p, "v", "equity", "value") }).filter(p => toMs(p.t) != null && num(p.v) != null);

export default function PortfolioTab({ ticks, refreshKey }) {
  const { data, err, loading, reload } = useLoad(() => api("/api/portfolio"), [refreshKey], { interval: 15000 });
  if (loading && !data) return <Loading label="portfolio" />;
  if (err && !data) return <ErrorBox err={err} onRetry={reload} />;
  const d = obj(data);
  const s = obj(d.stats);
  const positions = arr(d.positions).map(p => normPosition(p, ticks));
  const trades = arr(d.trades).map(normTrade).sort((a, b) => (toMs(b._close) ?? 0) - (toMs(a._close) ?? 0));
  const curve = normCurve(d.equityCurve);
  const upnlTotal = positions.reduce((a, p) => a + (p._upnl ?? 0), 0);
  const start = num(pick(d, "startingEquity", "initial", "startEquity")) ?? num(curve[0]?.v);
  const equity = num(d.equity);
  const totRet = num(pick(s, "totalReturn", "return")) ?? (start && equity != null ? equity / start - 1 : null);
  const maxDD = num(pick(s, "maxDD", "maxDrawdown", "mdd"));
  const exposure = positions.reduce((a, p) => a + (p._value ?? 0), 0);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {err && <ErrorBox err={"refresh failed: " + err} onRetry={reload} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8 }}>
        <Stat label="equity" value={usd(equity)} sub={totRet != null ? spct(totRet) + " total" : null} color={C.text} />
        <Stat label="cash" value={usd(d.cash)} sub={equity ? pct(num(d.cash) / equity, 0) + " of equity" : null} />
        <Stat label="unrealized" value={susd(upnlTotal)} color={colorSign(upnlTotal)} sub={`${positions.length} open`} />
        <Stat label="realized" value={susd(pick(s, "realizedPnl", "realized", "pnl"))} color={colorSign(pick(s, "realizedPnl", "realized", "pnl"))} />
        <Stat label="win rate" value={pct(pick(s, "winRate", "hitRate"), 1)} sub={`${pick(s, "nTrades", "trades", "n") ?? trades.length} trades`} />
        <Stat label="profit factor" value={fx(s.profitFactor, 2)} color={(num(s.profitFactor) ?? 0) >= 1 ? C.up : C.down} />
        <Stat label="sharpe" value={fx(s.sharpe, 2)} color={colorSign(s.sharpe)} />
        <Stat label="max DD" value={maxDD == null ? "—" : pct(-Math.abs(maxDD), 1)} color={C.down} />
        <Stat label="gross exposure" value={usd(exposure)} sub={equity ? pct(exposure / equity, 0) : null} />
      </div>

      <Panel title="Equity curve" pad={10}>
        <LineChart height={220} yFmt={(v) => usd(v)} refLines={start ? [{ v: start, color: C.dim, label: "start" }] : []}
          series={[{ name: "equity", color: C.blue, points: curve, fill: true }]} />
      </Panel>

      <Panel title={`Open positions · ${positions.length}`} pad={10}>
        <Table dense rows={positions} empty="flat — no open paper positions" rowKey={(p, i) => (p.id || p._sym || "") + i} initialSort={{ key: "upnl", dir: "desc" }} cols={[
          { key: "sym", label: "asset", sort: p => p._sym, render: p => <b>{p._sym}</b> },
          { key: "side", label: "side", sort: p => (p._short ? 1 : 0), render: p => <Tag color={p._short ? C.down : C.up}>{p._short ? "SHORT" : "LONG"}</Tag> },
          { key: "qty", label: "qty", align: "right", sort: p => p._qty, render: p => fx(p._qty, p._qty != null && Math.abs(p._qty) < 10 ? 4 : 2) },
          { key: "entry", label: "entry", align: "right", sort: p => p._entry, render: p => fprice(p._entry) },
          { key: "mark", label: "mark", align: "right", sort: p => p._mark, render: p => fprice(p._mark) },
          { key: "value", label: "value", align: "right", sort: p => p._value, render: p => usd(p._value) },
          { key: "upnl", label: "uP&L", align: "right", sort: p => p._upnl, render: p => <b style={{ color: colorSign(p._upnl) }}>{susd(p._upnl, 2)}</b> },
          { key: "upct", label: "%", align: "right", sort: p => p._upct, render: p => <span style={{ color: colorSign(p._upct) }}>{spct(p._upct)}</span> },
          { key: "stop", label: "stop", align: "right", render: p => <span style={{ color: C.down }}>{fprice(pick(p, "stop"))}</span> },
          { key: "tgt", label: "target", align: "right", render: p => <span style={{ color: C.up }}>{fprice(pick(p, "target"))}</span> },
          { key: "age", label: "opened", sort: p => toMs(p._open), render: p => <span style={{ color: C.dim }}>{ago(p._open)}</span> },
        ]} />
      </Panel>

      <Panel title={`Trade log · ${trades.length}`} pad={10}>
        <Table dense maxHeight={420} rows={trades} empty="no closed trades yet" rowKey={(t, i) => (t.id || "") + i} cols={[
          { key: "close", label: "closed", sort: t => toMs(t._close), render: t => <span style={{ color: C.dim }}>{dt(t._close)}</span> },
          { key: "sym", label: "asset", sort: t => t._sym, render: t => <b>{t._sym}</b> },
          { key: "side", label: "side", render: t => <Tag color={t._short ? C.down : C.up}>{t._short ? "SHORT" : "LONG"}</Tag> },
          { key: "entry", label: "entry", align: "right", render: t => fprice(t._entry) },
          { key: "exit", label: "exit", align: "right", render: t => fprice(t._exit) },
          { key: "pnl", label: "P&L", align: "right", sort: t => t._pnl, render: t => <b style={{ color: colorSign(t._pnl) }}>{susd(t._pnl, 2)}</b> },
          { key: "ret", label: "%", align: "right", sort: t => t._ret, render: t => <span style={{ color: colorSign(t._ret) }}>{spct(t._ret)}</span> },
          { key: "why", label: "exit reason", render: t => <span style={{ color: C.sub }}>{t._reason || "—"}</span> },
        ]} />
      </Panel>
      <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>Simulated paper account. Unrealized P&L re-marked live from the price stream when available.</div>
    </div>
  );
}
