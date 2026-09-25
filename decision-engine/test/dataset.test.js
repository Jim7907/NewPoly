// Research panel builder: labels, triple barrier, strict point-in-time behaviour (perturb the
// future → past rows unchanged), incremental updates, persistence. Synthetic candles, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = require("../server/config");
const D = require("../server/research/dataset");
const ensemble = require("../server/decision/ensemble");

const DAY = 86400000;
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// Daily random-walk candles. Stocks skip weekends (00:00 UTC per trading date), crypto trade daily.
function candles(seed, n, { crypto = false, vol = 0.015, start = Date.UTC(2021, 0, 4) } = {}) {
  const r = prng(seed);
  const out = [];
  let p = 100, t = start;
  while (out.length < n) {
    const wd = new Date(t).getUTCDay();
    if (crypto || (wd !== 0 && wd !== 6)) {
      const o = p * Math.exp(0.002 * gauss(r));
      p = o * Math.exp(vol * gauss(r));
      out.push({ t, o, h: Math.max(o, p) * (1 + 0.006 * r()), l: Math.min(o, p) * (1 - 0.006 * r()), c: p, v: 1e5 * (1 + r()) });
    }
    t += DAY;
  }
  return out;
}
const ASSETS = ["STOCK:SPY", "STOCK:AAA", "STOCK:BBB", "STOCK:CCC", "CRYPTO:BTC", "CRYPTO:ETH", "CRYPTO:SOL"];
function universe(n) {
  const cb = {};
  ASSETS.forEach((id, k) => { cb[id] = candles(k + 1, n, { crypto: id.startsWith("CRYPTO"), vol: id.startsWith("CRYPTO") ? 0.035 : 0.015 }); });
  const t0 = Date.UTC(2020, 0, 1);
  const r = prng(99);
  let v = 20;
  const vix = [], hy = [];
  for (let t = t0; t < Date.UTC(2023, 0, 1); t += DAY) { v = Math.max(9, v * Math.exp(0.05 * gauss(r))); vix.push({ t, v }); hy.push({ t, v: 3 + v / 20 }); }
  const fng = [];
  for (let t = t0; t < Date.UTC(2023, 0, 1); t += DAY) fng.push({ t, v: Math.round(50 + 45 * Math.sin(t / (40 * DAY))) });
  return { cb, macro: { vix, hyOas: hy }, fng };
}
const BASE = { horizon: "swing", assets: ASSETS, warmup: 200, lookback: 180, regimeEvery: 3, workers: 1 };
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((q) => [q, v[q]])) : v));
const pit = (r) => canon({ assetId: r.assetId, t: r.t, i: r.i, price: r.price, atrPct: r.atrPct, annVol: r.annVol, regime: r.regime, sig: r.sig, fam: r.fam, pRaw: r.pRaw });

// A stand-in relative analyzer. Like the real one it honours the cut-off `t` (reads peer /
// benchmark bars ≤ t only), and it records (a) any own bar after t — never allowed — and (b) how
// often it was handed peer / benchmark bars after t (expected in the default "full" input mode,
// zero in "slice" mode). Its signals depend on the latest peer / benchmark closes, so a leak
// would move them.
function spyRelative() {
  const leaks = [];
  const handed = { future: 0, calls: 0 };
  return {
    leaks, handed,
    signals(own, { peers, benchmark, assetClass, t }) {
      handed.calls++;
      const last = own[own.length - 1];
      if (last.t > t) leaks.push(`own ${last.t} > ${t}`);
      const cut = (cs) => { const out = cs.filter((c) => c.t <= t); if (out.length < cs.length) handed.future++; return out; };
      const P = Object.entries(peers).map(([k, cs]) => [k, cut(cs)]).filter(([, cs]) => cs.length > 6);
      const B = cut(benchmark);
      const rs = Math.tanh(20 * (Math.log(last.c / own[Math.max(0, own.length - 21)].c) - Math.log(B[B.length - 1].c / B[Math.max(0, B.length - 21)].c)));
      const peerMean = P.reduce((s, [, cs]) => s + Math.log(cs[cs.length - 1].c / cs[cs.length - 6].c), 0) / Math.max(1, P.length);
      return [
        { id: "rel.rs.1m", family: "relative", score: rs, confidence: 0.5, horizon: "any", value: {}, reason: "" },
        { id: "rel.xs.peer_mom", family: "relative", score: Math.tanh(10 * peerMean), confidence: 0.4, horizon: "any", value: { assetClass, nPeers: P.length }, reason: "" },
      ];
    },
  };
}

test("RESEARCH_UNIVERSE is the de-duplicated union of the live watchlist and the research extras", () => {
  const ids = D.RESEARCH_UNIVERSE.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of cfg.ASSETS) assert.ok(ids.includes(a.id), a.id);
  for (const id of ["STOCK:SPY", "CRYPTO:BTC", "STOCK:JPM", "STOCK:IWM", "STOCK:DIA", "CRYPTO:LINK"]) assert.ok(ids.includes(id), id);
  assert.ok(D.RESEARCH_UNIVERSE.every((a) => a.id && a.symbol && (a.assetClass === "stock" || a.assetClass === "crypto")));
  assert.ok(D.RESEARCH_UNIVERSE.find((a) => a.id === "STOCK:SPY").etf);
  const u = D.researchUniverse({ RESEARCH_STOCKS: "aapl, msft", RESEARCH_CRYPTO: "eth" });
  assert.deepEqual(u.map((a) => a.id), ["STOCK:AAPL", "STOCK:MSFT", "STOCK:SPY", "CRYPTO:BTC", "CRYPTO:ETH"]);
  assert.equal(D.toAsset("CRYPTO:ETH").coinbase, "ETH-USD");
  assert.equal(D.toAsset("STOCK:QQQ").etf, true);
});

test("triple barrier: target, stop, pessimistic tie, gaps, vertical barrier, costs", () => {
  const bar = (o, h, l, c) => ({ t: 0, o, h, l, c, v: 1 });
  const br = { stop: 2, target: 3 };
  // entry 100, ATR 1 → long stop 98 / target 103; short stop 102 / target 97.
  const up = [bar(100, 100, 100, 100), bar(100, 101, 99, 100.5), bar(100.5, 103.5, 99.5, 103), bar(103, 104, 102, 103)];
  let tb = D.tripleBarrier(up, 0, 3, 1, br, 0.001);
  assert.equal(tb.tbLong, 1);
  assert.ok(Math.abs(tb.tbLongRet - (0.03 - 0.001)) < 1e-12);
  assert.equal(tb.tbShort, -1);                                   // short stopped at 102 in bar 2
  assert.ok(Math.abs(tb.tbShortRet - (-0.02 - 0.001)) < 1e-12);
  // Both barriers inside one bar → stop (pessimistic) for both sides.
  const wide = [bar(100, 100, 100, 100), bar(100, 104, 96.5, 100)];
  tb = D.tripleBarrier(wide, 0, 1, 1, br, 0);
  assert.equal(tb.tbLong, -1); assert.ok(Math.abs(tb.tbLongRet + 0.02) < 1e-12);
  assert.equal(tb.tbShort, -1); assert.ok(Math.abs(tb.tbShortRet + 0.02) < 1e-12);
  // Gap below the long stop fills at the open (worse than the stop).
  const gap = [bar(100, 100, 100, 100), bar(96, 97, 95, 96.5)];
  tb = D.tripleBarrier(gap, 0, 1, 1, br, 0);
  assert.equal(tb.tbLong, -1); assert.ok(Math.abs(tb.tbLongRet - (-0.04)) < 1e-12);
  assert.equal(tb.tbShort, 1); assert.ok(Math.abs(tb.tbShortRet - 0.04) < 1e-12);   // gap through the short target
  // Nothing touched → vertical barrier at close[i+ahead].
  const flat = [bar(100, 100, 100, 100), bar(100, 101, 99, 100.4), bar(100.4, 101, 99.5, 101)];
  tb = D.tripleBarrier(flat, 0, 2, 1, br, 0.002);
  assert.equal(tb.tbLong, 0); assert.equal(tb.tbShort, 0);
  assert.ok(Math.abs(tb.tbLongRet - (0.01 - 0.002)) < 1e-12);
  assert.ok(Math.abs(tb.tbShortRet - (-0.01 - 0.002)) < 1e-12);
  // Window past the data → null.
  assert.equal(D.tripleBarrier(flat, 1, 2, 1, br, 0), null);
});

test("buildDataset: row shape, families, labels vs candles, ordering", async () => {
  const U = universe(300);
  const ds = await D.buildDataset({ ...BASE, candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng, relative: null });
  assert.equal(ds.version, 2);
  assert.equal(ds.horizon, "swing"); assert.equal(ds.tf, 86400); assert.equal(ds.ahead, 5);
  assert.deepEqual(ds.benchmarks, { stock: "STOCK:SPY", crypto: "CRYPTO:BTC" });
  assert.equal(ds.rows.length, 7 * 100);
  for (let k = 1; k < ds.rows.length; k++) {
    const a = ds.rows[k - 1], b = ds.rows[k];
    assert.ok(a.t < b.t || (a.t === b.t && a.assetId < b.assetId), "sorted by t, then assetId");
  }
  const fams = new Set(ds.signalIds.map((id) => ds.signalFamily[id]));
  for (const f of ["technical", "regime", "macro", "sentiment"]) assert.ok(fams.has(f), f);
  assert.ok(!ds.signalIds.some((id) => id.startsWith("rel.")));
  assert.ok(ds.meta.notes.some((n) => /relative/.test(n)));
  const costRT = { stock: 2 * (cfg.FEE_BPS_STOCK + cfg.SLIPPAGE_BPS) / 1e4, crypto: 2 * (cfg.FEE_BPS_CRYPTO + cfg.SLIPPAGE_BPS) / 1e4 };
  const br = ensemble.BRACKETS.swing;
  let checked = 0;
  for (const r of ds.rows) {
    assert.ok(Number.isFinite(r.pRaw) && r.pRaw > 0 && r.pRaw < 1);
    assert.ok(r.regime && r.regime.label);
    assert.ok(Number.isFinite(r.atrPct) && r.atrPct > 0 && Number.isFinite(r.annVol));
    for (const [id, v] of Object.entries(r.sig)) assert.ok(v.length === 2 && v[0] >= -1 && v[0] <= 1 && v[1] >= 0 && v[1] <= 1, id);
    assert.ok(r.assetClass === "stock" ? !("sent.feargreed.contrarian" in r.sig) : "sent.feargreed.contrarian" in r.sig);
    const cs = U.cb[r.assetId];
    assert.equal(cs[r.i].t, r.t);
    assert.equal(r.price, cs[r.i].c);
    if (r.i + 5 > cs.length - 1) { assert.equal(r.lab, null); continue; }
    const ret = Math.log(cs[r.i + 5].c / cs[r.i].c);
    assert.ok(Math.abs(r.lab.ret - ret) < 1e-6);
    assert.equal(r.lab.y, ret > 0 ? 1 : 0);
    assert.equal(r.lab.tEnd, cs[r.i + 5].t);
    const bench = U.cb[D.BENCHMARKS[r.assetClass]];
    if (r.assetId === D.BENCHMARKS[r.assetClass]) assert.equal(r.lab.exRet, 0);
    else {
      const b0 = bench.find((c) => c.t === r.t), b1 = bench.find((c) => c.t === r.lab.tEnd);
      assert.ok(Math.abs(r.lab.exRet - (ret - Math.log(b1.c / b0.c))) < 1e-6);
      assert.equal(r.lab.yEx, r.lab.exRet > 0 ? 1 : 0);
    }
    const tb = D.tripleBarrier(cs, r.i, 5, r.atrPct * r.price, br, costRT[r.assetClass]);
    assert.equal(r.lab.tbLong, tb.tbLong); assert.equal(r.lab.tbShort, tb.tbShort);
    assert.ok(Math.abs(r.lab.tbLongRet - tb.tbLongRet) < 1e-6 && Math.abs(r.lab.tbShortRet - tb.tbShortRet) < 1e-6);
    checked++;
  }
  assert.equal(checked, 7 * 95);
  assert.equal(ds.rows.filter((r) => r.lab === null).length, 7 * 5);
});

for (const relativeInput of ["full", "slice"]) {
  test(`strictly point-in-time: perturbing the future (own, peers, benchmark, macro, F&G) leaves rows ≤ i unchanged (relative input: ${relativeInput})`, async () => {
    const U = universe(290);
    const rel = spyRelative();
    const a = await D.buildDataset({ ...BASE, relativeInput, candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng, relative: rel });
    assert.ok(a.signalIds.includes("rel.rs.1m") && a.signalIds.includes("rel.xs.peer_mom"));
    const K = 240;                                          // perturb every bar after index K
    const tK = U.cb["STOCK:SPY"][K].t;
    const r = prng(4242);
    const cb2 = {};
    for (const [id, cs] of Object.entries(U.cb)) {
      cb2[id] = cs.map((c) => {
        if (c.t <= tK) return { ...c };
        const f = Math.exp(0.1 * gauss(r));
        return { t: c.t, o: c.o * f, h: c.h * f * 1.02, l: c.l * f * 0.98, c: c.c * f * (1 + 0.01 * gauss(r)), v: c.v * 3 };
      });
    }
    const macro2 = { vix: U.macro.vix.map((p) => (p.t > tK - DAY ? { t: p.t, v: p.v * 3 } : p)), hyOas: U.macro.hyOas.map((p) => (p.t > tK - DAY ? { t: p.t, v: p.v + 5 } : p)) };
    const fng2 = U.fng.map((p) => (p.t > tK ? { t: p.t, v: 100 - p.v } : p));
    const rel2 = spyRelative();
    const b = await D.buildDataset({ ...BASE, relativeInput, candlesByAsset: cb2, macroHistory: macro2, fearGreedHistory: fng2, relative: rel2 });
    assert.deepEqual(rel.leaks, []);
    assert.deepEqual(rel2.leaks, []);
    if (relativeInput === "slice") assert.equal(rel.handed.future + rel2.handed.future, 0, "slice mode hands over bars ≤ t only");
    assert.equal(a.rows.length, b.rows.length);
    let past = 0, pastLab = 0, futureDiff = 0;
    for (let k = 0; k < a.rows.length; k++) {
      const x = a.rows[k], y = b.rows[k];
      assert.equal(x.assetId, y.assetId); assert.equal(x.t, y.t);
      if (x.t <= tK) {
        assert.equal(pit(x), pit(y), `row ${x.assetId} @ ${new Date(x.t).toISOString()} moved`);
        past++;
        if (x.lab && x.lab.tEnd <= tK) { assert.equal(canon(x.lab), canon(y.lab)); pastLab++; }
      } else if (pit(x) !== pit(y)) futureDiff++;
    }
    assert.ok(past > 150 && pastLab > 100, `${past} past rows, ${pastLab} past labels checked`);
    assert.ok(futureDiff > 0.5 * (a.rows.length - past), "the perturbation does move later rows");
  });
}

test("updateDataset is incremental and reproduces a full build exactly", async () => {
  const U = universe(300);
  const opts = { ...BASE, macroHistory: U.macro, fearGreedHistory: U.fng, relative: null };
  const full = await D.buildDataset({ ...opts, candlesByAsset: U.cb });
  const cut = {};
  for (const [id, cs] of Object.entries(U.cb)) cut[id] = cs.slice(0, 272);
  const part = await D.buildDataset({ ...opts, candlesByAsset: cut });
  assert.equal(part.rows.length, 7 * 72);
  assert.equal(part.rows.filter((r) => !r.lab).length, 7 * 5);
  const seen = [];
  const upd = await D.updateDataset(part, { candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng, relative: null, workers: 1,
    onProgress: (p) => { if (p.phase === "compute") seen.push(p.done); } });
  assert.equal(upd, part);
  assert.equal(upd.meta.lastUpdate.newRows, 7 * 28);
  assert.equal(upd.meta.lastUpdate.maturedLabels, 7 * 5);
  assert.equal(Math.max(...seen), 7 * 28, "only the new bars are computed");
  assert.equal(upd.rows.length, full.rows.length);
  for (let k = 0; k < full.rows.length; k++) assert.equal(canon(upd.rows[k]), canon(full.rows[k]));
  // Nothing new → nothing computed.
  await D.updateDataset(upd, { candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng, relative: null, workers: 1 });
  assert.equal(upd.meta.lastUpdate.newRows, 0);
  assert.equal(upd.meta.lastUpdate.maturedLabels, 0);
});

test("stride and the forming bar", async () => {
  const U = universe(260);
  const cb = { "STOCK:SPY": U.cb["STOCK:SPY"], "STOCK:AAA": U.cb["STOCK:AAA"] };
  const last = cb["STOCK:SPY"][cb["STOCK:SPY"].length - 1].t;
  const ds = await D.buildDataset({ ...BASE, assets: ["STOCK:SPY", "STOCK:AAA"], candlesByAsset: cb, macroHistory: null, fearGreedHistory: null,
    relative: null, stride: 3, now: last + 3600000 });           // last bar still forming at `now`
  assert.ok(ds.rows.every((r) => (r.i - 200) % 3 === 0));
  assert.ok(ds.rows.every((r) => r.t < last));
  assert.equal(ds.rows.filter((r) => r.assetId === "STOCK:AAA").length, Math.ceil((259 - 200) / 3));
  assert.ok(!ds.signalIds.some((id) => id.startsWith("macro.")));
});

test("saveDataset / loadDataset round-trip (gzip, compact signals)", async () => {
  const U = universe(230);
  const ds = await D.buildDataset({ ...BASE, candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng, relative: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-test-"));
  try {
    const file = D.saveDataset(ds, path.join(dir, "swing.json.gz"));
    assert.ok(fs.existsSync(file));
    const back = D.loadDataset(file);
    assert.equal(canon(back.rows), canon(ds.rows));
    assert.deepEqual(back.signalIds, ds.signalIds);
    assert.equal(back.horizon, "swing");
    assert.equal(back.format, undefined);
    const plain = D.saveDataset(ds, path.join(dir, "swing.json"));
    assert.equal(canon(D.loadDataset(plain).rows), canon(ds.rows));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The same future-perturbation check with the real relative analyzer (and dataset.js's primed
// series cache), when server/analysis/relative.js is present.
let realRelative = null;
try { realRelative = require("../server/analysis/relative"); } catch { realRelative = null; }
test("strictly point-in-time with the real relative analyzer + primed cache", { skip: !realRelative && "server/analysis/relative.js not present" }, async () => {
  const U = universe(300);
  const opts = { ...BASE, macroHistory: U.macro, fearGreedHistory: U.fng };
  const a = await D.buildDataset({ ...opts, candlesByAsset: U.cb });
  assert.ok(a.meta.relative && a.signalIds.some((id) => id.startsWith("rel.")), "relative family present");
  // The fast path (full peer/benchmark arrays + t) equals handing over only bars ≤ t.
  const sliced = await D.buildDataset({ ...opts, candlesByAsset: U.cb, relativeInput: "slice" });
  assert.equal(canon(sliced.rows), canon(a.rows));
  const K = 250, tK = U.cb["STOCK:SPY"][K].t;
  const r = prng(777);
  const cb2 = {};
  for (const [id, cs] of Object.entries(U.cb)) cb2[id] = cs.map((c) => (c.t <= tK ? { ...c } : { ...c, c: c.c * Math.exp(0.2 * gauss(r)), h: c.h * 1.3, l: c.l * 0.7 }));
  const b = await D.buildDataset({ ...opts, candlesByAsset: cb2 });
  let past = 0;
  for (let k = 0; k < a.rows.length; k++) if (a.rows[k].t <= tK) { assert.equal(pit(a.rows[k]), pit(b.rows[k])); past++; }
  assert.ok(past > 200);
});

test("worker threads give exactly the in-process result", async () => {
  const U = universe(270);
  const opts = { ...BASE, candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng };
  const one = await D.buildDataset({ ...opts, workers: 1 });
  const two = await D.buildDataset({ ...opts, workers: 2 });
  assert.equal(two.meta.timing.workers, 2);
  assert.equal(canon(two.rows), canon(one.rows));
});

test("code fingerprint is stored and compared on update", async () => {
  const U = universe(240);
  const opts = { ...BASE, candlesByAsset: U.cb, macroHistory: U.macro, fearGreedHistory: U.fng, relative: null };
  const ds = await D.buildDataset(opts);
  assert.match(ds.meta.codeHash, /^[0-9a-f]{16}$/);
  assert.equal(ds.meta.codeHash, D.codeHash());
  await D.updateDataset(ds, { ...opts });
  assert.equal(ds.meta.lastUpdate.codeChanged, false);
  ds.meta.codeHash = "0000000000000000";
  await D.updateDataset(ds, { ...opts });
  assert.equal(ds.meta.lastUpdate.codeChanged, true);
  assert.ok(ds.meta.notes.some((n) => /full rebuild/.test(n)));
});
