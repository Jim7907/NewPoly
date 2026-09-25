const test = require("node:test");
const assert = require("node:assert");
const R = require("../server/analysis/relative");

// ---------- deterministic synthetic market ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const DAY = 864e5;
function calendar(n, { weekdays = true, start = Date.UTC(2021, 0, 4), step = DAY } = {}) {
  const out = [];
  let t = start;
  while (out.length < n) {
    const d = new Date(t).getUTCDay();
    if (!weekdays || step < DAY || (d !== 0 && d !== 6)) out.push(t);
    t += step;
  }
  return out;
}
function marketReturns(n, seed = 99, mu = 0.0003, sd = 0.01) { const r = rng(seed); return Array.from({ length: n }, () => mu + sd * gauss(r)); }
function series(ts, mkt, { beta = 1, sigma = 0.015, alpha = () => 0, seed = 1, p0 = 100 } = {}) {
  const r = rng(seed);
  let lp = Math.log(p0);
  return ts.map((t, i) => {
    if (i) lp += beta * mkt[i] + sigma * gauss(r) + alpha(i);
    const c = Math.exp(lp);
    return { t, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 };
  });
}
function universe({ n = 600, nPeers = 20, weekdays = true, plant = 0.003, plantBars = 260, seed = 7, step = DAY, start } = {}) {
  const ts = calendar(n, { weekdays, step, start });
  const mkt = marketReturns(n);
  const benchmark = series(ts, mkt, { beta: 1, sigma: 0, seed: 5, p0: 400 });
  const peers = {};
  for (let i = 0; i < nPeers; i++) peers["P" + i] = series(ts, mkt, { beta: 0.6 + (i % 10) * 0.1, sigma: 0.01 + (i % 7) * 0.003, seed: 100 + i });
  const asset = series(ts, mkt, { beta: 1.3, sigma: 0.012, alpha: (i) => (i > n - plantBars ? plant : 0), seed });
  return { ts, mkt, benchmark, peers, asset };
}
const byId = (sigs) => Object.fromEntries(sigs.map((s) => [s.id, s]));
function assertClean(sigs) {
  for (const s of sigs) {
    assert.ok(R.SIGNAL_IDS.includes(s.id), `unexpected id ${s.id}`);
    assert.equal(s.family, "relative");
    assert.ok(Number.isFinite(s.score) && s.score >= -1 && s.score <= 1, `${s.id} score ${s.score}`);
    assert.ok(Number.isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1, `${s.id} conf ${s.confidence}`);
    assert.equal(typeof s.reason, "string");
    assert.ok(!/NaN|undefined|Infinity/.test(s.reason), `${s.id} reason: ${s.reason}`);
    for (const [k, v] of Object.entries(s.value)) if (typeof v === "number") assert.ok(Number.isFinite(v), `${s.id}.value.${k}=${v}`);
    assert.ok("rank" in s.value && "nPeers" in s.value && "beta" in s.value, `${s.id} value keys`);
  }
}
const stripReason = (sigs) => sigs.map(({ reason, ...rest }) => rest);

// ---------- tests ----------
test("planted relative outperformance ranks top; planted underperformer ranks bottom", () => {
  const u = universe({ plant: 0.003 });
  const sigs = R.signals(u.asset, { peers: u.peers, benchmark: u.benchmark, assetClass: "stock", horizon: "swing", symbol: "WIN" });
  assertClean(sigs);
  const s = byId(sigs);
  const mom = s["rel.xs.mom_rank"];
  assert.equal(mom.value.rank, 1, mom.reason);
  assert.equal(mom.value.nPeers, 20);
  assert.ok(mom.score > 0.85, `mom score ${mom.score}`);
  assert.ok(mom.confidence > 0.3, `mom conf ${mom.confidence}`);
  assert.match(mom.reason, /12-1 month momentum \+\d+.*ranks 1\/21 \(\d+(st|nd|rd|th) pct\) among stocks/);
  assert.ok(s["rel.rs.12_1"].score > 0.6 && s["rel.rs.6m"].score > 0.5, "relative strength vs benchmark");
  assert.equal(s["rel.rs.12_1"].value.rank, 1);
  for (const id of ["rel.rs.1m", "rel.rs.3m", "rel.rs.6m", "rel.rs.12_1", "rel.xs.reversal_1w", "rel.xs.ivol_rank", "rel.beta"]) assert.ok(s[id], id);
  assert.equal(s["rel.btc_lead"], undefined, "no BTC lead for stocks");
  assert.equal(s["rel.beta"].score, 0, "beta is context only");

  const d = universe({ plant: -0.003, seed: 8 });
  const m2 = byId(R.signals(d.asset, { peers: d.peers, benchmark: d.benchmark, assetClass: "stock", horizon: "swing", symbol: "LOSE" }))["rel.xs.mom_rank"];
  assert.equal(m2.value.rank, 21);
  assert.ok(m2.score < -0.85, `loser score ${m2.score}`);
});

test("crypto: 2–4 week momentum rank, no reversal signal, BTC-lead for alts", () => {
  const u = universe({ weekdays: false, plant: 0.008, plantBars: 25, nPeers: 10 });
  const sigs = R.signals(u.asset, { peers: u.peers, benchmark: u.benchmark, assetClass: "crypto", horizon: "swing", symbol: "SOL" });
  assertClean(sigs);
  const s = byId(sigs);
  assert.equal(s["rel.xs.mom_rank"].value.rank, 1, s["rel.xs.mom_rank"].reason);
  assert.match(s["rel.xs.mom_rank"].reason, /2–4 week momentum/);
  assert.equal(s["rel.xs.reversal_1w"], undefined, "reversal is stocks only");
  assert.ok(s["rel.btc_lead"], "BTC lead emitted for alts");
  assert.ok(s["rel.rs.1m"].score > 0.5);
  // Crypto rs beyond ~1 month is low-evidence → lower confidence than rs.1m.
  assert.ok(s["rel.rs.12_1"].confidence < s["rel.rs.1m"].confidence);

  // BTC just rallied, the high-beta alt has not moved yet → bullish lead with most of the move unreflected.
  const n = 400, ts = calendar(n, { weekdays: false });
  const mkt = marketReturns(n, 3);
  mkt[n - 2] = 0.03; mkt[n - 1] = 0.03;
  const btc = series(ts, mkt, { sigma: 0, p0: 60000 });
  const alt = series(ts, mkt, { beta: 1.4, sigma: 0.01, seed: 11 });
  for (const i of [n - 2, n - 1]) { const c = alt[n - 3].c; alt[i] = { ...alt[i], o: c, h: c, l: c, c }; }  // alt lags
  const lead = byId(R.signals(alt, { peers: { ETH: u.peers.P1, XRP: u.peers.P2 }, benchmark: btc, assetClass: "crypto", symbol: "AVAX" }))["rel.btc_lead"];
  assert.ok(lead.score > 0.3, `lead ${lead.score}`);
  assert.ok(lead.value.unreflected > 0.9);
  assert.ok(lead.confidence <= 0.3 * 0.4 + 1e-9, "swing BTC-lead confidence is capped low (mixed evidence)");
});

test("beta matches a hand computation (helper and the prefix-sum fast path)", () => {
  // Hand computation: β = Σ(a−ā)(b−b̄) / Σ(b−b̄)².
  const rb = [0.01, -0.02, 0.015, 0.005, -0.01, 0.02];
  const ra = [0.012, -0.03, 0.02, 0.01, -0.012, 0.028];
  const mb = rb.reduce((x, y) => x + y) / rb.length, ma = ra.reduce((x, y) => x + y) / ra.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < rb.length; i++) { sxy += (ra[i] - ma) * (rb[i] - mb); sxx += (rb[i] - mb) ** 2; }
  const hand = sxy / sxx;
  const b = R.beta(ra, rb);
  assert.ok(Math.abs(b.beta - hand) < 1e-12, `${b.beta} vs ${hand}`);
  assert.ok(Math.abs(hand - 1.3605442) < 1e-6, `hand value ${hand}`);   // worked out on paper: 0.0010667/0.000784 ≈ 1.36054
  assert.equal(b.n, 6);
  // Exact linear relation → β = 2, corr = 1, idiosyncratic vol 0.
  const exact = R.beta(rb.map((x) => 2 * x + 0.001), rb);
  assert.ok(Math.abs(exact.beta - 2) < 1e-12 && Math.abs(exact.corr - 1) < 1e-9 && exact.idioVol < 1e-9);
  assert.ok(R.idioVol(ra, rb) > 0);
  assert.equal(R.beta([1, 2], [1, 2]), null);                         // too short
  assert.equal(R.beta([0.1, 0.2, 0.3], [0.01, 0.01, 0.01]), null);    // zero benchmark variance

  // The analyzer's rel.beta (prefix sums on the benchmark grid) equals the helper on time-aligned returns.
  const u = universe({ n: 500 });
  const sig = byId(R.signals(u.asset, { peers: u.peers, benchmark: u.benchmark, assetClass: "stock", symbol: "X" }))["rel.beta"];
  const pa = R.alignByTime(u.asset, u.benchmark), pb = u.benchmark.map((c) => c.c);
  const ret = (p) => p.slice(1).map((v, i) => Math.log(v / p[i]));
  const ref = R.beta(ret(pa).slice(-252), ret(pb).slice(-252));
  assert.ok(Math.abs(sig.value.beta - ref.beta) < 1e-3, `${sig.value.beta} vs ${ref.beta}`);
  assert.ok(Math.abs(sig.value.beta - 1.3) < 0.15, "recovers the true beta 1.3");
  assert.equal(sig.value.n, 252);
});

test("no lookahead: mutating future peer/benchmark (and asset) bars leaves the output unchanged", () => {
  const u = universe({ n: 700, nPeers: 15 });
  const i = 520, t = u.asset[i].t;
  const opts = (extra) => ({ peers: u.peers, benchmark: u.benchmark, assetClass: "stock", horizon: "swing", symbol: "A", ...extra });
  const base = R.signals(u.asset, opts({ t }));
  assert.ok(base.length >= 7);
  // Passing t == slicing the asset.
  assert.deepStrictEqual(R.signals(u.asset.slice(0, i + 1), opts({})), base);

  const r = rng(42);
  const scramble = (cs) => cs.map((c) => (c.t > t ? { ...c, c: c.c * (0.3 + 2 * r()) } : c));
  const peers2 = Object.fromEntries(Object.entries(u.peers).map(([k, v]) => [k, scramble(v)]));
  const bench2 = scramble(u.benchmark);
  const asset2 = scramble(u.asset);
  const cache = {};
  const a = R.signals(u.asset, opts({ t, cache }));
  const b = R.signals(asset2, { ...opts({ t, cache }), peers: peers2, benchmark: bench2 });
  const c = R.signals(u.asset.slice(0, i + 1), { ...opts({}), peers: peers2, benchmark: bench2 });
  assert.deepStrictEqual(a, base);
  assert.deepStrictEqual(b, base);
  assert.deepStrictEqual(c, base);
  // Sanity: the future really is used when t moves forward (the test would be vacuous otherwise).
  const later = R.signals(asset2, { ...opts({ t: u.asset[i + 60].t }), peers: peers2, benchmark: bench2 });
  assert.notDeepStrictEqual(stripReason(later), stripReason(base));
});

test("timestamp alignment: as-of join by time, provider stamp offsets, gaps and different starts", () => {
  // alignByTime semantics: last bar at or before each time; daily bars matched by UTC date.
  const d = (k, h = 0) => Date.UTC(2024, 0, k, h, 30);
  const cs = [{ t: d(2), c: 10 }, { t: d(3), c: 11 }, { t: d(5), c: 13 }];            // day 4 missing
  assert.deepStrictEqual(R.alignByTime(cs, [d(1), d(2), d(3), d(4), d(5), d(6)], { daily: true }), [null, 10, 11, 11, 13, 13]);
  const yahoo = [{ t: Date.UTC(2024, 0, 3, 14, 30), c: 11 }];                           // same session, stamped at the open
  assert.deepStrictEqual(R.alignByTime(yahoo, [Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 2)], { daily: true }), [11, null]);
  assert.deepStrictEqual(R.alignByTime([{ t: 1000, c: 1 }, { t: 2000, c: 2 }], [999, 1000, 1500, 2500], { daily: false }), [null, 1, 1, 2]);

  // Peers stamped 14:30 UTC (Yahoo-style) vs the asset / benchmark at 00:00 UTC → identical output.
  const u = universe({ n: 500, nPeers: 12 });
  const shift = (cs) => cs.map((c) => ({ ...c, t: c.t + 14.5 * 3600e3 }));
  const peersShifted = Object.fromEntries(Object.entries(u.peers).map(([k, v]) => [k, shift(v)]));
  const o = { benchmark: u.benchmark, assetClass: "stock", horizon: "swing", symbol: "A" };
  const ref = R.signals(u.asset, { ...o, peers: u.peers });
  assert.deepStrictEqual(R.signals(u.asset, { ...o, peers: peersShifted }), ref);

  // Index alignment would be wrong here: P0 starts 150 bars later, P1 misses ~10% of days.
  // Time alignment measures every return over the same two instants.
  const r = rng(5);
  const peers = { ...u.peers, P0: u.peers.P0.slice(150), P1: u.peers.P1.filter(() => r() > 0.1) };
  const sigs = R.signals(u.asset, { ...o, peers });
  assertClean(sigs);
  const rs = byId(sigs)["rel.rs.3m"];
  const k = u.asset.length - 1, L = 63;
  const handAsset = u.asset[k].c / u.asset[k - L].c - 1, handBench = u.benchmark[k].c / u.benchmark[k - L].c - 1;
  assert.ok(Math.abs(rs.value.assetRet - handAsset) < 1e-4 && Math.abs(rs.value.benchRet - handBench) < 1e-4);
  // A clone of the asset with a shorter history ties with it (same instants → same return).
  const clone = byId(R.signals(u.asset, { ...o, peers: { ...u.peers, CLONE: u.asset.slice(300) } }))["rel.rs.1m"];
  assert.ok(clone.value.nPeers === 13);
  // A peer that has a bar AFTER the asset's last bar never contributes that bar.
  const ahead = { ...u.peers, FUT: [...u.peers.P3, { t: u.asset[k].t + DAY, o: 1, h: 1, l: 1, c: 1e6, v: 1 }] };
  assert.deepStrictEqual(R.signals(u.asset, { ...o, peers: ahead }).map((s) => s.value.rank), ref.map((s) => s.value.rank));

  // Crypto trades 7 days: lookbacks are calendar days (1m = 30 bars) not trading days.
  const c = universe({ n: 500, weekdays: false, nPeers: 6 });
  const crs = byId(R.signals(c.asset, { peers: c.peers, benchmark: c.benchmark, assetClass: "crypto", symbol: "ETH" }))["rel.rs.1m"];
  assert.equal(crs.value.bars, 30);
});

test("few peers → low confidence and a shrunk score", () => {
  const u = universe({ n: 600, nPeers: 30 });
  const run = (n) => byId(R.signals(u.asset, { peers: Object.fromEntries(Object.entries(u.peers).slice(0, n)), benchmark: u.benchmark, assetClass: "stock", symbol: "A" }))["rel.xs.mom_rank"];
  const few = run(3), many = run(30);
  assert.equal(few.value.rank, 1);
  assert.equal(many.value.rank, 1);
  assert.ok(few.confidence < 0.5 * many.confidence, `few ${few.confidence} vs many ${many.confidence}`);
  assert.ok(few.confidence < 0.2);
  assert.ok(few.score < many.score && few.score < 0.85, `few score ${few.score}`);
  assert.match(few.reason, /only 3 peers, weak/);
  // One peer is not a cross-section: no xs signals, but vs-benchmark signals remain.
  const one = byId(R.signals(u.asset, { peers: { P0: u.peers.P0 }, benchmark: u.benchmark, assetClass: "stock", symbol: "A" }));
  assert.equal(one["rel.xs.mom_rank"], undefined);
  assert.ok(one["rel.rs.12_1"] && one["rel.beta"]);
  // Peer factor is monotone in the number of peers.
  const confs = [2, 4, 8, 16].map((n) => run(n).confidence);
  for (let j = 1; j < confs.length; j++) assert.ok(confs[j] >= confs[j - 1] - 0.02, `conf not increasing: ${confs}`);
});

test("benchmark special case: SPY / BTC return only a neutral rel.beta", () => {
  const u = universe({ n: 400, nPeers: 5 });
  for (const [cls, sym] of [["stock", "SPY"], ["crypto", "BTC"], ["stock", "STOCK:SPY"]]) {
    const out = R.signals(u.benchmark, { peers: u.peers, benchmark: u.benchmark, assetClass: cls, symbol: sym });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "rel.beta");
    assert.equal(out[0].score, 0);
    assert.equal(out[0].value.beta, 1);
    assert.equal(out[0].value.isBenchmark, true);
    assertClean(out);
  }
  // Identified by reference when no symbol is given.
  const anon = R.signals(u.benchmark, { peers: u.peers, benchmark: u.benchmark, assetClass: "stock" });
  assert.deepStrictEqual(anon.map((s) => s.id), ["rel.beta"]);
  // SPY inside the stock peer set is not ranked as a cross-section member.
  const withSpy = byId(R.signals(u.asset, { peers: { ...u.peers, SPY: u.benchmark }, benchmark: u.benchmark, assetClass: "stock", symbol: "A" }));
  assert.equal(withSpy["rel.xs.mom_rank"].value.nPeers, 5);
});

test("ETFs are fine as assets; missing peers/benchmark and bad input degrade gracefully (never NaN)", () => {
  const u = universe({ n: 500, nPeers: 10 });
  const etf = R.signals(u.peers.P4, { peers: { ...u.peers, A: u.asset }, benchmark: u.benchmark, assetClass: "stock", symbol: "QQQ", horizon: "position" });
  assertClean(etf);
  assert.ok(byId(etf)["rel.xs.mom_rank"] && byId(etf)["rel.xs.ivol_rank"].value.etf === true);

  assert.deepStrictEqual(R.signals(u.asset, { assetClass: "stock", symbol: "A" }), []);
  assert.deepStrictEqual(R.signals(u.asset, { peers: {}, benchmark: [], assetClass: "stock" }), []);
  assert.deepStrictEqual(R.signals([], { peers: u.peers, benchmark: u.benchmark }), []);
  assert.deepStrictEqual(R.signals(null, {}), []);
  assert.deepStrictEqual(R.signals(u.asset.slice(0, 10), { peers: u.peers, benchmark: u.benchmark }), []);
  assert.deepStrictEqual(R.signals(u.asset, { peers: u.peers, benchmark: u.benchmark, t: u.asset[0].t - DAY }), []);

  const benchOnly = byId(R.signals(u.asset, { benchmark: u.benchmark, assetClass: "stock", symbol: "A" }));
  assert.ok(benchOnly["rel.rs.12_1"] && benchOnly["rel.beta"] && !benchOnly["rel.xs.mom_rank"]);
  const peersOnly = byId(R.signals(u.asset, { peers: u.peers, assetClass: "stock", symbol: "A" }));
  assert.ok(peersOnly["rel.xs.mom_rank"] && peersOnly["rel.xs.reversal_1w"] && !peersOnly["rel.rs.1m"] && !peersOnly["rel.beta"]);
  assertClean(Object.values(peersOnly));

  // Garbage bars, flat peers, a stale peer, duplicate/unsorted bars, a Map of peers.
  const dirty = u.asset.map((c, i) => (i % 37 === 0 ? { ...c, c: NaN } : i % 53 === 0 ? null : c));
  const flat = u.asset.map((c) => ({ ...c, c: 50 }));
  const stale = u.peers.P2.slice(0, 300);
  const shuffled = [...u.peers.P3].reverse();
  const peersMap = new Map([["P0", u.peers.P0], ["FLAT", flat], ["STALE", stale], ["SHUF", shuffled], ["DUP", [...u.peers.P5, ...u.peers.P5]], ["BAD", "x"]]);
  const out = R.signals(dirty, { peers: peersMap, benchmark: u.benchmark, assetClass: "stock", symbol: "A" });
  assertClean(out);
  assert.ok(out.length >= 5);
  assert.equal(byId(out)["rel.xs.mom_rank"].value.nPeers, 4, "stale peer dropped");
  const flatAsset = R.signals(flat, { peers: u.peers, benchmark: u.benchmark, assetClass: "stock", symbol: "F" });
  assertClean(flatAsset);
});

test("intraday horizon: 15m bars, lookbacks scaled in bars", () => {
  const u = universe({ n: 1200, nPeers: 8, weekdays: false, step: 900e3, plant: 0.0005, plantBars: 120 });
  const sigs = R.signals(u.asset, { peers: u.peers, benchmark: u.benchmark, assetClass: "crypto", horizon: "intraday", symbol: "SOL" });
  assertClean(sigs);
  const s = byId(sigs);
  assert.equal(s["rel.rs.1m"].value.bars, Math.round(30 * R.INTRADAY_SCALE));   // 48 bars
  assert.equal(s["rel.rs.1m"].horizon, "intraday");
  assert.ok(s["rel.btc_lead"]);
  assert.equal(s["rel.xs.mom_rank"].value.rank, 1);
  const lb = R.lookbacks("stock", "intraday");
  assert.deepStrictEqual([lb.w1, lb.m1, lb.m12, lb.skip], [8, 34, 403, 34]);
});

test("xsRank: smooth, monotone, shrunk toward 0.5 with few peers", () => {
  const peers = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];
  const a = R.xsRank(0.3, peers), b = R.xsRank(0.3001, peers);
  assert.equal(a.rank, 1);
  assert.equal(a.n, 8);
  assert.ok(Math.abs(a.score - b.score) < 1e-3, "continuous in the value");
  let prev = -2;
  for (let x = -0.3; x <= 0.4; x += 0.01) { const s = R.xsRank(x, peers).score; assert.ok(s >= prev - 1e-12); prev = s; }
  const top2 = R.xsRank(1, [0, 0.1]).pct, top40 = R.xsRank(1, Array.from({ length: 40 }, (_, i) => i / 100)).pct;
  assert.ok(Math.abs(top2 - 0.75) < 0.01 && top40 > 0.95, `${top2} ${top40}`);
  assert.equal(R.xsRank(0.1, [0.1, 0.1, 0.1]).score, 0);
  assert.equal(R.xsRank(1, [2, 3], { higherIsBetter: false }).rank, 1);
  const rs = R.relStrength([100, 110, 121, 133.1], [100, 100, 100, 110], 3, 1);
  assert.ok(Math.abs(rs.exRet - Math.log(1.21)) < 1e-12 && rs.bars === 2);
  assert.equal(R.relStrength([1, 2], [1, 2], 5), null);
});

test("cache: sliding-window slices (dataset-builder style) give identical output to a fresh build", () => {
  const u = universe({ n: 800, nPeers: 12 });
  const cache = {};
  for (const i of [500, 501, 502, 650, 799]) {
    const t = u.asset[i].t;
    const win = (cs) => cs.slice(Math.max(0, i + 1 - 420), i + 1);
    const o = { peers: Object.fromEntries(Object.entries(u.peers).map(([k, v]) => [k, win(v)])), benchmark: win(u.benchmark), assetClass: "stock", symbol: "A", t };
    const fresh = R.signals(u.asset.slice(i + 1 - 600, i + 1), o);
    const cachedFull = R.signals(u.asset, { peers: u.peers, benchmark: u.benchmark, assetClass: "stock", symbol: "A", t, cache: {} });
    const cachedWin = R.signals(u.asset.slice(i + 1 - 600, i + 1), { ...o, cache });
    assert.deepStrictEqual(cachedWin, fresh, `window ${i}`);
    assert.ok(cachedFull.length === fresh.length);
  }
  // Live partial-bar update (same array, last close changes) must not serve a stale entry.
  const live = u.asset.slice();
  const o = { peers: u.peers, benchmark: u.benchmark, assetClass: "stock", symbol: "A", cache };
  const before = R.signals(live, o);
  live[live.length - 1] = { ...live[live.length - 1], c: live[live.length - 1].c * 1.2 };
  const after = R.signals(live, o);
  assert.deepStrictEqual(after, R.signals(live, { ...o, cache: undefined }));
  assert.notDeepStrictEqual(after, before);
});

test("timing: 40 peers × 1000 bars in < 10 ms (cold) and far less with the cache", () => {
  const u = universe({ n: 1000, nPeers: 40 });
  const o = { peers: u.peers, benchmark: u.benchmark, assetClass: "stock", horizon: "swing", symbol: "A" };
  for (let k = 0; k < 5; k++) R.signals(u.asset, o);                        // JIT warm-up
  const cold = [];
  for (let k = 0; k < 15; k++) { const t0 = performance.now(); R.signals(u.asset, o); cold.push(performance.now() - t0); }
  cold.sort((a, b) => a - b);
  const cache = {};
  R.signals(u.asset, { ...o, cache });
  const t0 = performance.now();
  let n = 0;
  for (let i = 400; i < 1000; i++, n++) R.signals(u.asset, { ...o, cache, t: u.asset[i].t });
  const warm = (performance.now() - t0) / n;
  const med = cold[cold.length >> 1];
  console.log(`    relative.signals 40×1000: cold median ${med.toFixed(2)} ms, cached per-bar ${warm.toFixed(3)} ms`);
  assert.ok(med < 10, `cold median ${med} ms`);
  assert.ok(warm < 10, `cached ${warm} ms`);
});
