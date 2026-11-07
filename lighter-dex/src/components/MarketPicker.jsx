import { useEffect, useMemo, useRef, useState } from 'react';
import { filterMarkets } from '../lighter/markets.js';
import { fmtCompact, fmtNum } from '../lighter/units.js';

const FAV_KEY = 'lighter-dex:favorites';
const loadFavs = () => {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) ?? []; } catch { return []; }
};

export default function MarketPicker({ markets, market, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [favs, setFavs] = useState(loadFavs);
  const inputRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* ignore */ }
  }, [favs]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const list = useMemo(() => filterMarkets(markets, { query, kind, favorites: favs }), [markets, query, kind, favs]);
  const counts = useMemo(() => ({
    all: markets.length,
    perp: markets.filter((m) => m.kind === 'perp').length,
    spot: markets.filter((m) => m.kind === 'spot').length,
    fav: favs.length,
  }), [markets, favs]);

  const toggleFav = (id) => setFavs((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const pick = (id) => {
    onSelect(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <button className="market-select" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {market ? market.label : 'Markets'} <span className="muted">▾</span>
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose market">
            <div className="sheet-head">
              <input
                ref={inputRef}
                className="input picker-search"
                placeholder={`Search ${markets.length} markets (BTC, ETH, SOL…)`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && list[0]) pick(list[0].market_id);
                  if (e.key === 'Escape') setOpen(false);
                }}
              />
              <button className="chip" onClick={() => setOpen(false)}>Close</button>
            </div>
            <div className="subtabs picker-tabs">
              {[['all', 'All'], ['perp', 'Perps'], ['spot', 'Spot'], ['fav', '★ Favorites']].map(([k, label]) => (
                <button key={k} className={`chip ${kind === k ? 'chip-active' : ''}`} onClick={() => setKind(k)}>
                  {label} <span className="count">{counts[k]}</span>
                </button>
              ))}
            </div>
            <div className="picker-list">
              <div className="picker-row picker-head muted">
                <span />
                <span>Market</span>
                <span>Price</span>
                <span>24h</span>
                <span className="hide-sm">Volume</span>
              </div>
              {list.length === 0 && <div className="empty muted">No markets match “{query}”.</div>}
              {list.map((m) => {
                const ch = Number(m.daily_price_change);
                const fav = favs.includes(m.market_id);
                return (
                  <div key={m.market_id} className={`picker-row ${market?.market_id === m.market_id ? 'current' : ''}`}>
                    <button className={`star ${fav ? 'on' : ''}`} onClick={() => toggleFav(m.market_id)} aria-label={fav ? 'Remove favorite' : 'Add favorite'}>
                      {fav ? '★' : '☆'}
                    </button>
                    <button className="picker-main" onClick={() => pick(m.market_id)}>
                      <strong>{m.label}</strong>
                      {m.kind === 'spot' && <span className="tag">spot</span>}
                      {m.kind === 'perp' && m.min_initial_margin_fraction && (
                        <span className="tag">{Math.floor(10000 / Number(m.min_initial_margin_fraction))}x</span>
                      )}
                    </button>
                    <span onClick={() => pick(m.market_id)}>{fmtNum(m.mark_price, m.price_decimals)}</span>
                    <span onClick={() => pick(m.market_id)} className={ch >= 0 ? 'up' : 'down'}>{Number.isFinite(ch) ? `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%` : '—'}</span>
                    <span onClick={() => pick(m.market_id)} className="muted hide-sm">${fmtCompact(m.daily_quote_token_volume)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
