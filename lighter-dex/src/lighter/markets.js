// Normalizes Lighter's perp and spot market details into one shape the UI uses.

/**
 * Adds: kind ('perp' | 'spot'), base, quote, label, and a mark_price for spot
 * (spot has no mark/index price, so the last trade price stands in).
 */
export function normalizeMarket(m) {
  const spot = m.market_type === 'spot';
  const [base, quote] = spot ? String(m.symbol).split('/') : [m.symbol, 'USD'];
  return {
    ...m,
    kind: spot ? 'spot' : 'perp',
    base,
    quote: quote ?? 'USDC',
    label: spot ? m.symbol : `${m.symbol}-PERP`,
    mark_price: m.mark_price ?? (m.last_trade_price !== undefined ? String(m.last_trade_price) : undefined),
    price_decimals: m.price_decimals ?? m.supported_price_decimals,
    size_decimals: m.size_decimals ?? m.supported_size_decimals,
  };
}

/** All tradable markets: perps first, then spot, each sorted by 24h volume. */
export function buildMarketList(details) {
  const byVolume = (a, b) => Number(b.daily_quote_token_volume ?? 0) - Number(a.daily_quote_token_volume ?? 0);
  const perps = (details.order_book_details ?? []).filter((m) => m.status === 'active' && m.market_type === 'perp');
  const spot = (details.spot_order_book_details ?? []).filter((m) => m.status === 'active' && m.market_type === 'spot');
  return [...perps.sort(byVolume), ...spot.sort(byVolume)].map(normalizeMarket);
}

/** Case-insensitive search over symbol/label, optional kind filter, favorites first. */
export function filterMarkets(markets, { query = '', kind = 'all', favorites = [] } = {}) {
  const q = query.trim().toLowerCase();
  const fav = new Set(favorites);
  return markets
    .filter((m) => (kind === 'all' ? true : kind === 'fav' ? fav.has(m.market_id) : m.kind === kind))
    .filter((m) => !q || m.label.toLowerCase().includes(q) || m.symbol.toLowerCase().includes(q))
    .sort((a, b) => {
      if (q) {
        // exact / prefix matches first when searching
        const rank = (m) => (m.base.toLowerCase() === q ? 0 : m.base.toLowerCase().startsWith(q) ? 1 : 2);
        const d = rank(a) - rank(b);
        if (d) return d;
      }
      return (fav.has(b.market_id) ? 1 : 0) - (fav.has(a.market_id) ? 1 : 0);
    });
}
