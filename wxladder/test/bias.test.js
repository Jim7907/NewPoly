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


test("bias pools across leads while sigma stays lead-specific", () => {
  // A station offset is a representativeness error (grid cell vs the real gauge), so it does
  // not depend on forecast lead. Measured over 7 stations: pooled bias +1.26 at lead 1 vs
  // +1.28 at lead 2. Pooling is therefore valid and buys ~3x the samples.
  const mk = (date, lead, err) => ({ date, leadDays: lead, rawCenter: 20, obs: 20 + err });
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(mk(`2026-08-${String(10 + i).padStart(2, "0")}`, 1, 2));
  for (let i = 0; i < 3; i++)  rows.push(mk(`2026-08-${String(10 + i).padStart(2, "0")}`, 2, 2));
  const opts = { asOf: "2026-08-22", windowDays: 30, halfLifeDays: 999, minLeadPairs: 10, sigmaGrowth: 1.20 };

  const lead1 = bias.fitBias(rows, { ...opts, targetLead: 1 });
  const lead2 = bias.fitBias(rows, { ...opts, targetLead: 2 });

  // Same pooled bias at both leads — the offset is shared.
  assert.ok(Math.abs(lead1.bias - 2) < 1e-6);
  assert.ok(Math.abs(lead2.bias - lead1.bias) < 1e-9, "bias must not depend on the target lead");
  assert.equal(lead1.n, lead2.n, "both fits see every lead's pairs");

  // Lead 1 has enough of its own pairs to measure sigma; lead 2 does not and is inflated.
  assert.equal(lead1.sigmaSource, "measured-at-lead");
  assert.equal(lead1.leadN, 12);
  assert.equal(lead2.sigmaSource, "inflated-from-pooled");
  assert.equal(lead2.leadN, 3);
  assert.ok(lead2.sd >= lead1.sd, "a thinly-sampled longer lead is never MORE confident");
});

test("a lead with enough pairs measures its own sigma instead of inflating", () => {
  const rows = [];
  // Lead 1 tight, lead 2 genuinely wider — both well sampled.
  for (let i = 0; i < 14; i++) rows.push({ date: `2026-08-${String(1 + i).padStart(2, "0")}`, leadDays: 1, rawCenter: 20, obs: 20 + (i % 2 ? 0.2 : -0.2) });
  for (let i = 0; i < 14; i++) rows.push({ date: `2026-08-${String(1 + i).padStart(2, "0")}`, leadDays: 2, rawCenter: 20, obs: 20 + (i % 2 ? 2.0 : -2.0) });
  const opts = { asOf: "2026-08-20", windowDays: 40, halfLifeDays: 999, minLeadPairs: 10, sigmaGrowth: 1.05 };
  const l1 = bias.fitBias(rows, { ...opts, targetLead: 1 });
  const l2 = bias.fitBias(rows, { ...opts, targetLead: 2 });
  assert.equal(l1.sigmaSource, "measured-at-lead");
  assert.equal(l2.sigmaSource, "measured-at-lead");
  assert.ok(l1.sd < 0.5 && l2.sd > 1.5, "each lead reports its OWN spread, not the pool's");
  assert.ok(l2.sd > l2.sdPooled, "measurement beats the inflation heuristic when available");
});

test("omitting targetLead keeps the original pooled behaviour", () => {
  const rows = [{ date: "2026-08-20", leadDays: 1, rawCenter: 20, obs: 21 },
                { date: "2026-08-19", leadDays: 2, rawCenter: 20, obs: 23 }];
  const f = bias.fitBias(rows, { asOf: "2026-08-21", halfLifeDays: 999 });
  assert.equal(f.sigmaSource, "pooled");
  assert.equal(f.targetLead, null);
  assert.ok(Math.abs(f.sd - f.sdPooled) < 1e-9);
});

test("sigma is inflated while the fit is seeded, and relaxes as live pairs arrive", () => {
  // Seeded pairs come from the historical-forecast archive, which stores a SHORT-LEAD forecast.
  // Measured true-D+1 sd / archived sd = 1.90 / 2.31 / 2.53 at EDDM, LFPB, EGLC — so a fit
  // dominated by seeded rows understates live uncertainty by roughly 2.3x.
  const mk = (i, nMembers) => ({ date: `2026-08-${String(1 + i).padStart(2, "0")}`,
    rawCenter: 20 + (i % 2 ? 0.5 : -0.5), obs: 21, leadDays: 1, nMembers });
  const opts = { asOf: "2026-08-25", windowDays: 40, halfLifeDays: 999, seededInflate: 2.3 };

  const seeded = bias.fitBias(Array.from({ length: 20 }, (_, i) => mk(i, 0)), opts);
  const live = bias.fitBias(Array.from({ length: 20 }, (_, i) => mk(i, 50)), opts);
  const half = bias.fitBias(Array.from({ length: 20 }, (_, i) => mk(i, i < 10 ? 0 : 50)), opts);

  assert.equal(seeded.seededFrac, 1);
  assert.equal(live.seededFrac, 0);
  assert.equal(seeded.sigmaInflate, 2.3);
  assert.equal(live.sigmaInflate, 1);
  assert.ok(Math.abs(half.sigmaInflate - 1.65) < 1e-6, "inflation scales with the seeded share");
  assert.ok(seeded.sd > live.sd, "a seeded fit must not claim live-quality confidence");
  assert.ok(Math.abs(seeded.sd / live.sd - 2.3) < 1e-6);

  // The bias itself is untouched — only the uncertainty around it.
  assert.ok(Math.abs(seeded.bias - live.bias) < 1e-9);
  // Opting out restores the raw residual.
  assert.equal(bias.fitBias(Array.from({ length: 20 }, (_, i) => mk(i, 0)), { ...opts, seededInflate: 1 }).sigmaInflate, 1);
});

test("the fit reports the raw-forecast distribution the regime guard needs", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    date: `2026-08-${String(1 + i).padStart(2, "0")}`, rawCenter: 25 + i, obs: 26 + i, leadDays: 1, nMembers: 40,
  }));
  const f = bias.fitBias(rows, { asOf: "2026-08-20", windowDays: 40, halfLifeDays: 999 });
  assert.ok(Math.abs(f.rawMean - 30.5) < 0.01, `rawMean ${f.rawMean}`);
  assert.ok(f.rawSd > 3 && f.rawSd < 4, `rawSd ${f.rawSd}`);
  // A single pair cannot define a spread, so the guard must stay off rather than divide by zero.
  const one = bias.fitBias([rows[0]], { asOf: "2026-08-20", windowDays: 40 });
  assert.equal(one.rawSd, null);
});
