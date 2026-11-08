import { useTrades } from '../lighter/useMarketData.js';
import { fmtNum } from '../lighter/units.js';

export default function Trades({ market }) {
  const { data: trades = [] } = useTrades(market?.market_id ?? null);
  if (!market) return null;
  return (
    <div className="panel trades-panel">
      <div className="panel-head">Recent trades</div>
      <div className="book-cols muted">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      <div className="trades-list">
        {trades.map((t) => {
          // Taker side: if the maker was the ask, the taker bought.
          const buy = t.is_maker_ask;
          return (
            <div className="trade-row" key={t.trade_id_str ?? t.trade_id}>
              <span className={buy ? 'up' : 'down'}>{fmtNum(t.price, market.price_decimals)}</span>
              <span>{fmtNum(t.size, market.size_decimals)}</span>
              <span className="muted">{new Date(t.timestamp).toLocaleTimeString([], { hour12: false })}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
