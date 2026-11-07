// Turns raw Lighter trades into "my fills" and performance stats.

/** View of a trade from one account's side. */
export function toFill(trade, accountIndex) {
  const me = Number(accountIndex);
  const isBuyer = Number(trade.bid_account_id) === me;
  const isMakerSide = trade.is_maker_ask ? !isBuyer : isBuyer;
  const pnl = Number(isBuyer ? trade.bid_account_pnl : trade.ask_account_pnl);
  return {
    id: trade.trade_id_str ?? String(trade.trade_id),
    time: trade.timestamp,
    marketId: trade.market_id,
    symbol: trade.market_symbol,
    side: isBuyer ? 'buy' : 'sell',
    role: isMakerSide ? 'maker' : 'taker',
    price: Number(trade.price),
    size: Number(trade.size),
    value: Number(trade.usd_amount),
    pnl: Number.isFinite(pnl) ? pnl : 0,
    type: trade.type, // trade | liquidation | deleverage
  };
}

/** Realized PnL, volume, win rate and per-market breakdown for a list of fills. */
export function summarizeFills(fills) {
  const byMarket = new Map();
  let realized = 0;
  let volume = 0;
  let wins = 0;
  let losses = 0;
  for (const f of fills) {
    realized += f.pnl;
    volume += f.value;
    if (f.pnl > 0) wins++;
    else if (f.pnl < 0) losses++;
    const m = byMarket.get(f.symbol) ?? { symbol: f.symbol, realized: 0, volume: 0, fills: 0 };
    m.realized += f.pnl;
    m.volume += f.value;
    m.fills++;
    byMarket.set(f.symbol, m);
  }
  const closed = wins + losses;
  return {
    realized,
    volume,
    fills: fills.length,
    wins,
    losses,
    winRate: closed ? wins / closed : null,
    byMarket: [...byMarket.values()].sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized)),
  };
}

/** Change of the cumulative trade PnL across a /pnl series. */
export function pnlChange(series) {
  if (!series?.length) return null;
  return Number(series.at(-1).trade_pnl) - Number(series[0].trade_pnl);
}
