// Concept-drift detection on live outcomes (docs/CONTRACT-v2.md §5, drift.js).
//
// Streams (both oriented so that HIGHER = WORSE):
//   • per-decision log-loss  L = −[y·ln p + (1−y)·ln(1−p)],  p clipped to [0.01, 0.99]
//   • miss indicator          1 − hit,  hit = 1{(p ≥ 0.5) = (y = 1)}
//
// PageHinkley (Page 1954; Hinkley 1971; the form used by Gama et al. 2013 / MOA / river), one-sided
// for an INCREASE of the mean, run on the standardized stream z = (x − x̄_burn)/σ̂_burn, where x̄ and
// σ̂ are estimated on the first `burnIn` observations (no alarms during burn-in; standardizing makes
// the parameters scale-free, so one setting serves log-loss and the Bernoulli miss stream):
//     x̄_n = running mean of z;  m_n = α·m_{n−1} + (z_n − x̄_n − δ);  M_n = min_k m_k;  PH_n = m_n − M_n
//     alarm when PH_n > λ, warning when PH_n > warnFrac·λ.   z is winsorized at ±5 against outliers.
//   δ (delta)  = 0.2 σ   drift tolerated per observation (CUSUM reference value k = shift/2 for the
//                        ~0.4σ shifts that matter; smaller δ multiplies false alarms, see below).
//   λ (lambda) = 25 σ    alarm threshold. Chosen from a sweep over δ ∈ {0.05…0.25}, λ ∈ {15…40} on
//                        N(0,1) streams (300 seeds each): per detector ≈ 2% false alarms per 2,000
//                        stationary observations; a 1σ mean shift is flagged after a median ~29
//                        observations, a 0.5σ shift after ~84. (δ=0.1/λ=25 alarmed falsely 19% of the
//                        time; δ=0.25/λ=25 missed 4% of 0.5σ shifts.) test/drift.test.js re-measures.
//   α (alpha)  = 1       no forgetting (a fading factor < 1 would bound the sum but also slow detection).
//   burnIn     = 50      observations used to estimate x̄, σ̂ (≈ 3–4 trading days of the live watchlist).
//
// AdwinLite (Bifet & Gavaldà 2007, simplified): a bounded window (≤ maxWindow) is checked every
// `checkEvery` updates at split points spaced `stride` apart; a cut is declared when
//     |μ̂_0 − μ̂_1| > ε = √(2/m·σ̂²·ln(2/δ')) + 2/(3m)·ln(2/δ'),  m = 1/(1/n0 + 1/n1),  δ' = δ/ln(n)
// (δ = 0.01) and the older sub-window is dropped. Only an INCREASE (degradation) counts as drift.
// It is the slower, assumption-light backstop for abrupt changes; PageHinkley does most detecting.
//
// DriftMonitor combines PH(log-loss), PH(miss) and ADWIN-lite(log-loss):
//   level "drift" when any detector alarms on this update (the detectors then reset), "warn" when
//   either PH statistic is above warnFrac·λ, else "ok".
//   Measured on live-like streams (calibrated p ~ U(0.35, 0.70), 200 seeds, test/drift.test.js):
//   2.5% false alarms per 2,000 stationary decisions; when the model's calls turn wrong (hit rate
//   ≈57% → 43%, log-loss +≈0.3σ per decision) drift is flagged after a median ~109 decisions
//   (p90 ~265; 1% not flagged within 2,000) — about a week of the live watchlist at one sample
//   per asset per day.
"use strict";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const PH_DEFAULTS = Object.freeze({ delta: 0.2, lambda: 25, alpha: 1, burnIn: 50, warnFrac: 0.5, clip: 5, standardize: true });
const ADWIN_DEFAULTS = Object.freeze({ delta: 0.01, maxWindow: 1000, minSub: 50, checkEvery: 10, stride: 10 });
const P_CLIP = 0.01;

/** Per-decision log-loss with p clipped to [0.01, 0.99]. */
function logLoss(p, y) {
  const q = clamp(Number(p), P_CLIP, 1 - P_CLIP);
  return y ? -Math.log(q) : -Math.log(1 - q);
}

class PageHinkley {
  constructor(opts = {}) {
    const o = { ...PH_DEFAULTS, ...opts };
    this.delta = o.delta; this.lambda = o.lambda; this.alpha = o.alpha;
    this.burnIn = Math.max(2, Math.floor(o.burnIn)); this.warnFrac = o.warnFrac; this.clip = o.clip;
    this.standardize = o.standardize !== false;
    this.reset(true);
  }

  /** Reset the change statistic. full=true also forgets the burn-in scale estimate. */
  reset(full = false) {
    this.n = 0; this.mean = 0; this.sum = 0; this.min = 0; this.stat = 0;
    if (full) { this.bn = 0; this.bMean = 0; this.bM2 = 0; this.mu0 = null; this.sigma0 = null; this.alarms = 0; this.total = 0; }
  }

  get ready() { return !this.standardize || this.sigma0 != null; }

  /** Feed one observation (higher = worse). Returns { alarm, warn, stat, n }. */
  update(x) {
    if (!fin(x)) return { alarm: false, warn: false, stat: this.stat, n: this.n };
    this.total++;
    let z = x;
    if (this.standardize) {
      if (this.sigma0 == null) {
        // Welford burn-in estimate of the in-control mean / sd.
        this.bn++;
        const d = x - this.bMean;
        this.bMean += d / this.bn;
        this.bM2 += d * (x - this.bMean);
        if (this.bn >= this.burnIn) {
          const sd = Math.sqrt(this.bM2 / (this.bn - 1));
          this.mu0 = this.bMean;
          this.sigma0 = sd > 1e-9 ? sd : Math.max(1e-3, Math.abs(this.bMean) * 0.1 || 1e-3);
        }
        return { alarm: false, warn: false, stat: 0, n: this.n, burnIn: true };
      }
      z = clamp((x - this.mu0) / this.sigma0, -this.clip, this.clip);
    }
    this.n++;
    this.mean += (z - this.mean) / this.n;
    this.sum = this.alpha * this.sum + (z - this.mean - this.delta);
    if (this.sum < this.min) this.min = this.sum;
    this.stat = this.sum - this.min;
    const alarm = this.stat > this.lambda;
    const warn = !alarm && this.stat > this.warnFrac * this.lambda;
    if (alarm) { this.alarms++; const st = this.stat; this.reset(false); return { alarm: true, warn: false, stat: st, n: 0 }; }
    return { alarm: false, warn, stat: this.stat, n: this.n };
  }

  toJSON() {
    return { v: 1, delta: this.delta, lambda: this.lambda, alpha: this.alpha, burnIn: this.burnIn, warnFrac: this.warnFrac, clip: this.clip,
      standardize: this.standardize, n: this.n, mean: this.mean, sum: this.sum, min: this.min, stat: this.stat,
      bn: this.bn, bMean: this.bMean, bM2: this.bM2, mu0: this.mu0, sigma0: this.sigma0, alarms: this.alarms, total: this.total };
  }

  static fromJSON(o) {
    const ph = new PageHinkley(o && typeof o === "object" ? o : {});
    if (!o || typeof o !== "object") return ph;
    for (const k of ["n", "mean", "sum", "min", "stat", "bn", "bMean", "bM2", "alarms", "total"]) if (fin(o[k])) ph[k] = o[k];
    ph.mu0 = fin(o.mu0) ? o.mu0 : null;
    ph.sigma0 = fin(o.sigma0) && o.sigma0 > 0 ? o.sigma0 : null;
    return ph;
  }
}

class AdwinLite {
  constructor(opts = {}) {
    const o = { ...ADWIN_DEFAULTS, ...opts };
    this.delta = o.delta; this.maxWindow = Math.max(20, Math.floor(o.maxWindow));
    this.minSub = Math.max(5, Math.floor(o.minSub)); this.checkEvery = Math.max(1, Math.floor(o.checkEvery));
    this.stride = Math.max(1, Math.floor(o.stride));
    this.w = []; this.tick = 0; this.detections = 0;
  }

  get mean() { if (!this.w.length) return null; let s = 0; for (const v of this.w) s += v; return s / this.w.length; }

  /** Feed one observation (higher = worse). Returns { drift, direction, width, mean, cut? }. */
  update(x) {
    if (!fin(x)) return { drift: false, direction: 0, width: this.w.length };
    this.w.push(x);
    if (this.w.length > this.maxWindow) this.w.shift();
    if (++this.tick % this.checkEvery !== 0 || this.w.length < 2 * this.minSub) return { drift: false, direction: 0, width: this.w.length };
    const n = this.w.length;
    const pre = new Float64Array(n + 1), pre2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { pre[i + 1] = pre[i] + this.w[i]; pre2[i + 1] = pre2[i] + this.w[i] * this.w[i]; }
    const mu = pre[n] / n, v = Math.max(1e-12, pre2[n] / n - mu * mu);
    const dPrime = this.delta / Math.max(1, Math.log(n));
    const lg = Math.log(2 / dPrime);
    let best = null;
    for (let k = this.minSub; k <= n - this.minSub; k += this.stride) {
      const n0 = k, n1 = n - k;
      const m0 = pre[k] / n0, m1 = (pre[n] - pre[k]) / n1;
      const m = 1 / (1 / n0 + 1 / n1);
      const eps = Math.sqrt((2 / m) * v * lg) + (2 / (3 * m)) * lg;
      const gap = m1 - m0;
      if (Math.abs(gap) > eps && (!best || Math.abs(gap) - eps > best.excess)) best = { k, gap, eps, excess: Math.abs(gap) - eps, m0, m1 };
    }
    if (!best) return { drift: false, direction: 0, width: n };
    this.w = this.w.slice(best.k);   // drop the stale sub-window
    const direction = Math.sign(best.gap);
    if (direction > 0) this.detections++;
    return { drift: direction > 0, direction, width: this.w.length, cut: { at: best.k, before: best.m0, after: best.m1, eps: best.eps } };
  }

  reset() { this.w = []; this.tick = 0; }

  toJSON() { return { v: 1, delta: this.delta, maxWindow: this.maxWindow, minSub: this.minSub, checkEvery: this.checkEvery, stride: this.stride, w: this.w.slice(), tick: this.tick, detections: this.detections }; }

  static fromJSON(o) {
    const a = new AdwinLite(o && typeof o === "object" ? o : {});
    if (o && Array.isArray(o.w)) a.w = o.w.filter(fin).slice(-a.maxWindow);
    if (o && fin(o.tick)) a.tick = o.tick;
    if (o && fin(o.detections)) a.detections = o.detections;
    return a;
  }
}

class DriftMonitor {
  /** opts: { ph: {...PageHinkley opts}, adwin: {...} | false } */
  constructor(opts = {}) {
    this.opts = { ph: { ...PH_DEFAULTS, ...(opts.ph || {}) }, adwin: opts.adwin === false ? false : { ...ADWIN_DEFAULTS, ...(opts.adwin || {}) } };
    this.phLoss = new PageHinkley(this.opts.ph);
    this.phMiss = new PageHinkley(this.opts.ph);
    this.adwin = this.opts.adwin ? new AdwinLite(this.opts.adwin) : null;
    this.n = 0; this.sumLoss = 0; this.hits = 0;
    this.recentLoss = []; this.recentHit = [];   // last 200 for display
    this.level = "ok";
    this.lastDrift = null; this.nDrifts = 0;
  }

  /** Feed one resolved decision. Returns { drift, level, stat }. */
  update(p, y) {
    const pp = Number(p), yy = y === true ? 1 : y === false ? 0 : Number(y);
    if (!fin(pp) || (yy !== 0 && yy !== 1)) return { drift: false, level: this.level, stat: this.stat(), skipped: true };
    const loss = logLoss(pp, yy);
    const hit = (pp >= 0.5 ? 1 : 0) === yy ? 1 : 0;
    this.n++; this.sumLoss += loss; this.hits += hit;
    this.recentLoss.push(loss); this.recentHit.push(hit);
    if (this.recentLoss.length > 200) { this.recentLoss.shift(); this.recentHit.shift(); }

    const a = this.phLoss.update(loss);
    const b = this.phMiss.update(1 - hit);
    const c = this.adwin ? this.adwin.update(loss) : { drift: false };
    const triggers = [];
    if (a.alarm) triggers.push("pageHinkley:logloss");
    if (b.alarm) triggers.push("pageHinkley:miss");
    if (c.drift) triggers.push("adwin:logloss");
    const drift = triggers.length > 0;
    if (drift) {
      // A new regime: restart every detector's change statistic (keep the PH scale estimates).
      if (!a.alarm) this.phLoss.reset(false);
      if (!b.alarm) this.phMiss.reset(false);
      this.nDrifts++;
      this.lastDrift = { at: new Date().toISOString(), n: this.n, triggers, phLoss: a.stat, phMiss: b.stat, adwinCut: c.cut || null };
      this.level = "drift";
    } else {
      const r = Math.max(this.phLoss.stat / this.phLoss.lambda, this.phMiss.stat / this.phMiss.lambda);
      this.level = r > this.opts.ph.warnFrac ? "warn" : "ok";
    }
    return { drift, level: this.level, stat: this.stat(), triggers };
  }

  stat() {
    const mean = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : null);
    return {
      n: this.n,
      logloss: this.n ? this.sumLoss / this.n : null,
      hitRate: this.n ? this.hits / this.n : null,
      recent: { n: this.recentLoss.length, logloss: mean(this.recentLoss), hitRate: mean(this.recentHit) },
      phLoss: { stat: this.phLoss.stat, lambda: this.phLoss.lambda, delta: this.phLoss.delta, ready: this.phLoss.ready, alarms: this.phLoss.alarms },
      phMiss: { stat: this.phMiss.stat, lambda: this.phMiss.lambda, delta: this.phMiss.delta, ready: this.phMiss.ready, alarms: this.phMiss.alarms },
      adwin: this.adwin ? { width: this.adwin.w.length, mean: this.adwin.mean, detections: this.adwin.detections } : null,
      nDrifts: this.nDrifts, lastDrift: this.lastDrift,
    };
  }

  /** Forget everything (e.g. after a new primary model is promoted: a new loss distribution). */
  reset() {
    const keep = { nDrifts: this.nDrifts, lastDrift: this.lastDrift };
    Object.assign(this, new DriftMonitor(this.opts), keep);
  }

  toJSON() {
    return { v: 1, opts: this.opts, phLoss: this.phLoss.toJSON(), phMiss: this.phMiss.toJSON(), adwin: this.adwin ? this.adwin.toJSON() : null,
      n: this.n, sumLoss: this.sumLoss, hits: this.hits, recentLoss: this.recentLoss.slice(), recentHit: this.recentHit.slice(),
      level: this.level, lastDrift: this.lastDrift, nDrifts: this.nDrifts };
  }

  static fromJSON(o) {
    if (!o || typeof o !== "object") return new DriftMonitor();
    const m = new DriftMonitor(o.opts || {});
    if (o.phLoss) m.phLoss = PageHinkley.fromJSON(o.phLoss);
    if (o.phMiss) m.phMiss = PageHinkley.fromJSON(o.phMiss);
    if (o.adwin && m.adwin) m.adwin = AdwinLite.fromJSON(o.adwin);
    for (const k of ["n", "sumLoss", "hits", "nDrifts"]) if (fin(o[k])) m[k] = o[k];
    if (Array.isArray(o.recentLoss)) m.recentLoss = o.recentLoss.filter(fin).slice(-200);
    if (Array.isArray(o.recentHit)) m.recentHit = o.recentHit.filter(fin).slice(-200);
    m.level = ["ok", "warn", "drift"].includes(o.level) ? o.level : "ok";
    m.lastDrift = o.lastDrift || null;
    return m;
  }
}

module.exports = { PageHinkley, AdwinLite, DriftMonitor, logLoss, PH_DEFAULTS, ADWIN_DEFAULTS };
