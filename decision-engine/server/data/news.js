// News + social (§3.4).
//   • headlines(asset): Google News RSS search (regex XML parsing, no deps).
//   • social(asset)   : StockTwits symbol stream — user-tagged Bullish/Bearish counts.
const { api, text, get, limiters } = require("./http");

const GNEWS = "https://news.google.com/rss/search";
const STOCKTWITS = "https://api.stocktwits.com/api/2/streams/symbol";

// ── Pure parsers (exported for tests) ──────────────────────────
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decodeEntities(s) {
  let out = String(s ?? "");
  // Two passes: RSS descriptions are often double-escaped (&amp;nbsp;).
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
      }
      const k = e.toLowerCase();
      return k in NAMED ? NAMED[k] : m;
    });
  }
  return out;
}
function tagText(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return null;
  let v = m[1].trim();
  const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cd) return cd[1].trim();                                // CDATA is literal — no entity decoding
  return decodeEntities(v).trim();
}
const stripTags = s => String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** RSS 2.0 XML → [{title, source, ts(ms), url}] newest-first, de-duplicated by title. */
function parseRss(xml) {
  const items = String(xml || "").match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    let title = stripTags(tagText(it, "title") || "");
    const source = stripTags(tagText(it, "source") || "") || null;
    // Google appends " - Publisher" to titles; drop it when it matches the <source>.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = Date.parse(tagText(it, "pubDate") || "") || null;
    out.push({ title, source, ts, url: tagText(it, "link") || null });
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/** StockTwits stream JSON → { bullish, bearish, total, messages:[{t, body, sentiment, user, likes}] }. */
function parseStockTwits(json) {
  const msgs = Array.isArray(json?.messages) ? json.messages : null;
  if (!msgs) return null;
  let bullish = 0, bearish = 0;
  const messages = msgs.map(m => {
    const s = m?.entities?.sentiment?.basic || null;
    if (s === "Bullish") bullish++; else if (s === "Bearish") bearish++;
    return {
      t: Date.parse(m?.created_at) || null, body: decodeEntities(String(m?.body || "")).slice(0, 280),
      sentiment: s ? s.toLowerCase() : null, user: m?.user?.username || null, likes: m?.likes?.total || 0,
    };
  });
  return { bullish, bearish, total: msgs.length, watchlistCount: json?.symbol?.watchlist_count ?? null, messages };
}

// ── Fetchers ───────────────────────────────────────────────────
function newsQuery(asset) {
  if (asset.assetClass === "crypto") return `${asset.name && asset.name !== asset.symbol ? asset.name : asset.symbol} crypto`;
  return asset.etf ? `${asset.symbol} ETF` : `${asset.symbol} stock`;
}

async function headlines(asset, { days = 7 } = {}) {
  try {
    const q = encodeURIComponent(`${newsQuery(asset)} when:${days}d`);
    const xml = await get(text, `${GNEWS}?q=${q}&hl=en-US&gl=US&ceid=US:en`, { limiter: limiters.google, retries: 1 });
    return parseRss(xml).slice(0, 60);
  } catch { return []; }
}

async function social(asset) {
  const sym = asset.assetClass === "crypto" ? `${asset.symbol}.X` : asset.symbol;
  try { return parseStockTwits(await get(api, `${STOCKTWITS}/${encodeURIComponent(sym)}.json`, { limiter: limiters.stocktwits, retries: 1 })); }
  catch { return null; }
}

module.exports = { headlines, social, parseRss, parseStockTwits, decodeEntities, newsQuery };
