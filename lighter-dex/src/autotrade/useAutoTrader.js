// Browser-run auto-trader. Runs while the app is open, signs with the user's own
// in-browser key (nothing is sent to any server but Lighter). Every TICK_MS it:
//   1. loads candles for the chosen market/timeframe
//   2. runs the chosen indicator script (sandboxed worker) to get its signals
//   3. acts once per new *closed* candle with a signal (open / close / reverse)
//   4. enforces limits (trades/day, loss limit, error streak) and stops if hit
// Paper mode simulates fills at the candle close and never touches the account.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lighter/api.js';
import { runIndicator } from '../indicators/runner.js';
import { buildEntryWithTpSl, buildOrder, marketOrderPrice, validateSize } from '../lighter/orders.js';
import { shortErr } from '../lighter/useLighter.js';
import { decideAction, lastClosedSignal, riskStop, sizeFromUsd, tpSlHit, tpSlPrices } from './engine.js';

const CONFIG_KEY = 'lighter-dex:autotrade:v1';
const LOG_KEY = 'lighter-dex:autotrade-log:v1';
const TICK_MS = 15000;
const ENTRY_SLIPPAGE = 0.005;
const EXIT_SLIPPAGE = 0.01;

export const DEFAULT_CONFIG = {
  indicatorId: 'ema-cross',
  marketId: 0,
  resolution: '15m',
  mode: 'both',
  sizeUsd: 50,
  tpPct: 2,
  slPct: 1,
  maxTradesPerDay: 10,
  maxLossUsd: 25,
  live: false,
};

const store = {
  get(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
  },
};

const utcDay = () => new Date().toISOString().slice(0, 10);

export function useAutoTrader({ lighter, markets, indicators }) {
  const [config, setConfigState] = useState(() => ({ ...DEFAULT_CONFIG, ...store.get(CONFIG_KEY, {}), live: false }));
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Stopped');
  const [log, setLog] = useState(() => store.get(LOG_KEY, []));
  const [paper, setPaper] = useState({ side: null, size: 0, entry: 0, entryTime: 0, tp: 0, sl: 0, realized: 0, trades: 0 });

  const rt = useRef({});
  const latest = useRef({});
  latest.current = { lighter, markets, indicators, config, paper };

  const setConfig = useCallback((patch) => {
    setConfigState((c) => {
      const next = { ...c, ...patch };
      store.set(CONFIG_KEY, { ...next, live: false }); // never auto-resume live mode
      return next;
    });
  }, []);

  const addLog = useCallback((type, text) => {
    setLog((l) => {
      const next = [{ t: Date.now(), type, text }, ...l].slice(0, 200);
      store.set(LOG_KEY, next);
      return next;
    });
  }, []);

  const releaseWakeLock = () => {
    rt.current.wakeLock?.release?.().catch(() => {});
    rt.current.wakeLock = null;
  };
  const acquireWakeLock = async () => {
    try {
      if ('wakeLock' in navigator && !rt.current.wakeLock) rt.current.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not supported or denied — the UI warns to keep the screen on */ }
  };

  const stop = useCallback((reason) => {
    clearTimeout(rt.current.timer);
    rt.current.active = false;
    releaseWakeLock();
    setRunning(false);
    setStatus(reason ? `Stopped: ${reason}` : 'Stopped');
    addLog(reason ? 'warn' : 'info', reason ? `Bot stopped — ${reason}` : 'Bot stopped');
  }, [addLog]);

  // ---------- one iteration ----------
  const tick = useCallback(async () => {
    const { lighter: L, markets: M, indicators: I, config: cfg } = latest.current;
    const r = rt.current;
    const market = M.find((m) => m.market_id === Number(cfg.marketId));
    const ind = I.list.find((i) => i.id === cfg.indicatorId);
    if (!market) throw new Error('Market not available');
    if (!ind) throw new Error('Strategy indicator was deleted');
    if (cfg.live && L.status !== 'ready') throw new Error('Wallet disconnected or trading not enabled');

    const candles = await api.getCandles(market.market_id, cfg.resolution, 300);
    const result = await runIndicator(ind.code, candles, ind.inputs);
    if (!result.signals) throw new Error(`"${ind.name}" returns no signals — it can't drive the bot`);
    const now = Math.floor(Date.now() / 1000);
    const last = lastClosedSignal(candles, result.signals, cfg.resolution, now);
    if (!last) return;
    const price = candles.at(-1).close;
    r.formingCandleTime = candles.at(-1).time;

    // paper TP/SL: current price, plus any candle that started after the entry candle
    if (!cfg.live) {
      const p = latest.current.paper;
      if (p.side) {
        const bars = [{ high: price, low: price }, ...candles.filter((x) => x.time > p.entryTime)];
        for (const c of bars) {
          const hit = tpSlHit(p.side, p, c);
          if (hit) {
            closePaper(hit.price, hit.reason);
            break;
          }
        }
      }
    }

    // equity for the loss limit
    let equity;
    let position = 0;
    if (cfg.live) {
      const acct = await api.getAccount(L.accountIndex);
      equity = Number(acct?.total_asset_value);
      const pos = acct?.positions?.find((x) => x.market_id === market.market_id);
      position = pos ? Number(pos.position) * (pos.sign > 0 ? 1 : -1) : 0;
    } else {
      const p = latest.current.paper;
      const unreal = p.side ? (price - p.entry) * p.size * (p.side === 'long' ? 1 : -1) : 0;
      equity = p.realized + unreal;
      position = p.side ? (p.side === 'long' ? p.size : -p.size) : 0;
    }
    if (r.startEquity === undefined) r.startEquity = equity;
    if (r.day !== utcDay()) {
      r.day = utcDay();
      r.tradesToday = 0;
    }
    const why = riskStop({ tradesToday: r.tradesToday, startEquity: r.startEquity, equity, consecutiveErrors: r.errors }, cfg);
    if (why) return stop(why);

    if (r.lastActed === undefined) {
      r.lastActed = last.time;
      addLog('info', `Watching ${market.symbol} ${cfg.resolution} with "${ind.name}" — acting on the next new signal`);
      setStatus('Waiting for a new signal');
      return;
    }
    if (last.time <= r.lastActed) {
      setStatus(`Waiting for a new signal · last check ${new Date().toLocaleTimeString([], { hour12: false })}`);
      return;
    }
    r.lastActed = last.time;
    if (!last.signal) return;

    const action = decideAction(last.signal, position, cfg.mode);
    if (!action.close && !action.open) {
      addLog('info', `${last.signal.toUpperCase()} signal — no action (already positioned / mode ${cfg.mode})`);
      return;
    }
    await execute(market, action, position, last.close, cfg);
    r.tradesToday++;
    setStatus(`Acted on ${last.signal.toUpperCase()} signal · ${r.tradesToday} trade(s) today`);
  }, [addLog, stop]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- order execution ----------
  function closePaper(exitPrice, reason) {
    const p = latest.current.paper;
    if (!p.side) return;
    const pnl = (exitPrice - p.entry) * p.size * (p.side === 'long' ? 1 : -1);
    addLog('paper', `Paper close ${p.side} ${p.size} @ ${exitPrice} (${reason}) → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    const next = { ...p, side: null, size: 0, entry: 0, tp: 0, sl: 0, realized: p.realized + pnl, trades: p.trades + 1 };
    latest.current.paper = next;
    setPaper(next);
  }

  // TP/SL legs from a previous bot trade must not fire on the next position.
  async function cancelLeftoverTpSl(market) {
    const L = latest.current.lighter;
    const orders = await api.getActiveOrders(L.accountIndex, await L.getAuthToken(), market.market_id);
    const stale = orders.filter((o) => o.reduce_only && (Number(o.trigger_price) > 0 || /stop|take|profit/i.test(o.type ?? '')));
    for (const o of stale) await L.cancelOrder(o.market_index, o.order_index);
    if (stale.length) addLog('info', `Cancelled ${stale.length} leftover TP/SL order(s) on ${market.symbol}`);
  }

  async function execute(market, action, position, refPrice, cfg) {
    const { lighter: L } = latest.current;
    const sym = market.symbol;

    if (action.close && position !== 0) {
      if (cfg.live) {
        const isAsk = position > 0;
        const px = await marketOrderPrice(market, isAsk, EXIT_SLIPPAGE);
        await L.placeOrder(buildOrder(market, { isAsk, size: String(Math.abs(position)), price: px, kind: 'market', reduceOnly: true }));
        addLog('trade', `Closed ${position > 0 ? 'long' : 'short'} ${Math.abs(position)} ${sym} (market)`);
      } else {
        closePaper(refPrice, 'signal');
      }
    }

    if (action.open) {
      if (cfg.live) await cancelLeftoverTpSl(market);
      const size = sizeFromUsd(cfg.sizeUsd, refPrice, market.size_decimals);
      const err = size ? validateSize(market, size, refPrice) : `$${cfg.sizeUsd} is too small for ${sym}`;
      if (err) throw new Error(err);
      const levels = tpSlPrices(action.open, refPrice, cfg.tpPct, cfg.slPct, market.price_decimals);
      const isAsk = action.open === 'short';
      if (cfg.live) {
        const px = await marketOrderPrice(market, isAsk, ENTRY_SLIPPAGE);
        const params = { isAsk, size, price: px, kind: 'market' };
        if (levels.tp || levels.sl) await L.placeGroupedOrders(buildEntryWithTpSl(market, params, levels));
        else await L.placeOrder(buildOrder(market, params));
        addLog('trade', `Opened ${action.open} ${size} ${sym} (~$${cfg.sizeUsd})${levels.tp ? ` TP ${levels.tp}` : ''}${levels.sl ? ` SL ${levels.sl}` : ''}`);
      } else {
        const next = {
          ...latest.current.paper, side: action.open, size: Number(size), entry: refPrice, entryTime: rt.current.formingCandleTime ?? 0,
          tp: Number(levels.tp) || 0, sl: Number(levels.sl) || 0,
        };
        latest.current.paper = next;
        setPaper(next);
        addLog('paper', `Paper open ${action.open} ${size} ${sym} @ ${refPrice}${levels.tp ? ` TP ${levels.tp}` : ''}${levels.sl ? ` SL ${levels.sl}` : ''}`);
      }
    }
  }

  // ---------- loop ----------
  const loop = useCallback(async () => {
    const r = rt.current;
    if (!r.active || r.busy) return; // never two iterations at once
    r.busy = true;
    try {
      await tick();
      r.errors = 0;
    } catch (e) {
      r.errors = (r.errors ?? 0) + 1;
      addLog('error', shortErr(e));
      setStatus(`Error: ${shortErr(e)}`);
      if (r.errors >= 3) {
        r.busy = false;
        return stop('3 errors in a row');
      }
    } finally {
      r.busy = false;
    }
    if (r.active) {
      clearTimeout(r.timer);
      r.timer = setTimeout(loop, TICK_MS);
    }
  }, [tick, addLog, stop]);

  const start = useCallback(() => {
    const { lighter: L, config: cfg } = latest.current;
    if (cfg.live && L.status !== 'ready') {
      setStatus('Enable trading first (connect wallet → Enable trading)');
      return;
    }
    rt.current = { active: true, errors: 0, tradesToday: 0, day: utcDay() };
    if (!cfg.live) {
      const fresh = { side: null, size: 0, entry: 0, entryTime: 0, tp: 0, sl: 0, realized: 0, trades: 0 };
      latest.current.paper = fresh;
      setPaper(fresh);
    }
    setRunning(true);
    setStatus('Starting…');
    addLog('info', `Bot started (${cfg.live ? 'LIVE — real orders' : 'paper mode'})`);
    acquireWakeLock();
    loop();
  }, [addLog, loop]);

  // keep the screen awake while running; stop live bot if the wallet goes away
  useEffect(() => {
    const onVis = () => {
      if (!rt.current.active) return;
      if (document.visibilityState === 'visible') {
        acquireWakeLock();
        clearTimeout(rt.current.timer);
        loop(); // catch up immediately after returning to the app
      } else {
        addLog('warn', 'App went to the background — the browser may pause the bot until you come back');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [loop, addLog]);

  useEffect(() => {
    if (running && config.live && lighter.status !== 'ready') stop('wallet disconnected');
  }, [lighter.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    clearTimeout(rt.current.timer);
    rt.current.active = false;
    releaseWakeLock();
  }, []);

  const clearLog = () => {
    setLog([]);
    store.set(LOG_KEY, []);
  };

  return { config, setConfig, running, status, log, paper, start, stop: () => stop(), clearLog };
}
