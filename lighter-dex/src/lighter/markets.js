// Normalizes Lighter's perp and spot market details into one shape the UI uses.

// Lighter's API has no asset-class field, so non-crypto perps are listed by symbol.
// Anything not listed here is treated as crypto. Update when Lighter lists new RWA markets.
const words = (s) => new Set(s.trim().split(/\s+/));
const CATEGORY_SYMBOLS = {
  stocks: words(`
    AAPL MSFT NVDA GOOGL AMZN META TSLA AMD AVGO TSM ARM ASML INTC QCOM MU MRVL WDC SNDK DELL IBM ORCL NOW
    PLTR COIN HOOD MSTR CRCL BMNR RKLB GEV IREN NBIS CRWV TTWO GME NOK MRNA BE AXTI AAOI LITE CBRS ASELS
    BABA TENCENT XIAOMI BYD SMIC POPMART KIOXIA SAMSUNGUSD SKHYNIXUSD SKHY HYUNDAIUSD ZHIPU MINIMAX CXMT`),
  preipo: words('ANTHROPIC OPENAI SPCX SHEIN UNITREE'),
  indices: words('SPY QQQ IWM EWY SOXL SOXS US500 US100 TUR30 US10Y'),
  fx: words('EURUSD GBPUSD AUDUSD NZDUSD USDJPY USDCAD USDCHF USDHKD USDKRW'),
  commodities: words('XAU XAG XPT XPD XCU WTI BRENTOIL NATGAS DRAM H100'),
};

export const CATEGORIES = [
  ['crypto', 'Crypto'],
  ['stocks', 'Stocks'],
  ['preipo', 'Pre-IPO'],
  ['indices', 'Indices & ETFs'],
  ['fx', 'FX'],
  ['commodities', 'Commodities'],
];

export function categoryOf(symbol) {
  const base = String(symbol).split('/')[0];
  for (const [cat, set] of Object.entries(CATEGORY_SYMBOLS)) if (set.has(base)) return cat;
  // tokenized stock/ETF spot pairs (rhSPY, rhQQQ …)
  if (/^rh[A-Z]/.test(base)) return 'indices';
  return 'crypto';
}

/**
 * Adds: kind ('perp' | 'spot'), category, base, quote, label, and a mark_price for spot
 * (spot has no mark/index price, so the last trade price stands in).
 */
export function normalizeMarket(m) {
  const spot = m.market_type === 'spot';
  const [base, quote] = spot ? String(m.symbol).split('/') : [m.symbol, 'USD'];
  return {
    ...m,
    kind: spot ? 'spot' : 'perp',
    category: categoryOf(m.symbol),
    reduce_only: Boolean(m.market_config?.force_reduce_only),
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

/**
 * Case-insensitive search over symbol/label, favorites first.
 * kind: 'all' | 'fav' | 'perp' | 'spot' | a category id from CATEGORIES.
 */
export function filterMarkets(markets, { query = '', kind = 'all', favorites = [] } = {}) {
  const q = query.trim().toLowerCase();
  const fav = new Set(favorites);
  const match = (m) => {
    if (kind === 'all') return true;
    if (kind === 'fav') return fav.has(m.market_id);
    if (kind === 'perp' || kind === 'spot') return m.kind === kind;
    return m.category === kind;
  };
  return markets
    .filter(match)
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
