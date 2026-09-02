# Scientific Evidence Base for the VeSync Environmental Demand Engine

*Companion to `vesync-environmental-demand-engine.md`. Research date: 2 September 2026.*

This document collects the peer-reviewed and institutional evidence behind each design assumption in the Barometer proposal, and states where the science changes the design. Findings are grouped by the question they answer.

---

## 1. Is the environmental driver growing? (Exposure trends)

| Finding | Source | Implication |
|---|---|---|
| Since 2016, wildfire smoke has slowed or reversed PM2.5 improvements in 35 of 48 contiguous states, erasing about 25% of multi-decade progress on average and more than 50% in many western states. Population experiencing at least one "unhealthy" smoke day per year rose 27-fold; those experiencing extreme smoke rose about 11,000-fold. | Burke et al., *Nature* 622 (2023), "The contribution of wildfire to PM2.5 trends in the USA" | Smoke-driven demand is a structural, multi-year trend across most of the country, not a western anomaly. |
| The 2026 fire season started early: by 31 March 2026, 1.6M acres had burned (231% of the ten-year average), with 56% of the US in drought and an "unprecedented early season heat wave". | National Interagency Fire Center outlooks, April and September 2026 | The fire-season window is widening into spring; the platform must be live year-round. |
| North American pollen seasons now start about 20 days earlier and run about 8 days longer than in 1990, with about 21% higher concentrations; roughly half of the season-length trend is attributable to human-caused warming. | Anderegg et al., *PNAS* 118 (2021) | Allergy demand is lengthening and shifting earlier every year; static promo calendars drift out of alignment. |
| Absolute humidity explains about 90% of variance in influenza virus survival and about 50% of transmission variance in lab data; low absolute humidity precedes wintertime flu onset in the US. | Shaman and Kohn, *PNAS* 106 (2009); Shaman et al., *PLOS Biology* (2010) | Dew point and indoor absolute humidity are a scientifically grounded humidifier demand signal, better than calendar month. |
| Enveloped viruses including influenza A survive best at low relative humidity; maintaining 40 to 60% RH reduces survival for several pathogens. A portable humidifier in a residential model cut airborne influenza survival by 17.5 to 31.6%. | Modeling study, *Environmental Health* (2010); review in *PMC9261129* (2022) | Supports informational humidity content in the app, but not health-outcome advertising claims (see section 6). |

## 2. Why do consumers care? (Health toxicity)

| Finding | Source |
|---|---|
| Wildfire-specific PM2.5 raised respiratory hospitalizations by 1.3 to 10% per 10 µg/m³, versus 0.67 to 1.3% for non-wildfire PM2.5. | Aguilera et al., *Nature Communications* 12 (2021) |
| Across 749 locations globally, each 10 µg/m³ of wildfire PM2.5 raised all-cause mortality risk by 1.9%, cardiovascular by 1.7%, respiratory by 1.9%. | Chen et al., *Lancet Planetary Health* 5 (2021) |
| During smoke events, indoor PM2.5 often stays 3 to 4 times above health-based guidelines and varies 20-fold between neighbouring households. | Burke et al., *Nature Human Behaviour* 6 (2022) |

The last row is the strongest scientific argument for the device-fleet data layer: outdoor AQI predicts *whether* an area is affected, but only indoor measurements reveal *which households* are actually exposed, and the variance between neighbours is enormous.

## 3. Do people actually buy in response? (Behavioural and economic evidence)

| Finding | Source | Design implication |
|---|---|---|
| Weekly NielsenIQ scanner data across the contiguous US (2006 to 2019) show a positive, statistically significant effect of wildfire smoke PM2.5 on retail sales of air purifiers, nasal products, cough remedies and bottled water, with dynamic effects: prior weeks' smoke raises current sales. | "A Burning Issue: Wildfire Smoke Exposure, Retail Sales, and Demand for Adaptation in Healthcare" (working paper, 2024); related: "Wildfires, smoke pollution, and household purchasing behaviors", *Journal of Economic Behavior and Organization* (2026) | The purchase response is real, national, and persists for more than one week. Campaign windows should extend 1 to 2 weeks past the plume. |
| During large smoke events, searches for air quality and health-protection information rise sharply in wealthier areas; lower-income areas search for air quality but much less for protection, and spend less time at home. | Burke et al., *Nature Human Behaviour* (2022) | Expect a strong income gradient in conversion. Weight ZIP-level indexes by household income and prior category purchase rates; consider value-tier creative (Core Mini, Core 300) for lower-income cells. |
| Households in China were willing to pay about US$1.34 per year per µg/m³ of PM10 removed, estimated from air purifier scanner data; WTP rises with income. | Ito and Zhang, *Journal of Political Economy* 128 (2020) | Revealed-preference evidence that purifier demand is a defensive expenditure with measurable price elasticity. Discount depth can be tuned to pollution intensity. |
| Day-to-day fluctuations in air quality drive facemask spending across 190 cities; responses are sharper when official readings cross salient thresholds. | Zhang and Mu, *Journal of Environmental Economics and Management* 92 (2018) | Use official AQI category boundaries (101, 151, 201) as trigger thresholds; they are what consumers see. |
| Real-time pollution disclosure in China triggered stronger avoidance and higher spending on protective products, with health benefits exceeding costs by an order of magnitude. | Barwick, Li, Lin and Zou, *American Economic Review* (2024), "From Fog to Smog" | Information itself drives protective purchases. Publishing the Levoit Indoor Air Report is both a public good and a demand driver. |
| Smog alerts change behaviour on day one, but behaviour largely rebounds by day two. | Neidell, *Journal of Human Resources* (2009) and follow-ups | The highest-intent window is the first 24 to 48 hours after an alert. Activation latency must be hours, not days. |
| Higher air pollution raises consumer spending, especially in hedonic categories (gourmet snacks, entertainment gadgets, wellness), as a mood-repair response. | Kim and Trusov, *Journal of Marketing* (2025) | A Cosori and Etekcity angle: comfort cooking and wellness products can be promoted during pollution episodes, not just purifiers. |
| Households exposed to distant wildfire smoke raised credit-card spending by about US$730 per year and showed higher delinquency; the June 2023 smoke event was estimated to add US$6B in spending in the New York metro alone. | Federal Reserve Bank of Philadelphia working paper 24-01 (2024); Dallas Fed summary | Smoke events shift real spending, so the budget shift is economically justified, but tone must be helpful, not exploitative. |
| Tree pollen peaks raise OTC allergy medication sales by 28.7% at a 2-day lag and by 141% cumulatively over the following 7 days; about 47% of the pollen effect on purchases is transmitted through search behaviour. | Sheffield et al. (2011); Ito et al., *Environmental Health* (2015); *Journal of Allergy and Clinical Immunology* (2026) forecasting study | Pollen campaigns should start on the forecast peak day and run 7 days. Search-based channels capture almost half the response. |

## 4. Does the product actually work in these conditions? (Indoor physics)

| Finding | Source | Implication |
|---|---|---|
| Across 1,400+ California buildings and 2.4M sensor-hours, the indoor/outdoor PM2.5 infiltration ratio fell from 0.4 on normal days to 0.2 on smoke days because people closed up homes, yet mean indoor PM2.5 still nearly tripled. Homes with air conditioning or filtration had lower infiltration. | Liang et al., *PNAS* 118 (2021) | Closing windows is not enough; filtration is the marginal intervention. This is a substantiated, non-health product claim. |
| Portable HEPA cleaners reduce indoor PM2.5 by 22.6 to 92% versus control across studies; about 57% in Shanghai dormitories, about 26% in Ulaanbaatar homes. | Reviews in *Environmental Health* (2016, 2021) and *JESEE* (2025) | Efficacy claims should quote CADR and measured PM reduction, not symptom outcomes. |
| AHAM updated its wildfire-smoke sizing guidance: choose a smoke CADR at least equal to the room area in square feet (previously two-thirds). EPA recommends portable air cleaners for smoke. | AHAM Verifide white paper (2021); EPA and American Lung Association guidance | Product recommendation logic in creative and app should size by smoke CADR = room area. |
| Low-cost laser PM sensors (Plantower class, as used in PurpleAir and consumer purifiers) read high in smoke and go nonlinear above about 300 µg/m³. EPA's correction (PM2.5 = 0.524 × PA_cf1 − 0.0862 × RH + 5.75) is applied before data reach the AirNow Fire and Smoke Map. | Barkjohn et al., *Sensors* 22 (2022) and *Atmospheric Measurement Techniques* 16 (2023) | Fleet aggregates must apply a humidity-aware correction and cap at the sensor's linear range before being used as a demand feature or published. |

## 5. How far ahead can we really see? (Forecast skill)

| Finding | Source | Implication |
|---|---|---|
| HRRR-Smoke correctly predicted about 60% of AQI > 100 days in the Northwest, but underestimates surface concentrations during the most severe episodes and only captures smoke from satellite-detected fires. | NOAA GSL evaluations; *Weather and Forecasting* 41 (2026) on the 2023 Canadian season | Use HRRR-Smoke as a 0 to 48 hour trigger with a bias correction; do not rely on it alone for severity. |
| Hourly PM2.5 forecasts from GEOS-CF, HRRR-Smoke, NAQFC and CAMS give useful directional guidance at 1 to 3 days, but errors in timing and intensity during smoke episodes are large. | *Bulletin of the AMS* 107 (2026), "Are hourly PM2.5 forecasts sufficiently accurate to plan your day?" | High-confidence activation horizon is 0 to 72 hours. Beyond that, the index should express a probability, not a point forecast. |
| Google's Air Quality API model validates at R² above 0.7 for PM2.5 against reference monitors in diverse urban settings. | Google Maps Platform documentation | Adequate for ZIP-level nowcasting and Europe coverage; blend with AirNow and PurpleAir in the US. |
| Google Pollen API provides 5-day species-level forecasts on a 1 km grid; pollen response peaks 2 days after the count peak. | Google developer documentation; Ito et al. (2015) | Pollen campaigns can be scheduled from the forecast 3 to 5 days ahead with good confidence. |
| Influenza-like-illness surveillance is weekly and lags by about a week; absolute humidity leads flu onset by days to weeks. | CDC FluView; Shaman et al. (2010) | Use dew point as the leading indicator for humidifiers and ILI as confirmation, not as the trigger. |

**Design change from this section:** the original proposal described a 3 to 14 day forecast horizon. The evidence supports three distinct horizons: a **0 to 72 hour activation horizon** (smoke, AQI, alerts), a **3 to 7 day scheduling horizon** (pollen, humidity, heat), and a **7 to 30 day watch horizon** derived from NIFC fire-potential outlooks and drought that pre-positions inventory rather than spend. The main proposal has been updated accordingly.

## 6. What may we say? (Regulatory boundaries)

| Rule | Source | Implication for creative |
|---|---|---|
| Health-related product claims, explicit or implied, must be substantiated by competent and reliable scientific evidence before publication. | FTC Health Products Compliance Guidance (revised 2022 to 2023) | Never claim prevention of flu, colds, asthma or allergy symptoms. |
| The FTC has settled with an air purifier and vacuum maker over claims that its purifier "kills virtually all bacteria, viruses, germs, mold, and allergens" and reduces flu, cold, asthma and allergy risk. | FTC enforcement, reported by Kelley Drye | Condition-matched copy may state measured particle removal, CADR, coverage and filter status; it may cite public AQI. It may not promise health outcomes. |
| AHAM CADR is the recognized efficacy metric; smoke CADR should be at least equal to room area. | AHAM Verifide | Quote CADR figures per model in creative and recommendation logic. |

## 7. Market context

| Market | Size and growth | Source |
|---|---|---|
| North America air purifiers | US$4.5B in 2025 to US$6.06B by 2030, 6.1% CAGR | Mordor Intelligence |
| Global household air purifiers | US$4.5B to 5.5B in 2025, 5.5 to 6.5% CAGR to 2030 | Research and Markets |
| Global humidifiers | US$5.19B in 2025 to US$10.36B by 2034, 8.0% CAGR; demand is strongly seasonal and weather-dependent | Fortune Business Insights; Grand View Research |
| Global air fryers | US$9.40B in 2025 to US$20.99B by 2034, 9.0% CAGR | Fortune Business Insights |

Levoit is the number one US air purifier and humidifier brand, so a demand engine that lifts category conversion during events disproportionately benefits the share leader.

## 8. Evidence-to-design map

| Scientific finding | Barometer design decision |
|---|---|
| Indoor exposure varies 20-fold between neighbours (Burke 2022) | Fleet-derived indoor PM2.5 is a first-class feature, not a nice-to-have |
| Purchase response persists for weeks (NielsenIQ scanner studies) | Event campaigns run 7 to 14 days after the plume clears |
| Behaviour rebounds by day two after alerts (Neidell) | Latency target of under 2 hours from alert to live campaign |
| Threshold crossings drive spending (Zhang and Mu) | Triggers keyed to AQI category boundaries |
| Income gradient in protective behaviour (Burke 2022; Ito and Zhang) | Index weighted by income and prior category purchases; value-tier creative for lower-income cells |
| Nearly half of pollen response flows through search (2026 JACI study) | Search and Amazon SQP share are primary pollen KPIs |
| Forecast skill is directional beyond 72 hours (BAMS 2026) | Three horizons: activate 0 to 72 h, schedule 3 to 7 d, watch 7 to 30 d |
| Low-cost sensors need correction in smoke (Barkjohn) | Humidity-aware correction and range capping in the aggregation job |
| Health claims are regulated (FTC) | Template library limited to CADR, coverage, particle removal, filter status and public AQI |
| Pollution raises hedonic spending (Kim and Trusov) | Cosori and Etekcity comfort campaigns during episodes |

## 9. Open questions for the Phase 1 backtest

1. What is VeSync's own purifier sales elasticity to ZIP-level AQI by product tier, and how does it differ between Amazon, retail and DTC?
2. How long does the filter-replacement response lag a smoke event, and does an app push shorten it?
3. Does indoor fleet PM2.5 predict conversion better than outdoor AQI alone? This is the direct test of the moat.
4. What is the incremental lift from geo-targeted spend versus organic demand during events? Only geo-holdouts can answer this.
5. What fraction of 2023 and 2025 event-week revenue was lost to stockouts, and how far ahead did the NIFC outlook signal the risk?

## 10. Sources

- Burke M. et al. (2023). The contribution of wildfire to PM2.5 trends in the USA. *Nature* 622: 761–766. https://www.nature.com/articles/s41586-023-06522-6
- Burke M. et al. (2022). Exposures and behavioural responses to wildfire smoke. *Nature Human Behaviour* 6: 1351–1361. https://www.nature.com/articles/s41562-022-01396-6
- Anderegg W. et al. (2021). Anthropogenic climate change is worsening North American pollen seasons. *PNAS* 118(7). https://www.pnas.org/doi/10.1073/pnas.2013284118
- Shaman J., Kohn M. (2009). Absolute humidity modulates influenza survival, transmission, and seasonality. *PNAS* 106(9). https://pubmed.ncbi.nlm.nih.gov/19204283/
- Shaman J. et al. (2010). Absolute humidity and the seasonal onset of influenza in the continental United States. *PLOS Biology*. https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.1000316
- Myatt T. et al. (2010). Modeling the airborne survival of influenza virus in a residential setting: the impacts of home humidification. *Environmental Health*. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2940868/
- Aguilera R. et al. (2021). Wildfire smoke impacts respiratory health more than fine particles from other sources. *Nature Communications* 12. https://www.nature.com/articles/s41467-021-21708-0
- Chen G. et al. (2021). Mortality risk attributable to wildfire-related PM2.5 pollution: a global time series study in 749 locations. *Lancet Planetary Health* 5. https://www.thelancet.com/journals/lanplh/article/PIIS2542-5196(21)00200-X/fulltext
- Liang Y. et al. (2021). Wildfire smoke impacts on indoor air quality assessed using crowdsourced data in California. *PNAS* 118(36). https://www.pnas.org/doi/10.1073/pnas.2106478118
- Ito K., Zhang S. (2020). Willingness to pay for clean air: evidence from air purifier markets in China. *Journal of Political Economy* 128(5). https://www.journals.uchicago.edu/doi/abs/10.1086/705554
- Zhang J., Mu Q. (2018). Air pollution and defensive expenditures: evidence from particulate-filtering facemasks. *JEEM* 92. https://www.sciencedirect.com/science/article/pii/S0095069617304771
- Barwick P.J., Li S., Lin L., Zou E. (2024). From Fog to Smog: the value of pollution information. *American Economic Review*. https://www.aeaweb.org/articles?id=10.1257/aer.20200956
- Neidell M. (2009). Information, avoidance behavior, and health. NBER w14209. https://www.nber.org/system/files/working_papers/w14209/w14209.pdf
- A Burning Issue: Wildfire Smoke Exposure, Retail Sales, and Demand for Adaptation in Healthcare (2024 working paper). https://www.researchgate.net/publication/384768383
- Wildfires, smoke pollution, and household purchasing behaviors (2026). *Journal of Economic Behavior and Organization*. https://www.sciencedirect.com/science/article/pii/S0167268126000600
- Kim S., Trusov M. (2025). Air pollution and consumer spending. *Journal of Marketing*; AMA summary. https://www.ama.org/2025/02/11/how-does-air-pollution-affect-consumer-spending/
- Federal Reserve Bank of Philadelphia (2024). Extreme wildfires, distant air pollution, and household financial health. WP 24-01. https://www.philadelphiafed.org/-/media/frbp/assets/working-papers/2024/wp24-01.pdf
- Dallas Fed (2024). Dirty air from wildfires casts a cloud over household finances. https://www.dallasfed.org/research/economics/2024/0924
- Ito K. et al. (2015). Daily spring pollen counts, OTC allergy medication sales, and asthma ED visits in NYC. *Environmental Health* 14. https://pmc.ncbi.nlm.nih.gov/articles/PMC4549916/
- Sheffield P. et al. (2011). Tree pollen concentration peaks and allergy medication sales in NYC. *ISRN Allergy*. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3658798/
- Forecasting seasonal allergic rhinitis through social media and online drug sales (2026). *JACI*. https://www.sciencedirect.com/science/article/pii/S1939455126002541
- Barkjohn K. et al. (2022). Correction and accuracy of PurpleAir PM2.5 measurements for extreme wildfire smoke. *Sensors* 22. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9784900/
- Evaluation of the EPA correction equation for PurpleAir in smoke, dust and winter events (2023). *AMT* 16. https://amt.copernicus.org/articles/16/1311/2023/
- Are hourly PM2.5 forecasts sufficiently accurate to plan your day? (2026). *BAMS* 107; preprint https://arxiv.org/pdf/2409.05866
- Operational performance of HRRR smoke forecasting during the Canadian wildfires of summer 2023 (2026). *Weather and Forecasting* 41. https://journals.ametsoc.org/view/journals/wefo/41/6/WAF-D-25-0211.1.xml
- NOAA GSL, Active wildfires test smoke models. https://gsl.noaa.gov/news/active-wildfires-test-smoke-models/
- Google Air Quality API FAQ (validation). https://developers.google.com/maps/documentation/air-quality/faq
- AHAM Verifide (2021). Portable air cleaners and air changes per hour. https://ahamverifide.org/wp-content/uploads/2021/11/White-Paper-Portable-Air-Cleaners-and-AIr-Changes-per-Hour-FINAL-00106301.pdf
- American Lung Association, How to choose an air cleaner for wildfire smoke. https://www.lung.org/blog/how-to-choose-an-air-cleaner
- HEPA cleaner reviews: Barn P. et al. (2016) *Environmental Health*; classroom crossover trial (2025) *JESEE*. https://ehjournal.biomedcentral.com/articles/10.1186/s12940-016-0198-9 ; https://www.nature.com/articles/s41370-025-00743-9
- FTC Health Products Compliance Guidance. https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance
- FTC air purifier enforcement (Kelley Drye summary). https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/ftc-continues-to-target-health-related-advertising-settlement-reached-with-maker-of-vacuum-cleaner-and-air-purifier
- National Interagency Fire Center outlooks, April and September 2026. https://www.nifc.gov/nicc-files/predictive/outlooks/monthly_seasonal_outlook.pdf
- ICC, 2026's fire season is a warning light. https://www.iccsafe.org/building-safety-journal/bsj-dives/2026s-fire-season-is-a-warning-light-building-wildfire-resilience-beyond-fire-season/
- Mordor Intelligence, North America air purifier market. https://www.mordorintelligence.com/industry-reports/north-america-air-purifier-market
- Research and Markets, Global household air purifiers 2025–2030. https://finance.yahoo.com/news/global-market-household-air-purifiers-080700601.html
- Fortune Business Insights, Humidifiers market. https://www.fortunebusinessinsights.com/humidifiers-market-112749
- Fortune Business Insights, Air fryer market. https://www.fortunebusinessinsights.com/air-fryer-market-107276
