# VeSync Internal Marketing Platform Research
## Recommendation: an Environmental Demand Engine (working name: "Barometer")

*Research date: 2 September 2026. Prepared as a build proposal for VeSync (Levoit, Cosori, Etekcity, Pawsync). Scientific and market evidence for every design assumption is in `vesync-scientific-evidence-base.md`. The extension of the same engine to Cosori, Etekcity and Pawsync, with a signal registry as the core abstraction, is in `vesync-one-platform-all-brands.md`.*

---

## 1. Executive summary

**Build an internal, closed-loop marketing platform that turns real-world environmental and health conditions into money, ahead of the moment, across every channel VeSync sells through.**

The platform ingests public hazard feeds (wildfire smoke, AQI, pollen, flu, humidity, heat), fuses them with the one dataset nobody else has (aggregate readings from the 5.5M+ VeSync-connected devices, most of which carry AirSight PM1/PM2.5/PM10 laser sensors), and produces a ZIP-level **Home Health Demand Index** on three horizons for each product line: activate (0 to 72 hours), schedule (3 to 7 days), and watch (7 to 30 days, inventory pre-positioning only). The horizons follow the forecast-skill evidence in the companion document `vesync-scientific-evidence-base.md`. It then acts on that forecast automatically: postal-code bid indexes into Amazon DSP, rule-based audiences into Amazon Marketing Cloud, budget and keyword shifts in Sponsored Products, geo-targeted Meta/Google/TikTok campaigns, Walmart Connect, Klaviyo/Shopify CRM flows, and VeSync-app push. Spend is gated on live inventory from the Amazon SP-API and Walmart so no dollar is spent into a stockout. Every activation is measured with geo-holdout incrementality, Amazon Marketing Stream hourly data, and Search Query Performance share.

**Why it is not available on the public market:**

| Existing category | What it does | What it cannot do for VeSync |
|---|---|---|
| Weather-trigger ad tools (WeatherAds, WeatherTrigger, Weather Unlocked) | Push weather/AQI rules into Meta, Google, TikTok, DV360 | No Amazon DSP / Sponsored Ads, no Walmart Connect, no inventory gating, no first-party sensor data, no incrementality measurement. Amazon is 75% of VeSync revenue. |
| Amazon suites (Pacvue, Helium 10, Jungle Scout Cobalt, SmartScout) | Bid automation, share of voice, keyword and ASIN tracking | Zero environmental or epidemiological signals. Reactive: they see demand after the search happens. |
| Marketing data unification (Improvado, Fivetran, Domo) | ETL and dashboards | Reporting only. No forecasting, no activation. |
| Social listening (Brandwatch, XPOZ) | Mentions and sentiment | No link to demand or spend. |

VeSync is the only company that sits on **both** a national indoor air-quality sensor network **and** a 75%-Amazon channel mix. That combination is the moat. Competitors (Dreame, launched air category March 2025 and growing 1,174% YoY in Q1 2026; SharkNinja, BreatheClear Max June 2026) are now shipping "proactive" purifiers, so the window to weaponize VeSync's installed-base advantage in marketing is now.

**Proven precedent:** a WeatherAds case study for an unnamed home-appliance brand in Canada used three triggers (high pollen, high dust, poor AQI) on Meta and TikTok and reported a **289% increase in air purifier category sales** versus the prior 8 weeks, with 60% higher CTR on Meta. That was two platforms, no Amazon, no inventory logic, no first-party data. Barometer is that idea, done on VeSync's real channel mix with VeSync's real data.

---

## 2. What we learned about VeSync (context that shapes the design)

| Fact | Source | Design implication |
|---|---|---|
| 2024 revenue US$652.6M (+11.5%), net profit US$93.0M (+20.1%) | HKEX annual results, kr-asia | Budget exists for a small internal build; ROI bar is incremental margin, not vanity metrics. |
| ~75% of sales through Amazon in 2024; strategy is to grow non-Amazon channels, TikTok, Europe | HKEX results, Futu research notes | Platform must be Amazon-first but multi-channel from day one (Walmart, Target, Best Buy, Costco, TikTok Shop, Shopify DTC, Amazon EU). |
| Delisted from HKEX May 2025 at 33.3% premium; privately held by founder | TipRanks, Baker McKenzie | Fewer disclosure constraints; long-horizon investments welcome; internal tooling is not scrutinized quarterly. |
| 5.5M+ devices connected to the VeSync app; Levoit #1 US air purifier and humidifier brand | yespress.io, VeSync IR | The device fleet is a proprietary sensor network. Purifiers report PM1/PM2.5/PM10, humidifiers report humidity/temperature, filter-life counters exist per device. |
| Stated strategy: "develop VeSync App into a home IoT platform" and "strengthen brand operation" | HKEX results | Aggregated device data used for marketing intelligence is aligned with existing strategy, subject to privacy design (Section 7). |
| Levoit sells replacement filters and runs a filter subscription at us.vesync.com (save up to 30%) | us.vesync.com | Highest-margin recurring revenue; environmental events are the natural trigger for filter replacement. |
| VeSync's "Manager, Marketing Analytics & Ops" job posting asks to "consolidate marketing data from multiple sources into a unified system" and requires Shopify Plus | Lever / ZipRecruiter | The internal need for unification is already recognized. Shopify Plus is the DTC stack. |
| 2023 Cosori recall of 2M+ air fryers | CPSC, NPR | Any automated messaging must have a brand-safety kill switch and never use fear-based copy. |
| June 2026 launches: Levoit VortexIQ vacuums, NeoClassic humidifiers | PR Newswire | The catalog now spans air, humidity, vacuum, heat/fan: every one has an environmental demand driver (dust, dry air, allergy, heat). |

---

## 3. The platform

### 3.1 Signal ingestion layer (all API-based)

**Outdoor environment (free or near-free):**

| Feed | API | Cost / access | Signal |
|---|---|---|---|
| EPA AirNow | REST, 2,500+ stations, forecasts for 500+ cities (US, CA, MX) | Free key | Observed and forecast AQI by ZIP / lat-lon |
| PurpleAir | REST, sensor-level PM2.5, history to 2016 | Free developer key, points-based | Hyper-local PM2.5, minutes latency |
| NASA FIRMS | REST, VIIRS/MODIS fire detections; ultra-real-time <60s in US/CA | Free MAP_KEY | Active fire locations and radiative power |
| NOAA HRRR-Smoke | GRIB via NOAA / GribStream | Free (raw) or paid API | 48h smoke plume forecast, 3km CONUS |
| NWS api.weather.gov | REST, GeoJSON, CAP alerts | Free | Air quality alerts, heat, red flag, freeze warnings |
| Google Air Quality API | REST, 500m grid, 100+ countries, 70+ indexes | 10k calls/mo free, then $5 CPM | Global AQI incl. Europe (Amazon DE/UK/FR) |
| Google Pollen API | REST, 1km grid, 65+ countries, 5-day forecast, 15 species | Same tier | Tree/grass/weed pollen forecast |
| Open-Meteo Air Quality | REST | Free non-commercial; commercial tier cheap | Backup and Europe coverage |
| Ambee (optional) | REST | Paid | 30+ pollen allergens, hourly |

**Health and seasonality:**

| Feed | API | Signal |
|---|---|---|
| CDC FluView via CMU Delphi Epidata | REST, free | ILI% by state and HHS region, weekly |
| NWS gridpoint forecasts | Free | Indoor dryness proxy (dew point, heating degree days) for humidifiers |
| Google Trends API (alpha) | Application-gated; 5-year daily/weekly, geo-restricted | Search interest by region for "air purifier", "humidifier", "wildfire smoke". Apply now; fall back to third-party trend scrapers. |

**First-party device fleet (the moat):**

The VeSync backend already holds per-device state that the app renders (real-time PM2.5, historical charts, indoor vs outdoor comparison, filter life). The `pyvesync` community library shows the fields exist: `air_quality_value` (PM2.5), humidity, temperature, filter life, fan mode. Barometer consumes an **aggregated, anonymized** stream from the IoT platform:

- Per ZIP3 (or DMA) per hour: median indoor PM2.5, share of devices in auto mode running at high speed, share of devices with filter life < 20%, humidifier median humidity, device count.
- k-anonymity threshold: no cell published with fewer than 1,000 devices.
- Use: (a) validates whether outdoor smoke is actually reaching homes indoors (purchase intent is far stronger when it is), (b) filter-replacement demand forecast, (c) humidifier demand from measured dry indoor air, (d) a public-facing "Levoit Indoor Air Report" content asset that earns press and search traffic during events.

**Commerce and competitive:**

| Feed | API | Signal |
|---|---|---|
| Amazon SP-API: FBA Inventory API | Real-time fulfillable / inbound / reserved units by marketplace | Inventory gate; days-of-cover per ASIN |
| Amazon SP-API: Data Kiosk (Sales & Traffic, Vendor Analytics manufacturingView/sourcingView) | GraphQL | Daily units, sessions, conversion by ASIN |
| Amazon Brand Analytics Search Query Performance via SP-API (programmatic since Feb 2025) | Weekly | Query-level impressions/clicks/purchases share for "air purifier for smoke", etc. |
| Amazon Marketing Stream | Push to SQS/Firehose, hourly | Real-time ad performance and budget consumption for SP/SB/SD/DSP |
| Walmart Marketplace API + Walmart Connect API | REST | Walmart inventory, sales, sponsored search and display |
| Shopify Admin API (Levoit.com, Cosori.com) | GraphQL | DTC orders, subscriptions, inventory |
| TikTok Shop Affiliate Seller API | REST | Creator-attributed GMV during events |
| Keepa / Rainforest (third-party) | REST | Competitor (Dreame, Shark, Coway, Blueair, Dyson) price, Buy Box, stock status during events |
| Reddit API, YouTube Data API, Instagram Graph API | REST | Mention velocity for "smoke", "air purifier", brand names by region |

Note: Amazon SP-API introduced a $1,400/year subscription plus usage-based fees from 2026. Budget for it.

### 3.2 Demand Index and forecast layer

For each (geo cell, product family, horizon) produce a 0-100 **Home Health Demand Index (HHDI)** and an expected-units uplift:

- Product families: air purifier, replacement filter, humidifier, dehumidifier/fan/heater, vacuum (dust/pollen season), Cosori (separate food-trend module, Phase 4), Pawsync (pet dander + shedding season).
- Features: outdoor AQI now and 72h forecast, smoke plume probability, fire radiative power within 300km and wind vector, pollen index by species, ILI%, dew point, NWS alert flags, indoor PM2.5 median from fleet, share of fleet on high speed, filter-life distribution, search interest, social mention velocity, day-of-week and promo calendar, prior event response curves.
- Model: gradient-boosted regression per family trained on 2023 to 2026 sales history (the June 2023 Canadian wildfire spike is a clean training event; Levoit Core 300 "sales spiked on Amazon" that week). Start with a transparent rules-plus-weights index; graduate to ML once holdout data accumulates.
- Horizons: **activate** 0 to 72 h (smoke, AQI, NWS alerts; forecast skill is only directional beyond this), **schedule** 3 to 7 d (pollen, dew point, heat), **watch** 7 to 30 d (NIFC fire-potential outlook and drought; moves inventory, not spend).
- Triggers keyed to EPA AQI category boundaries (101, 151, 201), which the literature shows are the thresholds consumers react to; event campaigns run through the exposure week and the week after, because scanner data show a smaller but still significant effect at a one-week lag.
- Fleet aggregates pass through the EPA humidity-aware low-cost-sensor correction and are capped at the sensor's linear range before use.
- Output every hour: HHDI grid, top-N geo cells crossing thresholds, expected uplift, recommended budget by channel.

### 3.3 Inventory and channel guard

Before any activation: compute days-of-cover per ASIN per marketplace from FBA Inventory API; per SKU per store for Walmart and Shopify. Rules:

- Do not increase spend on ASINs with < 7 days cover at forecasted demand.
- Auto-substitute: shift the event budget to the best in-stock sibling ASIN (Core 300S to Core 200S, or to Target/Walmart listings if Amazon is thin).
- Alert supply chain 10 to 14 days ahead when HHDI forecast implies a stockout so inbound shipments can be pulled forward (the forecast horizon is the point).

### 3.4 Activation orchestrator

| Channel | Mechanism | Geo precision |
|---|---|---|
| Amazon DSP | **Geographic Insights and Activation API** (beta, 2025 to 2026): upload postal-code index values (0-100), smart location groups auto-adjust bids by percentile. HHDI is literally the index Amazon asks for. Requires DSP + AMC access. | ZIP |
| Amazon Marketing Cloud | Rule-based audiences via Amazon Ads API: e.g. "searched purifier terms in last 7 days, no purchase, in impacted DMAs"; push to DSP and Sponsored Display. Filter-replacement lookalikes from purifier buyers 6 to 12 months ago. | Audience-level |
| Sponsored Products / Brands | Amazon Ads API: budget caps, top-of-search bid adjustments, keyword additions ("air purifier for wildfire smoke") during national events; Marketing Stream hourly feedback loop. No geo targeting exists here, so the trigger is national/regional severity weighted by sales share. | National |
| Meta Marketing API | Duplicate event ad sets targeted to ZIP lists, budget scaled by HHDI; condition-matched creative. | ZIP |
| Google Ads API | Location bid modifiers and campaign budgets; Performance Max asset groups by condition. | City/ZIP |
| TikTok Marketing API + TikTok Shop | Region-targeted Spark Ads on creator content; affiliate commission boosts in impacted regions. | State/DMA |
| Walmart Connect API | Sponsored search budget and bids; display via Display API. | National (store-level where supported) |
| Klaviyo / Shopify | Segment: purifier owners in impacted ZIPs with filter life < 20% (from fleet, with consent) receive filter-replacement flow; subscription offer. | Household |
| VeSync app push | Existing notification channel: "Smoke is forecast for your area tonight; your Core 400S filter is at 15%." Highest-intent, zero-CAC. | Household, opt-in |
| Retail partners (Target, Best Buy, Costco) | No ad API for all; generate a weekly "Demand Outlook" PDF/email for buyers to push endcap and replenishment. | DMA |

All activations are proposed first, auto-executed only within pre-approved guardrails (max budget delta, max duration, allowed creative library), and every action is logged for rollback.

### 3.5 Creative engine

Claude API generates condition-matched variants from a legal-approved template library: "Smoke in the forecast for Portland this week. Core 400S clears 1,980 sq ft in an hour." Guardrails: no medical claims, no fear language, CPSC-compliant, brand-voice review per brand, human approval for any net-new claim. Pre-render creative for the 12 most common condition types so activation latency is minutes, not days.

### 3.6 Measurement layer

- **Geo-holdout incrementality:** for every event, withhold a matched set of ZIPs (synthetic control) so uplift claims are real. This is what separates Barometer from every vendor case study.
- **Amazon Marketing Stream:** hourly spend, impressions, sales, budget exhaustion; auto-raise caps mid-event.
- **Search Query Performance:** VeSync share of clicks and purchases on event queries versus Dreame/Shark/Coway, week over week.
- **Filter attach and subscription conversion** within 14 days of an event push.
- **Stockout-spend avoided** (dollars not spent into OOS) and **competitor OOS captured** (Keepa shows Dreame/Shark out of stock during a plume; Barometer bids up).
- **Latency:** event detected to first campaign live (target < 2 hours).

---

## 4. Reference architecture

```
[Public feeds] AirNow, PurpleAir, FIRMS, HRRR-Smoke, NWS, Google AQ/Pollen, Delphi, Trends
[First-party] VeSync IoT platform -> aggregation job (k>=1000) -> HHDI feature store
[Commerce]  SP-API (Data Kiosk, FBA Inventory, SQP), Marketing Stream (SQS), Walmart, Shopify, TikTok Shop
[Competitive] Keepa/Rainforest, Reddit, YouTube, IG
        |
        v
  Ingestion (Python workers, Dagster/Airflow schedules; Marketing Stream via SQS consumer)
        |
        v
  Warehouse: ClickHouse or TimescaleDB (time series) + Postgres (metadata) + dbt models
        |
        v
  HHDI service (FastAPI): hourly grid, forecasts, thresholds, expected uplift
        |
        +--> Inventory guard (days-of-cover rules)
        +--> Activation orchestrator (adapters: Amazon Ads/DSP/AMC, Meta, Google, TikTok, Walmart Connect, Klaviyo, VeSync push)
        +--> Creative engine (Claude API + template library + approval queue)
        +--> Measurement (geo-holdout assignment, incrementality reports)
        |
        v
  Ops UI (Next.js): map of HHDI, pending activations, inventory risks, event P&L; Slack alerts
```

- Host on AWS (Marketing Stream requires an AWS account for SQS/Firehose; keeps latency to Amazon low).
- Everything behind the orchestrator is an adapter with a dry-run mode; new channels (Amazon EU, Target Roundel when API access is granted) plug in without touching the core.
- Estimated run cost: AWS US$1.5k to 3k/month; SP-API US$1.4k/year plus usage; Google environment APIs a few hundred dollars per month at ZIP-grid polling; Keepa/Rainforest US$100 to 500/month.

---

## 5. Build plan (16 weeks to a measurable loop)

| Phase | Weeks | Deliverable | Dependencies |
|---|---|---|---|
| 0. Access | 1 to 2 | API credentials: SP-API (Brand Analytics role), Amazon Ads API, DSP + AMC (via agency if needed), Meta, Google, TikTok, Walmart, Shopify, Klaviyo; IoT aggregation agreement with the app team; privacy sign-off | Legal, IoT platform team |
| 1. See | 3 to 6 | Ingestion of all public feeds + inventory + sales; HHDI v0 (rules); map UI; Slack alerts for threshold crossings; backtest against June 2023 and 2025 fire seasons | Phase 0 |
| 2. Act (owned + social) | 7 to 10 | Klaviyo, VeSync push, Meta, Google adapters with guardrails; creative template library; first live event with geo-holdout | Phase 1 |
| 3. Act (Amazon + retail) | 11 to 14 | Sponsored Products budget/keyword adapter with Marketing Stream feedback; DSP Geographic Insights & Activation upload; AMC rule-based audiences; Walmart Connect | DSP/AMC access |
| 4. Learn + extend | 15 to 16 | Incrementality reports, HHDI ML v1, SQP share tracking, retailer Demand Outlook; scope Cosori food-trend module and Pawsync shedding-season module | Phases 2 to 3 |

Team: 1 product owner (marketing), 2 backend engineers, 1 data scientist, 0.5 frontend, part-time legal/privacy. This is a small-team build.

---

## 6. Business case (order of magnitude, to be validated in Phase 1 backtest)

- Air purifiers and humidifiers are Levoit's core and are explicitly weather- and season-driven; the 2023 Canadian wildfire season alone put 100M+ Americans under air quality alerts and visibly spiked Levoit Core 300 sales on Amazon.
- Precedent uplift from a two-channel, no-inventory-logic version of this idea: +289% category sales during the campaign window (WeatherAds). Even a conservative 10 to 20% incremental lift on event-week purifier and filter revenue, plus stockout-spend avoidance and higher filter subscription attach, pays for the build inside one fire season.
- Strategic value: the same engine is the reason to keep growing non-Amazon channels (it makes Walmart, TikTok and DTC spend as smart as Amazon spend), directly serving the stated diversification strategy.

---

## 7. Privacy, brand safety, and legal design

- **Device data is aggregated only.** ZIP3/DMA cells, k >= 1,000 devices, no per-user targeting derived from sensor data unless the user has opted into personalized notifications inside the VeSync app. Household-level filter reminders already exist in the app; Barometer only adds environmental context to the timing.
- **Health onboarding answers** collected by the app are not used by Barometer.
- **Jurisdiction.** VeSync is Chinese-owned with US and EU customers: keep the aggregation job and warehouse in-region (AWS us-west / eu-central), CCPA/CPRA and GDPR compliant, and document that no raw telemetry leaves region.
- **Tone guardrails.** Informational and helpful, never alarmist; no health-outcome claims; every automated creative comes from an approved template library; a single kill switch pauses all activations.
- **Public good angle.** Publishing an aggregated "Levoit Indoor Air Report" during smoke events is genuinely useful to the public and earns media, the same way PurpleAir's map does.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Amazon DSP / AMC access requires managed service or minimum spend | Start via the existing agency's DSP seat; Sponsored Ads budget/keyword loop works without DSP |
| Google Trends API is alpha and gated; TikTok Research API bars commercial use | Apply for Trends; use SQP and Meta/Google search volumes as primary intent signals; use TikTok Creative Center manually or third-party data |
| Attribution disputes ("it would have sold anyway") | Geo-holdouts from day one; report only incremental lift |
| SP-API fees and rate limits | Budget the subscription; poll inventory at 15-minute cadence, not real-time |
| Reputational risk of "disaster marketing" | Template-only creative, kill switch, informational tone, no fear copy |
| IoT team bandwidth | Phase 1 works entirely on public feeds; fleet data is additive in Phase 2 |

---

## 9. Alternatives considered (and why Barometer wins)

1. **Review-to-R&D intelligence engine** (mine Amazon/Walmart/Reddit reviews across Levoit and competitors, route defects and feature requests to product teams). Valuable, but public tools (Bazaarvoice, ReviewMeta-style, Helium 10 review insights) already cover most of it, and it does not move revenue directly.
2. **Creator-commerce attribution engine** (TikTok Shop Affiliate API + YouTube Creator Partnerships API + Amazon Attribution to rank creators by incremental sales). Useful for the TikTok push, but impact.com and similar are building it, and YouTube's API is restricted to approved partners.
3. **Retail price and shelf integrity monitor** (Keepa/Rainforest + retailer scraping for MAP violations and Buy Box loss). Important hygiene, largely available commercially.

Barometer is the only option that (a) uses an asset no competitor has, (b) attaches to the channel that is 75% of revenue via a brand-new Amazon API built for exactly this input, and (c) is provably incremental. Alternatives 1 and 3 can be bolted on as modules later, since the ingestion and warehouse layers are shared.

---

## 10. Sources

**VeSync**
- HKEX 2024 annual results announcement: https://www1.hkexnews.hk/listedco/listconews/sehk/2024/0826/2024082601434.pdf
- Quartr, VeSync investor summary: https://quartr.com/companies/vesync-co-ltd_18595
- KrASIA, "VeSync goes private to play the long game": https://kr-asia.com/vesync-goes-private-to-play-the-long-game-in-smart-home-tech
- Baker McKenzie on the privatization: https://www.bakermckenzie.com/en/newsroom/2025/05/privatization-of-vesync
- YesPress VeSync profile (5.5M devices, revenue): https://yespress.io/vesync
- Futu research notes on non-Amazon channel growth: https://news.futunn.com/en/post/47595591/vesync-2148-hk-non-amazon-channel-performance-is-impressive-and
- VeSync brands page: https://www.vesync.com/brands
- VeSync filter subscription: https://us.vesync.com/filter-subscription
- VeSync marketing analytics job listing: https://jobs.lever.co/vesync
- Levoit VortexIQ launch (June 2026): https://www.prnewswire.com/news-releases/levoit-launches-new-vortexiq-vacuum-series-with-neosight-dust-detection-for-visible-cleaning-confidence-302788343.html
- Levoit NeoClassic humidifiers (June 2026): https://www.prnewswire.com/news-releases/levoit-takes-on-the-humidifier-cleaning-problem-with-neoclassic-series-302789933.html
- Cosori recall (NPR): https://www.npr.org/2023/02/24/1159240615/cosori-air-fryer-recall
- Levoit Core 300 wildfire sales spike: https://ca.style.yahoo.com/levoit-core-300-air-purifier-amazon-204420027.html
- pyvesync device data fields: https://github.com/webdjoe/pyvesync
- UX review of VeSync app (indoor vs outdoor AQ charts, health onboarding questions): https://everydayindustries.com/levoit-smart-devices-vesync-app-user-experience-evaluation/

**Competitors**
- Dreame CES 2026 six-category expansion: https://the-gadgeteer.com/2026/01/18/dreame-expands-beyond-vacuums-with-a-six-category-smart-home-ecosystem-at-ces-2026/
- Dreame NEXT North American air launch (+1,174% YoY): https://www.prnewswire.com/news-releases/dreame-launches-three-world-first-air-and-environmental-products-at-dreame-next-marking-north-american-expansion-302760019.html
- SharkNinja BreatheClear Max: https://ir.sharkninja.com/news/news-details/2026/SharkNinja-Introduces-Shark-BreatheClear-Max-with-NeverChange-Proactive-Purification--Intelligent-Air-Analysis-Purpose-Built-to-Act-Before-Air-Quality-Drops/default.aspx
- SharkNinja marketing mix: https://portersfiveforce.com/blogs/marketing-strategy/sharkninja

**Precedent and weather-trigger market**
- WeatherAds air purifier case study (+289%): https://www.weatherads.io/case-studies/air-quality-driven-campaign-boosts-air-purifier-sales-by-289-for-leading-home-appliances-brand
- WeatherAds connectors: https://www.weatherads.io/
- WeatherTrigger guide (no native weather triggers in Google/Meta): https://weathertrigger.com/guide-to-weather-triggered-ads/
- Weather Company on flu-season targeting: https://www.weathercompany.com/blog/from-sniffles-to-sales-essential-fall-health-and-wellness-marketing-strategies-for-allergy-cold-flu-season/

**Amazon APIs**
- Geographic Insights and Activation API (DSP, postal-code indexes): https://ppc.land/amazon-releases-geographic-optimization-api-for-dsp-advertisers/
- DSP geo targeting reference: https://advertising.amazon.com/API/docs/en-us/dsp-ad-group-targeting-geo
- AMC rule-based audiences: https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-cloud/audiences/rule-based-lookalike
- Amazon Marketing Stream: https://advertising.amazon.com/solutions/products/amazon-marketing-stream
- SP-API data overview (AWS): https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-gen-ai-selling-partner-api/data-sp-api.html
- SQP via SP-API (Feb 2025): https://clearadsagency.com/api-access-to-search-query-performance-sqp-reports/
- Data Kiosk: https://developer.amazonservices.com/datakiosk
- FBA Inventory API: https://developer-docs.amazon.com/sp-api/docs/fba-inventory-api
- SP-API fees from 2026: https://ppc.land/amazon-introduces-fees-for-third-party-developer-api-access-in-2026/

**Environmental and health feeds**
- AirNow API: https://docs.airnowapi.org/
- PurpleAir API: https://api.purpleair.com/
- NASA FIRMS API: https://firms.modaps.eosdis.nasa.gov/api/
- NOAA HRRR-Smoke: https://rapidrefresh.noaa.gov/hrrr/HRRRsmoke/
- NWS API: https://www.weather.gov/documentation/standards/services-web-api
- Google Air Quality API: https://developers.google.com/maps/documentation/air-quality/overview
- Google Air Quality pricing: https://developers.google.com/maps/documentation/air-quality/usage-and-billing
- Google Pollen API: https://developers.google.com/maps/documentation/pollen/overview
- Open-Meteo Air Quality: https://open-meteo.com/en/docs/air-quality-api
- Ambee: https://www.getambee.com/api/air-quality
- CMU Delphi Epidata FluView: https://cmu-delphi.github.io/delphi-epidata/api/fluview.html
- Google Trends API alpha: https://developers.google.com/search/apis/trends

**Other channels**
- Walmart Connect APIs: https://developer.walmart.com/advertising-partners-search/docs/introduction-to-walmart-connect-ads-apis
- Walmart Connect Display API: https://www.marketingdive.com/news/walmart-connect-display-ad-api-retail-media/741461/
- TikTok Shop Affiliate APIs: https://developers.tiktok.com/blog/2024-tiktok-shop-affiliate-apis-launch-developer-opportunity
- TikTok Research API commercial restriction: https://www.keyapi.ai/blog/tiktok-research-api-commercial-trend-scanning/
- YouTube Creator Partnerships API: https://www.netinfluencer.com/youtube-opens-creator-partnerships-api-to-third-party-influencer-marketing-platforms/
- Amazon tool landscape (SmartScout, Keepa, DataHawk): https://marketplaceadpros.com/guides/best-amazon-market-intelligence-data-tools-2026/
- Helium 10 / Jungle Scout limitations: https://smartscout.com/blog/helium-10-vs-jungle-scout
