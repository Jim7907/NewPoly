"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../server/learning/registry");

let clock = Date.parse("2026-01-01T00:00:00Z");
const now = () => (clock += 1000);
const mk = (opts = {}) => { const store = R.createMemoryStore(); return { store, reg: R.createRegistry({ store, now, ...opts }) }; };
const entry = (kind, extra = {}) => ({ horizon: "swing", kind, metrics: { holdout: { logloss: 0.69 } }, trainedThrough: 1, dataHash: "h", model: { w: Math.random() }, ...extra });

test("propose: global monotonic versions, challenger status, target identity", () => {
  const { reg } = mk();
  const a = reg.propose(entry("stacker", { target: "y" }));
  const b = reg.propose(entry("stacker", { target: "yEx" }));
  const c = reg.propose({ ...entry("meta"), horizon: "position" });
  assert.deepStrictEqual([a.version, b.version, c.version], [1, 2, 3]);
  assert.strictEqual(a.status, "challenger");
  assert.strictEqual(a.target, "y");
  assert.strictEqual(reg.propose(entry("stacker")).target, "y", "stacker target defaults to y");
  assert.strictEqual(reg.propose(entry("mask", { target: "whatever" })).target, null, "non-stacker kinds ignore target");
  assert.throws(() => reg.propose(entry("bogus")), /kind/);
  assert.throws(() => reg.propose(entry("stacker", { target: "nope" })), /target/);
  assert.throws(() => reg.propose({ kind: "meta" }), /horizon/);
  assert.strictEqual(reg.version(), 0, "proposals do not change the champion version");
});

test("promote: slot champion replaced, retired with reason, version() bumps; stacker targets are independent", () => {
  const { reg } = mk();
  const y1 = reg.propose(entry("stacker", { target: "y" }));
  const ex = reg.propose(entry("stacker", { target: "yEx" }));
  reg.promote(y1.version, "beat baseline");
  reg.promote(ex.version, "beat baseline (yEx)");
  assert.strictEqual(reg.version(), 2);
  assert.strictEqual(reg.champion("swing", "stacker", "y").version, y1.version);
  assert.strictEqual(reg.champion("swing", "stacker").version, y1.version, "target defaults to y");
  assert.strictEqual(reg.champion("swing", "stacker", "yEx").version, ex.version, "y and yEx champions coexist");
  assert.strictEqual(reg.champion("swing", "stacker", "tbLong"), null);
  const y2 = reg.propose(entry("stacker", { target: "y" }));
  const p = reg.promote(y2.version, "DM p=0.03");
  assert.strictEqual(p.status, "champion");
  assert.ok(p.promotedAt);
  const old = reg.history("swing").find((e) => e.version === y1.version);
  assert.strictEqual(old.status, "retired");
  assert.match(old.reason, new RegExp(`superseded by v${y2.version}`));
  assert.strictEqual(reg.champion("swing", "stacker", "yEx").version, ex.version, "other target untouched");
  assert.strictEqual(reg.version(), 3);
  // promoting the champion again is a no-op
  reg.promote(y2.version, "again");
  assert.strictEqual(reg.version(), 3);
  // meta / mask / thresholds: one champion each, target ignored
  const m = reg.propose(entry("meta"));
  reg.promote(m.version, "ok");
  assert.strictEqual(reg.champion("swing", "meta", "yEx").version, m.version);
  const lite = reg.champions("swing");
  assert.strictEqual(lite.stacker.y.version, y2.version);
  assert.strictEqual(lite.stacker.y.model, undefined);
  assert.strictEqual(lite.stacker.y.hasModel, true);
  assert.strictEqual(lite.meta.version, m.version);
  assert.strictEqual(lite.mask, null);
});

test("reject: retired with reason, model dropped, decision logged; a rejected entry cannot be promoted", () => {
  const { reg } = mk();
  const e = reg.propose(entry("stacker"));
  const r = reg.reject(e.version, "rejected: (a) log-loss 0.70 ≥ baseline 0.69");
  assert.strictEqual(r.status, "retired");
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.modelDropped, true);
  assert.match(r.reason, /baseline/);
  assert.throws(() => reg.promote(e.version, "x"), /no model/);
  const d = reg.decisions("swing");
  assert.strictEqual(d[0].action, "reject");
  assert.match(d[0].reason, /log-loss/);
  reg.logDecision("swing", { action: "reject", kind: "meta", reason: "trainer returned no model" });
  assert.match(reg.decisions("swing")[0].reason, /trainer/);
  const c = reg.propose(entry("mask"));
  reg.promote(c.version, "bundled");
  assert.throws(() => reg.reject(c.version, "no"), /champion/);
  assert.throws(() => reg.promote(999, "x"), /not found/);
});

test("rollback restores the previous champion, can go further back, and fails cleanly without one", () => {
  const { reg } = mk();
  const v = [];
  for (let i = 0; i < 3; i++) { const e = reg.propose(entry("stacker", { target: "y" })); reg.promote(e.version, `gen ${i}`); v.push(e.version); }
  assert.strictEqual(reg.champion("swing", "stacker", "y").version, v[2]);
  const before = reg.version();
  const r1 = reg.rollback("swing", "stacker", "y");
  assert.strictEqual(r1.restored.version, v[1]);
  assert.strictEqual(r1.retired.version, v[2]);
  assert.strictEqual(reg.champion("swing", "stacker", "y").version, v[1]);
  assert.strictEqual(reg.version(), before + 1);
  const r2 = reg.rollback("swing", "stacker");
  assert.strictEqual(r2.restored.version, v[0]);
  assert.throws(() => reg.rollback("swing", "stacker", "y"), /no previous/);
  assert.throws(() => reg.rollback("swing", "meta"), /no stacker|no meta/);
  assert.throws(() => reg.rollback("swing", "bogus"), /kind/);
  const log = reg.decisions("swing");
  assert.strictEqual(log[0].action, "rollback");
  assert.match(log[0].reason, new RegExp(`v${v[1]} → v${v[0]}`));
});

test("history is capped per (horizon, kind), never deletes a champion, prunes rejected entries first", () => {
  const { reg } = mk({ maxHistory: 5 });
  const champ = reg.propose(entry("stacker"));
  reg.promote(champ.version, "first");
  const formerChamp = champ.version;
  const next = reg.propose(entry("stacker"));
  reg.promote(next.version, "second");   // formerChamp → retired former champion
  for (let i = 0; i < 20; i++) { const e = reg.propose(entry("stacker")); reg.reject(e.version, `rejected ${i}`); }
  for (let i = 0; i < 3; i++) reg.propose(entry("meta"));
  const st = reg.history("swing", { kind: "stacker" });
  assert.strictEqual(st.length, 5);
  assert.ok(st.some((e) => e.version === next.version && e.status === "champion"), "champion kept");
  assert.ok(st.some((e) => e.version === formerChamp), "former champion kept while rejected entries remain");
  assert.strictEqual(reg.history("swing", { kind: "meta" }).length, 3, "cap is per kind");
  // versions keep increasing after pruning
  const e = reg.propose(entry("stacker"));
  assert.ok(e.version > next.version + 20);
  // the rollback target survives pruning
  assert.strictEqual(reg.rollback("swing", "stacker").restored.version, formerChamp);
});

test("persistence: a fresh registry over the same store sees the same state; history strips model JSON", () => {
  const { store, reg } = mk();
  const e = reg.propose(entry("thresholds", { model: { MIN_PROB_EDGE: 0.03, metaThreshold: 0.56 } }));
  reg.promote(e.version, "PBO 0.2, DSR 0.8");
  const reg2 = R.createRegistry({ store, now });
  assert.deepStrictEqual(reg2.champion("swing", "thresholds").model, { MIN_PROB_EDGE: 0.03, metaThreshold: 0.56 });
  assert.strictEqual(reg2.version(), 1);
  assert.strictEqual(reg2.propose(entry("mask")).version, e.version + 1, "sequence persisted");
  const h = reg2.history("swing");
  assert.ok(h.every((x) => x.model === undefined));
  assert.strictEqual(reg2.history("swing", { includeModel: true })[1].model.MIN_PROB_EDGE, 0.03);
  // champion() returns a copy
  const c = reg2.champion("swing", "thresholds");
  c.model.MIN_PROB_EDGE = 99;
  assert.strictEqual(reg2.champion("swing", "thresholds").model.MIN_PROB_EDGE, 0.03);
});

test("persists through db.saveModel / loadModel (sql.js, in-memory)", async () => {
  const db = require("../server/db");
  await db.initDB({ memory: true });
  const reg = R.createRegistry({ store: db, now });
  const e = reg.propose(entry("stacker", { target: "tbLong" }));
  reg.promote(e.version, "ok");
  assert.strictEqual(db.loadModel("registry:swing").entries[0].status, "champion");
  assert.strictEqual(db.loadModel("registry:_meta").version, 1);
  assert.strictEqual(R.createRegistry({ store: db }).champion("swing", "stacker", "tbLong").version, e.version);
});

test("hashRows is deterministic and sensitive to the rows used", () => {
  const rows = [{ assetId: "A", t: 1, pRaw: 0.5, sig: { x: [0.1, 1] }, lab: { y: 1 } }, { assetId: "B", t: 1, pRaw: 0.4, sig: {}, lab: null }];
  const h = R.hashRows(rows);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.strictEqual(R.hashRows(JSON.parse(JSON.stringify(rows))), h);
  assert.notStrictEqual(R.hashRows(rows.slice(0, 1)), h);
  assert.notStrictEqual(R.hashRows([{ ...rows[0], lab: { y: 0 } }, rows[1]]), h);
});
