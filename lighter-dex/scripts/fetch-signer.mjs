// Downloads Lighter's official browser signer (Go -> WASM) and the matching
// Go `wasm_exec.js` runtime into public/signer/, pinned by commit and verified
// by SHA-256. Runs automatically on `npm install`.
//
// Source: https://github.com/elliottech/lighter-go/tree/main/web-wasm
// To upgrade: bump LIGHTER_GO_COMMIT, copy `sha256` + `goVersion` from that
// commit's web-wasm/main.manifest.json, and update WASM_EXEC_SHA256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIGHTER_GO_COMMIT = 'aefa96848a105d82a6bbb55d3d05663293a71713';
const GO_VERSION = 'go1.26.8';

const FILES = [
  {
    name: 'lighter-signer.wasm',
    url: `https://raw.githubusercontent.com/elliottech/lighter-go/${LIGHTER_GO_COMMIT}/web-wasm/main.wasm`,
    sha256: '6caf0765a6f993bff0bd25ff4553ba8ea5657d0a6b85c767aae44ac5dcf17de9',
  },
  {
    name: 'wasm_exec.js',
    url: `https://raw.githubusercontent.com/golang/go/${GO_VERSION}/lib/wasm/wasm_exec.js`,
    sha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14',
  },
];

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'signer');
mkdirSync(outDir, { recursive: true });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

for (const f of FILES) {
  const dest = join(outDir, f.name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === f.sha256) {
    console.log(`[signer] ${f.name} up to date`);
    continue;
  }
  console.log(`[signer] downloading ${f.name}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`[signer] ${f.url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== f.sha256) {
    throw new Error(`[signer] checksum mismatch for ${f.name}: expected ${f.sha256}, got ${got}`);
  }
  writeFileSync(dest, buf);
  console.log(`[signer] ${f.name} OK (${(buf.length / 1e6).toFixed(1)} MB)`);
}
