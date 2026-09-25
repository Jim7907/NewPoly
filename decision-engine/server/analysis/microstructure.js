// Market microstructure (contract §2.8). Pure: order book + signed trades in, Signal[] out.
//
// ms = { book: { bids:[[p,s]], asks:[[p,s]] }, trades:[{t, side, size, price}], mid,
//        bookHistory?: [{ bidPx, bidSz, askPx, askSz }] | [{bids,asks}] (oldest → newest) }
// trades[].side is the TAKER (aggressor) side: "buy"/"sell" (also "b"/"s", or a signed size).
// (Coinbase `matches` report the MAKER side — the data layer must flip it before calling this.)
//
// Evidence: order-flow imbalance (Cont, Kukanov & Stoikov 2014) and depth imbalance
// (Cartea, Donnelly & Jaimungal 2018) predict price changes over seconds-to-minutes, decaying fast;
// trade-flow imbalance / CVD likewise. VPIN (Easley, López de Prado & O'Hara 2012) measures flow
// toxicity (probability of informed trading) in volume time — high VPIN = one-sided informed flow
// and imminent volatility. All of this is an INTRADAY signal: confidence is multiplied by
// 1.0 (intraday) / 0.25 (swing) / 0.1 (position) via opts.horizon.

const FAMILY = "microstructure";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (typeof x === "string" && x.trim() !== "" ? Number(x) : x);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const squash = (x) => (isNum(x) ? Math.tanh(x) : 0);
const HORIZON_MULT = { intraday: 1, swing: 0.25, position: 0.1, any: 1 };

function makeSignal(id, score, confidence, value, reason, opts) {
  const m = HORIZON_MULT[opts && opts.horizon] ?? 1;
  return {
    id, family: FAMILY,
    score: round(isNum(score) ? clamp(score, -1, 1) : 0),
    confidence: round(isNum(confidence) ? clamp(confidence * m * (opts && isNum(opts.qualityMult) ? opts.qualityMult : 1), 0, 1) : 0),
    horizon: "intraday", value, reason,
  };
}

function levels(side) {
  if (!Array.isArray(side)) return [];
  return side
    .map((l) => (Array.isArray(l) ? [num(l[0]), num(l[1])] : l ? [num(l.price), num(l.size)] : [NaN, NaN]))
    .filter(([p, s]) => isNum(p) && isNum(s) && p > 0 && s > 0);
}

function normBook(book) {
  if (!book) return null;
  const bids = levels(book.bids).sort((a, b) => b[0] - a[0]);
  const asks = levels(book.asks).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks };
}

// Depth-weighted imbalance within `bandBps` of mid: each level's notional is weighted linearly by
// proximity (1 at mid → 0 at the band edge). Returns (B − A)/(B + A) or null if the band is empty.
function bandImbalance(book, mid, bandBps) {
  const band = mid * bandBps / 1e4;
  let B = 0, A = 0;
  for (const [p, s] of book.bids) { const d = mid - p; if (d > band) break; B += p * s * (1 - Math.max(0, d) / band); }
  for (const [p, s] of book.asks) { const d = p - mid; if (d > band) break; A += p * s * (1 - Math.max(0, d) / band); }
  return B + A > 0 ? (B - A) / (B + A) : null;
}

function tradeSign(tr) {
  const side = typeof tr.side === "string" ? tr.side.toLowerCase() : null;
  if (side === "buy" || side === "b" || side === "bid") return 1;
  if (side === "sell" || side === "s" || side === "ask") return -1;
  const sz = num(tr.size);
  return isNum(sz) && sz !== 0 ? Math.sign(sz) : 0;
}

function normTrades(trades) {
  if (!Array.isArray(trades)) return [];
  const out = [];
  for (const tr of trades) {
    if (!tr) continue;
    const t = num(tr.t) ?? (tr.time ? Date.parse(tr.time) : null);
    const size = Math.abs(num(tr.size));
    const price = num(tr.price);
    const sign = tradeSign(tr);
    if (!isNum(size) || size <= 0 || !sign) continue;
    out.push({ t: isNum(t) ? t : out.length, size, price: isNum(price) ? price : null, sign });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Cont-Kukanov-Stoikov OFI over a sequence of top-of-book snapshots:
//   e_n = 1{Pb_n ≥ Pb_{n−1}}·qb_n − 1{Pb_n ≤ Pb_{n−1}}·qb_{n−1} − 1{Pa_n ≤ Pa_{n−1}}·qa_n + 1{Pa_n ≥ Pa_{n−1}}·qa_{n−1}
// Returns { ofi, depth (mean top-of-book size), n } or null.
function ofi(tops) {
  if (!Array.isArray(tops)) return null;
  const q = tops.map((x) => {
    if (x && x.bids) { const b = normBook(x); return b ? { bp: b.bids[0][0], bq: b.bids[0][1], ap: b.asks[0][0], aq: b.asks[0][1] } : null; }
    return x ? { bp: num(x.bidPx), bq: num(x.bidSz), ap: num(x.askPx), aq: num(x.askSz) } : null;
  }).filter((x) => x && [x.bp, x.bq, x.ap, x.aq].every(isNum));
  if (q.length < 2) return null;
  let e = 0, depth = 0;
  for (let n = 1; n < q.length; n++) {
    const c = q[n], p = q[n - 1];
    e += (c.bp >= p.bp ? c.bq : 0) - (c.bp <= p.bp ? p.bq : 0) - (c.ap <= p.ap ? c.aq : 0) + (c.ap >= p.ap ? p.aq : 0);
  }
  for (const x of q) depth += (x.bq + x.aq) / 2;
  return { ofi: e, depth: depth / q.length, n: q.length - 1 };
}

// VPIN with exact trade signs (no bulk-volume classification needed): split the signed volume
// stream into `nBuckets` equal-volume buckets, VPIN = mean |V_buy − V_sell| / V_bucket.
function vpin(trades, nBuckets = 20) {
  const total = trades.reduce((a, x) => a + x.size, 0);
  if (!(total > 0) || trades.length < 2 * nBuckets) return null;
  const V = total / nBuckets;
  const imb = [];
  let buy = 0, sell = 0, filled = 0;
  for (const tr of trades) {
    let rem = tr.size;
    while (rem > 1e-12) {
      const take = Math.min(rem, V - filled);
      if (tr.sign > 0) buy += take; else sell += take;
      filled += take; rem -= take;
      if (filled >= V - 1e-9) { imb.push({ abs: Math.abs(buy - sell) / V, signed: (buy - sell) / V }); buy = sell = filled = 0; }
    }
  }
  if (imb.length < Math.floor(nBuckets / 2)) return null;
  const vp = imb.reduce((a, x) => a + x.abs, 0) / imb.length;
  const recent = imb.slice(-Math.max(3, Math.floor(imb.length / 4)));
  const dir = recent.reduce((a, x) => a + x.signed, 0) / recent.length;
  return { vpin: vp, buckets: imb.length, recentDir: dir };
}

function signals(ms, opts = {}) {
  if (!ms || typeof ms !== "object") return [];
  const out = [];
  const book = normBook(ms.book);
  let mid = isNum(num(ms.mid)) && num(ms.mid) > 0 ? num(ms.mid) : null;
  let spreadBps = null;
  const o = { horizon: opts.horizon, qualityMult: 1 };

  if (book) {
    const bb = book.bids[0][0], ba = book.asks[0][0];
    if (ba > bb) {
      if (!mid) mid = (bb + ba) / 2;
      spreadBps = (ba - bb) / ((bb + ba) / 2) * 1e4;
      // Wide spread → thin, noisy book → trust all micro signals less.
      o.qualityMult = clamp(1 - squash(Math.max(0, spreadBps - 5) / 40), 0.3, 1);
    }
  }

  // ---- Book imbalance ----
  if (book && mid) {
    const i10 = bandImbalance(book, mid, 10), i25 = bandImbalance(book, mid, 25), i50 = bandImbalance(book, mid, 50);
    const parts = [[i10, 0.5], [i25, 0.3], [i50, 0.2]].filter(([v]) => isNum(v));
    if (parts.length) {
      const wsum = parts.reduce((a, [, w]) => a + w, 0);
      const obi = parts.reduce((a, [v, w]) => a + v * w, 0) / wsum;
      const score = 0.8 * squash(1.5 * obi);
      out.push(makeSignal("micro.book.imbalance", score, (0.3 + 0.35 * Math.abs(squash(1.5 * obi))) * (wsum / 1),
        { obi: round(obi), obi10: round(i10), obi25: round(i25), obi50: round(i50) },
        `Depth-weighted book imbalance ${obi >= 0 ? "+" : ""}${obi.toFixed(2)} (10/25/50bp: ${[i10, i25, i50].map((v) => (isNum(v) ? v.toFixed(2) : "–")).join("/")}) — ${obi > 0.15 ? "bid-heavy" : obi < -0.15 ? "ask-heavy" : "balanced"}`, o));
    }
  }
  if (isNum(spreadBps)) {
    // Informational only (no directional opinion): feeds UI and gates the other signals' confidence.
    out.push(makeSignal("micro.book.spread", 0, 0, { spreadBps: round(spreadBps, 2), mid: round(mid, 8) },
      `Spread ${spreadBps.toFixed(2)}bp${spreadBps > 10 ? " — thin liquidity, micro signals discounted" : ""}`, o));
  }

  // ---- OFI (needs book history) ----
  const of = ofi(ms.bookHistory);
  if (of && of.depth > 0) {
    const norm = of.ofi / (of.depth * Math.sqrt(of.n));
    out.push(makeSignal("micro.flow.ofi", 0.7 * squash(norm), 0.3 + 0.3 * Math.abs(squash(norm)) * clamp(of.n / 20, 0, 1),
      { ofi: round(of.ofi, 6), normalized: round(norm), updates: of.n },
      `Order-flow imbalance (CKS) ${norm >= 0 ? "+" : ""}${norm.toFixed(2)} depth-normalized over ${of.n} book updates`, o));
  }

  // ---- Trade flow ----
  let trades = normTrades(ms.trades);
  const windowMs = isNum(opts.windowMs) ? opts.windowMs : 5 * 60 * 1000;
  if (trades.length && trades[trades.length - 1].t > 1e11) {
    const tEnd = trades[trades.length - 1].t;
    const inWin = trades.filter((x) => x.t >= tEnd - windowMs);
    if (inWin.length >= 10) trades = inWin;
  }
  if (trades.length >= 5) {
    const tEnd = trades[trades.length - 1].t, tStart = trades[0].t;
    const span = Math.max(1, tEnd - tStart);
    const hl = span / 3; // recency half-life = a third of the window
    let sb = 0, ss = 0, raw = 0, tot = 0;
    for (const x of trades) {
      const w = Math.pow(0.5, (tEnd - x.t) / hl);
      const notional = x.size * (x.price || mid || 1);
      if (x.sign > 0) sb += w * notional; else ss += w * notional;
      raw += x.sign * x.size; tot += x.size;
    }
    const tfi = sb + ss > 0 ? (sb - ss) / (sb + ss) : 0;
    const nConf = 1 - Math.exp(-trades.length / 40);
    out.push(makeSignal("micro.flow.imbalance", 0.7 * squash(2 * tfi), (0.25 + 0.35 * Math.abs(squash(2 * tfi))) * nConf,
      { tfi: round(tfi), trades: trades.length, netVolume: round(raw, 6), totalVolume: round(tot, 6) },
      `Taker flow imbalance ${tfi >= 0 ? "+" : ""}${(tfi * 100).toFixed(0)}% (recency-weighted) over ${trades.length} trades`, o));

    // CVD slope: OLS of cumulative signed volume on time, normalized so that a one-sided tape
    // (all buys) → +1: slope·span / total volume.
    let cvd = 0;
    const pts = trades.map((x) => { cvd += x.sign * x.size; return [x.t - tStart, cvd]; });
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    if (sxx > 0 && tot > 0) {
      const slopeNorm = (sxy / sxx) * span / tot;
      const pFirst = trades.find((x) => x.price)?.price, pLast = [...trades].reverse().find((x) => x.price)?.price;
      const pChg = pFirst && pLast ? pLast / pFirst - 1 : null;
      const diverge = isNum(pChg) && Math.sign(pChg) !== 0 && Math.sign(pChg) !== Math.sign(slopeNorm) && Math.abs(slopeNorm) > 0.2;
      out.push(makeSignal("micro.flow.cvd_slope", 0.6 * squash(2.5 * slopeNorm), (0.2 + 0.3 * Math.abs(squash(2.5 * slopeNorm))) * nConf * (diverge ? 0.6 : 1),
        { slopeNorm: round(slopeNorm), cvd: round(cvd, 6), priceChange: round(pChg, 6) },
        `CVD slope ${slopeNorm >= 0 ? "+" : ""}${slopeNorm.toFixed(2)} (normalized)${diverge ? `, diverging from price (${(pChg * 100).toFixed(2)}%) — absorption, discounted` : ""}`, o));
    }
  }

  // ---- VPIN toxicity ----
  const vp = vpin(normTrades(ms.trades), isNum(opts.vpinBuckets) ? opts.vpinBuckets : 20);
  if (vp) {
    const tox = Math.max(0, squash((vp.vpin - 0.3) / 0.2)); // 0 below ~0.3, → 1 above ~0.6
    const dir = Math.abs(vp.recentDir) > 0.05 ? Math.sign(vp.recentDir) : 0;
    out.push(makeSignal("micro.toxicity.vpin", dir * 0.5 * tox, dir ? 0.15 + 0.35 * tox : 0,
      { vpin: round(vp.vpin), buckets: vp.buckets, recentDir: round(vp.recentDir) },
      `VPIN ${vp.vpin.toFixed(2)} over ${vp.buckets} volume buckets — ${tox > 0.5 ? "toxic, one-sided informed flow" : tox > 0.1 ? "elevated toxicity" : "benign flow"}${dir && tox > 0.1 ? ` leaning ${dir > 0 ? "buy" : "sell"}` : ""}`, o));
  }
  return out;
}

module.exports = { signals, ofi, vpin: (trades, n) => vpin(normTrades(trades), n), bandImbalance: (book, mid, bps) => { const b = normBook(book); return b ? bandImbalance(b, mid, bps) : null; } };
