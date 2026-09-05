# Barometer

VeSync's signal-driven advertising platform. It reads public hazard, health, economic and cultural feeds — plus aggregated first-party device data through an open adapter — scores every US ZIP3 area per brand and horizon, drafts creative that passes a claim check, routes spend through an inventory gate and a locked holdout, waits for a person to approve, writes to the ad platforms, and measures lift against the areas that saw no spend.

Research behind every rule lives in [`../docs/research/`](../docs/research/).

## Deploy to the VPS

Same pattern as `crypto15m`. On the VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/vesync-marketing-platform-research-97dyo1/barometer/deploy.sh | bash
```

or manually:

```bash
git clone https://github.com/Jim7907/NewPoly.git && cd NewPoly
git checkout claude/vesync-marketing-platform-research-97dyo1
cd barometer && cp .env.example .env && docker compose up --build -d
```

Open `http://<vps-ip>:3003`. Port **3003** (crypto15m keeps 3002). Re-run `deploy.sh` any time to pull and rebuild; `.env` and the database volume survive. Without Docker: `systemd/barometer.service`.

What happens on first boot, with no keys at all:

- the 891-cell ZIP3 grid loads, the catalog SKUs are seeded, and a 20–25 cell holdout is locked
- Open-Meteo (air quality + weather), NWS alerts, CDC FluView, BLS CPI and the calendar start polling — none need a key
- every cell gets an index per brand family per horizon; opportunities are detected and creative is drafted (templates until an Anthropic key is set)
- every ad-platform write is **dry-run**: the exact payload is recorded on the plan, nothing is sent

Then `node scripts/smoke.mjs http://<vps-ip>:3003 <FIRSTPARTY_INGEST_TOKEN>` walks one opportunity through the whole loop with demo data and asserts the rules held.

## Turning things on

Everything is an environment variable in `barometer/.env`. Leave a key blank and that source simply shows as "waiting for key" in the UI.

| Want | Set | Get it at |
|---|---|---|
| Generated creative (brief, 8 formats, headline pool) | `ANTHROPIC_API_KEY` | console.anthropic.com — model is `BAROMETER_MODEL`, default `claude-opus-5` |
| Reference-grade AQI monitors | `AIRNOW_API_KEY` | docs.airnowapi.org (free) |
| Dense sensor coverage, EPA-corrected | `PURPLEAIR_API_KEY` | develop.purpleair.com |
| Active fire detections | `FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov (free) |
| Pollen forecast, 5 days, species level | `GOOGLE_MAPS_API_KEY` | Google Cloud, enable Pollen API |
| Residential electricity price by state | `EIA_API_KEY` | eia.gov/opendata (free) |
| Higher BLS quota | `BLS_API_KEY` | api.bls.gov (free) |
| Real ad-platform writes | `LIVE_WRITES=true` **and** that channel's credentials | see `.env.example` |
| Amazon inventory for the gate | `AMAZON_SP_*` | Selling Partner API, FBA Inventory role |
| Accept first-party device readings | `FIRSTPARTY_INGEST_TOKEN` | pick a secret and share it with the IoT team |

`LIVE_WRITES` is a global switch. Off, a fully credentialed Meta account still gets dry-run writes. That is deliberate: you see exactly what would be sent before anything is.

## The first-party adapter is left open

Barometer never connects to the VeSync IoT platform. The team that owns device data aggregates readings to ZIP3 on their side and POSTs them:

```bash
curl -X POST http://<host>:3003/api/firstparty/readings \
  -H "Authorization: Bearer $FIRSTPARTY_INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"readings":[
        {"zip3":"972","brand":"levoit","metric":"indoor_pm25","value":41.2,"deviceCount":1840,"observedAt":"2026-09-05T14:00:00Z"},
        {"zip3":"972","brand":"levoit","metric":"filter_life_pct","value":22,"deviceCount":1840}
      ]}'
```

Accepted metrics: `indoor_pm25` (µg/m³, already corrected), `filter_life_pct`, `run_hours_delta_pct`, `cook_sessions_delta_pct`. Rows with fewer than 1,000 devices in the cell are stored but never scored. No device id, household or coordinate is ever accepted. `GET /api/firstparty/status` shows what has arrived. The adapter interface is `server/feeds/firstparty.js`; swap it for a pull from the IoT platform when that exists.

Partner signals with no open API (Pinterest Trends, Google Trends) arrive the same way through `POST /api/feeds/manual` — the smoke test uses that path to simulate a smoke event.

## How it works

```
feeds/*  ──▶ observations ──▶ normalise (grid, freshness, priority) ──▶ score (index per family/cell/horizon)
                                                                         │
                                                       detect ◀──────────┘  clusters of hot cells → opportunities
                                                         │
                          creative (brief → 8 formats → claim check) ◀───┤
                                                         │
                     plans (routing → inventory gate → approval → launch) ──▶ channels/* (dry-run or live)
                                                         │
                                       measure (treated vs locked holdout, diff-in-diff, bootstrap CI) ──▶ weights refit
```

- **`server/config.js`** is the decide layer as data: signal shapes keyed to the public AQI boundaries, per-family signal weights, three horizons (act 0–72 h, schedule 3–7 d, watch 7–30 d — watch never spends), money rules, claim rules, privacy floor.
- **Index denominator** is the set of metrics an *enabled* feed produces. A feed that failed this cycle still counts (no evidence ≠ not measured), so a lone alert reads ~30, not 100. Signals whose only feed lacks a key drop out until the key arrives.
- **Opportunities** are clusters of cells ≥ 55 within 170 km (or a single cell ≥ 75), merged when they share a top driver and a state. They persist by signature across polls and fade when the cells cool.
- **Inventory gate** computes days of cover at the uplifted sell rate. A held SKU reroutes its share to the sibling with the most cover; nothing is deleted. No inventory data → the gate says so instead of passing.
- **Money rules**: event cap, daily cap, any single write over $25,000 waits for a person, 90-second undo, kill switch blocks approval and launch and is logged.
- **Holdout**: chosen once at first boot (stratified, typical cells), stripped from every plan at build time and again at the moment of write.
- **Measurement** needs sales rows (`POST /api/sales` from Data Kiosk or retail exports). Until then results pages show the method and say so. `POST /api/demo/seed {"confirm":"DEMO"}` loads labelled synthetic data to walk the loop.

## API

`GET /api/status` · `/api/brands` · `/api/config` · `/api/feeds` · `/api/grid?brand=levoit:air&horizon=act` · `/api/grid/:zip3` · `/api/opportunities` · `/api/opportunities/:id` · `/api/plans` · `/api/plans/:id` · `/api/plans/:id/results` · `/api/channels` · `/api/inventory` · `/api/holdout` · `/api/firstparty/status` · `/api/audit`

`POST /api/feeds/run[?id=]` · `/api/feeds/manual` · `/api/score/run` · `/api/opportunities/:id/creatives` · `/api/opportunities/:id/dismiss` · `/api/opportunities/:id/plan` · `/api/plans/:id/approve` · `/api/plans/:id/launch` · `/api/plans/:id/stop` · `/api/writes/:id/release` · `/api/creatives/:id/status` · `PATCH /api/creatives/:id` · `/api/claims/check` · `/api/inventory` · `/api/inventory/sync-amazon` · `/api/sales` · `/api/firstparty/readings` · `/api/settings/kill-switch` · `/api/measure/refit` · `/api/demo/seed` · `/api/demo/clear`

Send `x-actor: <name>` on writes; it lands in the audit trail.

## Channel adapters

`server/channels/index.js`. Each adapter has `propose(plan, line)` → the exact payload, `write(payload)` for live sends, `reverse()` for undo. Live implementations: Amazon Sponsored Products (v3), Meta (campaign + ad set with per-cell lat/lon radius targeting), TikTok, Klaviyo (ZIP3-prefix segment), Shopify (event banner metafield), app push (webhook). Recorded as **shape only** because the platform API is partner-gated or in beta: Amazon DSP geographic index upload, AMC rule-based audiences, Google Ads proximity campaigns, Walmart Connect. Their payloads are complete and hand-off ready; they will not send even with `LIVE_WRITES=true`.

## Local development

```bash
cp .env.example .env
npm install
npm test          # 20 deterministic tests, no network
npm run server    # API + feeds + scoring on :3003
npm run dev       # + Vite UI on :3000
node scripts/smoke.mjs   # end-to-end against a running server
```

Regenerate the grid from fresh Census files with `python3 scripts/build-zip3.py <gazetteer.txt> <zcta_county.txt>`.

## What is not built

- The VeSync device-fleet connection (by design — see above).
- Per-event matched holdouts; the holdout is a permanent stratified set.
- Per-channel incrementality; channel attribution on the results page is by spend share and says so.
- Backtested elasticities; forecast revenue uses the configured baseline units and elasticity per family until sales history is loaded.
- NIFC fire-potential outlooks for the watch horizon (parsing the PDF outlook is a later task).
