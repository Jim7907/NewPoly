// Optional Claude "analyst": reads the qualitative evidence the quantitative stack is weakest at
// (headlines, fundamentals in context, macro backdrop) and returns ONE extra signal (family "llm")
// plus a narrative (bull/bear case, risks, catalysts) for the dashboard.
//
// Design notes:
//   • It is deliberately NOT the decision-maker. Its score enters the ensemble like any other
//     family, with a modest prior weight that the online WeightLearner can raise or lower once
//     its track record exists. (Lopez-Lira & Tang 2023 find LLM headline reads carry signal, but
//     they're also correlated with what's already in price — so we don't let it dominate.)
//   • It never sees the ensemble's verdict, so it can't just echo it back.
//   • Off the hot path: results are cached per asset for LLM_TTL_MS and calls are serialized.
//   • Fully optional: without ANTHROPIC_API_KEY (or with LLM_ENABLED=false) it returns null.
const cfg = require("../config");

let client = null;
function getClient() {
  if (client) return client;
  if (!cfg.ANTHROPIC_API_KEY || !cfg.LLM_ENABLED) return null;
  const Anthropic = require("@anthropic-ai/sdk").default;
  client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
  return client;
}

const enabled = () => !!(cfg.ANTHROPIC_API_KEY && cfg.LLM_ENABLED);

// Stable system prompt (kept byte-identical across calls so the prefix caches).
const SYSTEM = `You are a senior buy-side analyst covering US equities and crypto assets. You are one input
into a quantitative decision engine that already models price trends, momentum, volatility, order flow,
funding rates and accounting ratios. Your job is the part those models handle poorly: judging what the
news flow, the fundamental picture in context, and the macro backdrop imply for the asset's direction
over the stated horizon.

Be calibrated and sceptical. Most headlines are noise or already priced in, so a score near 0 with low
confidence is the right answer whenever the evidence is thin, stale, mixed or generic. Reserve |score| > 0.5
for clear, material, recent, asset-specific information (earnings surprise, guidance change, regulatory
action, hack/exploit, major product or partnership, M&A, index inclusion, ETF flows). Distinguish
information that is new from information that is already reflected in recent price moves. Never invent
facts that are not in the provided data; if something important is missing, say so in the risks.

score: your directional view in [-1, 1] for the horizon (+1 = strongly bullish).
confidence: in [0, 1], how much weight your view deserves given the quality of the evidence.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "confidence", "narrative", "bull_case", "bear_case", "key_risks", "catalysts", "news_assessment"],
  properties: {
    score:           { type: "number" },
    confidence:      { type: "number" },
    narrative:       { type: "string", description: "3-5 sentence synthesis for a trader." },
    bull_case:       { type: "array", items: { type: "string" } },
    bear_case:       { type: "array", items: { type: "string" } },
    key_risks:       { type: "array", items: { type: "string" } },
    catalysts:       { type: "array", items: { type: "string" } },
    news_assessment: { type: "string", description: "Is the news flow new, material, or already priced in?" },
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (a, b) => (a > 0 && b > 0 ? +((a / b - 1) * 100).toFixed(2) : null);

// Build a compact, factual evidence packet. Numbers only where they help; no model verdicts.
function buildContext(asset, g, horizon) {
  const c = g.candles || [];
  const last = c[c.length - 1];
  const at = (k) => (c.length > k ? c[c.length - 1 - k].c : null);
  const priceCtx = last ? {
    last: last.c, asOf: new Date(last.t).toISOString(),
    ret_1bar_pct: pct(last.c, at(1)), ret_5bar_pct: pct(last.c, at(5)),
    ret_20bar_pct: pct(last.c, at(20)), ret_60bar_pct: pct(last.c, at(60)),
  } : null;

  const f = g.fundamentals || null;
  const fund = f ? Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && typeof v !== "object")) : null;

  const lastOf = (s) => (Array.isArray(s) && s.length ? s[s.length - 1].v : null);
  const m = g.macro || {};
  const macro = { vix: lastOf(m.vix), us10y: lastOf(m.dgs10), curve_10y2y: lastOf(m.t10y2y), usd_index: lastOf(m.dxy), hy_oas: lastOf(m.hyOas) };

  const headlines = (g.news || []).slice(0, 25).map(h => ({
    title: h.title, source: h.source, ageHours: h.ts ? +((Date.now() - new Date(h.ts).getTime()) / 3.6e6).toFixed(1) : null,
  }));

  return {
    asset: { symbol: asset.symbol, name: asset.name, class: asset.assetClass, etf: !!asset.etf },
    horizon, price: priceCtx, fundamentals: fund, macro,
    derivatives: g.derivatives ? { fundingRate: g.derivatives.fundingRate, openInterest: g.derivatives.openInterest } : undefined,
    fearGreed: g.fearGreed ? { value: g.fearGreed.value, classification: g.fearGreed.classification } : undefined,
    social: g.social ? { bullish: g.social.bullish, bearish: g.social.bearish, total: g.social.total } : undefined,
    headlines,
  };
}

const cache = new Map();   // assetId -> { ts, result }
let chain = Promise.resolve(); // serialize calls (rate + cost control)
const inflight = new Map();    // key -> promise (de-dupe concurrent refreshes)

async function callClaude(context) {
  const c = getClient();
  const resp = await c.beta.messages.create({
    model: cfg.LLM_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: cfg.LLM_EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: `Evidence packet (JSON):\n${JSON.stringify(context)}\n\nAssess the ${context.horizon} outlook for ${context.asset.symbol}.`,
    }],
  });
  if (resp.stop_reason === "refusal") throw new Error(`refused (${resp.stop_details?.category || "unknown"})`);
  const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("");
  return { parsed: JSON.parse(text), model: resp.model };
}

// Returns { signal, narrative, bullCase, bearCase, risks, catalysts, newsAssessment, model, ts } or null.
async function analyze(asset, gathered, { horizon = cfg.HORIZON, force = false } = {}) {
  if (!enabled()) return null;
  const key = `${asset.id}|${horizon}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.ts < cfg.LLM_TTL_MS) return hit.result;
  if (inflight.has(key)) return inflight.get(key);

  const run = chain.then(async () => {
    try {
      const { parsed: o, model } = await callClaude(buildContext(asset, gathered, horizon));
      const score = clamp(Number(o.score) || 0, -1, 1);
      const confidence = clamp(Number(o.confidence) || 0, 0, 1);
      const result = {
        signal: {
          id: "llm.analyst.view", family: "llm", score, confidence, horizon,
          value: { model, score, confidence },
          reason: `Claude analyst: ${o.news_assessment || o.narrative || ""}`.slice(0, 300),
        },
        narrative: o.narrative, bullCase: o.bull_case || [], bearCase: o.bear_case || [],
        risks: o.key_risks || [], catalysts: o.catalysts || [], newsAssessment: o.news_assessment,
        model, ts: new Date().toISOString(),
      };
      cache.set(key, { ts: Date.now(), result });
      return result;
    } catch (e) {
      console.error(`[llm] ${asset.symbol}:`, e.message);
      cache.set(key, { ts: Date.now() - cfg.LLM_TTL_MS + 5 * 60 * 1000, result: hit?.result || null }); // back off 5 min
      return hit?.result || null;
    }
  });
  chain = run.catch(() => {});
  inflight.set(key, run);
  run.finally(() => inflight.delete(key));
  return run;
}

// Non-blocking accessor for the real-time loop: returns the cached result immediately and
// refreshes in the background when stale.
function cachedOrRefresh(asset, gathered, opts = {}) {
  if (!enabled()) return null;
  const key = `${asset.id}|${opts.horizon || cfg.HORIZON}`;
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.ts >= cfg.LLM_TTL_MS) analyze(asset, gathered, opts).catch(() => {});
  return hit?.result || null;
}

module.exports = { analyze, cachedOrRefresh, enabled, buildContext, SCHEMA };
