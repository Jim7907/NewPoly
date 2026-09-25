// Relative / cross-sectional analyzer (contract v2 §3). Pure: candles in, Signal[] out (family "relative").
//
//   signals(candles, { peers, benchmark, assetClass, horizon, t, symbol, benchmarkSymbol?, etf?, cache? })
//     peers     { SYM: Candle[] } (or a Map) of the same asset class. Self and, for stocks, the index
//               benchmark are dropped from the cross-section automatically.
//     benchmark Candle[] (SPY for stocks, BTC for crypto).
//     t         optional point-in-time cutoff (ms). Default = the asset's last bar.
//     cache     optional plain object, keyed by symbol (+ bar size), that holds prepared log-price series,
//               their benchmark-grid alignment and prefix sums. Any contiguous sub-range of a cached
//               history (prefix slices or the dataset builder's sliding windows) reuses the entry. Bars are
//               assumed immutable once written; a changed last bar (live partial candle) forces a rebuild.
//
// ── Evidence base (see docs/RESEARCH.md §1.1–1.2) ─────────────────────────────────────────────────────
//  * Cross-sectional momentum, stocks: 3–12-month winners beat losers over the next 3–12 months
//    (Jegadeesh & Titman 1993, JF). Canonical formation = 12-1: the return from t−12m to t−1m, skipping
//    the most recent month because 1-month returns reverse. → rel.xs.mom_rank (stocks), rel.rs.12_1.
//    Momentum crashes in "rebound" states after bear markets with high volatility (Daniel & Moskowitz
//    2016, JFE) → momentum confidences are halved when the benchmark's trailing 12m return is < 0 and
//    its volatility is above the 70th percentile of the past year.
//  * Cross-sectional momentum, crypto: market, size and momentum factors span the crypto cross-section;
//    momentum works at 1–4-WEEK formation/holding horizons (Liu, Tsyvinski & Wu 2022, JF, "Common risk
//    factors in cryptocurrency"). It fades and reverses after about a month (Dobrynskaya 2023) and crashes
//    in large, equal-weighted portfolios (Grobys et al. 2025). → crypto rel.xs.mom_rank uses the mean of
//    the 2-, 3- and 4-week returns with no skip; crypto rs.3m/6m/12_1 get very low confidence.
//  * Short-term reversal: weekly/monthly losers outperform winners next week/month (Lehmann 1990, QJE;
//    Jegadeesh 1990, JF). It is largely compensation for liquidity provision and is larger when volatility
//    is high (Nagel 2012, RFS); it is weak in mega-caps. STOCKS ONLY. At ≤ 1 week crypto shows momentum,
//    not reversal (Liu & Tsyvinski 2021). → rel.xs.reversal_1w, with confidence scaled by the
//    benchmark's volatility percentile (Nagel). The same literature is why the stock rs.1m signal gets
//    a low weight: the 1-month window is the single-stock reversal zone that JT skip.
//  * Idiosyncratic volatility: stocks with high IVOL (residual vol vs. the market model / FF3) earn
//    abysmally low future returns; low IVOL outperforms (Ang, Hodrick, Xing & Zhang 2006, JF). The
//    effect is concentrated in the highest-IVOL names, so the score mapping is asymmetric (a high-IVOL
//    penalty up to −1, a low-IVOL reward up to +0.6). IVOL here = residual σ of daily returns vs. the benchmark
//    (CAPM residual; AHXZ report robustness to this). Evidence in crypto is thin and mixed → low weight.
//  * Contrast with time-series momentum (Moskowitz, Ooi & Pedersen 2012, JFE): TSMOM bets on an asset's
//    OWN past return sign and is already covered by tech.momentum.tsmom. Everything in this family is
//    RELATIVE (vs. the benchmark or the peer cross-section), i.e. market-neutral by construction. These
//    signals target the excess return (lab.exRet / yEx), not the absolute direction.
//  * BTC → alt lead–lag: the theory is slow information diffusion from large to small assets (Lo &
//    MacKinlay 1990; Hou 2007, RFS: big firms lead small firms within an industry). The crypto evidence is
//    MIXED. Some hourly studies find BTC leading, but others find bidirectional or insignificant lead–lag at
//    daily frequency (e.g. Sifat, Mohamad & Mohamed Shariff 2019, RIBAF), and a single market factor
//    explains most co-movement contemporaneously (Liu, Tsyvinski & Wu 2022). → rel.btc_lead has a low
//    prior, especially for swing/position, and its confidence halves once the alt has already made the move.
//
// ── Horizon mapping ────────────────────────────────────────────────────────────────────────────────
//  swing / position: daily lookbacks in bars. Stocks count trading days (21 = 1m, 252 = 12m). Crypto
//  trades 7 days a week, so it counts calendar days (30 = 1m, 365 = 12m). intraday (15m bars): every
//  daily lookback is rescaled in bars by the horizon ratio 8/5 (cfg.HORIZONS: intraday looks 8 bars
//  ahead, swing 5), so the lookback/horizon ratio is preserved: "12-1" = 403-34 bars, "1w" = 8 bars.
//
// ── Point-in-time alignment ────────────────────────────────────────────────────────────────────────
//  Series are joined by TIMESTAMP, never by array index. Each peer's log price is carried forward onto
//  the benchmark's timeline (the "grid"), so every return is measured between the same two instants.
//  Only bars with key ≤ key(asset's last bar ≤ t) are ever read. key(t) = t for intraday bars. For daily
//  bars, key(t) = the UTC calendar date, because providers stamp the same session at 00:00 UTC (Nasdaq,
//  Coinbase) or at the 13:30 UTC open (Yahoo), and both bars close at the same instant. A peer whose last
//  usable bar is older than a staleness tolerance is dropped from the cross-section.

const FAMILY = "relative";
const DAY = 86400000;
const VERSION = 1;
const BENCH = { stock: "SPY", crypto: "BTC" };
// Broad index ETFs. For stocks they stay in the return cross-sections, but they are excluded from the IVOL
// cross-section: a diversified basket has ~zero idiosyncratic vol by construction, and AHXZ is a
// single-stock anomaly.
const INDEX_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "VOO", "IVV", "VTI", "RSP", "MDY", "IJH", "IJR", "VTV", "VUG"]);
const SIGNAL_IDS = ["rel.rs.1m", "rel.rs.3m", "rel.rs.6m", "rel.rs.12_1", "rel.xs.mom_rank", "rel.xs.reversal_1w",
  "rel.xs.ivol_rank", "rel.beta", "rel.btc_lead"];

// Lookbacks in bars of the base (daily) timeframe. mom = [[formation, skip], ...] (the stat is the mean
// log return across the listed windows); momAlt = fallback formation when history is short.
const DAILY_LB = {
  stock: { w1: 5, m1: 21, m3: 63, m6: 126, m12: 252, skip: 21, mom: [[252, 21]], momAlt: [[126, 21]],
    beta: 252, ivol: 63, corrS: 63, volWin: 20, lead: 2, stab: 5 },
  crypto: { w1: 7, m1: 30, m3: 91, m6: 182, m12: 365, skip: 30, mom: [[14, 0], [21, 0], [28, 0]], momAlt: null,
    beta: 180, ivol: 60, corrS: 60, volWin: 20, lead: 2, stab: 5 },
};
const INTRADAY_SCALE = 8 / 5;

// Evidence priors: the most confidence each signal can reach per asset class, before the data-quality
// factors (peer count, history, rank stability, strength) are applied.
const PRIOR = {
  "rel.rs.1m": { stock: 0.15, crypto: 0.45 },   // stocks: reversal zone (Jegadeesh 1990); crypto: LTW 1–4w
  "rel.rs.3m": { stock: 0.30, crypto: 0.20 },
  "rel.rs.6m": { stock: 0.40, crypto: 0.12 },
  "rel.rs.12_1": { stock: 0.50, crypto: 0.10 }, // crypto: > 1m returns fade/reverse (Dobrynskaya 2023)
  "rel.xs.mom_rank": { stock: 0.55, crypto: 0.55 },
  "rel.xs.reversal_1w": { stock: 0.35, crypto: 0 },
  "rel.xs.ivol_rank": { stock: 0.40, crypto: 0.15 },
  "rel.btc_lead": { stock: 0, crypto: 0.30 },
  "rel.beta": { stock: 0.30, crypto: 0.30 },
};
// Horizon fit: 3–12-month effects are position-horizon effects; weekly effects are swing effects;
// lead–lag lives at intraday frequency.
const HMULT = {
  long: { intraday: 0.5, swing: 0.8, position: 1.0 },
  short: { intraday: 0.8, swing: 1.0, position: 0.7 },
  lead: { intraday: 1.0, swing: 0.4, position: 0.25 },
  flat: { intraday: 1.0, swing: 1.0, position: 1.0 },
};
const PROFILE = {
  "rel.rs.1m": "short", "rel.rs.3m": "long", "rel.rs.6m": "long", "rel.rs.12_1": "long",
  "rel.xs.reversal_1w": "short", "rel.xs.ivol_rank": "long", "rel.btc_lead": "lead", "rel.beta": "flat",
};
const MIN_PEERS = 2;          // fewer → no cross-sectional signal at all
const GOOD_PEERS = 8;         // ≥ 8 peers → full peer factor

// ───────────────────────────── small utils ─────────────────────────────
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sat = (v) => clamp(v, 0, 1);
const r4 = (v) => { if (!isNum(v)) return null; const r = Math.round(v * 10000) / 10000; return r === 0 ? 0 : r; };
const sPct = (lr, d = 1) => { const v = Math.exp(lr) - 1; return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`; };
const ord = (n) => { const k = Math.round(n), t = k % 100; return `${k}${t >= 11 && t <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] || "th"}`; };
const norm = (s) => (s == null ? "" : String(s).trim().toUpperCase().replace(/^(STOCK|CRYPTO):/, ""));

function upperBound(a, x, n = a.length) { // first i in [0,n) with a[i] > x
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}
function lowerBound(a, x, n = a.length) { // first i in [0,n) with a[i] >= x
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
const validCandle = (k) => k && isNum(k.t) && isNum(k.c) && k.c > 0;
function headOf(c) { for (let i = 0; i < c.length; i++) if (validCandle(c[i])) return c[i]; return null; }
function tailOf(c) { for (let i = c.length - 1; i >= 0; i--) if (validCandle(c[i])) return c[i]; return null; }

// Median bar spacing (ms) over the last ≤ 60 bars — robust to weekend and overnight gaps.
function spacingOf(candles) {
  const d = [];
  let prev = null;
  for (let i = Math.max(0, candles.length - 61); i < candles.length; i++) {
    const k = candles[i];
    if (!validCandle(k)) continue;
    if (prev != null && k.t > prev) d.push(k.t - prev);
    prev = k.t;
  }
  if (!d.length) return DAY;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}
const isDailySpacing = (ms) => ms >= 20 * 3600e3;
const dayKey = (t) => Math.floor(t / DAY) * DAY;

function resolveClass(ac, symbol, candles) {
  if (ac === "crypto" || ac === "stock") return ac;
  if (/^CRYPTO:/i.test(String(symbol || ""))) return "crypto";
  let wk = 0;
  for (let i = Math.max(0, candles.length - 30); i < candles.length; i++) {
    const k = candles[i];
    if (validCandle(k)) { const d = new Date(k.t).getUTCDay(); if (d === 0 || d === 6) wk++; }
  }
  return wk >= 2 ? "crypto" : "stock";
}

function lookbacks(cls, horizon) {
  const b = DAILY_LB[cls];
  if (horizon !== "intraday") return b;
  const s = (x) => Math.max(1, Math.round(x * INTRADAY_SCALE));
  const sc = (specs) => specs && specs.map(([L, S]) => [s(L), S ? s(S) : 0]);
  return { w1: s(b.w1), m1: s(b.m1), m3: s(b.m3), m6: s(b.m6), m12: s(b.m12), skip: s(b.skip), mom: sc(b.mom),
    momAlt: sc(b.momAlt), beta: s(b.beta), ivol: s(b.ivol), corrS: s(b.corrS), volWin: s(b.volWin), lead: 4, stab: 4 };
}

// ───────────────────────────── prepared series + cache ─────────────────────────────
let SEQ = 0;

// Candle[] → sorted, de-duplicated log-price series keyed for alignment.
function buildSeries(candles, daily) {
  const n0 = candles.length;
  let t = new Float64Array(n0), c = new Float64Array(n0);
  let n = 0, sorted = true;
  for (let i = 0; i < n0; i++) {
    const k = candles[i];
    if (!validCandle(k)) continue;
    if (n && k.t <= t[n - 1]) sorted = false;
    t[n] = k.t; c[n] = k.c; n++;
  }
  if (!sorted) {                                    // contract says ascending — be defensive anyway
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b] || a - b);
    const t2 = new Float64Array(n), c2 = new Float64Array(n);
    let m = 0;
    for (const i of idx) { if (m && t2[m - 1] === t[i]) m--; t2[m] = t[i]; c2[m] = c[i]; m++; }
    t = t2; c = c2; n = m;
  }
  const keys = new Float64Array(n), tt = new Float64Array(n), cc = new Float64Array(n), lc = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const key = daily ? dayKey(t[i]) : t[i];
    if (m && key === keys[m - 1]) m--;              // same session bucket → the later bar wins
    keys[m] = key; tt[m] = t[i]; cc[m] = c[i]; lc[m] = Math.log(c[i]); m++;
  }
  return { id: ++SEQ, v: VERSION, daily, n: m, keys: keys.subarray(0, m), t: tt.subarray(0, m), c: cc.subarray(0, m),
    lc: lc.subarray(0, m), al: new Map(), gr: null, ref: null, rawLen: 0, tailT: NaN, tailC: NaN };
}

const cacheGet = (cache, k) => (!cache || !k ? null : cache instanceof Map ? cache.get(k) : cache[k]);
const cacheSet = (cache, k, v) => { if (!cache || !k) return; if (cache instanceof Map) cache.set(k, v); else cache[k] = v; };

// → { s: series, start, limit } — a view [start, limit) of a (possibly cached) series equal to what a
// fresh build of `candles` would contain.
function getView(cache, key, candles, daily) {
  const tail = tailOf(candles);
  if (!tail) return null;
  const e = cacheGet(cache, key);
  if (e && e.v === VERSION && e.daily === daily && e.n) {
    if (e.ref === candles && e.rawLen === candles.length && e.tailT === tail.t && e.tailC === tail.c) return { s: e, start: 0, limit: e.n };
    const head = headOf(candles);
    const j = upperBound(e.t, tail.t, e.n) - 1;
    const i0 = lowerBound(e.t, head.t, e.n);
    if (j >= 0 && i0 < e.n && e.t[j] === tail.t && e.c[j] === tail.c && e.t[i0] === head.t && e.c[i0] === head.c &&
        j - i0 + 1 === candles.length) return { s: e, start: i0, limit: j + 1 };
  }
  const s = buildSeries(candles, daily);
  if (!s.n) return null;
  s.ref = candles; s.rawLen = candles.length; s.tailT = tail.t; s.tailC = tail.c;
  cacheSet(cache, key, s);
  return { s, start: 0, limit: s.n };
}

// Grid (benchmark) returns and their prefix sums, computed once per grid series.
function gridPrefix(G) {
  if (G.gr) return G.gr;
  const n = G.n, B1 = new Float64Array(n), B2 = new Float64Array(n), b = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    const r = G.lc[k] - G.lc[k - 1];
    b[k] = r; B1[k] = B1[k - 1] + r; B2[k] = B2[k - 1] + r * r;
  }
  G.gr = { b, B1, B2 };
  return G.gr;
}

// Carry-forward alignment of series S onto grid G, with prefix sums of returns, squared returns and
// return × grid-return. src[k] = index of the S bar used at grid point k (−1 before S starts).
function alignTo(S, G) {
  const hit = S.al.get(G.id);
  if (hit) return hit;
  const n = G.n, gk = G.keys, { b } = gridPrefix(G);
  const lc = new Float64Array(n), src = new Int32Array(n), P1 = new Float64Array(n), P2 = new Float64Array(n), PB = new Float64Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    while (j < S.n && S.keys[j] <= gk[k]) j++;
    src[k] = j - 1;
    lc[k] = j ? S.lc[j - 1] : NaN;
    const r = k && src[k - 1] >= 0 ? lc[k] - lc[k - 1] : 0;
    P1[k] = (k ? P1[k - 1] : 0) + r;
    P2[k] = (k ? P2[k - 1] : 0) + r * r;
    PB[k] = (k ? PB[k - 1] : 0) + r * b[k];
  }
  const out = { lc, src, P1, P2, PB };
  if (S.al.size >= 4) S.al.delete(S.al.keys().next().value);
  S.al.set(G.id, out);
  return out;
}

// Point-in-time handle of a series on the grid: valid grid indices are [first, cap].
function onGrid(view, G, gStart, gK) {
  const A = alignTo(view.s, G);
  const { src } = A;
  if (gK < gStart || src[gK] < view.start) return null;
  let first = lowerBound(src, view.start, gK + 1);   // src is non-decreasing
  first = Math.max(first, gStart);
  let cap = gK;
  if (src[gK] >= view.limit) {                         // last k ≤ gK whose bar lies inside the view
    const k = upperBound(src, view.limit - 1, gK + 1) - 1;
    cap = k;
  }
  if (cap < first) return null;
  return { A, first, cap, s: view.s };
}

const lcAt = (X, k) => (k < X.first ? NaN : X.A.lc[Math.min(k, X.cap)]);
function retBetween(X, s, e) {
  if (s < X.first || e < s) return null;
  const v = lcAt(X, e) - lcAt(X, s);
  return isNum(v) ? v : null;
}

// Market-model regression of X's grid returns on the grid (benchmark) returns over (k0, k1].
function winStats(X, gp, k0, k1) {
  k1 = Math.min(k1, X.cap);
  k0 = Math.max(k0, X.first);
  const n = k1 - k0;
  if (n < 3) return null;
  const { P1, P2, PB } = X.A;
  const sr = P1[k1] - P1[k0], srr = P2[k1] - P2[k0], srb = PB[k1] - PB[k0];
  const sb = gp.B1[k1] - gp.B1[k0], sbb = gp.B2[k1] - gp.B2[k0];
  return regress(n, sr, srr, sb, sbb, srb);
}

function regress(n, sr, srr, sb, sbb, srb) {
  const Sxx = Math.max(0, sbb - (sb * sb) / n), Syy = Math.max(0, srr - (sr * sr) / n), Sxy = srb - (sr * sb) / n;
  const varA = Syy / (n - 1), varB = Sxx / (n - 1), cov = Sxy / (n - 1);
  const beta = Sxx > 1e-18 ? Sxy / Sxx : null;
  const sse = beta != null ? Math.max(0, Syy - beta * Sxy) : Syy;
  const corr = Sxx > 1e-18 && Syy > 1e-18 ? clamp(Sxy / Math.sqrt(Sxx * Syy), -1, 1) : 0;
  return {
    n, beta, alpha: beta != null ? (sr - beta * sb) / n : null, corr, r2: corr * corr,
    volA: Math.sqrt(varA), volB: Math.sqrt(varB), idio: Math.sqrt(sse / Math.max(1, n - 2)),
    te: Math.sqrt(Math.max(0, varA + varB - 2 * cov)),
  };
}

// ───────────────────────────── exported pure helpers ─────────────────────────────

/**
 * alignByTime(candles, times, { daily }) -> (number|null)[]
 * As-of join: for each time in `times` (ms numbers or candles), the close of the last candle whose key is
 * ≤ that time's key; null before the first candle. Daily bars are matched by UTC date (see header).
 * `daily` defaults to the candles' own median spacing ≥ 20h.
 */
function alignByTime(candles, times, opts = {}) {
  if (!Array.isArray(candles) || !Array.isArray(times)) return [];
  const daily = opts.daily != null ? !!opts.daily : isDailySpacing(spacingOf(candles));
  const S = buildSeries(candles, daily);
  return times.map((x) => {
    const T = x && typeof x === "object" ? x.t : x;
    if (!isNum(T) || !S.n) return null;
    const j = upperBound(S.keys, daily ? dayKey(T) : T, S.n);
    return j ? S.c[j - 1] : null;
  });
}

/**
 * beta(ra, rb) -> { beta, alpha, corr, r2, n, idioVol, te } | null
 * OLS market model ra = α + β·rb + ε over paired finite returns (per-bar). idioVol = σ(ε) with n−2 dof.
 */
function beta(ra, rb) {
  if (!Array.isArray(ra) || !Array.isArray(rb)) return null;
  let n = 0, sr = 0, srr = 0, sb = 0, sbb = 0, srb = 0;
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const a = ra[i], b = rb[i];
    if (!isNum(a) || !isNum(b)) continue;
    n++; sr += a; srr += a * a; sb += b; sbb += b * b; srb += a * b;
  }
  if (n < 3) return null;
  const st = regress(n, sr, srr, sb, sbb, srb);
  if (st.beta == null) return null;
  return { beta: st.beta, alpha: st.alpha, corr: st.corr, r2: st.r2, n, idioVol: st.idio, te: st.te };
}

/** idioVol(ra, rb) -> per-bar σ of market-model residuals (Ang et al. 2006 style, CAPM residual) | null */
function idioVol(ra, rb) {
  const b = beta(ra, rb);
  return b ? b.idioVol : null;
}

/**
 * relStrength(assetPx, benchPx, L, skip = 0) -> { exRet, assetRet, benchRet, bars } | null
 * Log relative strength on two time-ALIGNED price arrays (e.g. alignByTime output). The window runs from
 * L bars before the last point to `skip` bars before it (12-1 = L 252, skip 21 on daily stock bars).
 */
function relStrength(assetPx, benchPx, L, skip = 0) {
  if (!Array.isArray(assetPx) || !Array.isArray(benchPx) || assetPx.length !== benchPx.length) return null;
  const N = assetPx.length, e = N - 1 - (skip | 0), s = N - 1 - (L | 0);
  if (!(L > skip) || s < 0 || e < 0) return null;
  const a0 = assetPx[s], a1 = assetPx[e], b0 = benchPx[s], b1 = benchPx[e];
  if (![a0, a1, b0, b1].every((v) => isNum(v) && v > 0)) return null;
  const assetRet = Math.log(a1 / a0), benchRet = Math.log(b1 / b0);
  return { exRet: assetRet - benchRet, assetRet, benchRet, bars: e - s };
}

/**
 * xsRank(value, peerValues, { higherIsBetter = true, soft = true }) -> { rank, n, pct, score } | null
 * rank: 1 = best of n (= peers + self). pct: a SOFT, Laplace-shrunk percentile
 *   pct = (Σ_j σ((x − x_j)/h) + 1) / (nPeers + 2),  h = 0.25 · 1.4826 · MAD(cross-section),
 * so it is continuous in x (smooth score) and shrinks toward 0.5 when there are few peers
 * (2 peers, top: 0.75; 40 peers, top: ≈0.98). score = 2·(pct − 0.5) ∈ (−1, 1).
 */
function xsRank(value, peerValues, opts = {}) {
  if (!isNum(value) || !Array.isArray(peerValues)) return null;
  const sg = opts.higherIsBetter === false ? -1 : 1;
  const x = sg * value;
  const ys = [];
  for (const v of peerValues) if (isNum(v)) ys.push(sg * v);
  const n = ys.length;
  if (!n) return { rank: 1, n: 1, pct: 0.5, score: 0 };
  let h = 0;
  if (opts.soft !== false) {
    const all = ys.concat([x]).sort((a, b) => a - b);
    const med = median(all);
    let scale = 1.4826 * median(all.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
    if (!(scale > 0)) {
      const m = all.reduce((a, b) => a + b, 0) / all.length;
      scale = Math.sqrt(all.reduce((a, b) => a + (b - m) ** 2, 0) / all.length);
    }
    h = scale > 0 ? 0.25 * scale : 0;
  }
  let sum = 0, above = 0;
  for (const y of ys) {
    const d = x - y;
    if (y > x) above++;
    sum += h > 0 ? 1 / (1 + Math.exp(-d / h)) : d > 0 ? 1 : d < 0 ? 0 : 0.5;
  }
  const pct = (sum + 1) / (n + 2);
  return { rank: 1 + above, n: n + 1, pct, score: 2 * pct - 1 };
}
function median(sorted) {
  const m = sorted.length;
  if (!m) return 0;
  return m % 2 ? sorted[m >> 1] : 0.5 * (sorted[m / 2 - 1] + sorted[m / 2]);
}

// ───────────────────────────── signal plumbing ─────────────────────────────
function mk(id, score, confidence, horizon, value, reason) {
  const v = {};
  for (const k of Object.keys(value || {})) {
    const x = value[k];
    v[k] = typeof x === "number" ? r4(x) : x;
  }
  return { id, family: FAMILY, score: r4(isNum(score) ? clamp(score, -1, 1) : 0), confidence: r4(isNum(confidence) ? clamp(confidence, 0, 1) : 0), horizon, value: v, reason };
}
const peerFactor = (n) => sat((n - 1) / (GOOD_PEERS - 1));
const hmult = (id, cls, horizon) => {
  const p = id === "rel.xs.mom_rank" ? (cls === "crypto" ? "short" : "long") : PROFILE[id] || "flat";
  return (HMULT[p] || HMULT.flat)[horizon] ?? HMULT[p].swing;
};
const stabWord = (s) => (s >= 0.8 ? "stable" : s >= 0.5 ? "fairly stable" : "unstable");
const classWord = (cls) => (cls === "crypto" ? "crypto" : "stocks");

// Cross-sectional block: rank of stat(asset) among stat(peers) now, plus rank stability over the last m bars.
function xsBlock(stat, A, peers, gK, m, rankOpts) {
  const x0 = stat(A, gK);
  if (!isNum(x0)) return null;
  const used = [], vals = [];
  for (const p of peers) { const v = stat(p.X, gK); if (isNum(v)) { used.push(p); vals.push(v); } }
  if (vals.length < MIN_PEERS) return null;
  const r = xsRank(x0, vals, rankOpts);
  let dev = 0, cnt = 0;
  for (let j = 1; j <= m; j++) {
    const xj = stat(A, gK - j);
    if (!isNum(xj)) continue;
    const vj = [];
    for (const p of used) { const v = stat(p.X, gK - j); if (isNum(v)) vj.push(v); }
    if (vj.length < MIN_PEERS) continue;
    dev += Math.abs(xsRank(xj, vj, rankOpts).pct - r.pct);
    cnt++;
  }
  return { x0, r, nPeers: vals.length, stability: cnt ? sat(1 - (2 * dev) / cnt) : 0.5, nStab: cnt };
}

function rankConf(prior, hm, nPeers, fHist, stability, score) {
  return prior * hm * (0.2 + 0.8 * peerFactor(nPeers)) * (0.4 + 0.6 * sat(fHist)) * (0.5 + 0.5 * stability) * (0.75 + 0.25 * Math.abs(score));
}

// ───────────────────────────── main ─────────────────────────────
/**
 * signals(candles, { peers, benchmark, assetClass, horizon, t, symbol, benchmarkSymbol, etf, cache }) -> Signal[]
 * Emits rel.rs.{1m,3m,6m,12_1}, rel.xs.{mom_rank,reversal_1w (stocks),ivol_rank}, rel.beta and rel.btc_lead
 * (crypto alts). The benchmark itself gets only a neutral rel.beta. If there are neither usable peers nor a
 * benchmark, the result is []. Scores ∈ [−1, 1]; never NaN.
 */
function signals(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 2 || !opts || typeof opts !== "object") return [];
  const horizon = typeof opts.horizon === "string" && opts.horizon ? opts.horizon : "swing";
  const hz = HMULT.long[horizon] != null ? horizon : "swing";
  const cache = opts.cache && typeof opts.cache === "object" ? opts.cache : null;
  const sym = norm(opts.symbol);
  const cls = resolveClass(opts.assetClass, opts.symbol, candles);
  const benchSym = norm(opts.benchmarkSymbol) || BENCH[cls];
  const spacing = spacingOf(candles);
  const daily = isDailySpacing(spacing);
  const tfTag = daily ? "1d" : `${Math.round(spacing / 60000)}m`;
  const ck = (s) => `${cls}:${s}:${tfTag}`;
  const tCut = isNum(opts.t) ? (opts.t < 1e11 ? opts.t * 1000 : opts.t) : Infinity;

  // ---- asset view, truncated at t ----
  const aView = getView(cache, ck(sym || "__asset__"), candles, daily);
  if (!aView) return [];
  aView.limit = Math.min(aView.limit, upperBound(aView.s.t, tCut, aView.limit));
  if (aView.limit - aView.start < 2) return [];
  const aS = aView.s;
  const asOfKey = aS.keys[aView.limit - 1];
  const staleTol = daily ? (cls === "crypto" ? 3 : 6) * DAY : cls === "crypto" ? Math.max(6 * spacing, 2 * 3600e3) : 4 * DAY;

  const benchIn = Array.isArray(opts.benchmark) && opts.benchmark.length >= 2 ? opts.benchmark : null;
  const peerEntries = opts.peers instanceof Map ? [...opts.peers.entries()] : opts.peers && typeof opts.peers === "object" ? Object.entries(opts.peers) : [];

  // ---- benchmark special case: SPY / BTC themselves → neutral beta context only ----
  const isBench = (sym && sym === benchSym) || (benchIn && benchIn === candles) || (!sym && benchIn && sameTail(candles, benchIn));
  if (isBench) {
    const nPeers = peerEntries.filter(([k, v]) => Array.isArray(v) && v !== candles && norm(k) !== benchSym).length;
    return [mk("rel.beta", 0, 0, horizon, { beta: 1, corr: 1, rank: null, nPeers, isBenchmark: true },
      `${sym || benchSym} is the ${cls} benchmark — relative signals are measured against it (beta ≡ 1); neutral context only`)];
  }

  // ---- grid: the benchmark's timeline (or the asset's own when there is no usable benchmark) ----
  let G = null, gStart = 0, gK = -1, hasBench = false;
  if (benchIn) {
    const bv = getView(cache, ck(benchSym), benchIn, daily);
    if (bv) {
      const lim = Math.min(bv.limit, upperBound(bv.s.keys, asOfKey, bv.limit));
      if (lim - bv.start >= 2 && asOfKey - bv.s.keys[lim - 1] <= staleTol) {
        G = bv.s; gStart = bv.start; gK = lim - 1; hasBench = true;
      }
    }
  }
  if (!hasBench) { G = aS; gStart = aView.start; gK = aView.limit - 1; }
  const gp = gridPrefix(G);
  const A = onGrid(aView, G, gStart, gK);
  if (!A) return [];

  // ---- peers (same class), point-in-time and staleness-filtered ----
  const peers = [];
  const seen = new Set();
  for (const [k, arr] of peerEntries) {
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const ps = norm(k);
    if (arr === candles || (sym && ps === sym) || seen.has(ps)) continue;
    if (cls === "stock" && (ps === benchSym || arr === benchIn)) continue;   // the market is not a cross-section member
    seen.add(ps);
    const v = getView(cache, ck(ps), arr, daily);
    if (!v) continue;
    v.limit = Math.min(v.limit, upperBound(v.s.keys, asOfKey, v.limit));
    if (v.limit - v.start < 2) continue;
    const X = onGrid(v, G, gStart, gK);
    if (!X || asOfKey - v.s.keys[X.A.src[X.cap]] > staleTol) continue;
    peers.push({ sym: ps, X, etf: INDEX_ETFS.has(ps) });
  }
  if (!hasBench && peers.length < MIN_PEERS) return [];

  const lb = lookbacks(cls, hz);
  const m = lb.stab;
  const histBars = gK - A.first;               // asset returns available on the grid
  if (histBars < 20) return [];
  const ppy = daily ? (cls === "crypto" ? 365 : 252) : cls === "crypto" ? (365 * DAY) / spacing : (252 * 6.5 * 3600e3) / spacing;
  const name = sym || "asset";
  const out = [];
  const nearWin = (L) => (daily ? null : `${L}-bar`);

  // ---- benchmark context: beta, correlation regime, crash state, vol percentile ----
  let bst = null, betaV = null, crash = false, volPct = 0.5, benchRet12 = null;
  if (hasBench) {
    bst = winStats(A, gp, gK - lb.beta, gK);
    if (bst && bst.n >= 20 && bst.beta != null) betaV = bst.beta;
    const Lc = Math.min(lb.m12, gK - gStart);
    if (Lc >= lb.m3) benchRet12 = G.lc[gK] - G.lc[gK - Lc];
    const vw = lb.volWin;
    const rv = (k) => { const n = vw; const s1 = gp.B1[k] - gp.B1[k - n], s2 = gp.B2[k] - gp.B2[k - n]; return Math.max(0, s2 - (s1 * s1) / n) / (n - 1); };
    const P = Math.min(lb.m12, gK - gStart - vw);
    if (P >= 20) {
      const now = rv(gK);
      let below = 0;
      for (let k = gK - P; k < gK; k++) if (rv(k) < now) below++;
      volPct = below / P;
    }
    crash = isNum(benchRet12) && benchRet12 < 0 && volPct > 0.7;   // Daniel & Moskowitz (2016) rebound-risk state
  }
  const crashF = crash ? 0.5 : 1;
  const crashNote = crash ? `; momentum-crash guard on (${benchSym} 12m ${sPct(benchRet12, 0)}, vol ${ord(volPct * 100)} pct)` : "";

  // ---- rel.rs.* : relative strength vs the benchmark ----
  if (hasBench) {
    const te = bst && bst.n >= 20 ? bst.te : null;
    const specs = [
      ["rel.rs.1m", lb.m1, 0, "1-month"], ["rel.rs.3m", lb.m3, 0, "3-month"],
      ["rel.rs.6m", lb.m6, 0, "6-month"], ["rel.rs.12_1", lb.m12, lb.skip, "12-1 month"],
    ];
    for (const [id, L, S, label] of specs) {
      if (!isNum(te) || te <= 0) break;
      let Le = L;
      if (histBars < L) { if (histBars >= 0.6 * L && histBars - S >= 10) Le = histBars; else continue; }
      const s = gK - Le, e = gK - S;
      const ra = retBetween(A, s, e);
      const rb = G.lc[e] - G.lc[s];
      if (!isNum(ra) || !isNum(rb)) continue;
      const ex = ra - rb;
      const z = ex / (te * Math.sqrt(e - s));
      const score = Math.tanh(z / 1.5);
      const vals = [];
      for (const p of peers) { const v = retBetween(p.X, s, e); if (isNum(v)) vals.push(v); }
      const rk = vals.length >= MIN_PEERS ? xsRank(ra, vals) : null;
      const fHist = (Le / L) * sat(bst.n / 60);
      const momLike = id !== "rel.rs.1m";
      const conf = PRIOR[id][cls] * hmult(id, cls, hz) * (0.4 + 0.6 * sat(fHist)) * (0.55 + 0.45 * sat(Math.abs(z) / 2)) * (momLike ? crashF : 1);
      const lbl = nearWin(Le) ? (S ? `${Le}-${S} bar` : `${Le}-bar`) : Le < L ? `${Le}-bar${S ? ` (skip ${S})` : ""} (short history)` : label;
      let caveat = "";
      if (cls === "stock" && id === "rel.rs.1m") caveat = " — single-stock 1-month moves partly reverse (Jegadeesh 1990), low weight";
      if (cls === "crypto" && id !== "rel.rs.1m") caveat = " — beyond ~1 month crypto momentum fades/reverses (Dobrynskaya 2023), low weight";
      out.push(mk(id, score, conf, horizon,
        { exRet: Math.exp(ex) - 1, assetRet: Math.exp(ra) - 1, benchRet: Math.exp(rb) - 1, z, bars: e - s, skip: S,
          rank: rk ? rk.rank : null, nPeers: rk ? rk.n - 1 : vals.length, pct: rk ? rk.pct : null, beta: betaV },
        `${lbl} return vs ${benchSym} ${sPct(ex)} (${name} ${sPct(ra)}, ${benchSym} ${sPct(rb)}; ${z >= 0 ? "+" : ""}${z.toFixed(1)}σ of tracking error)` +
        `${rk ? `, ranks ${rk.rank}/${rk.n} among ${classWord(cls)}` : ""}${caveat}${momLike ? crashNote : ""}`));
    }
  }

  // ---- rel.xs.mom_rank : cross-sectional momentum (JT 1993 12-1 for stocks; LTW 2022 2–4w for crypto) ----
  {
    let specs = lb.mom, fb = false;
    const need = Math.max(...specs.map(([L]) => L));
    if (histBars < need && lb.momAlt && histBars >= Math.max(...lb.momAlt.map(([L]) => L))) { specs = lb.momAlt; fb = true; }
    const needS = Math.max(...specs.map(([L]) => L));
    const stat = (X, k) => {
      let s = 0;
      for (const [L, S] of specs) { const v = retBetween(X, k - L, k - S); if (!isNum(v)) return null; s += v; }
      return s / specs.length;
    };
    const blk = xsBlock(stat, A, peers, gK, m);
    if (blk) {
      const { x0, r, nPeers, stability } = blk;
      const fHist = sat(histBars / (need + m)) * (fb ? 0.7 : 1);
      const conf = rankConf(PRIOR["rel.xs.mom_rank"][cls], hmult("rel.xs.mom_rank", cls, hz), nPeers, fHist, stability, r.score) * crashF;
      const form = cls === "crypto"
        ? (daily ? "2–4 week momentum (mean of 14/21/28d)" : `${specs.map(([L]) => L).join("/")}-bar momentum (mean)`)
        : daily ? (fb ? "6-1 month momentum (short history)" : "12-1 month momentum") : `${specs[0][0]}-${specs[0][1]} bar momentum`;
      out.push(mk("rel.xs.mom_rank", r.score, conf, horizon,
        { ret: Math.exp(x0) - 1, rank: r.rank, nPeers, pct: r.pct, formation: needS, skip: specs[0][1], stability, beta: betaV, crashGuard: crash },
        `${form} ${sPct(x0)} ranks ${r.rank}/${r.n} (${ord(r.pct * 100)} pct) among ${classWord(cls)}; rank ${stabWord(stability)} over last ${m} bars` +
        `${nPeers < 4 ? ` — only ${nPeers} peers, weak` : ""}${crashNote}`));
    }
  }

  // ---- rel.xs.reversal_1w : short-term reversal, stocks only (Lehmann 1990; Jegadeesh 1990; Nagel 2012) ----
  if (cls === "stock") {
    const w = lb.w1;
    const stat = (X, k) => retBetween(X, k - w, k);
    const blk = xsBlock(stat, A, peers, gK, m);
    if (blk) {
      const { x0, r, nPeers, stability } = blk;
      const score = -r.score;                                   // losers rebound
      const nagel = hasBench ? 0.75 + 0.5 * volPct : 1;          // reversal pays more when vol is high
      const conf = rankConf(PRIOR["rel.xs.reversal_1w"].stock, hmult("rel.xs.reversal_1w", cls, hz), nPeers, sat(histBars / (w + m + 5)), stability, score) * nagel;
      const tilt = score > 0.1 ? "short-term loser, rebound tilt (bullish)" : score < -0.1 ? "short-term winner, give-back tilt (bearish)" : "mid-pack, no reversal edge";
      out.push(mk("rel.xs.reversal_1w", score, conf, horizon,
        { ret: Math.exp(x0) - 1, rank: r.rank, nPeers, pct: r.pct, bars: w, stability, volPct: hasBench ? volPct : null, beta: betaV },
        `${daily ? "1-week" : `${w}-bar`} return ${sPct(x0)} ranks ${r.rank}/${r.n} (${ord(r.pct * 100)} pct) among stocks — ${tilt} (Lehmann/Jegadeesh 1990)` +
        `${hasBench ? `; ${benchSym} vol at ${ord(volPct * 100)} pct` : ""}`));
    }
  }

  // ---- rel.xs.ivol_rank : idiosyncratic volatility (Ang, Hodrick, Xing & Zhang 2006) ----
  if (hasBench) {
    const W = lb.ivol;
    const stat = (X, k) => { const st = winStats(X, gp, k - W, k); return st && st.n >= 0.6 * W && st.beta != null ? st.idio : null; };
    const pool = cls === "stock" ? peers.filter((p) => !p.etf) : peers;
    const blk = xsBlock(stat, A, pool, gK, m);
    if (blk) {
      const { x0, r, nPeers, stability } = blk;
      const u = r.score;                                          // +1 = highest IVOL in the cross-section
      const score = -(0.8 * u + 0.2 * u * u);                     // high-IVOL penalty −1 … low-IVOL reward +0.6
      const etf = opts.etf === true || (opts.etf == null && INDEX_ETFS.has(sym));
      const conf = rankConf(PRIOR["rel.xs.ivol_rank"][cls], hmult("rel.xs.ivol_rank", cls, hz), nPeers, sat(histBars / (W + m)), stability, score) * (etf ? 0.3 : 1);
      const ann = x0 * Math.sqrt(ppy);
      const tilt = score < -0.1 ? "high-IVOL names tend to lag (bearish tilt)" : score > 0.1 ? "low-IVOL anomaly (mild bullish tilt)" : "mid-pack";
      out.push(mk("rel.xs.ivol_rank", score, conf, horizon,
        { ivolAnn: ann, rank: r.rank, nPeers, pct: r.pct, bars: W, stability, beta: betaV, etf },
        `Idiosyncratic vol ${(ann * 100).toFixed(0)}% ann. (residual vs ${benchSym}, ${W} bars) is #${r.rank} highest of ${r.n} ${classWord(cls)} (${ord(r.pct * 100)} pct) — ${tilt}` +
        `${etf ? "; ETF: anomaly is single-stock, down-weighted" : ""}`));
    }
  }

  // ---- rel.beta : beta + correlation regime to the benchmark (context only, score 0) ----
  if (hasBench && bst && bst.n >= 20 && bst.beta != null) {
    const cs = winStats(A, gp, gK - lb.corrS, gK);
    const corrS = cs && cs.n >= 15 ? cs.corr : null;
    const dC = isNum(corrS) ? corrS - bst.corr : 0;
    const regime = isNum(corrS) ? (dC > 0.15 ? "coupling" : dC < -0.15 ? "decoupling" : "stable") : "n/a";
    const level = bst.corr >= 0.8 ? "tightly coupled" : bst.corr <= 0.4 ? "loosely coupled" : "moderately coupled";
    const vals = [];
    for (const p of peers) { const st = winStats(p.X, gp, gK - lb.beta, gK); if (st && st.n >= 20 && st.beta != null) vals.push(st.beta); }
    const rk = vals.length >= MIN_PEERS ? xsRank(bst.beta, vals, { soft: false }) : null;
    const betaAdj = 0.67 * bst.beta + 0.33;                       // Blume (1971) shrink toward 1
    const conf = PRIOR["rel.beta"][cls] * sat(bst.n / lb.beta) * (0.5 + 0.5 * bst.r2);
    out.push(mk("rel.beta", 0, conf, horizon,
      { beta: bst.beta, betaAdj, corr: bst.corr, corrShort: corrS, r2: bst.r2, n: bst.n, corrRegime: regime,
        rank: rk ? rk.rank : null, nPeers: rk ? rk.n - 1 : 0, annVol: bst.volA * Math.sqrt(ppy), benchVolPct: volPct },
      `Beta ${bst.beta.toFixed(2)} to ${benchSym} over ${bst.n} bars (Blume-adj ${betaAdj.toFixed(2)}, corr ${bst.corr.toFixed(2)}, ${level})` +
      `${isNum(corrS) ? `; ${lb.corrS}-bar corr ${corrS.toFixed(2)} — ${regime}` : ""}${rk ? `; #${rk.rank} highest beta of ${rk.n}` : ""} — context only`));
  }

  // ---- rel.btc_lead : BTC's recent move × the alt's beta (crypto alts; evidence mixed) ----
  if (cls === "crypto" && hasBench && isNum(betaV) && benchSym === "BTC") {
    const L = lb.lead;
    const rB = G.lc[gK] - G.lc[gK - L];
    const rA = retBetween(A, gK - L, gK);
    const vs = winStats(A, gp, gK - lb.ivol, gK);
    if (isNum(rB) && isNum(rA) && vs && vs.volA > 0 && gK - L >= A.first) {
      const implied = betaV * rB;
      const z = implied / (vs.volA * Math.sqrt(L));
      const score = Math.tanh(z / 1.5);
      const unreflected = Math.abs(implied) > 1e-9 ? sat((implied - rA) / implied) : 0;
      const conf = PRIOR["rel.btc_lead"].crypto * hmult("rel.btc_lead", cls, hz) * (0.35 + 0.65 * unreflected) * (0.4 + 0.6 * bst.r2) * sat(bst.n / 60);
      out.push(mk("rel.btc_lead", score, conf, horizon,
        { btcRet: Math.exp(rB) - 1, implied: Math.exp(implied) - 1, altRet: Math.exp(rA) - 1, unreflected, bars: L, z, beta: betaV, corr: bst.corr, rank: null, nPeers: peers.length },
        `BTC ${sPct(rB)} over last ${L} bars × beta ${betaV.toFixed(2)} implies ${sPct(implied)} for ${name}, which moved ${sPct(rA)} (${Math.round(unreflected * 100)}% unreflected)` +
        ` — BTC→alt lead–lag tilt ${score > 0.05 ? "bullish" : score < -0.05 ? "bearish" : "neutral"}; evidence mixed, low weight`));
    }
  }

  return out;
}

function sameTail(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  let seen = 0;
  for (let i = a.length - 1; i >= 0 && seen < 3; i--, seen++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.t !== y.t || x.c !== y.c) return false;
  }
  return seen > 0;
}

module.exports = {
  signals, alignByTime, beta, relStrength, xsRank, idioVol,
  SIGNAL_IDS, BENCH, DAILY_LB, INTRADAY_SCALE, lookbacks,
};
