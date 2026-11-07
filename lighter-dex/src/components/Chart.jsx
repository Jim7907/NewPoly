import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers } from 'lightweight-charts';
import { useCandles } from '../lighter/useMarketData.js';
import { RESOLUTIONS } from '../lighter/api.js';
import { runIndicator } from '../indicators/runner.js';
import IndicatorsPanel from './IndicatorsPanel.jsx';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = ['#f5a524', '#7c6cff', '#22b8cf', '#e64980', '#40c057', '#fd7e14', '#94d82d', '#be4bdb'];

export default function Chart({ market, indicators }) {
  const el = useRef(null);
  const chartRef = useRef(null);
  const indSeriesRef = useRef([]);
  const [resolution, setResolution] = useState('15m');
  const [showPanel, setShowPanel] = useState(false);
  const [results, setResults] = useState([]); // [{ indicator, result }]
  const [errors, setErrors] = useState({});
  const { data } = useCandles(market?.market_id ?? null, resolution);

  // ---- base chart ----
  useEffect(() => {
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'inherit', panes: { separatorColor: css('--border') } },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderColor: css('--border') },
      timeScale: { borderColor: css('--border'), timeVisible: true },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: css('--up'), downColor: css('--down'), borderVisible: false,
      wickUpColor: css('--up'), wickDownColor: css('--down'),
    });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const markers = createSeriesMarkers(candles, []);
    chartRef.current = { chart, candles, volume, markers };
    return () => {
      chart.remove();
      chartRef.current = null;
      indSeriesRef.current = [];
    };
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

  // ---- indicators: compute in the worker ----
  const enabledKey = JSON.stringify(indicators.enabled.map((i) => [i.id, i.code, i.inputs]));
  useEffect(() => {
    if (!data?.length) return undefined;
    let cancelled = false;
    const enabled = indicators.enabled;
    Promise.allSettled(enabled.map((ind) => runIndicator(ind.code, data, ind.inputs))).then((settled) => {
      if (cancelled) return;
      const errs = {};
      const ok = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') ok.push({ indicator: enabled[i], result: s.value });
        else errs[enabled[i].id] = s.reason?.message ?? 'Indicator failed';
      });
      setErrors(errs);
      setResults(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [data, enabledKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- indicators: draw ----
  useEffect(() => {
    const c = chartRef.current;
    if (!c || !data?.length) return;
    const { chart } = c;
    for (const s of indSeriesRef.current) chart.removeSeries(s);
    indSeriesRef.current = [];
    for (let i = chart.panes().length - 1; i >= 1; i--) chart.removePane(i);

    let nextPane = 1;
    let colorIdx = 0;
    for (const { result } of results) {
      const pane = result.pane === 'separate' ? nextPane++ : 0;
      result.plots.forEach((plot, pi) => {
        const color = plot.color ?? PALETTE[colorIdx++ % PALETTE.length];
        const points = data.map((cd, k) => (plot.values[k] === null ? { time: cd.time } : { time: cd.time, value: plot.values[k] }));
        let series;
        if (plot.type === 'histogram') {
          series = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
          series.setData(points.map((p) => (p.value === undefined ? p : { ...p, color: p.value >= 0 ? css('--up-dim') : css('--down-dim') })));
        } else {
          series = chart.addSeries(LineSeries, { color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: pane !== 0, crosshairMarkerVisible: false }, pane);
          series.setData(points);
        }
        if (pi === 0 && pane !== 0) {
          for (const lvl of result.levels) {
            series.createPriceLine({ price: lvl, color: css('--muted'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
          }
        }
        indSeriesRef.current.push(series);
      });
    }
    const panes = chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));

    // Strategy signals as arrows on the candles
    const marks = [];
    for (const { result } of results) {
      if (!result.signals) continue;
      result.signals.forEach((s, k) => {
        if (!s || !data[k]) return;
        marks.push(
          s === 'long'
            ? { time: data[k].time, position: 'belowBar', shape: 'arrowUp', color: css('--up'), text: 'L' }
            : s === 'short'
              ? { time: data[k].time, position: 'aboveBar', shape: 'arrowDown', color: css('--down'), text: 'S' }
              : { time: data[k].time, position: 'aboveBar', shape: 'circle', color: css('--muted'), text: 'X' },
        );
      });
    }
    c.markers.setMarkers(marks.sort((a, b) => a.time - b.time));
  }, [results]); // eslint-disable-line react-hooks/exhaustive-deps

  const legend = useMemo(
    () => results.map(({ indicator, result }) => ({
      id: indicator.id,
      name: indicator.name,
      values: result.plots.map((p) => p.values.findLast((v) => v !== null)),
    })),
    [results],
  );
  const separatePanes = results.filter((r) => r.result.pane === 'separate').length;

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
        <button className="chip" onClick={() => setShowPanel(true)}>ƒx Indicators{indicators.enabled.length ? ` (${indicators.enabled.length})` : ''}</button>
      </div>
      {(legend.length > 0 || Object.keys(errors).length > 0) && (
        <div className="legend">
          {legend.map((l) => (
            <span key={l.id} className="legend-item">
              {l.name} <span className="muted">{l.values.map((v) => (v === undefined || v === null ? '—' : Number(v.toPrecision(6)))).join(' / ')}</span>
            </span>
          ))}
          {Object.entries(errors).map(([id]) => (
            <button key={id} className="legend-item down link" onClick={() => setShowPanel(true)}>
              ⚠ {indicators.list.find((i) => i.id === id)?.name}: error
            </button>
          ))}
        </div>
      )}
      <div className="chart" ref={el} style={{ minHeight: 360 + separatePanes * 110 }} />
      {showPanel && <IndicatorsPanel indicators={indicators} errors={errors} onClose={() => setShowPanel(false)} />}
    </div>
  );
}
