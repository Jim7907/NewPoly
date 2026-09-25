// Runs one self-improvement cycle (selfImprove.computeCycle) in a worker thread, so dataset
// building, report cards, stacker / meta-labeler training and threshold tuning never block the
// real-time loop, WebSocket or API (same pattern as server/learning/worker.js).
//
//   startCycleWorker(job, { timeoutMs, onProgress, resourceLimits }) -> { promise, terminate(reason) }
//     job: plain data (horizon, reason, champions, live, drift, opts) + optional depsModule — an
//     absolute path to a CommonJS module exporting deps overrides ({ buildDataset, trainStacker, … }
//     or { deps: {…} }); functions cannot be structured-cloned into a worker, a module path can.
//   The promise resolves with computeCycle's { report, proposals, reportCard } and rejects with an
//   Error (err.crashed = true) when the worker throws, exits without a result, runs out of memory,
//   times out, or is terminated.
"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

if (isMainThread) {
  function startCycleWorker(job, { timeoutMs = 40 * 60e3, onProgress, resourceLimits } = {}) {
    let w, timer = null, settled = false, stopReason = null;
    const promise = new Promise((resolve, reject) => {
      const fail = (msg) => { const e = new Error(msg); e.crashed = true; return e; };
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err); else resolve(val);
      };
      try {
        w = new Worker(__filename, { workerData: job, ...(resourceLimits ? { resourceLimits } : {}) });
      } catch (e) { finish(fail(`cycle worker could not start: ${e.message}`)); return; }
      w.on("message", (m) => {
        if (!m || typeof m !== "object") return;
        if (m.type === "progress") { try { if (onProgress) onProgress(m.progress); } catch { /* ignore */ } }
        else if (m.type === "result") finish(null, m.out);
        else if (m.type === "error") finish(fail(`cycle failed in worker: ${m.error}`));
      });
      w.once("error", (e) => finish(fail(`cycle worker crashed: ${e && e.message ? e.message : e}`)));
      w.once("exit", (code) => finish(fail(stopReason ? `cycle ${stopReason}` : `cycle worker exited with code ${code} before reporting`)));
      if (timeoutMs > 0) {
        timer = setTimeout(() => { stopReason = `timed out after ${Math.round(timeoutMs / 1000)} s`; w.terminate().catch(() => {}); }, timeoutMs);
        if (timer.unref) timer.unref();
      }
    });
    const terminate = (reason = "terminated") => { if (!settled && w) { stopReason = reason; w.terminate().catch(() => {}); } };
    return { promise, terminate };
  }

  module.exports = { startCycleWorker };
} else {
  (async () => {
    const job = workerData || {};
    let deps;
    if (job.depsModule) {
      const mod = require(job.depsModule);
      deps = mod && mod.deps && typeof mod.deps === "object" ? mod.deps : mod;
    }
    const { computeCycle } = require("./selfImprove");
    const out = await computeCycle({ ...job, deps, onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }) });
    parentPort.postMessage({ type: "result", out });
  })()
    .catch((e) => { parentPort.postMessage({ type: "error", error: (e && (e.stack || e.message)) || String(e) }); })
    .finally(() => { setImmediate(() => process.exit(0)); });
}
