const test = require("node:test");
const assert = require("node:assert");
const wx = require("../server/wx");

const hourly = {
  time: ["2026-08-24T00:00", "2026-08-24T14:00", "2026-08-24T18:00", "2026-08-25T13:00", "2026-08-25T15:00"],
  temperature_2m_ecmwf_ifs025_ensemble:          [24.0, 31.4, 29.0, 30.0, 28.0],
  temperature_2m_member01_ecmwf_ifs025_ensemble: [23.5, 32.1, 28.5, 29.4, 27.5],
  temperature_2m_member01_gfs025_ensemble:       [25.0, 30.2, 27.0, 31.0, 30.5],
};

test("parseSeriesKeys separates control run from numbered members", () => {
  const keys = wx.parseSeriesKeys(hourly);
  assert.equal(keys.length, 3);
  const ctrl = keys.find(k => k.key.endsWith("ecmwf_ifs025_ensemble") && !k.key.includes("member"));
  assert.equal(ctrl.member, 0, "the control run has no _memberNN suffix");
  assert.equal(keys.find(k => k.key.includes("member01_gfs")).model, "gfs025_ensemble");
  assert.deepEqual(wx.parseSeriesKeys({ time: [], other_field: [] }), []);
});

test("extremeByDate reduces to one value per LOCAL day, per kind", () => {
  const hi = wx.extremeByDate(hourly.time, hourly.temperature_2m_ecmwf_ifs025_ensemble, "high");
  assert.deepEqual(hi, { "2026-08-24": 31.4, "2026-08-25": 30.0 });
  const lo = wx.extremeByDate(hourly.time, hourly.temperature_2m_ecmwf_ifs025_ensemble, "low");
  assert.deepEqual(lo, { "2026-08-24": 24.0, "2026-08-25": 28.0 });
});

test("extremeByDate skips nulls without dropping the day", () => {
  const r = wx.extremeByDate(["2026-08-24T00:00", "2026-08-24T14:00"], [null, 30.5], "high");
  assert.deepEqual(r, { "2026-08-24": 30.5 });
  assert.deepEqual(wx.extremeByDate(["2026-08-24T00:00"], [null], "high"), {});
});

test("membersByDate collects every member's own daily extreme", () => {
  const r = wx.membersByDate(hourly, "high");
  assert.deepEqual(r["2026-08-24"].members.sort(), [30.2, 31.4, 32.1]);
  assert.equal(r["2026-08-24"].byModel.ecmwf_ifs025_ensemble.length, 2);
  assert.equal(r["2026-08-24"].byModel.gfs025_ensemble.length, 1);
});

test("deterministicByDate keys the multi-model response by model", () => {
  const det = wx.deterministicByDate({
    time: ["2026-08-24T13:00", "2026-08-24T14:00"],
    temperature_2m_ecmwf_ifs025: [30.0, 31.0],
    temperature_2m_gfs_seamless: [30.5, 30.2],
  }, "high");
  assert.deepEqual(det["2026-08-24"], { ecmwf_ifs025: 31.0, gfs_seamless: 30.5 });
});

test("combine blends the high-res deterministic centre with the ensemble mean", () => {
  const c = wx.combine({ members: [30, 31, 32], byModel: { ecmwf: [30, 31], gfs: [32] }, det: { a: 31, b: 31.4 } }, 0.65);
  assert.equal(c.ensMean, 31);
  assert.equal(c.detMean, 31.2);
  assert.ok(Math.abs(c.rawCenter - (0.65 * 31.2 + 0.35 * 31)) < 1e-3);
  assert.ok(c.ensSd > 0);
  assert.equal(c.nMembers, 3);
  assert.equal(c.detSpread, 0.4);
});

test("combine degrades gracefully when one source is missing", () => {
  assert.equal(wx.combine({ members: [30, 31], byModel: {}, det: null }, 0.65).rawCenter, 30.5);
  assert.equal(wx.combine({ members: [], byModel: {}, det: { a: 29 } }, 0.65).rawCenter, 29);
  assert.equal(wx.combine({ members: [], byModel: {}, det: null }, 0.65).rawCenter, null);
});
