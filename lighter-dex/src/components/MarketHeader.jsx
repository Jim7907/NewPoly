import { fmtCompact, fmtNum, fmtUsd } from '../lighter/units.js';
import MarketPicker from './MarketPicker.jsx';

export default function MarketHeader({ markets, market, onSelect }) {
  if (!market) return <div className="market-header muted">Loading markets…</div>;
  const change = Number(market.daily_price_change);
  const pd = market.price_decimals;
  return (
    <div className="market-header">
      <MarketPicker markets={markets} market={market} onSelect={onSelect} />
      {market.kind === 'perp' ? (
        <>
          <Stat label="Mark" value={fmtNum(market.mark_price, pd)} />
          <Stat label="Index" value={fmtNum(market.index_price, pd)} />
        </>
      ) : (
        <Stat label="Last price" value={fmtNum(market.mark_price, pd)} />
      )}
      <Stat
        label="24h change"
        value={Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${fmtNum(change, 2)}%` : '—'}
        tone={change >= 0 ? 'up' : 'down'}
      />
      <Stat label="24h high / low" value={`${fmtNum(market.daily_price_high, pd)} / ${fmtNum(market.daily_price_low, pd)}`} />
      <Stat label="24h volume" value={`$${fmtCompact(market.daily_quote_token_volume)}`} />
      {market.kind === 'perp' && (
        <>
          <Stat label="Open interest" value={fmtUsd(market.open_interest_usd ?? Number(market.open_interest) * Number(market.mark_price), 0)} />
          <Stat label="Max leverage" value={`${Math.floor(10000 / Number(market.min_initial_margin_fraction))}x`} />
        </>
      )}
      {market.kind === 'spot' && <Stat label="Type" value="Spot (no leverage)" />}
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
