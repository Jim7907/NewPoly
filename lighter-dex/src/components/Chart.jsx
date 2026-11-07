import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, createChart } from 'lightweight-charts';
import { useCandles } from '../lighter/useMarketData.js';
import { RESOLUTIONS } from '../lighter/api.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function Chart({ market }) {
  const el = useRef(null);
  const chartRef = useRef(null);
  const [resolution, setResolution] = useState('15m');
  const { data } = useCandles(market?.market_id ?? null, resolution);

  useEffect(() => {
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'inherit' },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderColor: css('--border') },
      timeScale: { borderColor: css('--border'), timeVisible: true },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: css('--up'), downColor: css('--down'), borderVisible: false,
      wickUpColor: css('--up'), wickDownColor: css('--down'),
    });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = { chart, candles, volume };
    return () => chart.remove();
  }, []);

  useEffect(() => {
    if (!chartRef.current || !market) return;
    chartRef.current.candles.applyOptions({
      priceFormat: { type: 'price', precision: market.price_decimals, minMove: 10 ** -market.price_decimals },
    });
  }, [market?.market_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fittedKey = useRef(null);
  useEffect(() => {
    if (!chartRef.current || !data) return;
    const { chart, candles, volume } = chartRef.current;
    candles.setData(data);
    volume.setData(
      data.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? css('--up-dim') : css('--down-dim') })),
    );
    const key = `${market?.market_id}:${resolution}`;
    if (data.length && fittedKey.current !== key) {
      fittedKey.current = key;
      chart.timeScale().fitContent();
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <div className="tabs">
          {RESOLUTIONS.map((r) => (
            <button key={r} className={`tab ${r === resolution ? 'active' : ''}`} onClick={() => setResolution(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="chart" ref={el} />
    </div>
  );
}
