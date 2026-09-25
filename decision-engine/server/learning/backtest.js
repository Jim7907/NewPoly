// Walk-forward backtest of the decision engine (contract §2.14).
//
// Bar-by-bar: the decision at bar i uses ONLY candles[0..i] (technical + regime + ml families —
// the others have no history), is taken at the close of bar i, entered at the OPEN of bar i+1
// (with slippage), and exits at the ATR stop, the ATR target, or the horizon (close of bar
// entry+ahead−1), paying fees + slippage on both sides. One position at a time. Intrabar
// ambiguity (stop and target both inside one bar) is resolved pessimistically (stop first);
// gaps through a level fill at the open.
//
// Outputs trades, a mark-to-market equity curve, metrics (vs buy-and-hold), calibration pairs
// (pRaw → y, y = 1 if close[i+ahead] > close[i]) for the Calibrator and per-signal hit stats for
// the WeightLearner. Calibration pairs overlap when stride < ahead: n_eff ≈ n·stride/ahead.
//
// Dependency injection: opts.analyzers = { technical(window, ctx), regime(window, ctx),
// regimeSignals(regime, ctx), ml(windowFromStart, ctx), atr(window) } — any subset overrides the
// defaults built from server/analysis/*. ML is optional (opts.useML, default true) and is
// silently dropped if the module is missing or throws.
//
// CLI: node server/learning/backtest.js --symbol BTC --class crypto --horizon swing [--limit 2500]
//      [--stride 1] [--no-ml] [--sizing full|risk] [--full]

const baseCfg = require("../config");
const ensemble = require("../decision/ensemble");
const risk = require("../decision/risk");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const r6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

function tryRequire(p) { try { return require(p); } catch { return null; } }

// Default analyzers from the real modules (lazily required so stubs never need them).
function defaultAnalyzers(asset, horizon, hz) {
  const tech = tryRequire("../analysis/technical");
  const reg = tryRequire("../analysis/regime");
  const ml = tryRequire("../analysis/ml");
  const ind = tryRequire("../analysis/indicators");
  const cls = asset.etf ? "etf" : asset.assetClass;
  return {
    technical: tech ? (w) => tech.analyze(w, { horizon, assetClass: cls }) : null,
    regime: reg ? (w) => reg.detect(w) : null,
    regimeSignals: reg ? (r) => reg.signals(r) : null,
    ml: ml ? (w) => ml.signals(w, { ahead: hz.ahead, horizon, key: `backtest:${asset.symbol}:${hz.tf}:${hz.ahead}`, symbol: asset.symbol, tf: hz.tf }) : null,
    atr: ind ? (w) => { const a = ind.atr(w, 14); for (let k = a.length - 1; k >= 0; k--) if (Number.isFinite(a[k])) return a[k]; return null; } : fallbackAtr,
  };
}

// Wilder-free simple ATR fallback (mean true range over n bars).
function fallbackAtr(w, n = 14) {
  if (!Array.isArray(w) || w.length < 2) return null;
  const k0 = Math.max(1, w.length - n);
  let s = 0, m = 0;
  for (let k = k0; k < w.length; k++) {
    const c = w[k], p = w[k - 1].c;
    s += Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p)); m++;
  }
  return m ? s / m : null;
}

// 10 equal-mass bins (RESEARCH §4): our probabilities cluster near 0.5.
function ece(pairs, bins = 10) {
  const a = pairs.filter(q => Number.isFinite(q.p)).slice().sort((x, y) => x.p - y.p);
  if (!a.length) return null;
  const size = Math.max(1, Math.ceil(a.length / bins));
  let e = 0;
  for (let s = 0; s < a.length; s += size) {
    const b = a.slice(s, s + size);
    const mp = b.reduce((u, q) => u + q.p, 0) / b.length, my = b.reduce((u, q) => u + q.y, 0) / b.length;
    e += (b.length / a.length) * Math.abs(mp - my);
  }
  return e;
}
const brierOf = (pairs) => (pairs.length ? pairs.reduce((s, q) => s + (q.p - q.y) ** 2, 0) / pairs.length : null);

function moments(r) {
  const n = r.length;
  if (n < 3) return { mean: 0, sd: 0, skew: 0, kurt: 3 };
  const m = r.reduce((s, v) => s + v, 0) / n;
  const v2 = r.reduce((s, v) => s + (v - m) ** 2, 0) / n;
  const sdv = Math.sqrt(v2);
  if (!(sdv > 0)) return { mean: m, sd: 0, skew: 0, kurt: 3 };
  const skew = r.reduce((s, v) => s + ((v - m) / sdv) ** 3, 0) / n;
  const kurt = r.reduce((s, v) => s + ((v - m) / sdv) ** 4, 0) / n;
  return { mean: m, sd: sdv, skew, kurt };
}

// Probabilistic & deflated Sharpe (Bailey & López de Prado 2012/2014) on per-period returns.
//   PSR(SR*) = Φ((SR − SR*)·√(T−1) / √(1 − γ3·SR + (γ4−1)/4·SR²))
//   DSR: SR* = √(1/T) · ((1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))), γ = 0.5772 (Euler–Mascheroni),
//   i.e. the expected max Sharpe of N null strategies (SR variance under the null ≈ 1/T).
function sharpeSignificance(returns, nTrials = 10) {
  const r = returns.filter(Number.isFinite), T = r.length;
  const { mean, sd, skew, kurt } = moments(r);
  if (T < 10 || !(sd > 0)) return { psr: null, dsr: null, srPeriod: 0, srStar: null, T };
  const sr = mean / sd;
  const den = Math.sqrt(Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  const psr = risk.normCdf(sr * Math.sqrt(T - 1) / den);
  const N = Math.max(1, nTrials), g = 0.5772156649;
  const srStar = N > 1 ? Math.sqrt(1 / T) * ((1 - g) * risk.normInv(1 - 1 / N) + g * risk.normInv(1 - 1 / (N * Math.E))) : 0;
  const dsr = risk.normCdf((sr - srStar) * Math.sqrt(T - 1) / den);
  return { psr, dsr, srPeriod: sr, srStar, T, skew, kurt };
}

// Wilson 95% interval for a hit rate.
function wilson(h, n) {
  if (!(n > 0)) return [null, null];
  const z = 1.96, p = h / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, w = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [c - w, c + w];
}

function curveStats(values, ppy) {
  const rets = [];
  for (let k = 1; k < values.length; k++) if (values[k - 1] > 0) rets.push(values[k] / values[k - 1] - 1);
  const n = values.length;
  const total = n > 1 && values[0] > 0 ? values[n - 1] / values[0] - 1 : 0;
  const years = (n - 1) / ppy;
  const cagr = years > 0 && 1 + total > 0 ? Math.pow(1 + total, 1 / years) - 1 : 0;
  return { rets, totalReturn: total, cagr, sharpe: risk.sharpe(rets, ppy), sortino: risk.sortino(rets, ppy), maxDD: risk.maxDrawdown(values) };
}

/**
 * run({ candles, asset, horizon, cfg, feeBps, ...opts }) -> { trades, equity, metrics, calibrationPairs, signalStats, ... }
 * opts: stride (1), warmup (250), lookback (cfg.HORIZONS[h].history, ≥ 300), useML (true), analyzers,
 *       sizing ("full" = 100% notional per trade | "risk" = decision.risk.sizeFrac), allowShort (true),
 *       thresholds, calibrator, weights, nTrials (10, for the deflated Sharpe), capital (PAPER_BALANCE),
 *       regimeEvery (1: re-detect the regime every evaluated bar), onProgress(i, n).
 */
function run(params = {}) {
  const p = { ...params, ...(params.opts || {}) };
  const cfg = { ...baseCfg, ...(p.cfg || {}) };
  const candles = (Array.isArray(p.candles) ? p.candles : []).filter(c => c && [c.o, c.h, c.l, c.c].every(Number.isFinite) && c.c > 0);
  const asset = p.asset || { symbol: "?", assetClass: "crypto", id: "?" };
  const cls = asset.assetClass || "crypto";
  const horizon = p.horizon || "swing";
  const hz = (cfg.HORIZONS && cfg.HORIZONS[horizon]) || { tf: 86400, ahead: 5, history: 1000, label: horizon };
  const H = Math.max(1, fin(hz.ahead, 5));
  const feeBps = fin(p.feeBps, cls === "crypto" ? fin(cfg.FEE_BPS_CRYPTO, 10) : fin(cfg.FEE_BPS_STOCK, 1));
  const slip = fin(cfg.SLIPPAGE_BPS, 5) / 1e4, fee = feeBps / 1e4;
  const stride = Math.max(1, Math.floor(fin(p.stride, 1)));
  const warmup = Math.max(60, Math.floor(fin(p.warmup, 250)));
  const lookback = Math.max(300, Math.floor(fin(p.lookback, fin(hz.history, 1000))));
  const useML = p.useML !== false;
  const sizing = p.sizing || "full";
  const allowShort = p.allowShort !== false;
  const capital = fin(p.capital, fin(cfg.PAPER_BALANCE, 100000));
  const regimeEvery = Math.max(1, Math.floor(fin(p.regimeEvery, 1)));
  const ppy = cls === "crypto" ? 365 * 86400 / fin(hz.tf, 86400) : (fin(hz.tf, 86400) >= 86400 ? 252 : 252 * 6.5 * 3600 / hz.tf);
  const bracket = ensemble.BRACKETS[horizon] || ensemble.BRACKETS.swing;
  const an = { ...defaultAnalyzers(asset, horizon, hz), ...(p.analyzers || {}) };
  if (!useML) an.ml = null;

  const n = candles.length;
  const empty = { trades: [], equity: [], metrics: null, calibrationPairs: [], signalStats: {}, notes: [`not enough candles (${n} < ${warmup + H + 2})`] };
  if (n < warmup + H + 2) return empty;

  const notes = [];
  const analyzerErrors = {};
  const safe = (name, fn, ...args) => {
    if (typeof fn !== "function") return null;
    try { return fn(...args); } catch (e) {
      analyzerErrors[name] = (analyzerErrors[name] || 0) + 1;
      if (name === "ml" && analyzerErrors.ml >= 3) an.ml = null;          // give up on a broken ML module
      return null;
    }
  };
  const expectedFamilies = ["technical", "regime", ...(an.ml ? ["ml"] : [])];

  let equity = capital, pos = null, pending = null, cachedRegime = null, regimeAge = Infinity;
  const trades = [], curve = [], evals = [], calibrationPairs = [], signalStats = {};
  const actionCounts = {}, abstainCounts = {};
  let barsInPos = 0;

  const exitTrade = (i, px, reason) => {
    const exitPx = px * (1 - pos.dir * slip);
    const gross = pos.dir * (exitPx / pos.entry - 1);
    const ret = gross - 2 * fee;
    equity *= 1 + pos.frac * ret;
    trades.push({ entryT: candles[pos.idx].t, exitT: candles[i].t, side: pos.dir > 0 ? "long" : "short", entry: r6(pos.entry), exit: r6(exitPx),
      stop: r6(pos.stop), target: r6(pos.target), bars: i - pos.idx + 1, ret: r6(ret), frac: r6(pos.frac), reason,
      pUp: pos.pUp, confidence: pos.confidence, action: pos.action });
    pos = null;
  };

  for (let i = warmup; i < n; i++) {
    const bar = candles[i];
    // 1) fill a pending entry at this bar's open.
    if (pending && !pos) {
      const entry = bar.o * (1 + pending.dir * slip);
      pos = { dir: pending.dir, idx: i, entry, frac: pending.frac, pUp: pending.pUp, confidence: pending.confidence, action: pending.action,
        stop: entry - pending.dir * bracket.stop * pending.atr, target: entry + pending.dir * bracket.target * pending.atr };
      pending = null;
    }
    // 2) manage the open position on this bar (gaps fill at the open; stop wins ties).
    if (pos) {
      barsInPos++;
      const { dir, stop, target } = pos;
      const gapStop = i > pos.idx && (dir > 0 ? bar.o <= stop : bar.o >= stop);
      const gapTgt = i > pos.idx && (dir > 0 ? bar.o >= target : bar.o <= target);
      const hitStop = dir > 0 ? bar.l <= stop : bar.h >= stop;
      const hitTgt = dir > 0 ? bar.h >= target : bar.l <= target;
      if (gapStop) exitTrade(i, bar.o, "stop");
      else if (gapTgt) exitTrade(i, bar.o, "target");
      else if (hitStop) exitTrade(i, stop, "stop");
      else if (hitTgt) exitTrade(i, target, "target");
      else if (i >= pos.idx + H - 1 || i === n - 1) exitTrade(i, bar.c, i === n - 1 ? "end" : "horizon");
    }
    // 3) mark to market at the close.
    const mark = pos ? equity * (1 + pos.frac * (pos.dir * (bar.c * (1 - pos.dir * slip) / pos.entry - 1) - fee)) : equity;
    curve.push({ t: bar.t, v: mark });

    // 4) evaluate a decision at this close (every `stride` bars), only from candles[0..i].
    if ((i - warmup) % stride !== 0 || i >= n - 1) continue;
    const window = candles.slice(Math.max(0, i + 1 - lookback), i + 1);
    let regime = cachedRegime;
    if (regimeAge >= regimeEvery || !regime) { regime = safe("regime", an.regime, window, { i }) || null; cachedRegime = regime; regimeAge = 0; }
    regimeAge += stride;
    const sigs = [];
    const push = (xs) => { if (Array.isArray(xs)) for (const s of xs) if (s && Number.isFinite(s.score)) sigs.push(s); };
    push(safe("technical", an.technical, window, { i, horizon }));
    if (regime) push(safe("regimeSignals", an.regimeSignals, regime, { i }));
    if (an.ml) push(safe("ml", an.ml, candles.slice(0, i + 1), { i, horizon }));
    const atr = fin(safe("atr", an.atr, window), 0) || fallbackAtr(window);
    const d = ensemble.decide({ asset, signals: sigs, regime, horizon, price: bar.c, atr, candles: window, now: bar.t,
      calibrator: p.calibrator, weights: p.weights, thresholds: p.thresholds, cfg: p.cfg, feeBps, expectedFamilies,
      equity: capital, openPositions: [] });
    actionCounts[d.action] = (actionCounts[d.action] || 0) + 1;
    if (d.abstainReason) for (const part of d.abstainReason.split("; ")) {
      const k = /^confidence/.test(part) ? "confidence" : /^edge/.test(part) ? "edge" : /^agreement/.test(part) ? "agreement"
        : /cost/.test(part) ? "cost" : "noEvidence";
      abstainCounts[k] = (abstainCounts[k] || 0) + 1;
    }

    if (i + H < n) {
      const y = candles[i + H].c > bar.c ? 1 : 0;
      calibrationPairs.push({ p: d.pRaw, y, t: bar.t });
      evals.push({ p: d.pUp, y, action: d.action });
      for (const s of sigs) {
        if (!(s.confidence > 0) || Math.abs(s.score) < 0.05) continue;
        const st = signalStats[s.id] || (signalStats[s.id] = { n: 0, hits: 0 });
        st.n++; if ((s.score > 0) === (y === 1)) st.hits++;
      }
    }
    if (!pos && !pending && atr > 0) {
      const dir = d.action.endsWith("BUY") ? 1 : d.action.endsWith("SELL") && allowShort ? -1 : 0;
      if (dir) {
        const frac = sizing === "risk" ? clamp(fin(d.risk.sizeFrac), 0, 1) : 1;
        if (frac > 0) pending = { dir, atr, frac, pUp: d.pUp, confidence: d.confidence, action: d.action };
      }
    }
  }

  // ---- metrics ----
  const values = curve.map(q => q.v);
  const cs = curveStats(values, ppy);
  const wins = trades.filter(t => t.ret > 0), losses = trades.filter(t => t.ret <= 0);
  const sumW = wins.reduce((s, t) => s + t.ret, 0), sumL = -losses.reduce((s, t) => s + t.ret, 0);
  const bhVals = candles.slice(warmup).map(c => c.c);
  const bh = curveStats(bhVals, ppy);
  const sig = sharpeSignificance(cs.rets, fin(p.nTrials, 10));
  const tradeRets = trades.map(t => t.ret);
  const tm = moments(tradeRets);
  const tStat = trades.length > 2 && tm.sd > 0 ? tm.mean / (tm.sd * Math.sqrt(trades.length / (trades.length - 1))) * Math.sqrt(trades.length) : null;
  const [hitLo, hitHi] = wilson(wins.length, trades.length);
  const acted = evals.filter(e => e.action !== "HOLD");
  const dirHits = acted.filter(e => (e.action.endsWith("BUY") ? 1 : 0) === e.y).length;
  const baseRate = evals.length ? evals.reduce((s, e) => s + e.y, 0) / evals.length : null;

  const metrics = {
    cagr: r6(cs.cagr), totalReturn: r6(cs.totalReturn), sharpe: r6(cs.sharpe), sortino: r6(cs.sortino), maxDD: r6(cs.maxDD),
    hitRate: trades.length ? r6(wins.length / trades.length) : null, hitRateCI95: [r6(hitLo), r6(hitHi)],
    nTrades: trades.length, avgWin: wins.length ? r6(sumW / wins.length) : null, avgLoss: losses.length ? r6(sumL / losses.length) : null,
    profitFactor: sumL > 0 ? r6(sumW / sumL) : null, avgTradeRet: trades.length ? r6(tm.mean) : null, tradeTStat: r6(tStat),
    exposure: r6(barsInPos / Math.max(1, n - warmup)),
    brier: r6(brierOf(evals)), brierBaseRate: baseRate == null ? null : r6(baseRate * (1 - baseRate)), ece: r6(ece(evals)),
    brierRaw: r6(brierOf(calibrationPairs)), eceRaw: r6(ece(calibrationPairs)),
    directionalAccuracy: acted.length ? r6(dirHits / acted.length) : null, nDecisions: evals.length, nActionable: acted.length,
    psr: r6(sig.psr), dsr: r6(sig.dsr), nTrials: fin(p.nTrials, 10),
    exits: trades.reduce((o, t) => ((o[t.reason] = (o[t.reason] || 0) + 1), o), {}),
    actionCounts, abstainCounts,
    buyHold: { cagr: r6(bh.cagr), totalReturn: r6(bh.totalReturn), sharpe: r6(bh.sharpe), sortino: r6(bh.sortino), maxDD: r6(bh.maxDD) },
    excessCagr: r6(cs.cagr - bh.cagr),
    period: { from: new Date(candles[warmup].t).toISOString(), to: new Date(candles[n - 1].t).toISOString(), bars: n - warmup, periodsPerYear: ppy },
    costs: { feeBps, slippageBps: fin(cfg.SLIPPAGE_BPS, 5), roundTripBps: 2 * (feeBps + fin(cfg.SLIPPAGE_BPS, 5)) },
    sizing, stride, useML: !!an.ml,
  };
  for (const st of Object.values(signalStats)) st.hitRate = st.n ? r6(st.hits / st.n) : null;

  // ---- honest caveats ----
  if (trades.length < 30) notes.push(`Only ${trades.length} trades: Sharpe, hit rate and profit factor are statistically unreliable (need ≥ 30, ideally ≥ 100). Hit-rate 95% CI ${hitLo == null ? "n/a" : `${(hitLo * 100).toFixed(0)}–${(hitHi * 100).toFixed(0)}%`}.`);
  if (sig.psr != null) notes.push(`Probabilistic Sharpe P(SR>0) = ${(sig.psr * 100).toFixed(0)}%; deflated for ${metrics.nTrials} trials = ${(sig.dsr * 100).toFixed(0)}% (≥ 95% would be convincing).`);
  if (cs.cagr < bh.cagr) notes.push(`Strategy CAGR ${(cs.cagr * 100).toFixed(1)}% trails buy-and-hold ${(bh.cagr * 100).toFixed(1)}% over the same period (exposure ${(metrics.exposure * 100).toFixed(0)}%).`);
  if (metrics.brier != null && metrics.brierBaseRate != null && metrics.brier >= metrics.brierBaseRate)
    notes.push(`Brier ${metrics.brier.toFixed(4)} is not better than the base-rate forecast ${metrics.brierBaseRate.toFixed(4)} — probabilities carry no demonstrated skill.`);
  if (stride < H) notes.push(`Calibration pairs overlap (stride ${stride} < ahead ${H}); effective sample ≈ ${Math.round(calibrationPairs.length * stride / H)}.`);
  notes.push("Only technical/regime/ml families are testable historically; live decisions also use families this backtest cannot validate. Universe is survivor-selected — halve any backtested edge.");
  if (Object.keys(analyzerErrors).length) notes.push(`Analyzer errors: ${JSON.stringify(analyzerErrors)}.`);

  return { asset: { id: asset.id, symbol: asset.symbol, assetClass: cls }, horizon, trades, equity: curve, metrics,
    calibrationPairs, signalStats, notes };
}

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const o = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2), nx = argv[k + 1];
    if (nx == null || nx.startsWith("--")) o[key] = true; else { o[key] = nx; k++; }
  }
  return o;
}

async function coinbaseDaily(product, tfSec, limit) {
  const axios = require("axios");
  const out = new Map();
  let end = Date.now();
  for (let page = 0; page < Math.ceil(limit / 300) + 1 && out.size < limit; page++) {
    const start = end - 300 * tfSec * 1000;
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${tfSec}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const { data } = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "decision-engine-backtest/1.0" } });
    if (!Array.isArray(data) || !data.length) break;
    for (const r of data) out.set(r[0] * 1000, { t: r[0] * 1000, o: +r[3], h: +r[2], l: +r[1], c: +r[4], v: +r[5] });
    end = start - tfSec * 1000;
    await new Promise(r => setTimeout(r, 250));
  }
  return [...out.values()].sort((a, b) => a.t - b.t).slice(-limit);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = String(args.symbol || "BTC").toUpperCase();
  const cls = String(args.class || (baseCfg.CRYPTO_UNIVERSE[symbol] ? "crypto" : "stock"));
  const horizon = String(args.horizon || "swing");
  const hz = baseCfg.HORIZONS[horizon] || baseCfg.HORIZONS.swing;
  const limit = Number(args.limit) || Math.max(hz.history, 2500);
  const asset = baseCfg.ASSETS.find(a => a.symbol === symbol && a.assetClass === cls)
    || (cls === "crypto" ? { ...(baseCfg.CRYPTO_UNIVERSE[symbol] || { symbol, coinbase: `${symbol}-USD` }), assetClass: "crypto", id: `CRYPTO:${symbol}` }
      : { symbol, name: symbol, assetClass: "stock", id: `STOCK:${symbol}`, etf: ["SPY", "QQQ", "IWM", "DIA"].includes(symbol) });
  let candles = [];
  const data = tryRequire("../data");
  if (data && typeof data.candles === "function") { try { candles = await data.candles(asset, hz.tf, limit); } catch { candles = []; } }
  if ((!Array.isArray(candles) || candles.length < 300) && cls === "crypto") candles = await coinbaseDaily(asset.coinbase || `${symbol}-USD`, hz.tf, limit);
  const t0 = Date.now();
  const res = run({ candles, asset, horizon, stride: Number(args.stride) || 1, useML: !args["no-ml"], sizing: args.sizing || "full",
    nTrials: Number(args.trials) || 10 });
  const out = args.full ? res : {
    asset: res.asset, horizon, candles: candles.length, runtimeSec: (Date.now() - t0) / 1000, metrics: res.metrics, notes: res.notes,
    lastTrades: res.trades.slice(-10), nCalibrationPairs: res.calibrationPairs.length,
    topSignals: Object.entries(res.signalStats).filter(([, s]) => s.n >= 50).sort((a, b) => b[1].hitRate - a[1].hitRate)
      .map(([id, s]) => ({ id, ...s })),
  };
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main().catch(e => { console.error(e && e.stack || e); process.exit(1); });

module.exports = { run, sharpeSignificance, ece, wilson, curveStats, fallbackAtr };
