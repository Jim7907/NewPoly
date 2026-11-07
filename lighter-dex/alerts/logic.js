// Pure alert logic (no I/O) so it can be unit-tested.

export const LIMITS = { perCode: 30, total: 5000 };
export const LIQ_COOLDOWN_MS = 60 * 60 * 1000;
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const isValidCode = (c) => typeof c === 'string' && CODE_RE.test(c);

/** Validates a create-alert request body. Returns { alert } or { error }. */
export function parseAlertRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  if (!isValidCode(body.code)) return { error: 'Invalid code' };
  if (body.type === 'price') {
    const marketId = Number(body.marketId);
    const price = Number(body.price);
    if (!Number.isInteger(marketId) || marketId < 0) return { error: 'Invalid market' };
    if (!(price > 0) || !Number.isFinite(price)) return { error: 'Invalid price' };
    if (body.op !== 'above' && body.op !== 'below') return { error: 'op must be above or below' };
    const symbol = String(body.symbol ?? marketId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20);
    return { alert: { type: 'price', code: body.code, marketId, symbol, op: body.op, price } };
  }
  if (body.type === 'liq') {
    const accountIndex = Number(body.accountIndex);
    const pct = Number(body.pct);
    if (!Number.isInteger(accountIndex) || accountIndex < 0) return { error: 'Invalid account' };
    if (!(pct > 0 && pct <= 50)) return { error: 'Distance must be between 0 and 50%' };
    return { alert: { type: 'liq', code: body.code, accountIndex, pct } };
  }
  return { error: 'Unknown alert type' };
}

/** True when a one-shot price alert should fire at this mark price. */
export function priceAlertHit(alert, mark) {
  if (!Number.isFinite(mark)) return false;
  return alert.op === 'above' ? mark >= alert.price : mark <= alert.price;
}

/**
 * Positions within `alert.pct` % of their liquidation price, skipping markets
 * warned about within the cooldown. Returns [{ marketId, symbol, mark, liq, distancePct, side }].
 */
export function liqWarnings(alert, account, marks, lastFired, now) {
  const out = [];
  for (const p of account?.positions ?? []) {
    const size = Number(p.position);
    const liq = Number(p.liquidation_price);
    const mark = marks.get(p.market_id);
    if (!size || !(liq > 0) || !Number.isFinite(mark) || mark <= 0) continue;
    const distancePct = (Math.abs(mark - liq) / mark) * 100;
    if (distancePct > alert.pct) continue;
    const key = `${alert.id}:${p.market_id}`;
    if (lastFired[key] && now - lastFired[key] < LIQ_COOLDOWN_MS) continue;
    out.push({ key, marketId: p.market_id, symbol: p.symbol, mark, liq, distancePct, side: p.sign > 0 ? 'long' : 'short' });
  }
  return out;
}

export function describeAlert(a) {
  if (a.type === 'price') return `${a.symbol} ${a.op === 'above' ? '≥' : '≤'} ${a.price}`;
  return `Liquidation warning: account ${a.accountIndex} within ${a.pct}%`;
}
