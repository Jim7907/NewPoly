// Runs CPU-heavy walk-forward backtests off the main thread so the real-time loop, WebSocket and
// API stay responsive (a single BTC backtest with ML is ~150 s of synchronous CPU).
//   runInWorker({ asset, horizon, limit, opts }) -> Promise<backtest result>
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

if (isMainThread) {
  function runInWorker(job) {
    return new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: job });
      w.once("message", (m) => (m && m.error ? reject(new Error(m.error)) : resolve(m)));
      w.once("error", reject);
      w.once("exit", (code) => { if (code !== 0) reject(new Error(`backtest worker exited ${code}`)); });
    });
  }
  module.exports = { runInWorker };
} else {
  (async () => {
    try {
      const cfg = require("../config");
      const data = require("../data");
      const backtest = require("./backtest");
      const { asset, horizon, limit, opts = {} } = workerData;
      const hc = cfg.HORIZONS[horizon] || cfg.HORIZONS.swing;
      const candles = await data.candles(asset, hc.tf, limit || Math.max(hc.history, 1000));
      if (!candles || candles.length < 300) throw new Error(`not enough history (${candles?.length || 0} bars)`);
      const res = backtest.run({ candles, asset, horizon, cfg, ...opts });
      parentPort.postMessage({ ...res, bars: candles.length, from: candles[0].t, to: candles.at(-1).t });
    } catch (e) {
      parentPort.postMessage({ error: e.message });
    }
    process.exit(0);
  })();
}
