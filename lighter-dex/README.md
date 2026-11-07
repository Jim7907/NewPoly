# Lighter Trade — your own frontend for Lighter perps

A self-custodial trading UI on top of [Lighter](https://lighter.xyz): users connect their own
wallet and trade Lighter's perpetual futures from your website. Lighter does the matching,
margin, liquidations and custody; this app is "just" the frontend — no backend, no user funds.

- Live markets, candlestick chart, order book (WebSocket with REST fallback), recent trades
- Market & limit orders, post-only, reduce-only, slippage cap, leverage
- **TP/SL**: attach take-profit / stop-loss to a new order (one grouped tx), or add them to an
  open position (OCO pair tied to the whole position) — Lighter-native, they fire with the app closed
- **History & PnL**: fills with realized PnL, win rate, per-market stats, PnL chart (7/30/90d), funding payments
- **All markets**: every Lighter perp and spot pair (mainnet: 215 perps + 11 spot), searchable picker with favorites
- **Indicators in Pine Script**: Supertrend, EMA, SMA, Bollinger, VWAP, RSI, MACD, Stochastic, ATR — plus
  **user-imported TradingView Pine Script** indicators/strategies (paste or upload, edit inputs, share)
- **Auto-trading bot**: trades from any indicator script that outputs `signals` (incl. user-imported
  ones). Paper mode by default, backtest preview, per-trade size, TP/SL, max trades/day, loss limit
- **Telegram alerts**: price crosses and "position close to liquidation" warnings
- **Phone layout**: bottom tabs (Chart / Book / Trade / Account), big buy/sell bar, position cards
- Optional **integrator fee**: earn a cut of every trade routed through your frontend (earnings shown in Account tab)

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

### Turn on Telegram alerts

1. In Telegram, message **@BotFather** → `/newbot` → pick a name → copy the token.
2. Re-run the deploy with it:
   `curl -fsSL …/deploy.sh | TELEGRAM_BOT_TOKEN=123456:ABC… bash`
3. In the app: **Alerts** tab → **Connect Telegram** → tap **Start** in Telegram.

The `alerts` container (`alerts/server.js`, no dependencies) links each browser to a Telegram chat
via a random secret, checks Lighter mark prices every 10s, and stores alerts in a Docker volume.

## Custom indicators (Pine Script)

Users import indicators and strategies as **Pine Script** (TradingView, v4–v6): **ƒx Indicators →
+ Import Pine Script** (paste) or **Upload .pine file**. The editor checks the script live and shows
the name, its settings and any error with its line number. Settings declared with `input.*` become
editable fields (numbers, on/off, dropdowns, price source). All built-in indicators are Pine too, so
"Copy as custom" is a quick way to start.

Supported (`src/indicators/pine/`, a parser + interpreter, no `eval`):
- `indicator()` / `study()` / `strategy()`, `input`, `input.int/float/bool/string/source/…` (with `options`, `minval`)
- `var`, `:=`, `+=`…, `[n]` history, `if / else if / else`, `if`/`switch` as expressions, `for`, `while`,
  user functions (single-line and block, tuple returns), tuple assignment `[a, b] = …`
- `ta.*`: sma ema rma wma vwma hma linreg stdev variance dev highest lowest (bars) change mom roc cum
  crossover crossunder cross rising falling barssince valuewhen rsi macd bb bbw kc tr atr cci stoch mfi
  vwap obv supertrend dmi pivothigh pivotlow — matching TradingView's seeding (e.g. `ta.ema` vs `ta.rma`)
- `math.*`, `nz`, `na`, `fixnan`, `color.*`/`color.new`, `str.tostring`, `plot`, `hline`, `bar_index`,
  `barstate.*`, `syminfo.mintick`, `timeframe.period`, `strategy.position_size`
- Drawings and cosmetics (`label.*`, `line.*`, `box.*`, `table.*`, `fill`, `bgcolor`, `barcolor`) are skipped
- Not available: `request.security` (other symbols/timeframes), libraries (`import`), user types/methods, arrays

Tested on popular community scripts (UT Bot Alerts, Squeeze Momentum, Supertrend strategy, RSI+MA v6).

### Auto-trading from an indicator

A script can drive the bot (**Bot** tab) when it produces buy/sell signals, in any of these ways:
- **Strategy scripts:** `strategy.entry("L", strategy.long)`, `strategy.entry("S", strategy.short)`,
  `strategy.close(...)` / `strategy.close_all()` (`strategy.exit` is ignored, the bot's TP/SL apply)
- **Indicator scripts:** `alertcondition(cond, "Buy …")` / `alertcondition(cond, "Sell …")`, or
  `plotshape(cond, title="Buy")` / `title="Sell"` (words like buy/long, sell/short, exit/close)

Signals show as L/S arrows on the chart. Built-in examples: *Strategy: EMA cross*, *Strategy: RSI reversal*.

```pine
//@version=5
strategy("EMA cross", overlay=true)
f = ta.ema(close, input.int(9, "Fast"))
s = ta.ema(close, input.int(21, "Slow"))
if ta.crossover(f, s)
    strategy.entry("Long", strategy.long)
if ta.crossunder(f, s)
    strategy.entry("Short", strategy.short)
```

(JavaScript indicators returning `{ plots, signals }` are still accepted for advanced use.)

How the bot behaves (`src/autotrade/`):
- Runs **in the user's browser** with their own key — nothing is stored on the server. It pauses if
  the app is closed / phone locked (it requests a screen wake lock while running). TP/SL orders live
  on Lighter, so open positions stay protected.
- Acts only on **closed** candles, once per candle, and only on signals that appear **after** it
  starts. `long`/`short` open or reverse; `exit` closes. Direction can be long-only / short-only.
- Limits: size per trade ($), TP %/SL % per entry, max trades/day, stop after losing $X, stop after
  3 errors in a row. Live mode needs an explicit confirmation and never auto-resumes after reload.
- Manages the whole position on its market and cancels leftover TP/SL orders there before each entry.
- The backtest (last 300 candles) fills at the next candle's open, unleveraged, no fees/funding.

**Safety:** Pine is interpreted (never `eval`-ed) and every script runs in a Web Worker isolated from
the page: no `localStorage` (where the trading key is), no DOM, no signer. Loops are capped, anything
running longer than 2s is killed, and output is validated before drawing.

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
| `src/lighter/history.js` | Fills → realized PnL, win rate, per-market stats |
| `src/indicators/*` | TA library, built-ins, sandboxed worker runner, saved indicator list |
| `src/components/*` | Chart, order book, trades, order form (TP/SL), positions, history, alerts |
| `alerts/` | Telegram alerts server (own container) |
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
