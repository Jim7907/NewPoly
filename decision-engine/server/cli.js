// One-shot analysis from the terminal:
//   npm run analyze -- BTC            (crypto symbols in the universe are auto-detected)
//   npm run analyze -- NVDA --horizon position --json
//   npm run analyze -- AAPL --deep    (forces a fresh Claude analyst read if ANTHROPIC_API_KEY is set)
const cfg = require("./config");
const db = require("./db");
const engine = require("./engine");
const { adHocAsset } = require("./index");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? "--" : `${(x * 100).toFixed(d)}%`);

async function main() {
  const symbols = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--horizon", "--class"].includes(args[i - 1])));
  if (!symbols.length) { console.log("usage: npm run analyze -- <SYMBOL...> [--class crypto|stock] [--horizon intraday|swing|position] [--deep] [--json]"); process.exit(1); }
  await db.initDB({ memory: true });
  engine.loadState();
  const horizon = opt("horizon", cfg.HORIZON);
  for (const sym of symbols) {
    const cls = opt("class", cfg.CRYPTO_UNIVERSE[sym.toUpperCase()] ? "crypto" : "stock");
    const asset = adHocAsset(sym, cls);
    const t0 = Date.now();
    const d = await engine.evaluate(asset, { horizon, forceLLM: flag("deep") });
    if (flag("json")) { console.log(JSON.stringify(d, null, 2)); continue; }
    console.log(`\n══ ${asset.symbol} (${cls}) — ${horizon} ══  [${Date.now() - t0} ms, ${d.signals?.length || 0} signals]`);
    console.log(d.summary);
    console.log(`\n  action ${d.action}  P(up) ${pct(d.pUp)}  raw ${pct(d.pRaw)}  confidence ${pct(d.confidence)}  agreement ${pct(d.agreement)}  coverage ${pct(d.coverage)}`);
    if (d.abstainReason) console.log(`  abstain: ${d.abstainReason}`);
    console.log("  families:");
    for (const [f, v] of Object.entries(d.families || {})) console.log(`    ${f.padEnd(15)} score ${(v.score ?? 0).toFixed(2).padStart(6)}  n=${v.n ?? "-"}`);
    console.log("  drivers:");
    for (const s of d.drivers || []) console.log(`    + ${s.id.padEnd(34)} ${s.reason}`);
    for (const s of d.against || []) console.log(`    − ${s.id.padEnd(34)} ${s.reason}`);
    if (d.llm?.narrative) console.log(`  analyst: ${d.llm.narrative}`);
    if (d.analyzerErrors) console.log("  analyzer errors:", d.analyzerErrors.join("; "));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
