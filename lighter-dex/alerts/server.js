// Telegram alerts for the Lighter trading frontend. Zero dependencies (Node 20+).
//
//  - Browser keeps a random secret "code"; user opens t.me/<bot>?start=<code> once to link
//    their Telegram chat to it. The code then owns that user's alerts.
//  - Every CHECK_MS the server reads Lighter mark prices (and watched accounts) and
//    sends Telegram messages for price crosses and positions close to liquidation.
//
// Env: TELEGRAM_BOT_TOKEN (required to enable), LIGHTER_NETWORK=mainnet|testnet,
//      PORT=8080, DATA_DIR=./data, CHECK_MS=10000
import http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LIMITS, describeAlert, isValidCode, liqWarnings, parseAlertRequest, priceAlertHit } from './logic.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // overridable for tests
const NETWORK = process.env.LIGHTER_NETWORK || process.env.VITE_LIGHTER_NETWORK || 'testnet';
const LIGHTER = NETWORK === 'mainnet' ? 'https://mainnet.zklighter.elliot.ai' : 'https://testnet.zklighter.elliot.ai';
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || './data';
const CHECK_MS = Number(process.env.CHECK_MS || 10000);
const DB_FILE = join(DATA_DIR, 'alerts.json');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- storage ----------------
mkdirSync(DATA_DIR, { recursive: true });
let db = { links: {}, alerts: [], lastFired: {} };
try {
  db = { ...db, ...JSON.parse(readFileSync(DB_FILE, 'utf8')) };
} catch { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFileSync(`${DB_FILE}.tmp`, JSON.stringify(db));
    renameSync(`${DB_FILE}.tmp`, DB_FILE);
  }, 200);
}

// ---------------- telegram ----------------
let botUsername = null;

async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

const send = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }).catch((e) => log('send failed', e.message));

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || !msg.chat) continue;
        await handleCommand(msg.chat.id, msg.text.trim());
      }
    } catch (e) {
      log('poll error', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handleCommand(chatId, text) {
  const [cmd, arg] = text.split(/\s+/, 2);
  if (cmd === '/start' && isValidCode(arg)) {
    db.links[arg] = { chatId, linkedAt: Date.now() };
    save();
    return send(chatId, '✅ Linked! You will get your trading alerts here.\n\n/list – your alerts\n/stop – unlink and delete all alerts');
  }
  if (cmd === '/list') {
    const codes = Object.entries(db.links).filter(([, l]) => l.chatId === chatId).map(([c]) => c);
    const mine = db.alerts.filter((a) => codes.includes(a.code));
    return send(chatId, mine.length ? mine.map((a) => `• ${describeAlert(a)}`).join('\n') : 'No alerts set.');
  }
  if (cmd === '/stop') {
    const codes = Object.entries(db.links).filter(([, l]) => l.chatId === chatId).map(([c]) => c);
    for (const c of codes) delete db.links[c];
    db.alerts = db.alerts.filter((a) => !codes.includes(a.code));
    save();
    return send(chatId, 'Unlinked and deleted all alerts.');
  }
  return send(chatId, 'Open the trading app → Alerts → "Connect Telegram" to link this chat.');
}

// ---------------- checker ----------------
async function lighterGet(path) {
  const res = await fetch(`${LIGHTER}/api/v1/${path}`);
  const data = await res.json();
  if (data.code !== undefined && data.code !== 200) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

async function check() {
  if (!db.alerts.length) return;
  const d = await lighterGet('orderBookDetails');
  const marks = new Map((d.order_book_details ?? []).map((m) => [m.market_id, Number(m.mark_price)]));
  const now = Date.now();
  let changed = false;

  for (const a of [...db.alerts]) {
    if (a.type !== 'price') continue;
    const link = db.links[a.code];
    if (!link) continue;
    const mark = marks.get(a.marketId);
    if (priceAlertHit(a, mark)) {
      await send(link.chatId, `🔔 ${a.symbol} is ${a.op === 'above' ? 'above' : 'below'} ${a.price}\nMark price: ${mark}`);
      db.alerts = db.alerts.filter((x) => x.id !== a.id); // one-shot
      changed = true;
    }
  }

  const liqAlerts = db.alerts.filter((a) => a.type === 'liq' && db.links[a.code]);
  const accounts = [...new Set(liqAlerts.map((a) => a.accountIndex))];
  for (const idx of accounts) {
    let account;
    try {
      account = (await lighterGet(`account?by=index&value=${idx}`)).accounts?.[0];
    } catch (e) {
      log('account fetch failed', idx, e.message);
      continue;
    }
    for (const a of liqAlerts.filter((x) => x.accountIndex === idx)) {
      for (const w of liqWarnings(a, account, marks, db.lastFired, now)) {
        await send(
          db.links[a.code].chatId,
          `⚠️ ${w.symbol} ${w.side} is ${w.distancePct.toFixed(2)}% from liquidation\nMark ${w.mark} · Liq. price ${w.liq}`,
        );
        db.lastFired[w.key] = now;
        changed = true;
      }
    }
  }
  if (changed) save();
}

async function checkLoop() {
  for (;;) {
    try {
      await check();
    } catch (e) {
      log('check error', e.message);
    }
    await new Promise((r) => setTimeout(r, CHECK_MS));
  }
}

// ---------------- http api ----------------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip) ?? { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++;
  hits.set(ip, h);
  if (hits.size > 10000) hits.clear();
  return h.n > 120;
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const publicAlert = ({ code, ...a }) => a; // never echo the secret back

const server = http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) return reply(res, 429, { error: 'Too many requests' });
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/alerts-api/, '');
  const code = url.searchParams.get('code');

  try {
    if (req.method === 'GET' && path === '/health') {
      return reply(res, 200, { ok: true, enabled: !!TOKEN && !!botUsername, network: NETWORK });
    }
    if (!TOKEN || !botUsername) return reply(res, 503, { error: 'Alerts are not configured on this server' });

    if (req.method === 'GET' && path === '/link') {
      if (!isValidCode(code)) return reply(res, 400, { error: 'Invalid code' });
      return reply(res, 200, { linked: !!db.links[code], botUrl: `https://t.me/${botUsername}?start=${code}` });
    }
    if (req.method === 'GET' && path === '/alerts') {
      if (!isValidCode(code)) return reply(res, 400, { error: 'Invalid code' });
      return reply(res, 200, { alerts: db.alerts.filter((a) => a.code === code).map(publicAlert) });
    }
    if (req.method === 'POST' && path === '/alerts') {
      const { alert, error } = parseAlertRequest(await readBody(req));
      if (error) return reply(res, 400, { error });
      if (!db.links[alert.code]) return reply(res, 403, { error: 'Connect Telegram first' });
      if (db.alerts.filter((a) => a.code === alert.code).length >= LIMITS.perCode) return reply(res, 400, { error: `Max ${LIMITS.perCode} alerts` });
      if (db.alerts.length >= LIMITS.total) return reply(res, 503, { error: 'Server alert limit reached' });
      const full = { ...alert, id: randomUUID(), createdAt: Date.now() };
      db.alerts.push(full);
      save();
      return reply(res, 201, { alert: publicAlert(full) });
    }
    const del = path.match(/^\/alerts\/([0-9a-f-]{36})$/);
    if (req.method === 'DELETE' && del) {
      if (!isValidCode(code)) return reply(res, 400, { error: 'Invalid code' });
      const before = db.alerts.length;
      db.alerts = db.alerts.filter((a) => !(a.id === del[1] && a.code === code));
      if (db.alerts.length !== before) save();
      return reply(res, 200, { deleted: before - db.alerts.length });
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (e) {
    return reply(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => log(`alerts api on :${PORT} (lighter ${NETWORK})`));

if (TOKEN) {
  tg('getMe')
    .then((me) => {
      botUsername = me.username;
      log(`telegram bot @${botUsername} ready`);
      pollTelegram();
      checkLoop();
    })
    .catch((e) => log('TELEGRAM_BOT_TOKEN rejected:', e.message));
} else {
  log('TELEGRAM_BOT_TOKEN not set — alerts disabled (API answers /health only)');
}
