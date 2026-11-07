# Lighter Trade — your own frontend for Lighter perps

A self-custodial trading UI on top of [Lighter](https://lighter.xyz): users connect their own
wallet and trade Lighter's perpetual futures from your website. Lighter does the matching,
margin, liquidations and custody; this app is "just" the frontend — no backend, no user funds.

- Live markets, candlestick chart, order book (WebSocket with REST fallback), recent trades
- Market & limit orders, post-only, reduce-only, slippage cap, leverage
- Positions (one-click close), open orders (cancel), account balances
- Optional **integrator fee**: earn a cut of every trade routed through your frontend

## Quick start

```bash
cd lighter-dex
cp .env.example .env      # defaults to TESTNET (fake money) — start there
npm install               # also downloads + checksum-verifies Lighter's WASM signer
npm run dev               # http://localhost:3000
npm test                  # unit tests for price/size scaling & order building
npm run build             # static site in build/ — deploy to Vercel/Netlify/Cloudflare Pages/S3
```

## Deploy to a VPS (one command)

On the VPS (works from a phone SSH app such as Termius/JuiceSSH):

```bash
curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/ccr-02956898-1rlsfk/lighter-dex/deploy.sh | bash
```

It installs Docker if needed, builds the site, and serves it with automatic HTTPS at
`https://<vps-ip-with-dashes>.sslip.io` (no domain or DNS needed; mobile wallets require https).
If ports 80/443 are already taken on the VPS it falls back to `http://<vps-ip>:3003`.
Options: `NETWORK=mainnet`, `DOMAIN=trade.yourdomain.com`, `HTTPS=0` — e.g.
`curl -fsSL …/deploy.sh | NETWORK=mainnet bash`. Re-run the same command to update.

**On your phone:** open that URL inside your wallet app's built-in browser
(MetaMask / Rabby / Coinbase Wallet → Browser), then tap **Connect wallet**.

## How it works

```
 Wallet (MetaMask, Rabby, WalletConnect)
   │  1 signature, once: "authorize this API key"   (ChangePubKey, tx type 8)
   ▼
 Browser ── Lighter WASM signer (lighter-go/web-wasm) holds a Lighter API key
   │  signs orders/cancels/leverage locally — no wallet popup per order
   ▼
 Lighter REST  POST /api/v1/sendTx   ← signed tx
 Lighter REST  GET  /api/v1/...      → markets, book, trades, candles, account, orders
 Lighter WS    wss://…/stream        → live order book
```

1. **Wallet → account.** `GET /accountsByL1Address` maps the wallet to its Lighter account
   index. A wallet with no account must deposit USDC on Lighter first (link shown in the UI).
2. **API key.** Lighter orders are signed by a Lighter-native key, not by the wallet. On
   "Enable trading" the app generates a key in the browser, the wallet signs Lighter's
   ChangePubKey message once, and the key is registered in slot `VITE_API_KEY_INDEX`
   (default 7 — slots 0/1 belong to Lighter's own apps). The private key is kept in the
   user's `localStorage`; on reload it's checked against `GET /apikeys` and re-used.
3. **Trading.** Orders are signed in the WASM signer with a locally tracked nonce
   (resynced from `GET /nextNonce` after any failure) and posted to `/sendTx`.
   Market orders are IOC orders capped at best price ± slippage.
4. **Private data.** Open orders use a short-lived auth token created by the signer.

### Code map

| File | What |
|---|---|
| `src/lighter/config.js` | Network endpoints, chain ids, tx types, env config |
| `src/lighter/api.js` | REST client (CORS-enabled, browser talks to Lighter directly) |
| `src/lighter/signer.js` | Wrapper for the WASM signer; argument order mirrors `lighter-go/web-wasm/main.go` |
| `src/lighter/useLighter.js` | Session: account lookup, key registration, nonce queue, trade actions |
| `src/lighter/useMarketData.js` | Markets, candles, trades, live order book |
| `src/lighter/orders.js`, `units.js` | Decimal → integer scaling, order building, validation |
| `src/components/*` | Chart, order book, trades, order form, positions/orders |
| `scripts/fetch-signer.mjs` | Downloads the signer pinned by commit + SHA-256 |

## Earning fees (integrator)

Set in `.env`:

```
VITE_INTEGRATOR_ACCOUNT_INDEX=<your Lighter account index>
VITE_INTEGRATOR_TAKER_FEE=200   # 0.02% (units: millionths of notional)
VITE_INTEGRATOR_MAKER_FEE=0
```

Each user approves your max fee once with a wallet signature (ApproveIntegrator, tx 45,
valid 180 days); every order then carries your integrator index and fee. Check Lighter's
docs/terms for current integrator rules before going live.

## Before going to production

- **Test on testnet end-to-end** (enable trading → place/cancel → close). The signing
  flow follows the official SDK, but it has not yet been exercised against a live account.
- **Deposits/withdrawals** currently link out to Lighter's app. Adding in-app deposits means
  integrating Lighter's L1 bridge contracts — get the addresses from Lighter's docs.
- **Key storage:** the API key sits in `localStorage`. It can trade (and lose money) but can't
  withdraw to another address. Ship a strict Content-Security-Policy and avoid third-party
  scripts to limit XSS risk; add a "log out / revoke key" button if you want.
- **Legal:** perps are regulated derivatives in many countries (US, UK, …). Geoblock where
  required and get legal advice before launching publicly.
- Brand it as your own product — don't present it as Lighter's official app.
