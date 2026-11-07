import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AreaSeries, createChart } from 'lightweight-charts';
import * as api from '../lighter/api.js';
import { pnlChange, summarizeFills, toFill } from '../lighter/history.js';
import { fmtNum, fmtUsd } from '../lighter/units.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export default function History({ lighter, markets }) {
  const [view, setView] = useState('fills');
  if (!lighter.tradingReady) {
    return <div className="empty muted">Enable trading to load your history (it uses the same signed key).</div>;
  }
  return (
    <div>
      <div className="subtabs">
        {[['fills', 'Fills & PnL'], ['pnl', 'PnL chart'], ['funding', 'Funding']].map(([k, label]) => (
          <button key={k} className={`chip ${view === k ? 'chip-active' : ''}`} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {view === 'fills' && <Fills lighter={lighter} markets={markets} />}
      {view === 'pnl' && <PnlChart lighter={lighter} />}
      {view === 'funding' && <Funding lighter={lighter} markets={markets} />}
    </div>
  );
}

function Fills({ lighter, markets }) {
  const byId = new Map(markets.map((m) => [m.market_id, m]));
  const q = useInfiniteQuery({
    queryKey: ['fills', lighter.accountIndex],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      api.getAccountTrades(lighter.accountIndex, await lighter.getAuthToken(), { cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15000,
  });
  const fills = useMemo(
    () => (q.data?.pages ?? []).flatMap((p) => p.trades).map((t) => toFill(t, lighter.accountIndex)),
    [q.data, lighter.accountIndex],
  );
  const s = useMemo(() => summarizeFills(fills), [fills]);

  if (q.isLoading) return <div className="empty muted">Loading fills…</div>;
  if (q.error) return <div className="empty down">{q.error.message}</div>;
  if (!fills.length) return <div className="empty muted">No trades yet.</div>;

  return (
    <>
      <div className="kpis">
        <Kpi label={`Realized PnL (last ${s.fills} fills)`} value={fmtUsd(s.realized)} tone={s.realized >= 0 ? 'up' : 'down'} />
        <Kpi label="Volume" value={fmtUsd(s.volume, 0)} />
        <Kpi label="Win rate" value={s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(0)}%`} sub={`${s.wins}W / ${s.losses}L`} />
        <Kpi
          label="Best market"
          value={s.byMarket[0] ? s.byMarket[0].symbol : '—'}
          sub={s.byMarket[0] ? fmtUsd(s.byMarket[0].realized) : ''}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Time</th><th>Market</th><th>Side</th><th>Price</th><th>Size</th><th>Value</th><th>Realized PnL</th><th>Role</th></tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id}>
                <td className="muted">{fmtTime(f.time)}</td>
                <td>{f.symbol}{f.type !== 'trade' && <span className="tag">{f.type}</span>}</td>
                <td className={f.side === 'buy' ? 'up' : 'down'}>{f.side === 'buy' ? 'Buy' : 'Sell'}</td>
                <td>{fmtNum(f.price, byId.get(f.marketId)?.price_decimals ?? 2)}</td>
                <td>{f.size}</td>
                <td>{fmtUsd(f.value)}</td>
                <td className={f.pnl > 0 ? 'up' : f.pnl < 0 ? 'down' : 'muted'}>{f.pnl ? fmtUsd(f.pnl) : '—'}</td>
                <td className="muted">{f.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div className="load-more">
          <button className="chip" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

function PnlChart({ lighter }) {
  const [days, setDays] = useState(30);
  const el = useRef(null);
  const q = useQuery({
    queryKey: ['pnl', lighter.accountIndex, days],
    queryFn: async () => api.getPnlSeries(lighter.accountIndex, await lighter.getAuthToken(), days),
    refetchInterval: 60000,
  });
  const change = pnlChange(q.data);

  useEffect(() => {
    if (!el.current || !q.data?.length) return undefined;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'inherit' },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderColor: css('--border') },
      timeScale: { borderColor: css('--border') },
      handleScroll: false,
      handleScale: false,
    });
    const up = (change ?? 0) >= 0;
    const series = chart.addSeries(AreaSeries, {
      lineColor: css(up ? '--up' : '--down'),
      topColor: css(up ? '--up-dim' : '--down-dim'),
      bottomColor: 'transparent',
      lineWidth: 2,
    });
    const base = Number(q.data[0].trade_pnl);
    series.setData(q.data.map((p) => ({ time: p.timestamp, value: Number(p.trade_pnl) - base })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [q.data, change]);

  return (
    <div>
      <div className="kpis">
        <Kpi label={`Trading PnL, last ${days} days`} value={change === null ? '—' : fmtUsd(change)} tone={(change ?? 0) >= 0 ? 'up' : 'down'} />
        <div className="kpi">
          <div className="subtabs">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`chip ${d === days ? 'chip-active' : ''}`} onClick={() => setDays(d)}>{d}d</button>
            ))}
          </div>
        </div>
      </div>
      {q.error ? <div className="empty down">{q.error.message}</div> : <div className="pnl-chart" ref={el} />}
    </div>
  );
}

function Funding({ lighter, markets }) {
  const byId = new Map(markets.map((m) => [m.market_id, m]));
  const q = useQuery({
    queryKey: ['funding', lighter.accountIndex],
    queryFn: async () => api.getPositionFunding(lighter.accountIndex, await lighter.getAuthToken(), { limit: 100 }),
    refetchInterval: 60000,
  });
  const rows = q.data?.fundings ?? [];
  const total = rows.reduce((a, r) => a + Number(r.change), 0);
  if (q.isLoading) return <div className="empty muted">Loading funding…</div>;
  if (q.error) return <div className="empty down">{q.error.message}</div>;
  if (!rows.length) return <div className="empty muted">No funding payments yet.</div>;
  return (
    <>
      <div className="kpis">
        <Kpi label={`Net funding (last ${rows.length} payments)`} value={fmtUsd(total)} tone={total >= 0 ? 'up' : 'down'} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Size</th><th>Rate</th><th>Payment</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.funding_id}-${r.market_id}`}>
                <td className="muted">{fmtTime(r.timestamp * (r.timestamp < 1e12 ? 1000 : 1))}</td>
                <td>{byId.get(r.market_id)?.symbol ?? r.market_id}</td>
                <td className={r.position_side === 'long' ? 'up' : 'down'}>{r.position_side}</td>
                <td>{r.position_size}</td>
                <td>{r.rate}</td>
                <td className={Number(r.change) >= 0 ? 'up' : 'down'}>{fmtUsd(r.change, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Kpi({ label, value, sub, tone }) {
  return (
    <div className="kpi">
      <div className="stat-label">{label}</div>
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
      {sub && <div className="muted kpi-sub">{sub}</div>}
    </div>
  );
}
