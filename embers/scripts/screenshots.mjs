// Serves the exported web bundle and captures screenshots of each screen.
// Run: node scripts/screenshots.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
const PORT = 4173;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
  res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const shot = (name) => page.screenshot({ path: `screenshots/${name}.png` });

await shot('1-feed');

// Open the most urgent post's detail.
await page.getByText('last night 🎶').first().click();
await page.waitForTimeout(400);
await shot('2-post-detail');
await page.getByText('← back').click();
await page.waitForTimeout(300);

await page.getByText('📸 Post').click();
await page.waitForTimeout(300);
await shot('3-capture');

await page.getByText('🪦 Graves').click();
await page.waitForTimeout(300);
await shot('4-graveyard');

await page.getByText('🧑 You').click();
await page.waitForTimeout(300);
await shot('5-profile');

// Warp a day so deaths/refills happen, then shoot the feed again.
await page.getByText('🏠 Feed').click();
await page.getByText('⏩ +1d').click();
await page.waitForTimeout(600);
await shot('6-feed-after-warp');

await browser.close();
server.close();
console.log('screenshots written');
