// Indicator sandbox. Runs as a dedicated Web Worker: no DOM, no localStorage (where
// the trading key lives), no access to the WASM signer. Killed by the runner after 2s.
//  - Pine Script: interpreted (no eval) by ./pine/runtime.js
//  - JavaScript (legacy/advanced): run with the ta helper library
import { runPine } from './pine/runtime.js';
import { TA_SOURCE } from './ta-source.js';

let ta = null;

self.onmessage = (e) => {
  const { id, lang, code, candles, inputs, opts } = e.data;
  try {
    let out;
    if (lang === 'pine') {
      out = runPine(code, candles, inputs || {}, opts || {});
    } else {
      ta ??= new Function(`${TA_SOURCE}; return ta;`)();
      const fn = new Function('candles', 'inputs', 'ta', `"use strict";\n${code}`);
      out = fn(candles, inputs || {}, ta);
    }
    self.postMessage({ id, out: JSON.parse(JSON.stringify(out ?? null)) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
