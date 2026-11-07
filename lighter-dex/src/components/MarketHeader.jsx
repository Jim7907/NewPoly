import { fmtCompact, fmtNum, fmtUsd } from '../lighter/units.js';

export default function MarketHeader({ markets, market, onSelect }) {
  if (!market) return <div className="market-header muted">Loading markets…</div>;
  const change = Number(market.daily_price_change);
  return (
    <div className="market-header">
      <select
        className="market-select"
        value={market.market_id}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label="Market"
      >
        {markets.map((m) => (
          <option key={m.market_id} value={m.market_id}>
            {m.symbol}-PERP
          </option>
        ))}
      </select>
      <Stat label="Mark" value={fmtNum(market.mark_price, market.price_decimals)} />
      <Stat label="Index" value={fmtNum(market.index_price, market.price_decimals)} />
      <Stat
        label="24h change"
        value={`${change >= 0 ? '+' : ''}${fmtNum(change, 2)}%`}
        tone={change >= 0 ? 'up' : 'down'}
      />
      <Stat label="24h volume" value={`$${fmtCompact(market.daily_quote_token_volume)}`} />
      <Stat label="Open interest" value={fmtUsd(market.open_interest_usd ?? Number(market.open_interest) * Number(market.mark_price), 0)} />
      <Stat label="Max leverage" value={`${Math.floor(10000 / Number(market.min_initial_margin_fraction))}x`} />
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}
