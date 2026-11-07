import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import {
  buildEntryWithTpSl, buildOrder, marketOrderPrice, maxLeverage, pnlAt, validateSize, validateTpSl,
} from '../lighter/orders.js';
import { INTEGRATOR, MARGIN_MODE, NETWORK } from '../lighter/config.js';
import { shortErr } from '../lighter/useLighter.js';
import { fmtNum, fmtUsd, roundTo } from '../lighter/units.js';

export default function OrderForm({ market, book, lighter, presetPrice, sideRequest }) {
  const { isConnected } = useAccount();
  const [side, setSide] = useState('buy');
  const [tpslOn, setTpslOn] = useState(false);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [kind, setKind] = useState('market');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [slippagePct, setSlippagePct] = useState('0.5');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null);

  const position = lighter.account?.positions?.find((p) => p.market_id === market?.market_id);
  const currentLev = position && Number(position.initial_margin_fraction) > 0
    ? Math.round(100 / Number(position.initial_margin_fraction))
    : market ? Math.round(10000 / Number(market.default_initial_margin_fraction)) : 1;
  const [leverage, setLeverage] = useState(currentLev);

  useEffect(() => setLeverage(currentLev), [currentLev, market?.market_id]);
  useEffect(() => {
    setPrice('');
    setSize('');
    setTp('');
    setSl('');
    setMsg(null);
  }, [market?.market_id]);
  useEffect(() => {
    if (sideRequest) setSide(sideRequest.side);
  }, [sideRequest]);
  useEffect(() => {
    if (presetPrice) {
      setKind('limit');
      setPrice(presetPrice.price);
    }
  }, [presetPrice]);

  const isAsk = side === 'sell';
  const refPrice = useMemo(() => {
    if (kind === 'limit' && Number(price) > 0) return Number(price);
    const top = isAsk ? book.bids[0] : book.asks[0];
    return top ? Number(top.price) : Number(market?.mark_price);
  }, [kind, price, isAsk, book, market]);

  if (!market) return <div className="panel form-panel" />;

  const available = Number(lighter.account?.available_balance ?? 0);
  const notional = Number(size) * refPrice;
  const margin = notional / leverage;
  const sizeError = size ? validateSize(market, size, refPrice) : null;
  const maxLev = maxLeverage(market);
  const isLong = !isAsk;
  const tpslError = tpslOn && (tp || sl) ? validateTpSl({ isLong, refPrice, tp, sl }) : null;
  const pctFrom = (p) => (Number(p) > 0 && refPrice ? ((Number(p) / refPrice - 1) * 100 * (isLong ? 1 : -1)) : null);
  const tpPnl = Number(tp) > 0 && Number(size) > 0 ? pnlAt({ isLong, entryPrice: refPrice, exitPrice: tp, size }) : null;
  const slPnl = Number(sl) > 0 && Number(size) > 0 ? pnlAt({ isLong, entryPrice: refPrice, exitPrice: sl, size }) : null;

  const setPct = (pct) => {
    if (!refPrice || !available) return;
    setSize(roundTo((available * leverage * pct) / refPrice, market.size_decimals, 'down'));
  };

  const submit = async () => {
    setMsg(null);
    const err = validateSize(market, size, refPrice);
    if (err) return setMsg({ type: 'error', text: err });
    if (kind === 'limit' && !(Number(price) > 0)) return setMsg({ type: 'error', text: 'Enter a limit price' });
    setSubmitting(true);
    try {
      const px = kind === 'market'
        ? await marketOrderPrice(market, isAsk, Number(slippagePct) / 100)
        : price;
      const entryParams = { isAsk, size, price: px, kind, reduceOnly, postOnly };
      const withTpSl = tpslOn && (tp || sl);
      if (withTpSl) {
        const err2 = validateTpSl({ isLong, refPrice, tp, sl });
        if (err2) throw new Error(err2);
        await lighter.placeGroupedOrders(buildEntryWithTpSl(market, entryParams, { tp, sl }));
      } else {
        await lighter.placeOrder(buildOrder(market, entryParams));
      }
      setMsg({
        type: 'ok',
        text: `${side === 'buy' ? 'Buy' : 'Sell'} ${size} ${market.symbol} submitted${withTpSl ? ' with TP/SL' : ''}`,
      });
      setSize('');
      setTp('');
      setSl('');
    } catch (e) {
      setMsg({ type: 'error', text: shortErr(e) });
    } finally {
      setSubmitting(false);
    }
  };

  const applyLeverage = async () => {
    setMsg(null);
    setSubmitting(true);
    try {
      await lighter.updateLeverage(market.market_id, leverage, MARGIN_MODE.CROSS);
      setMsg({ type: 'ok', text: `Leverage set to ${leverage}x` });
    } catch (e) {
      setMsg({ type: 'error', text: shortErr(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="panel form-panel">
      <div className="seg">
        <button className={`seg-btn buy ${side === 'buy' ? 'active' : ''}`} onClick={() => setSide('buy')}>Buy / Long</button>
        <button className={`seg-btn sell ${side === 'sell' ? 'active' : ''}`} onClick={() => setSide('sell')}>Sell / Short</button>
      </div>

      <div className="tabs">
        {['market', 'limit'].map((k) => (
          <button key={k} className={`tab ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>

      {kind === 'limit' && (
        <label className="field">
          <span>Price (USD)</span>
          <input inputMode="decimal" value={price} placeholder={fmtNum(refPrice, market.price_decimals)}
            onChange={(e) => setPrice(e.target.value)} />
        </label>
      )}

      <label className="field">
        <span>Size ({market.symbol})</span>
        <input inputMode="decimal" value={size} placeholder={`min ${market.min_base_amount}`}
          onChange={(e) => setSize(e.target.value)} />
      </label>
      <div className="pct-row">
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <button key={p} className="chip" onClick={() => setPct(p)} disabled={!available}>{p * 100}%</button>
        ))}
      </div>

      <div className="field">
        <span>Leverage: <strong>{leverage}x</strong> {leverage !== currentLev && <em className="muted">(current {currentLev}x)</em>}</span>
        <div className="lev-row">
          <input type="range" min={1} max={maxLev} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
          <button className="chip" disabled={leverage === currentLev || lighter.status !== 'ready' || submitting} onClick={applyLeverage}>Set</button>
        </div>
      </div>

      <div className="checks">
        <label><input type="checkbox" checked={tpslOn} onChange={(e) => setTpslOn(e.target.checked)} /> TP/SL</label>
        <label><input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Reduce only</label>
        {kind === 'limit' && (
          <label><input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} /> Post only</label>
        )}
        {kind === 'market' && (
          <label className="slip">Slippage
            <input inputMode="decimal" value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} />%
          </label>
        )}
      </div>

      {tpslOn && (
        <div className="tpsl-grid">
          <label className="field">
            <span>Take profit {pctFrom(tp) !== null && <em className="up">+{pctFrom(tp).toFixed(2)}%</em>}</span>
            <input inputMode="decimal" value={tp} placeholder="Trigger price" onChange={(e) => setTp(e.target.value)} />
            {tpPnl !== null && <small className={tpPnl >= 0 ? 'up' : 'down'}>≈ {fmtUsd(tpPnl)}</small>}
          </label>
          <label className="field">
            <span>Stop loss {pctFrom(sl) !== null && <em className="down">{pctFrom(sl).toFixed(2)}%</em>}</span>
            <input inputMode="decimal" value={sl} placeholder="Trigger price" onChange={(e) => setSl(e.target.value)} />
            {slPnl !== null && <small className={slPnl >= 0 ? 'up' : 'down'}>≈ {fmtUsd(slPnl)}</small>}
          </label>
        </div>
      )}

      <dl className="summary">
        <dt>Order value</dt><dd>{notional ? fmtUsd(notional) : '—'}</dd>
        <dt>Margin required</dt><dd>{notional ? fmtUsd(margin) : '—'}</dd>
        <dt>Available</dt><dd>{lighter.account ? fmtUsd(available) : '—'}</dd>
        <dt>Fees (taker / maker)</dt>
        <dd>
          {(Number(market.taker_fee)).toFixed(4)}% / {(Number(market.maker_fee)).toFixed(4)}%
          {INTEGRATOR && <span className="muted"> + {(INTEGRATOR.takerFee / 1e4).toFixed(3)}% / {(INTEGRATOR.makerFee / 1e4).toFixed(3)}% app</span>}
        </dd>
      </dl>

      <ActionButton
        isConnected={isConnected}
        lighter={lighter}
        disabled={submitting || !!sizeError || !!tpslError}
        label={submitting ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${market.symbol}`}
        side={side}
        onSubmit={submit}
      />

      {(sizeError || tpslError || msg || lighter.error) && (
        <div className={`msg ${msg?.type === 'ok' && !sizeError && !tpslError ? 'ok' : 'error'}`}>
          {sizeError || tpslError || msg?.text || lighter.error}
        </div>
      )}
    </div>
  );
}

function ActionButton({ isConnected, lighter, disabled, label, side, onSubmit }) {
  if (!isConnected) return <div className="hint">Connect a wallet to trade.</div>;
  switch (lighter.status) {
    case 'loading':
      return <button className="btn btn-block" disabled>Loading account…</button>;
    case 'no-account':
      return (
        <div className="hint">
          This wallet has no Lighter account yet. Deposit USDC on{' '}
          <a href={NETWORK.app} target="_blank" rel="noreferrer">Lighter</a> first, then come back.
        </div>
      );
    case 'needs-key':
      return (
        <button className="btn btn-primary btn-block" disabled={lighter.busy} onClick={lighter.enableTrading}>
          {lighter.busy ? 'Waiting for signature…' : 'Enable trading (1 signature)'}
        </button>
      );
    case 'needs-integrator':
      return (
        <button className="btn btn-primary btn-block" disabled={lighter.busy} onClick={lighter.approveIntegrator}>
          {lighter.busy ? 'Waiting for signature…' : 'Approve app fee (1 signature)'}
        </button>
      );
    case 'ready':
      return (
        <button className={`btn btn-block btn-${side}`} disabled={disabled} onClick={onSubmit}>
          {label}
        </button>
      );
    default:
      return <div className="hint">Something went wrong loading your account. Reload the page.</div>;
  }
}
