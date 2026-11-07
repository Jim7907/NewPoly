import { useEffect, useState } from 'react';
import ConnectButton from './components/ConnectButton.jsx';
import MarketHeader from './components/MarketHeader.jsx';
import Chart from './components/Chart.jsx';
import OrderBook from './components/OrderBook.jsx';
import Trades from './components/Trades.jsx';
import OrderForm from './components/OrderForm.jsx';
import AccountTabs from './components/AccountTabs.jsx';
import { useMarkets, useOrderBook } from './lighter/useMarketData.js';
import { useLighter } from './lighter/useLighter.js';
import { loadSigner } from './lighter/signer.js';
import { NETWORK } from './lighter/config.js';

const MARKET_KEY = 'lighter-dex:market';

function initialMarket() {
  try {
    const v = localStorage.getItem(MARKET_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

export default function App() {
  const { data: markets = [], error: marketsError } = useMarkets();
  const [marketId, setMarketId] = useState(initialMarket);
  const [presetPrice, setPresetPrice] = useState(null);
  const lighter = useLighter();

  // Warm the 8 MB signer in the background so the first order is instant.
  useEffect(() => {
    loadSigner().catch((e) => console.warn('Signer failed to load', e));
  }, []);

  useEffect(() => {
    if (markets.length && !markets.some((m) => m.market_id === marketId)) setMarketId(markets[0].market_id);
  }, [markets, marketId]);

  useEffect(() => {
    if (marketId === null) return;
    try { localStorage.setItem(MARKET_KEY, String(marketId)); } catch { /* ignore */ }
  }, [marketId]);

  const market = markets.find((m) => m.market_id === marketId) ?? null;
  const book = useOrderBook(market ? market.market_id : null);

  useEffect(() => {
    if (market) document.title = `${Number(market.mark_price).toFixed(market.price_decimals)} ${market.symbol} · Lighter Trade`;
  }, [market?.mark_price, market?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> Lighter Trade
          <span className={`badge ${NETWORK.chainId === 304 ? 'badge-main' : ''}`}>{NETWORK.name}</span>
        </div>
        <MarketHeader markets={markets} market={market} onSelect={setMarketId} />
        <ConnectButton />
      </header>

      {marketsError && <div className="banner">Could not reach Lighter API: {marketsError.message}</div>}

      <main className="grid">
        <Chart market={market} />
        <div className="col-book">
          <OrderBook market={market} book={book} onPrice={(price) => setPresetPrice({ price, at: Date.now() })} />
          <Trades market={market} />
        </div>
        <OrderForm market={market} book={book} lighter={lighter} presetPrice={presetPrice} />
        <AccountTabs lighter={lighter} markets={markets} onSelectMarket={setMarketId} />
      </main>

      <footer className="footer muted">
        Orders are signed in your browser and sent directly to Lighter. This interface never holds your funds.
        Perpetual futures are risky and may be restricted where you live.
      </footer>
    </div>
  );
}
