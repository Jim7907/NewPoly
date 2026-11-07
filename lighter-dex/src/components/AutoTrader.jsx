import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from '../lighter/api.js';
import { runIndicator } from '../indicators/runner.js';
import { backtest } from '../autotrade/engine.js';
import { fmtUsd } from '../lighter/units.js';

const RESOLUTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'];

export default function AutoTrader({ bot, lighter, markets, indicators }) {
  const { config: cfg, setConfig, running } = bot;
  const [confirmLive, setConfirmLive] = useState(false);
  const ind = indicators.list.find((i) => i.id === cfg.indicatorId);
  const market = markets.find((m) => m.market_id === Number(cfg.marketId));

  // Backtest preview on the last 300 candles with the current settings
  const preview = useQuery({
    queryKey: ['bt', cfg.marketId, cfg.resolution, ind?.code, JSON.stringify(ind?.inputs), cfg.mode, cfg.tpPct, cfg.slPct],
    enabled: !!ind && !!market,
    staleTime: 60000,
    retry: false,
    queryFn: async () => {
      const candles = await api.getCandles(market.market_id, cfg.resolution, 300);
      const r = await runIndicator(ind, candles, { priceDecimals: market.price_decimals, resolution: cfg.resolution, ticker: market.symbol });
      if (!r.signals) return { noSignals: true };
      return { ...backtest(candles, r.signals, { mode: cfg.mode, tpPct: cfg.tpPct, slPct: cfg.slPct }), from: candles[0]?.time };
    },
  });
  const bt = preview.data;

  const num = (k) => ({
    value: cfg[k],
    disabled: running,
    inputMode: 'decimal',
    onChange: (e) => setConfig({ [k]: e.target.value === '' ? '' : Number(e.target.value) }),
  });

  const canStart = !!ind && !!market && bt && !bt.noSignals && (!cfg.live || (confirmLive && lighter.status === 'ready'));

  return (
    <div className="bot">
      <div className="bot-grid">
        <div className="bot-card">
          <div className="section-title">Strategy</div>
          <label className="field">
            <span>Indicator (must output signals)</span>
            <select className="input" value={cfg.indicatorId} disabled={running} onChange={(e) => setConfig({ indicatorId: e.target.value })}>
              {indicators.list.map((i) => (
                <option key={i.id} value={i.id}>{i.name}{i.builtin ? '' : ' (custom)'}</option>
              ))}
            </select>
          </label>
          {ind && Object.keys(ind.inputs ?? {}).length > 0 && (
            <p className="muted small">
              Settings: {Object.entries(ind.inputs).map(([k, v]) => `${k} ${v}`).join(', ')} — change them under ƒx Indicators.
            </p>
          )}
          <div className="bot-row">
            <label className="field">
              <span>Market</span>
              <select className="input" value={cfg.marketId} disabled={running} onChange={(e) => setConfig({ marketId: Number(e.target.value) })}>
                {markets.filter((m) => m.kind === 'perp').map((m) => <option key={m.market_id} value={m.market_id}>{m.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Timeframe</span>
              <select className="input" value={cfg.resolution} disabled={running} onChange={(e) => setConfig({ resolution: e.target.value })}>
                {RESOLUTIONS.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Direction</span>
              <select className="input" value={cfg.mode} disabled={running} onChange={(e) => setConfig({ mode: e.target.value })}>
                <option value="both">Long & short</option>
                <option value="long">Long only</option>
                <option value="short">Short only</option>
              </select>
            </label>
          </div>
        </div>

        <div className="bot-card">
          <div className="section-title">Risk</div>
          <div className="bot-row">
            <label className="field"><span>Size per trade ($)</span><input className="input" {...num('sizeUsd')} /></label>
            <label className="field"><span>Take profit %</span><input className="input" {...num('tpPct')} placeholder="0 = off" /></label>
            <label className="field"><span>Stop loss %</span><input className="input" {...num('slPct')} placeholder="0 = off" /></label>
          </div>
          <div className="bot-row">
            <label className="field"><span>Max trades / day</span><input className="input" {...num('maxTradesPerDay')} /></label>
            <label className="field"><span>Stop if down ($)</span><input className="input" {...num('maxLossUsd')} /></label>
          </div>
          <p className="muted small">
            Size is the position value; margin used = size ÷ your leverage on {market?.symbol ?? 'the market'}. TP/SL are placed on
            Lighter with each entry, so they work even if the app closes. The bot manages the whole position on this market
            (including manual trades) and clears old TP/SL orders there before each new entry.
          </p>
        </div>

        <div className="bot-card">
          <div className="section-title">Backtest (last 300 candles)</div>
          {preview.isLoading ? (
            <p className="muted">Running…</p>
          ) : preview.error ? (
            <div className="msg error">{preview.error.message}</div>
          ) : bt?.noSignals ? (
            <div className="msg error">
              &quot;{ind?.name}&quot; gives no buy/sell signals, so it can&apos;t trade. Pick a strategy, or in your Pine script
              call <code>strategy.entry()</code>/<code>strategy.close()</code> or add <code>alertcondition(cond, &quot;Buy&quot;)</code> /
              <code>alertcondition(cond, &quot;Sell&quot;)</code>.
            </div>
          ) : bt ? (
            <>
              <div className="kpis compact">
                <div className="kpi"><div className="stat-label">Trades</div><div className="kpi-value">{bt.count}</div></div>
                <div className="kpi"><div className="stat-label">Win rate</div><div className="kpi-value">{bt.winRate === null ? '—' : `${Math.round(bt.winRate * 100)}%`}</div></div>
                <div className="kpi"><div className="stat-label">Return</div><div className={`kpi-value ${bt.totalReturnPct >= 0 ? 'up' : 'down'}`}>{bt.totalReturnPct >= 0 ? '+' : ''}{bt.totalReturnPct.toFixed(2)}%</div></div>
                <div className="kpi"><div className="stat-label">Max drawdown</div><div className="kpi-value down">-{bt.maxDrawdownPct.toFixed(2)}%</div></div>
              </div>
              <p className="muted small">Unleveraged, before fees/funding/slippage. Past results don&apos;t predict future ones.</p>
            </>
          ) : null}
        </div>
      </div>

      <div className="bot-card bot-run">
        <div className="seg">
          <button className={`seg-btn ${!cfg.live ? 'active paper' : ''}`} disabled={running} onClick={() => setConfig({ live: false })}>Paper (simulated)</button>
          <button className={`seg-btn ${cfg.live ? 'active sell' : ''}`} disabled={running} onClick={() => setConfig({ live: true })}>Live (real orders)</button>
        </div>
        {cfg.live && !running && (
          <label className="confirm">
            <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
            I understand the bot will place real orders with my funds while this app is open, and that I can lose money.
          </label>
        )}
        {cfg.live && lighter.status !== 'ready' && <div className="msg error">Connect your wallet and tap “Enable trading” first.</div>}
        {running ? (
          <button className="btn btn-block btn-sell" onClick={bot.stop}>■ Stop bot</button>
        ) : (
          <button className="btn btn-block btn-primary" disabled={!canStart} onClick={bot.start}>
            ▶ Start {cfg.live ? 'LIVE' : 'paper'} bot
          </button>
        )}
        <div className="bot-status">
          <span className={`dot ${running ? 'dot-live' : ''}`} /> {bot.status}
        </div>
        {!cfg.live && (bot.paper.trades > 0 || bot.paper.side) && (
          <div className="muted small">
            Paper: {bot.paper.side ? `${bot.paper.side} ${bot.paper.size} @ ${bot.paper.entry}` : 'flat'} · realized{' '}
            <span className={bot.paper.realized >= 0 ? 'up' : 'down'}>{fmtUsd(bot.paper.realized)}</span> · {bot.paper.trades} closed trades
          </div>
        )}
        <p className="muted small">
          Runs inside this app: keep it open with the screen on (the app asks your phone to stay awake). If you switch apps
          or lock the phone, the browser pauses the bot until you return. Open positions keep their TP/SL on Lighter.
        </p>
      </div>

      <div className="bot-card">
        <div className="panel-head bare">
          <span>Activity</span>
          {bot.log.length > 0 && <button className="link small" onClick={bot.clearLog}>Clear</button>}
        </div>
        {bot.log.length === 0 ? (
          <div className="muted small">Nothing yet.</div>
        ) : (
          <ul className="bot-log">
            {bot.log.slice(0, 60).map((l, i) => (
              <li key={`${l.t}-${i}`} className={`log-${l.type}`}>
                <span className="muted">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span> {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
