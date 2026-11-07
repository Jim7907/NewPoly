import { getOrderBook } from './api.js';
import { GROUPING, ORDER_TYPE, TIME_IN_FORCE } from './config.js';
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

// ---------------- Take-profit / stop-loss ----------------

/** Max distance between trigger and fill-limit price, so a triggered TP/SL actually fills. */
export const TRIGGER_SLIPPAGE = 0.02;

/**
 * Checks TP/SL prices make sense for the position direction.
 * `refPrice` is the entry (or current mark for an existing position).
 */
export function validateTpSl({ isLong, refPrice, tp, sl }) {
  const ref = Number(refPrice);
  if (tp !== '' && tp !== undefined && tp !== null) {
    const t = Number(tp);
    if (!(t > 0)) return 'Invalid take-profit price';
    if (isLong && t <= ref) return 'Take-profit must be above the entry price for a long';
    if (!isLong && t >= ref) return 'Take-profit must be below the entry price for a short';
  }
  if (sl !== '' && sl !== undefined && sl !== null) {
    const s = Number(sl);
    if (!(s > 0)) return 'Invalid stop-loss price';
    if (isLong && s >= ref) return 'Stop-loss must be below the entry price for a long';
    if (!isLong && s <= ref) return 'Stop-loss must be above the entry price for a short';
  }
  return null;
}

/**
 * A reduce-only trigger order that closes (part of) a position.
 * @param kind 'tp' | 'sl'
 * @param isLong direction of the position being protected
 * @param size decimal string, or '0' = "whole position" (only valid inside a grouped tx)
 */
export function buildTriggerOrder(market, { kind, isLong, trigger, size = '0', slippage = TRIGGER_SLIPPAGE }) {
  const closeIsAsk = isLong; // closing a long = selling
  const t = Number(trigger);
  const limit = roundTo(t * (closeIsAsk ? 1 - slippage : 1 + slippage), market.price_decimals, closeIsAsk ? 'down' : 'up');
  const triggerPrice = toScaledInt(roundTo(t, market.price_decimals), market.price_decimals);
  const baseAmount = size === '0' ? '0' : toScaledInt(size, market.size_decimals);
  if (!triggerPrice || triggerPrice === '0') throw new Error(`Invalid ${kind === 'tp' ? 'take-profit' : 'stop-loss'} price`);
  if (baseAmount === null) throw new Error('Invalid size');
  return {
    marketIndex: market.market_id,
    clientOrderIndex: nextClientOrderIndex(),
    baseAmount,
    price: toScaledInt(limit, market.price_decimals),
    isAsk: closeIsAsk,
    orderType: kind === 'tp' ? ORDER_TYPE.TAKE_PROFIT_LIMIT : ORDER_TYPE.STOP_LOSS_LIMIT,
    timeInForce: TIME_IN_FORCE.GTT,
    reduceOnly: true,
    triggerPrice,
    orderExpiry: -1,
  };
}

/**
 * Entry order + attached TP and/or SL as one grouped tx. The TP/SL only go live once
 * the entry fills, and sized to whatever filled. Returns { groupingType, orders }.
 */
export function buildEntryWithTpSl(market, entryParams, { tp, sl }) {
  const entry = buildOrder(market, entryParams);
  // Grouped entries are sent as limit orders (IOC for "market"), per Lighter's SDK examples.
  if (entry.orderType === ORDER_TYPE.MARKET) entry.orderType = ORDER_TYPE.LIMIT;
  const isLong = !entryParams.isAsk;
  const legs = [];
  if (tp) legs.push(buildTriggerOrder(market, { kind: 'tp', isLong, trigger: tp }));
  if (sl) legs.push(buildTriggerOrder(market, { kind: 'sl', isLong, trigger: sl }));
  if (!legs.length) throw new Error('Set a take-profit or stop-loss price');
  return { groupingType: legs.length === 2 ? GROUPING.OTOCO : GROUPING.OTO, orders: [entry, ...legs] };
}

/**
 * TP/SL for an existing position. With both prices: an OCO pair tied to the whole
 * position (follows the position size, cancelled when it closes). With one price:
 * a single reduce-only trigger order for the current size.
 * Returns { groupingType, orders } (groupingType null = single order).
 */
export function buildPositionTpSl(market, { isLong, size, tp, sl }) {
  if (tp && sl) {
    return {
      groupingType: GROUPING.OCO,
      orders: [
        buildTriggerOrder(market, { kind: 'tp', isLong, trigger: tp }),
        buildTriggerOrder(market, { kind: 'sl', isLong, trigger: sl }),
      ],
    };
  }
  if (!tp && !sl) throw new Error('Set a take-profit or stop-loss price');
  return {
    groupingType: null,
    orders: [buildTriggerOrder(market, { kind: tp ? 'tp' : 'sl', isLong, trigger: tp || sl, size: String(Math.abs(Number(size))) })],
  };
}

/** Profit/loss of closing `size` at `exitPrice`. */
export function pnlAt({ isLong, entryPrice, exitPrice, size }) {
  return (Number(exitPrice) - Number(entryPrice)) * Number(size) * (isLong ? 1 : -1);
}
