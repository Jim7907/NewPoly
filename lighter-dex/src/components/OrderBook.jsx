import { useMemo } from 'react';
import { fmtNum } from '../lighter/units.js';

const DEPTH = 10;

export default function OrderBook({ market, book, onPrice }) {
  const { asks, bids, maxTotal, spread } = useMemo(() => {
    const cum = (levels) => {
      let t = 0;
      return levels.slice(0, DEPTH).map((l) => ({ ...l, total: (t += Number(l.size)) }));
    };
    const a = cum(book.asks);
    const b = cum(book.bids);
    const max = Math.max(a.at(-1)?.total ?? 0, b.at(-1)?.total ?? 0) || 1;
    const sp = a[0] && b[0] ? Number(a[0].price) - Number(b[0].price) : null;
    return { asks: a.reverse(), bids: b, maxTotal: max, spread: sp };
  }, [book]);

  if (!market) return <div className="panel book-panel" />;
  const pd = market.price_decimals;
  const sd = market.size_decimals;
  const mid = asks.length && bids.length ? (Number(asks.at(-1).price) + Number(bids[0].price)) / 2 : null;

  const Row = ({ l, side }) => (
    <button className={`book-row ${side}`} onClick={() => onPrice?.(l.price)} title="Use this price">
      <span className="depth" style={{ width: `${(l.total / maxTotal) * 100}%` }} />
      <span className={side === 'ask' ? 'down' : 'up'}>{fmtNum(l.price, pd)}</span>
      <span>{fmtNum(l.size, sd)}</span>
      <span className="muted">{fmtNum(l.total, sd)}</span>
    </button>
  );

  return (
    <div className="panel book-panel">
      <div className="panel-head">
        <span>Order book</span>
        <span className={`dot ${book.live ? 'dot-live' : ''}`} title={book.live ? 'Live stream' : 'Polling'} />
      </div>
      <div className="book-cols muted">
        <span>Price</span>
        <span>Size ({market.symbol})</span>
        <span>Total</span>
      </div>
      <div className="book-side">{asks.map((l) => <Row key={`a${l.price}`} l={l} side="ask" />)}</div>
      <div className="book-mid">
        <strong>{mid ? fmtNum(mid, pd) : '—'}</strong>
        <span className="muted">
          spread {spread !== null ? fmtNum(spread, pd) : '—'}
          {spread !== null && mid ? ` (${((spread / mid) * 100).toFixed(3)}%)` : ''}
        </span>
      </div>
      <div className="book-side">{bids.map((l) => <Row key={`b${l.price}`} l={l} side="bid" />)}</div>
    </div>
  );
}
