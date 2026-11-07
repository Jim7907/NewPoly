import { getOrderBook } from './api.js';
import { ORDER_TYPE, TIME_IN_FORCE } from './config.js';
import { roundTo, toScaledInt } from './units.js';

let lastClientOrderIndex = 0;
/** Unique, strictly increasing client order id (must be < 2^48; ms timestamps are ~2^41). */
export function nextClientOrderIndex() {
  lastClientOrderIndex = Math.max(Date.now(), lastClientOrderIndex + 1);
  return lastClientOrderIndex;
}

/** Max leverage allowed by a market (min IMF is in basis points, e.g. 200 = 2% = 50x). */
export const maxLeverage = (market) => Math.floor(10000 / Number(market.min_initial_margin_fraction || 10000));

/**
 * Worst acceptable fill price for a market order, from the live top of book.
 * Lighter market orders are IOC orders with a price cap; this is the cap.
 */
export async function marketOrderPrice(market, isAsk, slippage) {
  const book = await getOrderBook(market.market_id, 1);
  const top = isAsk ? book.bids[0] : book.asks[0];
  if (!top) throw new Error('No liquidity on the other side of the book');
  const px = Number(top.price) * (isAsk ? 1 - slippage : 1 + slippage);
  return roundTo(px, market.price_decimals, isAsk ? 'down' : 'up');
}

export function validateSize(market, size, price) {
  const s = Number(size);
  if (!(s > 0)) return 'Enter a size';
  if (s < Number(market.min_base_amount)) return `Min size is ${market.min_base_amount} ${market.symbol}`;
  if (price && s * Number(price) < Number(market.min_quote_amount)) return `Min order value is $${Number(market.min_quote_amount)}`;
  return null;
}

/** Builds signer params. `price`/`size` are human decimal strings. */
export function buildOrder(market, { isAsk, size, price, kind, reduceOnly = false, postOnly = false }) {
  const baseAmount = toScaledInt(size, market.size_decimals);
  const scaledPrice = toScaledInt(price, market.price_decimals);
  if (!baseAmount || baseAmount === '0') throw new Error('Invalid size');
  if (!scaledPrice || scaledPrice === '0') throw new Error('Invalid price');
  const isMarket = kind === 'market';
  return {
    marketIndex: market.market_id,
    clientOrderIndex: nextClientOrderIndex(),
    baseAmount,
    price: scaledPrice,
    isAsk,
    orderType: isMarket ? ORDER_TYPE.MARKET : ORDER_TYPE.LIMIT,
    timeInForce: isMarket ? TIME_IN_FORCE.IOC : postOnly ? TIME_IN_FORCE.POST_ONLY : TIME_IN_FORCE.GTT,
    reduceOnly,
    triggerPrice: '0',
    orderExpiry: isMarket ? 0 : -1, // -1 = 28 days
  };
}
