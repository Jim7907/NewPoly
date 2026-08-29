const test = require("node:test");
const assert = require("node:assert");
const cfg = require("../server/config");

test("every station carries the fields the resolution pipeline branches on", () => {
  for (const s of Object.values(cfg.UNIVERSE)) {
    assert.ok(s.icao && s.tz && s.name, `${s.city} missing identity`);
    assert.ok(isFinite(s.lat) && isFinite(s.lon), `${s.city} missing coordinates`);
    assert.ok(["round", "floor"].includes(s.bucketRule), `${s.city} bucketRule`);
    assert.ok(["metar", "hko"].includes(s.obsSource), `${s.city} obsSource`);
    assert.ok(s.settleGraceDays > 0 && s.biasWindowDays > 0, `${s.city} settlement policy`);
    assert.ok(Intl.DateTimeFormat(undefined, { timeZone: s.tz }), `${s.city} bad timezone`);
  }
});

test("the 31 NOAA cities resolve on whole-degree METAR", () => {
  const metar = Object.values(cfg.UNIVERSE).filter(s => s.resolver === "metar");
  assert.equal(metar.length, 32);
  assert.ok(metar.every(s => s.bucketRule === "round" && s.obsSource === "metar"));
  // A handful of the non-obvious ones, since picking the wrong airport is the classic trap.
  assert.equal(cfg.UNIVERSE["London"].icao, "EGLC");      // City, not Heathrow
  assert.equal(cfg.UNIVERSE["Paris"].icao, "LFPB");       // Le Bourget, not CDG
  assert.equal(cfg.UNIVERSE["Taipei"].icao, "RCSS");      // Songshan, not Taoyuan
  assert.equal(cfg.UNIVERSE["Moscow"].icao, "UUWW");      // Vnukovo
});

test("Hong Kong keeps the settings that were established empirically", () => {
  const hk = cfg.UNIVERSE["Hong Kong"];
  // floor(T) matched 31/31 resolved HK markets; round(T) matched only 12/31. Flipping this
  // back to "round" would shift every bucket boundary half a degree.
  assert.equal(hk.bucketRule, "floor");
  // The HK Observatory HQ gauge in Tsim Sha Tsui, not VHHH airport ~26 km west: over July
  // 2026 the two differed by >=1 C on 13 of 31 days, worth ~0.74 C of bias.
  assert.equal(hk.obsSource, "hko");
  assert.ok(Math.abs(hk.lat - 22.302) < 0.01 && Math.abs(hk.lon - 114.174) < 0.01, "HQ, not the airport");
  assert.ok(hk.lon > 114, "airport is at 113.9 — a regression here silently re-points the station");
  // The Daily Extract publishes ~a month in arrears, so both the settle grace and the bias
  // window have to outrun the lag or HK is permanently uncalibrated / prematurely voided.
  assert.ok(hk.settleGraceDays >= 30, "short grace would void every HK basket before it resolves");
  assert.ok(hk.biasWindowDays >= 60, "short window leaves too few readable days to calibrate");
});

test("the tradable universe is the whole station table", () => {
  assert.equal(cfg.CITY_KEYS.length, 33);
  assert.ok(cfg.CITY_KEYS.includes("Hong Kong"));
  assert.ok(cfg.STATIONS.every(s => cfg.UNIVERSE[s.city] === s));
});
