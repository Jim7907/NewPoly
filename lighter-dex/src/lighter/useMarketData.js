import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from './api.js';
import { NETWORK } from './config.js';

export function useMarkets() {
  return useQuery({ queryKey: ['markets'], queryFn: api.getMarkets, refetchInterval: 10000 });
}

export function useCandles(marketId, resolution) {
  return useQuery({
    queryKey: ['candles', marketId, resolution],
    queryFn: () => api.getCandles(marketId, resolution),
    enabled: marketId !== null,
    refetchInterval: 10000,
  });
}

export function useTrades(marketId) {
  return useQuery({
    queryKey: ['trades', marketId],
    queryFn: () => api.getRecentTrades(marketId),
    enabled: marketId !== null,
    refetchInterval: 2000,
  });
}

// Merge price-level deltas ({price, size}; size 0 = remove) into a book side.
function applyLevels(side, updates) {
  const m = new Map(side.map((l) => [l.price, l]));
  for (const u of updates ?? []) {
    if (Number(u.size) === 0) m.delete(u.price);
    else m.set(u.price, { price: u.price, size: u.size });
  }
  return [...m.values()];
}

const sortBook = (b) => ({
  asks: [...b.asks].sort((x, y) => Number(x.price) - Number(y.price)),
  bids: [...b.bids].sort((x, y) => Number(y.price) - Number(x.price)),
});

/**
 * Live order book. Streams `order_book/{id}` over WebSocket; if the socket
 * can't connect (or goes quiet) it falls back to polling REST.
 */
export function useOrderBook(marketId) {
  const [book, setBook] = useState({ asks: [], bids: [] });
  const [live, setLive] = useState(false);
  const bookRef = useRef(book);

  useEffect(() => {
    if (marketId === null) return undefined;
    let closed = false;
    let ws;
    let pollTimer;
    let lastMsg = 0;
    let reconnectTimer;

    const publish = (b) => {
      bookRef.current = b;
      setBook(sortBook(b));
    };

    const poll = async () => {
      try {
        const b = await api.getOrderBook(marketId);
        if (!closed && Date.now() - lastMsg > 5000) publish(b);
      } catch { /* transient */ }
    };
    poll();
    pollTimer = setInterval(() => {
      if (Date.now() - lastMsg > 5000) {
        setLive(false);
        poll();
      }
    }, 1500);

    const connect = () => {
      try {
        ws = new WebSocket(NETWORK.ws);
      } catch {
        return;
      }
      ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${marketId}` }));
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'subscribed/order_book' && msg.order_book) {
          lastMsg = Date.now();
          setLive(true);
          publish({ asks: msg.order_book.asks ?? [], bids: msg.order_book.bids ?? [] });
        } else if (msg.type === 'update/order_book' && msg.order_book) {
          lastMsg = Date.now();
          setLive(true);
          const cur = bookRef.current;
          publish({
            asks: applyLevels(cur.asks, msg.order_book.asks),
            bids: applyLevels(cur.bids, msg.order_book.bids),
          });
        }
      };
      ws.onclose = () => {
        setLive(false);
        if (!closed) reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      closed = true;
      clearInterval(pollTimer);
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      bookRef.current = { asks: [], bids: [] };
      setBook({ asks: [], bids: [] });
    };
  }, [marketId]);

  return { ...book, live };
}
