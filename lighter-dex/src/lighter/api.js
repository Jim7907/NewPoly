// Thin client for Lighter's public REST API. The API sends CORS headers, so the
// browser talks to it directly — no backend needed.
// Reference: https://apidocs.lighter.xyz  (OpenAPI: elliottech/lighter-python/openapi.json)
import { NETWORK } from './config.js';
import { buildMarketList } from './markets.js';

export class LighterApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function request(path, { params, method = 'GET', form, headers } = {}) {
  const url = new URL(`/api/v1/${path}`, NETWORK.api);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const init = { method, headers: { ...headers } };
  if (form) {
    init.body = new URLSearchParams(form);
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, init);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new LighterApiError(`HTTP ${res.status} from ${path}`, res.status);
  }
  // Lighter uses code 200 for success, everything else is an error.
  if (!res.ok || (data.code !== undefined && data.code !== 200)) {
    throw new LighterApiError(data.message || `HTTP ${res.status} from ${path}`, data.code ?? res.status);
  }
  return data;
}

// ---- market data (public) ----

/** Every active market: perps and spot (see markets.js for the normalized shape). */
export async function getMarkets() {
  return buildMarketList(await request('orderBookDetails'));
}

export async function getMarket(marketId) {
  const d = await request('orderBookDetails', { params: { market_id: marketId } });
  return d.order_book_details?.[0];
}

/** REST returns individual resting orders; aggregate them into price levels. */
export async function getOrderBook(marketId, limit = 100) {
  const d = await request('orderBookOrders', { params: { market_id: marketId, limit } });
  const levels = (orders) => {
    const m = new Map();
    for (const o of orders ?? []) {
      m.set(o.price, (m.get(o.price) ?? 0) + Number(o.remaining_base_amount));
    }
    return [...m].map(([price, size]) => ({ price, size: String(size) }));
  };
  return { asks: levels(d.asks), bids: levels(d.bids) };
}

export async function getRecentTrades(marketId, limit = 40) {
  const d = await request('recentTrades', { params: { market_id: marketId, limit } });
  return d.trades ?? [];
}

const RES_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
export const RESOLUTIONS = Object.keys(RES_MS);

export async function getCandles(marketId, resolution = '15m', count = 300) {
  const end = Date.now();
  const d = await request('candles', {
    params: {
      market_id: marketId,
      resolution,
      start_timestamp: end - RES_MS[resolution] * count,
      end_timestamp: end,
      count_back: count,
    },
  });
  // Zero values are omitted by the API; a missing price field must not become a 0 wick.
  return (d.c ?? [])
    .map((c) => {
      const close = c.c ?? c.o;
      const open = c.o ?? close;
      return {
        time: Math.floor(c.t / 1000),
        open,
        high: c.h ?? Math.max(open, close),
        low: c.l ?? Math.min(open, close),
        close,
        volume: c.v ?? 0,
      };
    })
    .filter((c) => c.open !== undefined && c.close !== undefined);
}

// ---- accounts ----

/** Returns the master account index for an Ethereum address, or null if the address never deposited. */
export async function getAccountIndexByAddress(address) {
  try {
    const d = await request('accountsByL1Address', { params: { l1_address: address } });
    const subs = d.sub_accounts ?? [];
    if (!subs.length) return null;
    return subs.reduce((min, a) => (Number(a.index) < Number(min.index) ? a : min)).index;
  } catch (e) {
    if (e instanceof LighterApiError && /not found/i.test(e.message)) return null;
    throw e;
  }
}

export async function getAccount(accountIndex) {
  const d = await request('account', { params: { by: 'index', value: accountIndex } });
  return d.accounts?.[0] ?? null;
}

/** Public key registered for (account, apiKeyIndex), or null. */
export async function getApiKeyPublicKey(accountIndex, apiKeyIndex) {
  const d = await request('apikeys', { params: { account_index: accountIndex, api_key_index: apiKeyIndex } });
  const k = (d.api_keys ?? []).find((x) => Number(x.api_key_index) === Number(apiKeyIndex));
  return k?.public_key ?? null;
}

export async function getNextNonce(accountIndex, apiKeyIndex) {
  const d = await request('nextNonce', { params: { account_index: accountIndex, api_key_index: apiKeyIndex } });
  return Number(d.nonce);
}

export async function getActiveOrders(accountIndex, authToken, marketId) {
  const d = await request('accountActiveOrders', {
    params: { account_index: accountIndex, market_id: marketId ?? 255 },
    headers: { authorization: authToken },
  });
  return d.orders ?? [];
}

// ---- transactions ----

export async function sendTx(txType, txInfo) {
  return request('sendTx', { method: 'POST', form: { tx_type: String(txType), tx_info: txInfo } });
}

// ---- history (auth) ----

/** Account fills, newest first. Pass `cursor` from the previous page to load more. */
export async function getAccountTrades(accountIndex, authToken, { cursor, limit = 50 } = {}) {
  const d = await request('trades', {
    params: { account_index: accountIndex, sort_by: 'timestamp', sort_dir: 'desc', limit, cursor },
    headers: { authorization: authToken },
  });
  return { trades: d.trades ?? [], nextCursor: d.next_cursor || null };
}

export async function getPositionFunding(accountIndex, authToken, { cursor, limit = 50 } = {}) {
  const d = await request('positionFunding', {
    params: { account_index: accountIndex, limit, cursor },
    headers: { authorization: authToken },
  });
  return { fundings: d.position_fundings ?? [], nextCursor: d.next_cursor || null };
}

/** Daily account PnL series (cumulative values), oldest first. */
export async function getPnlSeries(accountIndex, authToken, days = 30) {
  const end = Math.floor(Date.now() / 1000);
  const d = await request('pnl', {
    params: {
      by: 'index', value: accountIndex, resolution: '1d',
      start_timestamp: end - days * 86400, end_timestamp: end, count_back: days,
    },
    headers: { authorization: authToken },
  });
  return d.pnl ?? [];
}

/** Integrator ("partner") earnings for an account index; public. */
export async function getPartnerStats(accountIndex) {
  return request('partnerStats', { params: { account_index: accountIndex } });
}
