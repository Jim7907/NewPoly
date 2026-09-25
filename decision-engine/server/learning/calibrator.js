// Probability calibrator (contract §2.12).
//
// Method is chosen on the EFFECTIVE sample size n_eff = n / ahead (consecutive outcomes of an
// `ahead`-bar label overlap, so they are not independent — docs/RESEARCH.md §5.1):
//  n_eff < 30          → identity-with-shrink: q = 0.5 + SHRINK·(p − 0.5), reliable: false
//  30 ≤ n_eff < 300    → Platt scaling on the logit: q = σ(a·logit(p) + b), fit by Newton/IRLS
//                        with Platt's smoothed targets and a tiny ridge; a is floored at 0 so the
//                        map is never decreasing (anti-informative input collapses to base rate).
//  300 ≤ n_eff < 1000  → blend q = w·iso + (1 − w)·platt, w = (n_eff − 300)/700 (0 → 1)
//  n_eff ≥ 1000        → isotonic regression (pool-adjacent-violators), linearly interpolated
//                        between block centres.
// Every branch is monotone non-decreasing in p and clipped to [0.01, 0.99].
// Reliability metrics use 10 EQUAL-MASS bins (our probabilities cluster in 0.4–0.6, so
// equal-width bins would leave most bins empty and hide miscalibration).
"use strict";

const SHRINK = 0.5;
const MIN_N = 30;
const BLEND_N = 300, ISO_N = 1000;
const P_LO = 0.01, P_HI = 0.99;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const sigmoid = z => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const logit = p => { const q = clamp(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)); };

function cleanPairs(pairs) {
  const out = [];
  for (const r of pairs || []) {
    if (!r) continue;
    const p = Number(r.p);
    const y = r.y === true ? 1 : r.y === false ? 0 : Number(r.y);
    if (Number.isFinite(p) && (y === 0 || y === 1)) out.push({ p: clamp(p, 0, 1), y });
  }
  return out;
}

/** Platt scaling via Newton on z = logit(p). Returns { a, b }. */
function fitPlatt(pairs) {
  const n = pairs.length;
  const nPos = pairs.reduce((s, r) => s + r.y, 0), nNeg = n - nPos;
  const tPos = (nPos + 1) / (nPos + 2), tNeg = 1 / (nNeg + 2);
  const z = pairs.map(r => logit(r.p)), t = pairs.map(r => (r.y ? tPos : tNeg));
  let a = 1, b = 0;
  const ridge = 1e-3;
  for (let it = 0; it < 50; it++) {
    let ga = ridge * (a - 1), gb = ridge * b, haa = ridge, hab = 0, hbb = ridge;
    for (let i = 0; i < n; i++) {
      const q = sigmoid(a * z[i] + b), e = q - t[i], w = Math.max(q * (1 - q), 1e-9);
      ga += e * z[i]; gb += e;
      haa += w * z[i] * z[i]; hab += w * z[i]; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-15)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) { a = 1; b = 0; break; }
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  if (a < 0) { // anti-informative: refuse to invert, use the (smoothed) base rate
    a = 0; b = logit((nPos + 1) / (n + 2));
  }
  return { a, b };
}

/** Pool-adjacent-violators. Returns block centres xs (ascending) and fitted ys (non-decreasing). */
function fitIsotonic(pairs) {
  const s = pairs.slice().sort((u, v) => u.p - v.p);
  const blocks = []; // { sx, sy, w }
  for (const r of s) {
    blocks.push({ sx: r.p, sy: r.y, w: 1 });
    while (blocks.length > 1) {
      const B = blocks[blocks.length - 1], A = blocks[blocks.length - 2];
      if (A.sy / A.w <= B.sy / B.w) break;
      A.sx += B.sx; A.sy += B.sy; A.w += B.w; blocks.pop();
    }
  }
  // Minimum support per step: PAV happily produces tiny tail blocks (e.g. the 3 highest scores all
  // happened to win → 100%). Merge any block lighter than minW into its lighter-side neighbour;
  // merging adjacent monotone blocks keeps the fit monotone.
  const minW = Math.max(30, Math.floor(0.02 * s.length));
  for (let changed = true; changed && blocks.length > 1;) {
    changed = false;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].w >= minW) continue;
      const j = i === 0 ? 1 : i === blocks.length - 1 ? i - 1 : (blocks[i - 1].w <= blocks[i + 1].w ? i - 1 : i + 1);
      const [a, b2] = j < i ? [blocks[j], blocks[i]] : [blocks[i], blocks[j]];
      a.sx += b2.sx; a.sy += b2.sy; a.w += b2.w;
      blocks.splice(j < i ? i : j, 1);
      changed = true; break;
    }
  }
  // blocks with identical centres cannot occur (sorted + pooled), but guard anyway
  const xs = [], ys = [];
  for (const B of blocks) {
    const x = B.sx / B.w, y = B.sy / B.w;
    if (xs.length && x <= xs[xs.length - 1]) { ys[ys.length - 1] = Math.max(ys[ys.length - 1], y); continue; }
    xs.push(x); ys.push(y);
  }
  return { xs, ys };
}

function isoApply(iso, p) {
  const { xs, ys } = iso;
  if (!xs.length) return p;
  if (p <= xs[0]) return ys[0];
  if (p >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= p) lo = m; else hi = m; }
  const f = (p - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + f * (ys[hi] - ys[lo]);
}

/**
 * Brier / logloss / ECE over 10 equal-mass bins for raw [{p, y}] (no fitting). Each bin reports
 * its p-range (lo, hi), count, mean p and hit rate. Tied p values never straddle two bins.
 */
function reliabilityOf(pairs, nBins = 10) {
  const P = cleanPairs(pairs);
  const n = P.length;
  if (!n) return { n: 0, brier: null, logloss: null, ece: null, bins: [] };
  let br = 0, ll = 0;
  for (const { p, y } of P) {
    br += (p - y) ** 2;
    const q = clamp(p, 1e-6, 1 - 1e-6);
    ll -= y ? Math.log(q) : Math.log(1 - q);
  }
  const s = P.slice().sort((a, b) => a.p - b.p);
  const bins = [];
  let start = 0;
  for (let k = 1; k <= nBins && start < n; k++) {
    let end = k === nBins ? n : Math.round((k * n) / nBins);
    if (end <= start) continue;
    while (end < n && s[end].p === s[end - 1].p) end++; // keep ties together
    let sp = 0, sy = 0;
    for (let i = start; i < end; i++) { sp += s[i].p; sy += s[i].y; }
    bins.push({ lo: s[start].p, hi: s[end - 1].p, n: end - start, pMean: sp / (end - start), yRate: sy / (end - start) });
    start = end;
  }
  let ece = 0;
  for (const b of bins) ece += (b.n / n) * Math.abs(b.pMean - b.yRate);
  const r = x => +x.toFixed(6);
  return {
    n, brier: r(br / n), logloss: r(ll / n), ece: r(ece),
    bins: bins.map(b => ({ lo: r(b.lo), hi: r(b.hi), n: b.n, pMean: r(b.pMean), yRate: r(b.yRate) })),
  };
}

class Calibrator {
  constructor() {
    this.method = "identity-shrink";
    this.n = 0;
    this.platt = null;
    this.iso = null;
    this.wIso = 0;
    this.nEff = 0;
    this.ahead = 1;
    this._rel = { ...reliabilityOf([]), reliable: false, method: this.method, nEff: 0, raw: reliabilityOf([]) };
  }

  /** pairs: [{p, y}] in time order; opts.ahead = label length in bars (n_eff = n / ahead). */
  fit(pairs, { ahead = 1 } = {}) {
    const P = cleanPairs(pairs);
    this.ahead = Math.max(1, Number(ahead) || 1);
    this.n = P.length;
    this.nEff = P.length / this.ahead;
    this.platt = null; this.iso = null; this.wIso = 0;
    // Support: never extrapolate beyond the 1st–99th percentile of scores seen in training. A live
    // score outside that range (e.g. extra families pushing pRaw past anything backtested) is
    // treated as the boundary value rather than trusted to an unfitted region.
    const sp = P.map(r => r.p).sort((u, v) => u - v);
    this.support = sp.length >= 100 ? [sp[Math.floor(0.01 * (sp.length - 1))], sp[Math.ceil(0.99 * (sp.length - 1))]] : null;
    const ne = this.nEff;
    if (ne < MIN_N) this.method = "identity-shrink";
    else if (ne < BLEND_N) { this.platt = fitPlatt(P); this.method = "platt"; }
    else if (ne < ISO_N) {
      this.platt = fitPlatt(P); this.iso = fitIsotonic(P);
      this.wIso = (ne - BLEND_N) / (ISO_N - BLEND_N);
      this.method = "isotonic+platt";
    } else { this.iso = fitIsotonic(P); this.wIso = 1; this.method = "isotonic"; }
    // In-sample reliability of the calibrated output (and of the raw input, for comparison).
    const cal = P.map(r => ({ p: this.apply(r.p), y: r.y }));
    this._rel = { ...reliabilityOf(cal), reliable: this.reliable, method: this.method, nEff: +ne.toFixed(2), raw: reliabilityOf(P) };
    return this;
  }

  apply(p) {
    let x = Number(p);
    if (!Number.isFinite(x)) x = 0.5;
    x = clamp(x, 0, 1);
    if (this.support) x = clamp(x, this.support[0], this.support[1]);
    let q;
    if (this.method === "identity-shrink") q = 0.5 + SHRINK * (x - 0.5);
    else if (this.method === "isotonic") q = isoApply(this.iso, x);
    else {
      const qp = sigmoid(this.platt.a * logit(x) + this.platt.b);
      q = this.method === "isotonic+platt" ? this.wIso * isoApply(this.iso, x) + (1 - this.wIso) * qp : qp;
    }
    return clamp(Number.isFinite(q) ? q : 0.5, P_LO, P_HI);
  }

  get reliable() { return this.method !== "identity-shrink"; }

  /** { n, nEff, brier, logloss, ece, bins, reliable, method, raw } — in-sample on the fitted pairs. */
  reliability() { return JSON.parse(JSON.stringify(this._rel)); }

  toJSON() {
    return { v: 2, method: this.method, n: this.n, nEff: this.nEff, ahead: this.ahead, platt: this.platt, iso: this.iso, wIso: this.wIso, support: this.support || null, reliability: this._rel };
  }

  static fromJSON(o) {
    const c = new Calibrator();
    if (!o || typeof o !== "object") return c;
    c.method = ["identity-shrink", "platt", "isotonic+platt", "isotonic"].includes(o.method) ? o.method : "identity-shrink";
    c.n = Number(o.n) || 0;
    c.nEff = Number(o.nEff) || c.n;
    c.ahead = Number(o.ahead) || 1;
    c.platt = o.platt && Number.isFinite(o.platt.a) && Number.isFinite(o.platt.b) ? { a: o.platt.a, b: o.platt.b } : null;
    c.iso = o.iso && Array.isArray(o.iso.xs) && Array.isArray(o.iso.ys) ? { xs: o.iso.xs.slice(), ys: o.iso.ys.slice() } : null;
    c.wIso = Number(o.wIso) || 0;
    c.support = Array.isArray(o.support) && o.support.length === 2 && o.support.every(Number.isFinite) ? o.support.slice() : null;
    // degrade gracefully if parameters are missing/corrupt
    if (c.method === "isotonic" && !c.iso) c.method = c.platt ? "platt" : "identity-shrink";
    if (c.method === "isotonic+platt" && !c.iso) c.method = "platt";
    if (c.method === "isotonic+platt" && !c.platt) c.method = "isotonic";
    if (c.method === "platt" && !c.platt) c.method = "identity-shrink";
    c._rel = o.reliability || { ...reliabilityOf([]), reliable: c.reliable, method: c.method, nEff: c.nEff, raw: reliabilityOf([]) };
    return c;
  }
}

Calibrator.reliabilityOf = reliabilityOf;

module.exports = { Calibrator, reliabilityOf, fitPlatt, fitIsotonic, SHRINK, MIN_N, BLEND_N, ISO_N };
