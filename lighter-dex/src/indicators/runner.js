// Runs indicator scripts in a dedicated Web Worker.
//
// Why a worker: imported indicators are arbitrary user-supplied code. A worker has
// no access to the page DOM, localStorage (where the trading key lives) or the WASM
// signer's memory, so a malicious script can't read keys or place orders. It also
// can't freeze the UI: scripts that run longer than TIMEOUT_MS are killed.
import { TA_SOURCE } from './ta-source.js';

const TIMEOUT_MS = 2000;
const MAX_PLOTS = 8;

const WORKER_SOURCE = `${TA_SOURCE}
self.onmessage = (e) => {
  const { id, code, candles, inputs } = e.data;
  try {
    const fn = new Function('candles', 'inputs', 'ta', '"use strict";\\n' + code);
    const out = fn(candles, inputs || {}, ta);
    self.postMessage({ id, out: JSON.parse(JSON.stringify(out ?? null)) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};`;

// Jobs run one at a time so a hanging script only fails itself: its 2s timer starts
// when it is sent, and on timeout the worker is replaced before the next job runs.
let worker = null;
let seq = 0;
let current = null; // { id, timer, resolve, reject, length }
const queue = [];

function getWorker() {
  if (worker) return worker;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = (e) => {
    if (!current || e.data.id !== current.id) return;
    const job = current;
    finish();
    if (e.data.error) job.reject(new Error(e.data.error));
    else {
      try {
        job.resolve(normalizeResult(e.data.out, job.length));
      } catch (err) {
        job.reject(err);
      }
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    fail(new Error(e.message || 'Indicator crashed'));
  };
  return worker;
}

function finish() {
  clearTimeout(current?.timer);
  current = null;
  next();
}

function fail(err) {
  worker?.terminate();
  worker = null;
  const job = current;
  finish();
  job?.reject(err);
}

function next() {
  if (current || !queue.length) return;
  current = queue.shift();
  current.timer = setTimeout(() => fail(new Error('Indicator timed out (over 2s)')), TIMEOUT_MS);
  getWorker().postMessage(current.message);
}

/** Runs one indicator. Resolves to a normalized result (see normalizeResult). */
export function runIndicator(code, candles, inputs) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    queue.push({ id, resolve, reject, length: candles.length, message: { id, code, candles, inputs } });
    next();
  });
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;

const SIGNAL_ALIASES = { long: 'long', buy: 'long', short: 'short', sell: 'short', exit: 'exit', close: 'exit', flat: 'exit' };

/** 'long' | 'short' | 'exit' | null */
export function normalizeSignal(s) {
  return typeof s === 'string' ? SIGNAL_ALIASES[s.toLowerCase()] ?? null : null;
}

/**
 * Validates what a script returned. Expected shape:
 *   { pane: 'overlay' | 'separate',
 *     plots: [{ name, values: (number|null)[], color?, type?: 'line' | 'histogram' }],
 *     levels?: number[],
 *     signals?: ('long' | 'short' | 'exit' | null)[]   // per candle; used by the auto-trader }
 */
export function normalizeResult(out, length) {
  if (!out || typeof out !== 'object' || (!Array.isArray(out.plots) && !Array.isArray(out.signals))) {
    throw new Error('Indicator must return { pane, plots: [...] } (and optionally signals: [...])');
  }
  if (out.signals !== undefined && (!Array.isArray(out.signals) || out.signals.length !== length)) {
    throw new Error(`signals must have one entry per candle (${length})`);
  }
  return {
    signals: Array.isArray(out.signals) ? out.signals.map(normalizeSignal) : null,
    pane: out.pane === 'separate' ? 'separate' : 'overlay',
    levels: Array.isArray(out.levels) ? out.levels.filter((v) => Number.isFinite(v)).slice(0, 5) : [],
    plots: (out.plots ?? []).slice(0, MAX_PLOTS).map((p, i) => {
      if (!p || !Array.isArray(p.values)) throw new Error(`Plot ${i + 1} has no values array`);
      if (p.values.length !== length) throw new Error(`Plot ${i + 1} has ${p.values.length} values, expected ${length}`);
      return {
        name: String(p.name ?? `Plot ${i + 1}`).slice(0, 40),
        type: p.type === 'histogram' ? 'histogram' : 'line',
        color: typeof p.color === 'string' && COLOR_RE.test(p.color) ? p.color : null,
        values: p.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
      };
    }),
  };
}

/**
 * Reads optional header comments from an imported script:
 *   // @name My indicator
 *   // @input length 14
 */
export function parseHeader(code) {
  const name = code.match(/^\s*\/\/\s*@name\s+(.+)$/m)?.[1]?.trim();
  const inputs = {};
  for (const m of code.matchAll(/^\s*\/\/\s*@input\s+([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?)\s*$/gm)) {
    inputs[m[1]] = Number(m[2]);
  }
  return { name: name ? name.slice(0, 40) : null, inputs };
}
