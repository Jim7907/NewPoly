import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const CODE_KEY = 'lighter-dex:alerts-code';

function getCode() {
  try {
    let c = localStorage.getItem(CODE_KEY);
    if (!c) {
      c = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(CODE_KEY, c);
    }
    return c;
  } catch {
    return null;
  }
}

async function call(path, { method = 'GET', body, code } = {}) {
  const url = `/alerts-api${path}${code ? `${path.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('Alerts service unavailable'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export default function Alerts({ lighter, markets }) {
  const [code] = useState(getCode);
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['alerts-health'], queryFn: () => call('/health'), retry: false, staleTime: 60000 });
  const enabled = !!health.data?.enabled && !!code;
  const link = useQuery({
    queryKey: ['alerts-link', code],
    queryFn: () => call('/link', { code }),
    enabled,
    refetchInterval: (q) => (q.state.data?.linked ? false : 3000),
  });
  const list = useQuery({
    queryKey: ['alerts', code],
    queryFn: () => call('/alerts', { code }),
    enabled: enabled && !!link.data?.linked,
    refetchInterval: 15000,
  });

  const [marketId, setMarketId] = useState(markets?.[0]?.market_id ?? 0);
  const [op, setOp] = useState('above');
  const [price, setPrice] = useState('');
  const [pct, setPct] = useState('5');
  const [msg, setMsg] = useState(null);
  const market = markets.find((m) => m.market_id === Number(marketId));

  if (health.isLoading) return <div className="empty muted">Checking alerts service…</div>;
  if (!health.data?.enabled) {
    return (
      <div className="empty muted">
        Telegram alerts aren&apos;t switched on for this server yet.<br />
        Server owner: create a bot with @BotFather and redeploy with <code>TELEGRAM_BOT_TOKEN=…</code> (see README).
      </div>
    );
  }
  if (!code) return <div className="empty muted">Your browser blocks local storage, which alerts need.</div>;

  if (!link.data?.linked) {
    return (
      <div className="alerts-connect">
        <p>Get a Telegram message when a price is hit or a position gets close to liquidation — even when this page is closed.</p>
        <a className="btn btn-primary" href={link.data?.botUrl} target="_blank" rel="noreferrer">Connect Telegram</a>
        <p className="muted small">Opens Telegram → tap <b>Start</b>. This page updates automatically once linked.</p>
      </div>
    );
  }

  const create = async (body) => {
    setMsg(null);
    try {
      await call('/alerts', { method: 'POST', body: { ...body, code } });
      qc.invalidateQueries({ queryKey: ['alerts', code] });
      setMsg({ ok: true, text: 'Alert created' });
      setPrice('');
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };
  const remove = async (id) => {
    await call(`/alerts/${id}`, { method: 'DELETE', code }).catch(() => {});
    qc.invalidateQueries({ queryKey: ['alerts', code] });
  };

  const alerts = list.data?.alerts ?? [];
  return (
    <div className="alerts">
      <div className="alert-forms">
        <div className="alert-form">
          <div className="section-title">Price alert</div>
          <div className="row-gap">
            <select className="input" value={marketId} onChange={(e) => setMarketId(e.target.value)}>
              {markets.map((m) => <option key={m.market_id} value={m.market_id}>{m.label}</option>)}
            </select>
            <select className="input" value={op} onChange={(e) => setOp(e.target.value)}>
              <option value="above">rises to ≥</option>
              <option value="below">falls to ≤</option>
            </select>
            <input className="input" inputMode="decimal" placeholder={market ? `now ${market.mark_price}` : 'Price'} value={price} onChange={(e) => setPrice(e.target.value)} />
            <button className="btn btn-primary" disabled={!(Number(price) > 0)} onClick={() => create({ type: 'price', marketId: Number(marketId), symbol: market?.symbol, op, price: Number(price) })}>
              Add
            </button>
          </div>
        </div>
        <div className="alert-form">
          <div className="section-title">Liquidation warning</div>
          {lighter.accountIndex === null ? (
            <p className="muted small">Connect a wallet with a Lighter account to watch your positions.</p>
          ) : (
            <div className="row-gap">
              <span className="muted">Warn when any position is within</span>
              <input className="input input-sm" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
              <span className="muted">% of liquidation</span>
              <button className="btn btn-primary" onClick={() => create({ type: 'liq', accountIndex: Number(lighter.accountIndex), pct: Number(pct) })}>Add</button>
            </div>
          )}
        </div>
      </div>
      {msg && <div className={`msg ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      {alerts.length === 0 ? (
        <div className="empty muted">No alerts yet.</div>
      ) : (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <span>
                {a.type === 'price'
                  ? <>🔔 <b>{a.symbol}</b> {a.op === 'above' ? '≥' : '≤'} {a.price}</>
                  : <>⚠️ Liquidation within <b>{a.pct}%</b> (account {a.accountIndex})</>}
              </span>
              <button className="chip" onClick={() => remove(a.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
