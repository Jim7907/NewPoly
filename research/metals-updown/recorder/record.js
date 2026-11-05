// Tick recorder for Polymarket gold/silver 15m Up-or-Down research. Read-only; places no orders.
// Streams, each line written as JSON to data/<UTC date>.jsonl:
//   src=cl    Chainlink XAU/USD, XAG/USD 1s prices via Polymarket RTDS (`equity_prices`, the settlement feed)
//   src=hl    Hyperliquid xyz:GOLD / xyz:SILVER best bid/offer + trades
//   src=clob  Polymarket CLOB market channel (book / price_change / best_bid_ask / last_trade_price)
//   src=win   window metadata (slug, token ids) each time the live windows roll
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 0); // 0 = run forever
fs.mkdirSync(DATA_DIR, { recursive: true });

const ASSETS = [
  { key: "XAU", slug: "xau-updown-15m", cl: "xauusd", hl: "xyz:GOLD" },
  { key: "XAG", slug: "xag-updown-15m", cl: "xagusd", hl: "xyz:SILVER" },
];

let out = null, outDay = "";
function write(src, obj) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== outDay) { if (out) out.end(); out = fs.createWriteStream(path.join(DATA_DIR, `${day}.jsonl`), { flags: "a" }); outDay = day; }
  out.write(JSON.stringify({ src, r: now, ...obj }) + "\n");
}

// Reconnecting websocket helper.
function keep(name, url, onOpen, onMsg, pingFrame, pingMs) {
  let ws, pinger, backoff = 1000, closedByUs = false;
  const connect = () => {
    ws = new WebSocket(url);
    ws.on("open", () => { backoff = 1000; write("sys", { ev: "open", name }); onOpen(ws);
      if (pingFrame) pinger = setInterval(() => { try { ws.send(pingFrame); } catch {} }, pingMs); });
    ws.on("message", (m) => { const s = m.toString(); if (s === "PONG" || s === "") return; onMsg(s); });
    ws.on("close", (c) => { clearInterval(pinger); write("sys", { ev: "close", name, code: c });
      if (!closedByUs) setTimeout(connect, backoff = Math.min(backoff * 2, 30000)); });
    ws.on("error", (e) => { write("sys", { ev: "error", name, msg: e.message }); try { ws.close(); } catch {} });
  };
  connect();
  return { restart: () => { try { ws.close(); } catch {} }, stop: () => { closedByUs = true; try { ws.close(); } catch {} } };
}

// ── Chainlink via RTDS (one connection per symbol: RTDS honours one equity subscription per socket) ──
const cls = ASSETS.map(a => keep(`rtds-${a.cl}`, "wss://ws-live-data.polymarket.com",
  (ws) => ws.send(JSON.stringify({ action: "subscribe", subscriptions: [{
    topic: "equity_prices", type: "update", filters: JSON.stringify({ symbol: a.cl }) }] })),
  (s) => { try { const m = JSON.parse(s); const p = m.payload || {};
    if (p.symbol) write("cl", { sym: p.symbol, ts: p.timestamp, v: p.full_accuracy_value ?? p.value });
    else if (Array.isArray(p.data)) write("cl_snap", { sym: a.cl, data: p.data }); } catch {} },
  "PING", 5000));

// ── Hyperliquid ──
const hl = keep("hl", "wss://api.hyperliquid.xyz/ws",
  (ws) => { for (const a of ASSETS) for (const type of ["bbo", "trades"])
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type, coin: a.hl } })); },
  (s) => { try { const m = JSON.parse(s);
    if (m.channel === "bbo") { const d = m.data, b = d.bbo || [];
      write("hl", { k: "bbo", coin: d.coin, t: d.time, bid: b[0]?.px, ask: b[1]?.px, bsz: b[0]?.sz, asz: b[1]?.sz }); }
    else if (m.channel === "trades") for (const t of m.data) write("hl", { k: "trade", coin: t.coin, t: t.time, px: t.px, sz: t.sz, side: t.side });
  } catch {} },
  JSON.stringify({ method: "ping" }), 30000);

// ── Polymarket CLOB books for the live windows ──
let assetIds = [];
const clob = keep("clob", "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  (ws) => { if (assetIds.length) ws.send(JSON.stringify({ assets_ids: assetIds, type: "market", custom_feature_enabled: true })); },
  (s) => { try { const m = JSON.parse(s); for (const e of Array.isArray(m) ? m : [m]) write("clob", e); } catch {} },
  "PING", 10000);

async function getJson(url) { const r = await fetch(url, { headers: { "User-Agent": "metals-recorder/1.0" } }); return r.json(); }
async function rollWindows() {
  const t0 = Math.floor(Date.now() / 1000 / 900) * 900;
  const ids = [];
  for (const a of ASSETS) for (const start of [t0, t0 + 900]) {
    try {
      const e = await getJson(`https://gamma-api.polymarket.com/events/slug/${a.slug}-${start}`);
      const m = (e.markets || [])[0]; if (!m) continue;
      const tok = JSON.parse(m.clobTokenIds);
      write("win", { asset: a.key, start, slug: e.slug, cid: m.conditionId, up: tok[0], down: tok[1], meta: e.eventMetadata || null });
      if (start === t0) ids.push(...tok);
    } catch (err) { write("sys", { ev: "gamma_error", msg: String(err) }); }
  }
  if (ids.length && ids.join() !== assetIds.join()) { assetIds = ids; clob.restart(); }
}
rollWindows();
// Re-discover a few seconds after every 15-minute boundary (and record metadata of the window that just closed).
setInterval(() => { const s = Math.floor(Date.now() / 1000) % 900; if (s === 3 || s === 120) rollWindows(); }, 1000);

if (RUN_SECONDS > 0) setTimeout(() => { cls.forEach(c => c.stop()); hl.stop(); clob.stop(); if (out) out.end(); setTimeout(() => process.exit(0), 500); }, RUN_SECONDS * 1000);
process.on("SIGINT", () => { if (out) out.end(); process.exit(0); });
