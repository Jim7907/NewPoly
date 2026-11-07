import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildOrder, buildPositionTpSl, marketOrderPrice, pnlAt, validateTpSl } from '../lighter/orders.js';
import { getPartnerStats } from '../lighter/api.js';
import { INTEGRATOR } from '../lighter/config.js';
import { shortErr } from '../lighter/useLighter.js';
import { fmtNum, fmtUsd } from '../lighter/units.js';
import History, { Kpi } from './History.jsx';
import Alerts from './Alerts.jsx';
import AutoTrader from './AutoTrader.jsx';

const isTrigger = (o) => Number(o.trigger_price) > 0 || /stop|take|profit/i.test(o.type ?? '');
const triggerKind = (o) => (/take|profit/i.test(o.type ?? '') ? 'TP' : /stop/i.test(o.type ?? '') ? 'SL' : null);

export default function AccountTabs({ lighter, markets, onSelectMarket, bot, indicators, tabRequest }) {
  const [tab, setTab] = useState('positions');
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  const [pending, setPending] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // market_id whose TP/SL editor is open
  const byId = new Map((markets ?? []).map((m) => [m.market_id, m]));
  const acct = lighter.account;
  const positions = (acct?.positions ?? []).filter((p) => Number(p.position) !== 0);
  const orders = lighter.orders ?? [];
  const canTrade = lighter.status === 'ready';

  const run = async (id, fn) => {
    setErr(null);
    setPending(id);
    try {
      await fn();
      return true;
    } catch (e) {
      setErr(shortErr(e));
      return false;
    } finally {
      setPending(null);
    }
  };

  const closePosition = (p) =>
    run(`close-${p.market_id}`, async () => {
      const market = byId.get(p.market_id);
      if (!market) throw new Error('Market not loaded');
      const isAsk = p.sign > 0; // long -> sell to close
      const price = await marketOrderPrice(market, isAsk, 0.01);
      await lighter.placeOrder(buildOrder(market, { isAsk, size: p.position, price, kind: 'market', reduceOnly: true }));
    });

  const cancel = (o) => run(`cancel-${o.order_index}`, () => lighter.cancelOrder(o.market_index, o.order_index));

  const TABS = [
    ['positions', `Positions (${positions.length})`],
    ['orders', `Orders (${orders.length})`],
    ['bot', bot?.running ? '🤖 Bot ●' : '🤖 Bot'],
    ['history', 'History'],
    ['alerts', 'Alerts'],
    ['account', 'Account'],
  ];

  return (
    <div className="panel account-panel">
      <div className="panel-head">
        <div className="tabs tabs-scroll">
          {TABS.map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {err && <span className="msg error inline">{err}</span>}
      </div>

      {tab === 'alerts' ? (
        <Alerts lighter={lighter} markets={markets} />
      ) : tab === 'bot' ? (
        <AutoTrader bot={bot} lighter={lighter} markets={markets} indicators={indicators} />
      ) : !acct ? (
        <div className="empty muted">
          {lighter.status === 'disconnected' ? 'Connect a wallet to see your positions.' : 'No account data yet.'}
        </div>
      ) : tab === 'positions' ? (
        positions.length === 0 ? (
          <div className="empty muted">No open positions</div>
        ) : (
          <div className="positions">
            {positions.map((p) => {
              const m = byId.get(p.market_id);
              const pd = m?.price_decimals ?? 2;
              const pnl = Number(p.unrealized_pnl);
              const long = p.sign > 0;
              const tpsl = orders.filter((o) => o.market_index === p.market_id && isTrigger(o));
              const roe = Number(p.position_value) ? (pnl / (Number(p.position_value) * Number(p.initial_margin_fraction) / 100)) * 100 : null;
              return (
                <div className="position-card" key={p.market_id}>
                  <div className="position-top">
                    <button className="link" onClick={() => onSelectMarket(p.market_id)}>{p.symbol}</button>
                    <span className={`tag ${long ? 'tag-up' : 'tag-down'}`}>{long ? 'Long' : 'Short'} {Math.round(100 / Number(p.initial_margin_fraction || 100))}x</span>
                    <span className={`position-pnl ${pnl >= 0 ? 'up' : 'down'}`}>
                      {fmtUsd(pnl)}{roe !== null && Number.isFinite(roe) && <small> ({roe >= 0 ? '+' : ''}{roe.toFixed(1)}%)</small>}
                    </span>
                  </div>
                  <dl className="position-grid">
                    <dt>Size</dt><dd>{p.position}</dd>
                    <dt>Value</dt><dd>{fmtUsd(p.position_value)}</dd>
                    <dt>Entry</dt><dd>{fmtNum(p.avg_entry_price, pd)}</dd>
                    <dt>Mark</dt><dd>{m ? fmtNum(m.mark_price, pd) : '—'}</dd>
                    <dt>Liq.</dt><dd className="down">{Number(p.liquidation_price) > 0 ? fmtNum(p.liquidation_price, pd) : '—'}</dd>
                    <dt>TP / SL</dt>
                    <dd>
                      {tpsl.length
                        ? tpsl.map((o) => `${triggerKind(o) ?? '•'} ${fmtNum(o.trigger_price, pd)}`).join(' · ')
                        : '—'}
                    </dd>
                  </dl>
                  <div className="position-actions">
                    <button className="chip" disabled={!canTrade} onClick={() => setEditing(editing === p.market_id ? null : p.market_id)}>
                      {editing === p.market_id ? 'Hide TP/SL' : 'TP/SL'}
                    </button>
                    <button className="chip chip-danger" disabled={!canTrade || pending === `close-${p.market_id}`} onClick={() => closePosition(p)}>
                      {pending === `close-${p.market_id}` ? 'Closing…' : 'Market close'}
                    </button>
                  </div>
                  {editing === p.market_id && m && (
                    <PositionTpSl
                      market={m}
                      position={p}
                      busy={pending === `tpsl-${p.market_id}`}
                      onSubmit={(tp, sl) =>
                        run(`tpsl-${p.market_id}`, () =>
                          lighter.placeGroupedOrders(buildPositionTpSl(m, { isLong: long, size: p.position, tp, sl })),
                        ).then((ok) => ok && setEditing(null))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : tab === 'orders' ? (
        <Table
          head={['Market', 'Side', 'Type', 'Price', 'Trigger', 'Size', 'Filled', '']}
          empty={canTrade ? 'No open orders' : 'Enable trading to load your open orders'}
          rows={orders.map((o) => {
            const m = byId.get(o.market_index);
            const pd = m?.price_decimals ?? 2;
            return [
              m?.symbol ?? o.market_symbol ?? o.market_index,
              <span className={o.is_ask ? 'down' : 'up'}>{o.is_ask ? 'Sell' : 'Buy'}{o.reduce_only ? ' (RO)' : ''}</span>,
              o.type,
              fmtNum(o.price, pd),
              Number(o.trigger_price) > 0 ? fmtNum(o.trigger_price, pd) : '—',
              Number(o.remaining_base_amount) === 0 && isTrigger(o) ? 'Position' : o.remaining_base_amount,
              o.filled_base_amount,
              <button className="chip" disabled={!canTrade || pending === `cancel-${o.order_index}`} onClick={() => cancel(o)}>
                {pending === `cancel-${o.order_index}` ? '…' : 'Cancel'}
              </button>,
            ];
          })}
        />
      ) : tab === 'history' ? (
        <History lighter={lighter} markets={markets} />
      ) : (
        <AccountSummary lighter={lighter} acct={acct} />
      )}
    </div>
  );
}

function PositionTpSl({ market, position, busy, onSubmit }) {
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const isLong = position.sign > 0;
  const ref = Number(market.mark_price);
  const error = tp || sl ? validateTpSl({ isLong, refPrice: ref, tp, sl }) : null;
  const est = (px) =>
    Number(px) > 0 ? pnlAt({ isLong, entryPrice: position.avg_entry_price, exitPrice: px, size: position.position }) : null;
  return (
    <div className="tpsl-editor">
      <div className="tpsl-grid">
        <label className="field">
          <span>Take profit</span>
          <input inputMode="decimal" value={tp} placeholder={isLong ? `> ${fmtNum(ref, market.price_decimals)}` : `< ${fmtNum(ref, market.price_decimals)}`} onChange={(e) => setTp(e.target.value)} />
          {est(tp) !== null && <small className={est(tp) >= 0 ? 'up' : 'down'}>PnL ≈ {fmtUsd(est(tp))}</small>}
        </label>
        <label className="field">
          <span>Stop loss</span>
          <input inputMode="decimal" value={sl} placeholder={isLong ? `< ${fmtNum(ref, market.price_decimals)}` : `> ${fmtNum(ref, market.price_decimals)}`} onChange={(e) => setSl(e.target.value)} />
          {est(sl) !== null && <small className={est(sl) >= 0 ? 'up' : 'down'}>PnL ≈ {fmtUsd(est(sl))}</small>}
        </label>
      </div>
      <p className="muted small">
        {tp && sl
          ? 'Both set: one-cancels-the-other, tied to your whole position (adjusts if you add or reduce).'
          : 'Triggers on the mark price and closes the current position size.'}
      </p>
      {error && <div className="msg error">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy || !!error || (!tp && !sl)} onClick={() => onSubmit(tp, sl)}>
        {busy ? 'Submitting…' : 'Set TP/SL'}
      </button>
    </div>
  );
}

function AccountSummary({ lighter, acct }) {
  const earnings = useQuery({
    queryKey: ['partner', INTEGRATOR?.accountIndex],
    queryFn: () => getPartnerStats(INTEGRATOR.accountIndex),
    enabled: !!INTEGRATOR,
    refetchInterval: 60000,
  });
  const e = earnings.data;
  return (
    <div className="account-summary">
      <dl className="summary wide">
        <dt>Account index</dt><dd>{lighter.accountIndex}</dd>
        <dt>Collateral</dt><dd>{fmtUsd(acct.collateral)}</dd>
        <dt>Total asset value</dt><dd>{fmtUsd(acct.total_asset_value)}</dd>
        <dt>Available balance</dt><dd>{fmtUsd(acct.available_balance)}</dd>
        <dt>Initial margin used</dt><dd>{fmtUsd(acct.cross_initial_margin_requirement)}</dd>
        <dt>Maintenance margin</dt><dd>{fmtUsd(acct.cross_maintenance_margin_requirement)}</dd>
      </dl>
      {INTEGRATOR && e && (
        <div>
          <div className="section-title">This app's fee earnings (all time)</div>
          <div className="kpis">
            <Kpi label="Fees earned" value={fmtUsd(e.total_fees_earned)} tone="up" />
            <Kpi label="Volume routed" value={fmtUsd(e.total_volume, 0)} />
            <Kpi label="Trades" value={fmtNum(e.total_trades, 0)} />
            <Kpi label="Traders" value={fmtNum(e.unique_clients, 0)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Table({ head, rows, empty }) {
  if (!rows.length) return <div className="empty muted">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
