const test = require("node:test");
const assert = require("node:assert");
const obs = require("../server/obs");

const csv = [
  "station,valid,tmpc",
  ...Array.from({ length: 20 }, (_, i) => `WSSS,2026-08-10 ${String(i).padStart(2, "0")}:00,${28 + (i % 5)}.00`),
  "WSSS,2026-08-10 20:00,32.40",
  "WSSS,2026-08-10 21:00,M",
  "WSSS,2026-08-11 12:00,33.00",
].join("\n");

test("parseAsosCsv drops missing readings and coerces numbers", () => {
  const rows = obs.parseAsosCsv(csv);
  assert.equal(rows.length, 22, "20 synthetic + the 32.4 + the next day; 'M' dropped");
  assert.equal(typeof rows[0].tmpc, "number");
  assert.deepEqual(obs.parseAsosCsv(""), []);
  assert.deepEqual(obs.parseAsosCsv("station,valid,tmpc"), []);
});

test("dailyExtreme rounds each reading first — that is the column the market resolves on", () => {
  const rows = obs.parseAsosCsv(csv);
  // 32.40 rounds to 32, which beats every other reading that day.
  assert.equal(obs.dailyExtreme(rows, "2026-08-10", "high").value, 32);
  assert.equal(obs.dailyExtreme(rows, "2026-08-10", "low").value, 28);
});

test("dailyExtreme refuses to resolve a day it barely observed", () => {
  const rows = obs.parseAsosCsv(csv);
  assert.equal(obs.dailyExtreme(rows, "2026-08-11", "high"), null, "1 reading is not a day");
  assert.equal(obs.dailyExtreme(rows, "2026-08-11", "high", 1).value, 33);
  assert.equal(obs.dailyExtreme(rows, "2026-01-01", "high", 1), null);
});

test("parseHkoCsv reads the HK Observatory daily extract and drops flagged rows", () => {
  const csv = [
    '"Daily Maximum Temperature (°C) at the Hong Kong Observatory"',
    "Year,Month,Day,Value,Completeness",
    "2026,7,29,27.9,C",
    "2026,7,30,28.8,C",
    "2026,7,31,27.6,#",      // incomplete
    "2026,7,28,***,*",       // unavailable
    "2026,8,1,30.0,C",       // different month
  ].join("\n");
  assert.deepEqual(obs.parseHkoCsv(csv, 2026, 7), { "2026-07-29": 27.9, "2026-07-30": 28.8 });
  assert.deepEqual(obs.parseHkoCsv("", 2026, 7), {});
  // The published value keeps its 0.1 C precision — that precision is the whole reason
  // Hong Kong needs the floor bucket rule rather than the METAR round rule.
  const one = obs.parseHkoCsv("2026,1,5,-1.4,C", 2026, 1);
  assert.equal(one["2026-01-05"], -1.4);
});

test("localDateOf projects a METAR timestamp into the station's local day", () => {
  const t = Math.floor(Date.parse("2026-08-24T02:30:00Z") / 1000);
  assert.equal(obs.localDateOf(t, "Asia/Singapore"), "2026-08-24");
  assert.equal(obs.localDateOf(t, "America/New_York"), "2026-08-23");
  assert.equal(obs.localDateOf(t, "Pacific/Auckland"), "2026-08-24");
});

test("metarRowsToObs converts the aviationweather payload into obs rows", () => {
  const t = Math.floor(Date.parse("2026-08-24T02:30:00Z") / 1000);
  const rows = obs.metarRowsToObs([
    { icaoId: "WSSS", obsTime: t, temp: 30 },
    { icaoId: "WSSS", obsTime: t, temp: null },
  ], "Asia/Singapore");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tmpc, 30);
  assert.ok(rows[0].valid.startsWith("2026-08-24"));
});
