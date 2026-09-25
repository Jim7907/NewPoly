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
//
// AUDIT (2026-09) — base-rate neutrality. "correct = sign(score) agrees with y" rewards DRIFT, not
// skill: with stocks up 57% of weeks, a no-skill signal that is always bullish converged to w ≈ 1.94
// and an always-bearish one to w ≈ 0.63 (3000 simulated outcomes), turning the learner into a
// long-bias amplifier (the mirror image for crypto, base < 0.5). update() therefore accepts the
// class base rate b and rewards sign(score)·2·(y − b) instead of ±1 (identical when b = 0.5; zero in
// expectation for a no-skill vote). seed() likewise scores each signal against the hit rate a
// no-skill vote with the same long/short mix would have had, shrinks with the EFFECTIVE sample size
// n/ahead (overlapping labels), and POOLS repeated calls (warm start seeds one asset at a time —
// previously each call overwrote the last, so every shared id carried only the last asset's stats).
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
   * opts.baseRate (default 0.5) = the asset class's unconditional P(y = 1); the reward is
   * sign(score)·2·(y − baseRate), so pure drift earns nothing in expectation.
   * Returns the number of signals updated.
   */
  update(votes, y, { scale = 1, baseRate = 0.5 } = {}) {
    const out = y === true ? 1 : y === false ? 0 : Number(y);
    if (out !== 0 && out !== 1) return 0;
    const sc = Number.isFinite(Number(scale)) ? Math.max(0, Number(scale)) : 1;
    const b = Number.isFinite(Number(baseRate)) ? clamp(Number(baseRate), 0.05, 0.95) : 0.5;
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
      const reward = Math.sign(score) * 2 * (out - b);            // ±1 when b = 0.5
      const nw = e.w * Math.exp(this.eta * sc * reward * mag);
      e.w = clamp(Number.isFinite(nw) ? nw : e.w, this.min, this.max);
      e.n++; if (correct) e.hits++;
      count++;
    }
    return count;
  }

  /**
   * Set prior weights from backtest stats { id: { n, hits, nLong?, yUp?, ahead? } }.
   *   • Drift correction (when nLong/yUp are present): a no-skill vote with the same long/short mix
   *     would hit E₀ = nLong·b + (n − nLong)·(1 − b) times, b = yUp/n; the skill hit rate is
   *     h = 0.5 + (hits − E₀)/n. Without those fields h = hits/n (legacy behaviour).
   *   • Shrinkage toward 0.5 with PRIOR_OBS pseudo-observations on the EFFECTIVE sample size
   *     n_eff = n / ahead (opts.ahead or st.ahead; overlapping labels): h̃ = (n_eff·h + 25)/(n_eff + 50).
   *   • w = h̃/(1 − h̃) clamped to [min, max] (h̃ = 0.55 → 1.22, 0.45 → 0.82).
   *   • Repeated calls POOL the counts per id (warm start seeds one asset at a time).
   * Live n/hits are not touched; the pooled prior is kept for the report.
   */
  seed(signalStats, { ahead } = {}) {
    let count = 0;
    if (!signalStats || typeof signalStats !== "object") return 0;
    for (const id of Object.keys(signalStats)) {
      const st = signalStats[id] || {};
      const n = Math.max(0, num(st.n, 0)), hits = clamp(num(st.hits, 0), 0, n);
      if (!n) continue;
      const e = this.w[id] || (this.w[id] = { w: 1, n: 0, hits: 0 });
      const pr = e.prior || { n: 0, hits: 0 };
      const pooled = { n: pr.n + n, hits: pr.hits + hits };
      const hasMix = Number.isFinite(Number(st.nLong)) && Number.isFinite(Number(st.yUp));
      if (hasMix && (pr.n === 0 || Number.isFinite(pr.nLong))) {
        pooled.nLong = (pr.nLong || 0) + clamp(num(st.nLong, 0), 0, n);
        pooled.yUp = (pr.yUp || 0) + clamp(num(st.yUp, 0), 0, n);
      }
      const a = Math.max(1, num(ahead, num(st.ahead, 1)));
      pooled.nEff = (pr.nEff != null ? pr.nEff : pr.n) + n / a;
      let h = pooled.hits / pooled.n;
      if (Number.isFinite(pooled.nLong)) {
        const b = pooled.yUp / pooled.n;
        const e0 = pooled.nLong * b + (pooled.n - pooled.nLong) * (1 - b);
        h = clamp(0.5 + (pooled.hits - e0) / pooled.n, 0, 1);
        pooled.skillHitRate = +h.toFixed(4);
      }
      const hs = (pooled.nEff * h + 0.5 * PRIOR_OBS) / (pooled.nEff + PRIOR_OBS);
      e.w = clamp(hs / (1 - hs), this.min, this.max);
      pooled.hitRate = +(pooled.hits / pooled.n).toFixed(4);
      e.prior = pooled;
      count++;
    }
    return count;
  }

  /** Forget backtest priors (e.g. before a fresh warm start, so seed() does not pool the new
   *  backtests with the previous ones). Live n/hits and the current w are kept. Returns #cleared. */
  clearPriors() {
    let k = 0;
    for (const id in this.w) if (this.w[id].prior) { delete this.w[id].prior; k++; }
    return k;
  }

  /** { id: { w, n, hitRate, prior? } } */
  report() {
    const r = {};
    for (const id of Object.keys(this.w).sort()) {
      const e = this.w[id];
      r[id] = { w: +e.w.toFixed(4), n: e.n, hitRate: e.n ? +(e.hits / e.n).toFixed(4) : null };
      if (e.prior) {
        r[id].prior = { n: e.prior.n, hits: e.prior.hits, hitRate: e.prior.hitRate };
        if (Number.isFinite(e.prior.skillHitRate)) r[id].prior.skillHitRate = e.prior.skillHitRate;
      }
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
        if (e.prior && typeof e.prior === "object") {
          const pr = { n: num(e.prior.n, 0), hits: num(e.prior.hits, 0), hitRate: num(e.prior.hitRate, null) };
          for (const k of ["nLong", "yUp", "nEff", "skillHitRate"]) if (Number.isFinite(Number(e.prior[k]))) pr[k] = Number(e.prior[k]);
          L.w[id].prior = pr;
        }
      }
    }
    return L;
  }
}

module.exports = { WeightLearner, W_MIN, W_MAX, PRIOR_OBS };
