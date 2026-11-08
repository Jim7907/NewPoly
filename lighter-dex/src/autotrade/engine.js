// Pure auto-trading logic (no I/O): when to act, what to do, how big, and a backtest.

export const RES_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

/**
 * Signal of the most recent *closed* candle. Acting only on closed candles means a
 * signal can't appear and disappear while the candle is still forming.
 */
export function lastClosedSignal(candles, signals, resolution, nowSec) {
  const step = RES_SECONDS[resolution];
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time + step <= nowSec) {
      return { time: candles[i].time, signal: signals?.[i] ?? null, close: candles[i].close };
    }
  }
  return null;
}

/**
 * What to do for a signal given the current position.
 * @param position signed size (+long / -short / 0 flat)
 * @param mode 'both' | 'long' (long-only) | 'short' (short-only)
 * @returns {{ close: boolean, open: 'long' | 'short' | null }}
 */
export function decideAction(signal, position, mode = 'both') {
  const none = { close: false, open: null };
  const pos = Number(position) || 0;
  if (signal === 'exit') return pos !== 0 ? { close: true, open: null } : none;
  if (signal === 'long') {
    if (pos > 0) return none;
    const canOpen = mode !== 'short';
    return { close: pos < 0, open: canOpen ? 'long' : null };
  }
  if (signal === 'short') {
    if (pos < 0) return none;
    const canOpen = mode !== 'long';
    return { close: pos > 0, open: canOpen ? 'short' : null };
  }
  return none;
}

/** USD notional -> base size string, rounded down to the market's size step. */
export function sizeFromUsd(usd, price, sizeDecimals) {
  const raw = Number(usd) / Number(price);
  if (!(raw > 0) || !Number.isFinite(raw)) return null;
  const f = 10 ** sizeDecimals;
  const s = Math.floor(raw * f + 1e-9) / f;
  return s > 0 ? s.toFixed(sizeDecimals) : null;
}

/** TP/SL trigger prices for an entry, from percentages (0 / empty = none). */
export function tpSlPrices(side, entry, tpPct, slPct, priceDecimals) {
  const long = side === 'long';
  const r = (v) => Number(v.toFixed(priceDecimals));
  return {
    tp: Number(tpPct) > 0 ? String(r(entry * (1 + (long ? 1 : -1) * tpPct / 100))) : '',
    sl: Number(slPct) > 0 ? String(r(entry * (1 - (long ? 1 : -1) * slPct / 100))) : '',
  };
}

/**
 * Safety limits. Returns a reason to stop, or null.
 * @param s { tradesToday, startEquity, equity, consecutiveErrors }
 */
export function riskStop(s, cfg) {
  if (cfg.maxTradesPerDay > 0 && s.tradesToday >= cfg.maxTradesPerDay) return `Daily trade limit reached (${cfg.maxTradesPerDay})`;
  if (cfg.maxLossUsd > 0 && Number.isFinite(s.startEquity) && Number.isFinite(s.equity) && s.startEquity - s.equity >= cfg.maxLossUsd) {
    return `Loss limit hit: down $${(s.startEquity - s.equity).toFixed(2)} since start`;
  }
  if (s.consecutiveErrors >= 3) return 'Stopped after 3 errors in a row';
  return null;
}

/** If a paper position's TP/SL was touched by a candle, the exit price and reason. SL checked first (conservative). */
export function tpSlHit(side, { tp, sl }, candle) {
  const long = side === 'long';
  if (sl && (long ? candle.low <= sl : candle.high >= sl)) return { price: Number(sl), reason: 'stop-loss' };
  if (tp && (long ? candle.high >= tp : candle.low <= tp)) return { price: Number(tp), reason: 'take-profit' };
  return null;
}

/**
 * Backtest a signal series. A signal on candle i fills at candle i+1's open (what the
 * live bot does: it waits for the candle to close). TP/SL checked intrabar.
 * Returns per-trade % returns (unleveraged) and summary stats.
 */
export function backtest(candles, signals, { mode = 'both', tpPct = 0, slPct = 0, feePct = 0 } = {}) {
  const trades = [];
  let pos = null; // { side, entry, entryTime, tp, sl }
  const close = (c, price, reason) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const ret = (dir * (price - pos.entry)) / pos.entry * 100 - 2 * feePct;
    trades.push({ side: pos.side, entryTime: pos.entryTime, entry: pos.entry, exitTime: c.time, exit: price, retPct: ret, reason });
    pos = null;
  };
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const hit = tpSlHit(pos.side, pos, c);
      if (hit && c.time > pos.entryTime) close(c, hit.price, hit.reason);
    }
    const sig = signals[i - 1];
    if (!sig) continue;
    const a = decideAction(sig, pos ? (pos.side === 'long' ? 1 : -1) : 0, mode);
    if (a.close && pos) close(c, c.open, 'signal');
    if (a.open && !pos) {
      const levels = tpSlPrices(a.open, c.open, tpPct, slPct, 10);
      pos = { side: a.open, entry: c.open, entryTime: c.time, tp: Number(levels.tp) || 0, sl: Number(levels.sl) || 0 };
      const hit = tpSlHit(pos.side, pos, c); // can hit inside the entry candle
      if (hit) close(c, hit.price, hit.reason);
    }
  }
  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + t.retPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak * 100);
  }
  const wins = trades.filter((t) => t.retPct > 0).length;
  return {
    trades,
    openPosition: pos,
    count: trades.length,
    winRate: trades.length ? wins / trades.length : null,
    totalReturnPct: equity - 100,
    maxDrawdownPct: maxDd,
  };
}
