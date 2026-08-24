const test = require("node:test");
const assert = require("node:assert");
const bias = require("../server/bias");

// The real Singapore numbers this project was built against: the three-model consensus ran
// ~0.8 C below what WSSS actually reported, day after day.
const singapore = [
  { date: "2026-08-10", rawCenter: 31.6, obs: 32 },
  { date: "2026-08-11", rawCenter: 31.7, obs: 33 },
  { date: "2026-08-12", rawCenter: 31.7, obs: 32 },
  { date: "2026-08-13", rawCenter: 31.1, obs: 32 },
  { date: "2026-08-14", rawCenter: 32.1, obs: 33 },
];

test("fitBias recovers a real station offset and shrinks the error", () => {
  const f = bias.fitBias(singapore, { asOf: "2026-08-15" });
  assert.ok(f.ready);
  assert.equal(f.n, 5);
  assert.ok(f.bias > 0.6 && f.bias < 1.0, `expected ~+0.8, got ${f.bias}`);
  assert.ok(f.rmse < f.rmseUncorrected, "correcting the centre beats not correcting it");
});

test("fitBias weights recent days more heavily", () => {
  const drift = [
    { date: "2026-08-01", rawCenter: 30, obs: 30 },   // old: no bias
    { date: "2026-08-20", rawCenter: 30, obs: 32 },   // recent: +2
  ];
  const fast = bias.fitBias(drift, { asOf: "2026-08-21", halfLifeDays: 2 });
  const slow = bias.fitBias(drift, { asOf: "2026-08-21", halfLifeDays: 60 });
  assert.ok(fast.bias > slow.bias, "a short half-life tracks the recent regime");
  assert.ok(fast.bias > 1.8 && fast.bias <= 2);
  assert.ok(Math.abs(slow.bias - 1) < 0.2, "a long half-life averages both");
});

test("fitBias respects the window and the clamp", () => {
  const old = [{ date: "2026-01-01", rawCenter: 30, obs: 35 }];
  assert.equal(bias.fitBias(old, { asOf: "2026-08-21", windowDays: 30 }).n, 0, "stale pairs excluded");
  const wild = [{ date: "2026-08-20", rawCenter: 30, obs: 50 }];
  const f = bias.fitBias(wild, { asOf: "2026-08-21", clampTo: 4 });
  assert.equal(f.bias, 4, "never shifts the centre further than the clamp");
  assert.equal(f.biasUnclamped, 20);
});

test("fitBias is not ready on empty or unusable input", () => {
  assert.equal(bias.fitBias([], { asOf: "2026-08-21" }).ready, false);
  assert.equal(bias.fitBias(null, { asOf: "2026-08-21" }).ready, false);
  assert.equal(bias.fitBias([{ date: "2026-08-20", rawCenter: null, obs: 30 }], { asOf: "2026-08-21" }).n, 0);
  // A future-dated pair would be lookahead; it must not enter the fit.
  assert.equal(bias.fitBias([{ date: "2026-08-25", rawCenter: 30, obs: 31 }], { asOf: "2026-08-21" }).n, 0);
});

test("spreadHistory keeps only usable, in-window spreads", () => {
  const rows = [
    { date: "2026-08-20", ensSd: 1.1 }, { date: "2026-08-19", ensSd: null },
    { date: "2026-08-18", ensSd: 0 }, { date: "2026-01-01", ensSd: 2.0 },
  ];
  assert.deepEqual(bias.spreadHistory(rows, { asOf: "2026-08-21", windowDays: 60 }), [1.1]);
  assert.deepEqual(bias.spreadHistory([], {}), []);
});

test("spreadTracks keeps the two dispersion scales apart", () => {
  // Seeded rows carry only detSd (historical ensemble members are not retrievable); live
  // rows carry both. Pooling them would take a median across two different scales.
  const rows = [
    { date: "2026-08-20", ensSd: 1.1, detSd: 0.4 },   // live
    { date: "2026-08-19", ensSd: null, detSd: 0.5 },  // seeded
    { date: "2026-08-18", ensSd: null, detSd: null },
    { date: "2026-01-01", ensSd: 9.9, detSd: 9.9 },   // out of window
  ];
  const t = bias.spreadTracks(rows, { asOf: "2026-08-21", windowDays: 60 });
  assert.deepEqual(t.ens, [1.1]);
  assert.deepEqual(t.det, [0.4, 0.5]);
  assert.deepEqual(bias.spreadTracks([], {}), { ens: [], det: [] });
});

test("daysBetween handles month boundaries", () => {
  assert.equal(bias.daysBetween("2026-08-31", "2026-09-01"), 1);
  assert.equal(bias.daysBetween("2026-08-10", "2026-08-15"), 5);
});
