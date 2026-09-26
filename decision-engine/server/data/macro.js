// Macro series (§3.5) from FRED's keyless CSV endpoint. Missing observations ("." or "") skipped.
// NB: FRED drops connections that present a browser User-Agent from this network — use a plain one.
const { text, get, limiters } = require("./http");

const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const SERIES = { vix: "VIXCLS", dgs10: "DGS10", t10y2y: "T10Y2Y", dxy: "DTWEXBGS", hyOas: "BAMLH0A0HYM2" };
const KEEP = 300;

/** FRED CSV ("observation_date,SERIES\n2025-06-02,18.36\n2025-06-03,.") → [{t(ms UTC), v}] ascending. */
function parseFredCsv(csv) {
  const out = [];
  for (const line of String(csv || "").split(/\r?\n/)) {
    const m = /^(\d{4})-(\d{2})-(\d{2}),\s*([^,]*)\s*$/.exec(line.trim());
    if (!m) continue;
    const raw = m[4].trim();
    if (raw === "" || raw === ".") continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out.push({ t: Date.UTC(+m[1], +m[2] - 1, +m[3]), v });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function series(id, keep = KEEP) {
  // ~300 business days ≈ 14.5 months; ask for 16 months to be safe.
  const cosd = new Date(Date.now() - 16 * 31 * 86400000).toISOString().slice(0, 10);
  try {
    const csv = await get(text, `${FRED}?id=${id}&cosd=${cosd}`, { limiter: limiters.fred, retries: 2, headers: { "User-Agent": "decision-engine/1.0 (+research)" } });
    return parseFredCsv(csv).slice(-keep);
  } catch { return []; }
}

/** snapshot() → { vix, dgs10, t10y2y, dxy, hyOas } each [{t, v}] (possibly []). */
async function snapshot() {
  const keys = Object.keys(SERIES);
  const vals = await Promise.all(keys.map(k => series(SERIES[k])));
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

module.exports = { snapshot, series, parseFredCsv, SERIES };
