// Online per-signal weights (contract §2.13) — Hedge / multiplicative weights with fixed share.
//
// After a decision resolves with outcome y ∈ {0,1}, every signal that voted (score ≠ 0,
// confidence > 0) is updated:
//     w ← w · exp(η · scale · (correct ? +1 : −1) · |score| · confidence),   clamped to [0.5, 2]
// where correct = sign(score) agrees with the outcome and `scale` (default 1) lets the caller
// down-weight overlapping outcomes (the engine passes 1/ahead). Before each update every known
// weight is pulled toward 1 by fixed share (Herbster & Warmuth 1998): w ← (1 − α)·w + α, α=0.005,
// i.e. a memory of ≈ 200 outcomes. Unknown ids have weight 1.
//
// Defaults (η = 0.05, clamp [0.5, 2]) follow docs/RESEARCH.md §5.1: labels are very noisy, and
// the forecast-combination puzzle says to stay close to equal weights.
"use strict";

const W_MIN = 0.5, W_MAX = 2;
const PRIOR_OBS = 50; // pseudo-observations at 50% used to shrink seeded hit rates
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (x, d) => (x !== null && x !== "" && Number.isFinite(Number(x)) ? Number(x) : d);

class WeightLearner {
  constructor({ eta = 0.05, decay = 0.005, min = W_MIN, max = W_MAX } = {}) {
    this.eta = eta; this.decay = decay; this.min = min; this.max = max;
    this.w = Object.create(null);   // id -> { w, n, hits, prior?: { n, hits, hitRate } }
  }

  get(id) {
    const e = this.w[id];
    return e && Number.isFinite(e.w) ? e.w : 1;
  }

  /**
   * Update from one resolved decision. votes: [{ id, family, score, confidence }].
   * opts.scale multiplies the learning rate (e.g. 1/ahead for overlapping labels).
   * Returns the number of signals updated.
   */
  update(votes, y, { scale = 1 } = {}) {
    const out = y === true ? 1 : y === false ? 0 : Number(y);
    if (out !== 0 && out !== 1) return 0;
    const sc = Number.isFinite(Number(scale)) ? Math.max(0, Number(scale)) : 1;
    if (this.decay > 0) {
      const a = this.decay * Math.min(1, sc); // overlapping outcomes also decay proportionally less
      for (const id in this.w) this.w[id].w = clamp((1 - a) * this.w[id].w + a, this.min, this.max);
    }
    let count = 0;
    for (const s of votes || []) {
      if (!s || typeof s.id !== "string") continue;
      const score = Number(s.score), conf = Number(s.confidence == null ? 1 : s.confidence);
      if (!Number.isFinite(score) || !Number.isFinite(conf) || score === 0 || conf <= 0) continue;
      const correct = (score > 0) === (out === 1);
      const e = this.w[s.id] || (this.w[s.id] = { w: 1, n: 0, hits: 0 });
      const mag = Math.min(1, Math.abs(score)) * Math.min(1, conf);
      const nw = e.w * Math.exp(this.eta * sc * (correct ? 1 : -1) * mag);
      e.w = clamp(Number.isFinite(nw) ? nw : e.w, this.min, this.max);
      e.n++; if (correct) e.hits++;
      count++;
    }
    return count;
  }

  /**
   * Set prior weights from backtest stats { id: { n, hits } }. The hit rate is shrunk toward 0.5
   * with PRIOR_OBS pseudo-observations, h̃ = (hits + 25)/(n + 50), and the weight is the shrunk
   * odds ratio h̃/(1 − h̃), clamped to [min, max] (h̃ = 0.55 → 1.22, 0.45 → 0.82). Live n/hits
   * are not touched; the prior is kept for the report.
   */
  seed(signalStats) {
    let count = 0;
    if (!signalStats || typeof signalStats !== "object") return 0;
    for (const id of Object.keys(signalStats)) {
      const st = signalStats[id] || {};
      const n = Math.max(0, num(st.n, 0)), hits = clamp(num(st.hits, 0), 0, n);
      if (!n) continue;
      const h = (hits + 0.5 * PRIOR_OBS) / (n + PRIOR_OBS);
      const e = this.w[id] || (this.w[id] = { w: 1, n: 0, hits: 0 });
      e.w = clamp(h / (1 - h), this.min, this.max);
      e.prior = { n, hits, hitRate: +(hits / n).toFixed(4) };
      count++;
    }
    return count;
  }

  /** { id: { w, n, hitRate, prior? } } */
  report() {
    const r = {};
    for (const id of Object.keys(this.w).sort()) {
      const e = this.w[id];
      r[id] = { w: +e.w.toFixed(4), n: e.n, hitRate: e.n ? +(e.hits / e.n).toFixed(4) : null };
      if (e.prior) r[id].prior = { ...e.prior };
    }
    return r;
  }

  toJSON() {
    return { v: 2, eta: this.eta, decay: this.decay, min: this.min, max: this.max, weights: this.w };
  }

  static fromJSON(o) {
    const L = new WeightLearner(o && typeof o === "object"
      ? { eta: num(o.eta, 0.05), decay: num(o.decay, 0.005), min: num(o.min, W_MIN), max: num(o.max, W_MAX) }
      : {});
    const ws = o && o.weights;
    if (ws && typeof ws === "object") {
      for (const id of Object.keys(ws)) {
        const e = ws[id] || {};
        const n = Math.max(0, Math.floor(num(e.n, 0)));
        L.w[id] = { w: clamp(num(e.w, 1), L.min, L.max), n, hits: clamp(Math.floor(num(e.hits, 0)), 0, n) };
        if (e.prior && typeof e.prior === "object") L.w[id].prior = { n: num(e.prior.n, 0), hits: num(e.prior.hits, 0), hitRate: num(e.prior.hitRate, null) };
      }
    }
    return L;
  }
}

module.exports = { WeightLearner, W_MIN, W_MAX, PRIOR_OBS };
