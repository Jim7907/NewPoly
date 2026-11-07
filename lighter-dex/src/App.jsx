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
import { useIndicators } from './indicators/useIndicators.js';
import { useAutoTrader } from './autotrade/useAutoTrader.js';
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
  const [sideRequest, setSideRequest] = useState(null);
  const [mobileTab, setMobileTab] = useState('chart');
  const lighter = useLighter();
  const indicators = useIndicators(); // shared by the chart and the auto-trader
  const bot = useAutoTrader({ lighter, markets, indicators }); // lives here so it keeps running across tabs
  const [tabRequest, setTabRequest] = useState(null);
  const openBot = () => {
    setTabRequest({ tab: 'bot', at: Date.now() });
    setMobileTab('account');
  };
  const openPositions = (lighter.account?.positions ?? []).filter((p) => Number(p.position) !== 0).length;

  const startTrade = (side) => {
    setSideRequest({ side, at: Date.now() });
    setMobileTab('trade');
  };

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
    if (market) document.title = `${Number(market.mark_price).toFixed(market.price_decimals)} ${market.label} · Lighter Trade`;
  }, [market?.mark_price, market?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> Lighter Trade
          <span className={`badge ${NETWORK.chainId === 304 ? 'badge-main' : ''}`}>{NETWORK.name}</span>
        </div>
        <MarketHeader markets={markets} market={market} onSelect={setMarketId} />
        {bot.running && (
          <button className={`bot-badge ${bot.config.live ? 'live' : ''}`} onClick={openBot} title={bot.status}>
            🤖 {bot.config.live ? 'LIVE bot' : 'Paper bot'}
          </button>
        )}
        <ConnectButton />
      </header>

      {marketsError && <div className="banner">Could not reach Lighter API: {marketsError.message}</div>}
      {NETWORK.chainId !== 304 && markets.length > 0 && (
        <div className="banner banner-info">
          Testnet (fake money) — Lighter&apos;s testnet only lists {markets.length} markets. Mainnet has 200+ perps and spot pairs:
          redeploy with <code>NETWORK=mainnet</code>.
        </div>
      )}

      <main className="grid" data-mtab={mobileTab}>
        <Chart market={market} indicators={indicators} />
        <div className="col-book">
          <OrderBook
            market={market}
            book={book}
            onPrice={(price) => {
              setPresetPrice({ price, at: Date.now() });
              setMobileTab('trade');
            }}
          />
          <Trades market={market} />
        </div>
        <OrderForm market={market} book={book} lighter={lighter} presetPrice={presetPrice} sideRequest={sideRequest} />
        <AccountTabs
          lighter={lighter}
          markets={markets}
          bot={bot}
          indicators={indicators}
          tabRequest={tabRequest}
          onSelectMarket={(id) => {
            setMarketId(id);
            setMobileTab('chart');
          }}
        />
      </main>

      {/* Phone only: quick buy/sell bar + bottom navigation */}
      {(mobileTab === 'chart' || mobileTab === 'book') && market && (
        <div className="mobile-cta">
          <button className="btn btn-buy" onClick={() => startTrade('buy')}>Buy / Long</button>
          <button className="btn btn-sell" onClick={() => startTrade('sell')}>Sell / Short</button>
        </div>
      )}
      <nav className="bottom-nav" aria-label="Sections">
        {[
          ['chart', '📈', 'Chart'],
          ['book', '📖', 'Book'],
          ['trade', '⚡', 'Trade'],
          ['account', '💼', openPositions ? `Positions (${openPositions})` : 'Account'],
        ].map(([k, icon, label]) => (
          <button key={k} className={mobileTab === k ? 'active' : ''} onClick={() => setMobileTab(k)}>
            <span aria-hidden="true">{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      <footer className="footer muted">
        Orders are signed in your browser and sent directly to Lighter. This interface never holds your funds.
        Perpetual futures are risky and may be restricted where you live.
      </footer>
    </div>
  );
}
