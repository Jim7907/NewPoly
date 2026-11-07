import { useState } from 'react';
import { buildOrder, marketOrderPrice } from '../lighter/orders.js';
import { shortErr } from '../lighter/useLighter.js';
import { fmtNum, fmtUsd } from '../lighter/units.js';

export default function AccountTabs({ lighter, markets, onSelectMarket }) {
  const [tab, setTab] = useState('positions');
  const [pending, setPending] = useState(null);
  const [err, setErr] = useState(null);
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
    } catch (e) {
      setErr(shortErr(e));
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

  return (
    <div className="panel account-panel">
      <div className="panel-head">
        <div className="tabs">
          <button className={`tab ${tab === 'positions' ? 'active' : ''}`} onClick={() => setTab('positions')}>
            Positions ({positions.length})
          </button>
          <button className={`tab ${tab === 'orders' ? 'active' : ''}`} onClick={() => setTab('orders')}>
            Open orders ({orders.length})
          </button>
          <button className={`tab ${tab === 'balances' ? 'active' : ''}`} onClick={() => setTab('balances')}>
            Account
          </button>
        </div>
        {err && <span className="msg error inline">{err}</span>}
      </div>

      {!acct ? (
        <div className="empty muted">
          {lighter.status === 'disconnected' ? 'Connect a wallet to see your positions.' : 'No account data yet.'}
        </div>
      ) : tab === 'positions' ? (
        <Table
          head={['Market', 'Side', 'Size', 'Entry', 'Mark', 'Value', 'uPnL', 'Liq. price', '']}
          empty="No open positions"
          rows={positions.map((p) => {
            const m = byId.get(p.market_id);
            const pd = m?.price_decimals ?? 2;
            const pnl = Number(p.unrealized_pnl);
            return [
              <button className="link" onClick={() => onSelectMarket(p.market_id)}>{p.symbol}</button>,
              <span className={p.sign > 0 ? 'up' : 'down'}>{p.sign > 0 ? 'Long' : 'Short'}</span>,
              p.position,
              fmtNum(p.avg_entry_price, pd),
              m ? fmtNum(m.mark_price, pd) : '—',
              fmtUsd(p.position_value),
              <span className={pnl >= 0 ? 'up' : 'down'}>{fmtUsd(pnl)}</span>,
              Number(p.liquidation_price) > 0 ? fmtNum(p.liquidation_price, pd) : '—',
              <button className="chip" disabled={!canTrade || pending === `close-${p.market_id}`} onClick={() => closePosition(p)}>
                {pending === `close-${p.market_id}` ? '…' : 'Close'}
              </button>,
            ];
          })}
        />
      ) : tab === 'orders' ? (
        <Table
          head={['Market', 'Side', 'Type', 'Price', 'Size', 'Filled', 'Reduce only', '']}
          empty={canTrade ? 'No open orders' : 'Enable trading to load your open orders'}
          rows={orders.map((o) => {
            const m = byId.get(o.market_index);
            return [
              m?.symbol ?? o.market_symbol ?? o.market_index,
              <span className={o.is_ask ? 'down' : 'up'}>{o.is_ask ? 'Sell' : 'Buy'}</span>,
              o.type,
              fmtNum(o.price, m?.price_decimals ?? 2),
              o.remaining_base_amount,
              o.filled_base_amount,
              o.reduce_only ? 'Yes' : 'No',
              <button className="chip" disabled={!canTrade || pending === `cancel-${o.order_index}`} onClick={() => cancel(o)}>
                {pending === `cancel-${o.order_index}` ? '…' : 'Cancel'}
              </button>,
            ];
          })}
        />
      ) : (
        <dl className="summary wide">
          <dt>Account index</dt><dd>{lighter.accountIndex}</dd>
          <dt>Collateral</dt><dd>{fmtUsd(acct.collateral)}</dd>
          <dt>Total asset value</dt><dd>{fmtUsd(acct.total_asset_value)}</dd>
          <dt>Available balance</dt><dd>{fmtUsd(acct.available_balance)}</dd>
          <dt>Initial margin used</dt><dd>{fmtUsd(acct.cross_initial_margin_requirement)}</dd>
          <dt>Maintenance margin</dt><dd>{fmtUsd(acct.cross_maintenance_margin_requirement)}</dd>
        </dl>
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
