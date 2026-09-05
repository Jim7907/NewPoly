/**
 * Barometer configuration — the "decide" layer as data.
 *
 * Everything here traces to docs/research/. Weights start as rules and are
 * refitted from holdout results (see measure.js); thresholds are the public AQI
 * category boundaries because that is where consumer behaviour changes
 * (Zhang & Mu 2018). Horizons follow published forecast skill.
 */

// ---------- metrics: canonical names every feed writes ----------
// A "shape" turns a raw value into a 0..1 pressure. Piecewise-linear over the
// listed (value, score) points; clamped at the ends.
const SHAPES = {
  // US AQI category boundaries 50/100/150/200: the numbers people see on their phone.
  aqi:        [[0, 0], [50, 0.05], [100, 0.3], [101, 0.45], [150, 0.7], [151, 0.8], [200, 0.95], [201, 1]],
  pm25:       [[0, 0], [12, 0.05], [35, 0.3], [55, 0.6], [150, 0.9], [250, 1]],
  fires:      [[0, 0], [1, 0.3], [5, 0.6], [20, 0.9], [50, 1]],          // active fire detections within 150 km
  alert:      [[0, 0], [1, 0.6], [2, 0.85], [3, 1]],                    // NWS alert severity: 1 minor 2 moderate 3 severe+
  pollen:     [[0, 0], [1, 0.15], [2, 0.4], [3, 0.7], [4, 0.9], [5, 1]], // Google Pollen UPI 0-5
  heat_f:     [[85, 0], [95, 0.3], [100, 0.55], [105, 0.8], [110, 1]],   // daily max °F
  dew_low_f:  [[45, 0], [35, 0.35], [25, 0.7], [15, 0.9], [5, 1]],       // dew point °F, lower = drier = humidifier pressure
  rh_low:     [[45, 0], [35, 0.4], [25, 0.8], [15, 1]],
  cold_f:     [[45, 0], [35, 0.3], [25, 0.6], [15, 0.85], [5, 1]],
  ili:        [[1, 0], [2, 0.2], [3, 0.5], [4, 0.75], [6, 1]],           // CDC weighted ILI %
  power_c:    [[12, 0], [15, 0.25], [18, 0.5], [22, 0.75], [28, 1]],     // residential ¢/kWh
  power_yoy:  [[0, 0], [5, 0.3], [10, 0.6], [18, 0.85], [30, 1]],        // % change year on year
  food_yoy:   [[0, 0], [2, 0.2], [4, 0.5], [6, 0.8], [10, 1]],           // food-at-home CPI % yoy
  velocity:   [[0, 0], [20, 0.3], [50, 0.6], [100, 0.85], [200, 1]],     // % change in recipe / hashtag interest
  fp_pm25:    [[0, 0], [12, 0.1], [35, 0.5], [55, 0.8], [100, 1]],       // indoor PM2.5 from the fleet (corrected)
  fp_filter:  [[100, 0], [40, 0.2], [25, 0.6], [15, 0.9], [5, 1]],       // remaining filter life %, lower = replacement pressure
  fp_run:     [[0, 0], [10, 0.2], [30, 0.5], [60, 0.8], [100, 1]],       // % change in run hours vs 14-day baseline
  fp_cook:    [[0, 0], [5, 0.2], [15, 0.5], [30, 0.8], [50, 1]],         // % change in cook sessions vs baseline
  calendar:   [[0, 0], [1, 1]]
}

function shape(name, v) {
  const pts = SHAPES[name]; if (!pts || v == null || Number.isNaN(v)) return null
  const asc = pts[0][0] <= pts[pts.length - 1][0]
  const ordered = asc ? pts : [...pts].reverse()
  if (v <= ordered[0][0]) return ordered[0][1]
  if (v >= ordered[ordered.length - 1][0]) return ordered[ordered.length - 1][1]
  for (let i = 1; i < ordered.length; i++) {
    const [x0, y0] = ordered[i - 1], [x1, y1] = ordered[i]
    if (v <= x1) return y0 + (y1 - y0) * ((v - x0) / (x1 - x0))
  }
  return ordered[ordered.length - 1][1]
}

// ---------- brands and product families ----------
// Each family subscribes to the signals that move it. `weight` is the starting
// contribution; `shape` names the transform above; `horizons` says which
// horizons this signal may drive (a monthly CPI series should not "activate").
const BRANDS = {
  levoit: {
    name: 'Levoit', color: '#0FA3A3',
    families: {
      air: {
        name: 'Air purifiers',
        skus: ['LEVOIT-CORE-400S', 'LEVOIT-CORE-300S', 'LEVOIT-CORE-200S', 'LEVOIT-CORE-MINI'],
        baselineDailyUnitsPerCell: 9, avgPrice: 149, elasticity: 1.9,
        signals: [
          { metric: 'aqi',        shape: 'aqi',      weight: 30, horizons: ['act'] },
          { metric: 'pm25_fc',    shape: 'pm25',     weight: 22, horizons: ['act', 'schedule'] },
          { metric: 'fires',      shape: 'fires',    weight: 12, horizons: ['act', 'schedule'] },
          { metric: 'alert_air',  shape: 'alert',    weight: 10, horizons: ['act'] },
          { metric: 'pollen',     shape: 'pollen',   weight: 8,  horizons: ['act', 'schedule'] },
          { metric: 'fp_pm25',    shape: 'fp_pm25',  weight: 12, horizons: ['act'] },
          { metric: 'fp_filter',  shape: 'fp_filter', weight: 6, horizons: ['act', 'schedule'] }
        ],
        claims: {
          allow: ['CADR', 'coverage', 'particle removal', 'filter status', 'public AQI', 'HEPA'],
          deny: ['cure', 'prevent', 'flu', 'virus', 'asthma', 'allergy relief', 'medical', 'kills', 'germs', 'healthier', 'protect your family'],
          note: 'No health outcomes. Measured particle removal, CADR, room coverage and the public AQI reading only.'
        }
      },
      humidity: {
        name: 'Humidifiers',
        skus: ['LEVOIT-LV600S', 'LEVOIT-CLASSIC-300S', 'LEVOIT-DUAL-200S'],
        baselineDailyUnitsPerCell: 5, avgPrice: 79, elasticity: 1.3,
        signals: [
          { metric: 'dew_point_f', shape: 'dew_low_f', weight: 30, horizons: ['act', 'schedule'] },
          { metric: 'rh',          shape: 'rh_low',    weight: 15, horizons: ['act'] },
          { metric: 'temp_min_f',  shape: 'cold_f',    weight: 15, horizons: ['act', 'schedule'] },
          { metric: 'ili',         shape: 'ili',       weight: 25, horizons: ['schedule', 'watch'] },
          { metric: 'fp_run',      shape: 'fp_run',    weight: 15, horizons: ['act'] }
        ],
        claims: {
          allow: ['humidity level', 'tank size', 'run time', 'coverage', 'dry air'],
          deny: ['flu', 'virus', 'cure', 'prevent', 'medical', 'healthier', 'immune'],
          note: 'Humidity numbers and comfort only. Never a health outcome.'
        }
      }
    }
  },
  cosori: {
    name: 'Cosori', color: '#D9662E',
    families: {
      kitchen: {
        name: 'Air fryers',
        skus: ['COSORI-PRO-LE-5QT', 'COSORI-TURBOBLAZE-6QT', 'COSORI-DUAL-BLAZE-6.8QT'],
        baselineDailyUnitsPerCell: 7, avgPrice: 119, elasticity: 1.1,
        signals: [
          { metric: 'power_price_c', shape: 'power_c',   weight: 22, horizons: ['schedule', 'watch'] },
          { metric: 'power_yoy',     shape: 'power_yoy', weight: 18, horizons: ['schedule', 'watch'] },
          { metric: 'temp_max_f',    shape: 'heat_f',    weight: 25, horizons: ['act', 'schedule'] },
          { metric: 'alert_heat',    shape: 'alert',     weight: 10, horizons: ['act'] },
          { metric: 'food_yoy',      shape: 'food_yoy',  weight: 8,  horizons: ['watch'] },
          { metric: 'recipe_velocity', shape: 'velocity', weight: 9, horizons: ['act', 'schedule'] },
          { metric: 'fp_cook',       shape: 'fp_cook',   weight: 8,  horizons: ['act'] }
        ],
        claims: {
          allow: ['cheaper to run', 'kWh', 'watts', 'minutes', 'cost per cook', 'no preheat'],
          deny: ['healthier', 'healthy', 'weight loss', 'diet', 'nutrition', 'low fat', 'bill shock', 'can\'t afford'],
          note: 'Energy claims only with the arithmetic shown (watts × time × price). No nutrition or health language. No fear language about bills.'
        }
      }
    }
  },
  etekcity: {
    name: 'Etekcity', color: '#5B6ABF',
    families: {
      measure: {
        name: 'Scales and thermometers',
        skus: ['ETEKCITY-ESF24', 'ETEKCITY-EFT-100', 'ETEKCITY-EK4150'],
        baselineDailyUnitsPerCell: 4, avgPrice: 29, elasticity: 0.8,
        signals: [
          { metric: 'ili',          shape: 'ili',      weight: 45, horizons: ['act', 'schedule', 'watch'] },
          { metric: 'cal_newyear',  shape: 'calendar', weight: 30, horizons: ['schedule', 'watch'] },
          { metric: 'cal_backtoschool', shape: 'calendar', weight: 25, horizons: ['schedule', 'watch'] }
        ],
        claims: {
          allow: ['accuracy', 'increments', 'sync', 'app', 'readings'],
          deny: ['diagnose', 'detect fever', 'medical', 'clinical', 'doctor', 'weight loss'],
          note: 'Measurement accuracy only. Never diagnosis, never a medical claim.'
        }
      }
    }
  },
  pawsync: {
    name: 'Pawsync', color: '#4E9B62',
    families: {
      pet: {
        name: 'Pet care',
        skus: ['PAWSYNC-GROOM-PRO', 'PAWSYNC-FEEDER-S1', 'PAWSYNC-FOUNTAIN-2L'],
        baselineDailyUnitsPerCell: 3, avgPrice: 69, elasticity: 0.9,
        signals: [
          { metric: 'pollen',      shape: 'pollen',   weight: 35, horizons: ['act', 'schedule'] },
          { metric: 'temp_max_f',  shape: 'heat_f',   weight: 20, horizons: ['act', 'schedule'] },
          { metric: 'cal_shedding', shape: 'calendar', weight: 30, horizons: ['schedule', 'watch'] },
          { metric: 'fp_run',      shape: 'fp_run',   weight: 15, horizons: ['act'] }
        ],
        claims: {
          allow: ['shedding', 'grooming', 'portion', 'schedule', 'quiet'],
          deny: ['vet', 'cure', 'treat', 'medical', 'allergy relief', 'healthier pet'],
          note: 'Grooming and feeding convenience. No veterinary or health claims.'
        }
      }
    }
  }
}

// ---------- horizons (from forecast-skill evidence) ----------
const HORIZONS = {
  act:      { label: 'Act',      hours: [0, 72],       canSpend: true,  note: 'Smoke, AQI, alerts. Point forecasts are usable here.' },
  schedule: { label: 'Schedule', hours: [72, 168],     canSpend: true,  note: 'Pollen, humidity, heat. Build and approve ahead of the peak.' },
  watch:    { label: 'Watch',    hours: [168, 720],    canSpend: false, note: 'Directional only. Moves inventory, never media money.' }
}

// ---------- freshness: a stale feed drops out of the score rather than freezing ----------
// Full weight until `fullHours`, linear to zero at `zeroHours`.
const FRESHNESS = {
  aqi: [3, 12], pm25_fc: [6, 24], fires: [6, 36], alert_air: [2, 8], alert_heat: [2, 12], pollen: [24, 72],
  temp_max_f: [12, 48], temp_min_f: [12, 48], dew_point_f: [12, 48], rh: [6, 24],
  ili: [24 * 8, 24 * 16], power_price_c: [24 * 45, 24 * 90], power_yoy: [24 * 45, 24 * 90], food_yoy: [24 * 45, 24 * 90],
  recipe_velocity: [24 * 2, 24 * 5], fp_pm25: [1, 6], fp_filter: [24, 72], fp_run: [2, 12], fp_cook: [2, 12],
  cal_newyear: [24 * 400, 24 * 401], cal_backtoschool: [24 * 400, 24 * 401], cal_shedding: [24 * 400, 24 * 401]
}

// ---------- opportunity detection ----------
const DETECT = {
  cellThreshold: 55,      // index a cell must reach to be part of an opportunity
  singleCellThreshold: 75, // or a single cell this hot on its own
  clusterKm: 170,          // cells within this distance cluster into one opportunity
  minCells: 2,
  ladder: [[0, 'quiet'], [26, 'building'], [46, 'elevated'], [66, 'high'], [81, 'severe'], [93, 'extreme']]
}

// ---------- channel routing: starting shares per brand, refit from results ----------
const CHANNELS = {
  amazon_sp:   { name: 'Amazon Sponsored Products & Brands', geo: 'national', kind: 'search' },
  amazon_dsp:  { name: 'Amazon DSP',                          geo: 'zip3',     kind: 'display' },
  amazon_amc:  { name: 'Amazon Marketing Cloud audiences',    geo: 'dma',      kind: 'audience' },
  meta:        { name: 'Meta',                                geo: 'zip3',     kind: 'social' },
  google:      { name: 'Google Ads',                          geo: 'zip3',     kind: 'search' },
  tiktok:      { name: 'TikTok',                              geo: 'dma',      kind: 'social' },
  walmart:     { name: 'Walmart Connect',                     geo: 'national', kind: 'retail' },
  klaviyo:     { name: 'Klaviyo email and SMS',               geo: 'zip3',     kind: 'crm' },
  shopify:     { name: 'Shopify storefront',                  geo: 'zip3',     kind: 'dtc' },
  app_push:    { name: 'VeSync app push',                     geo: 'zip3',     kind: 'owned' }
}
const ROUTING = {
  levoit:   { amazon_dsp: 0.34, amazon_sp: 0.24, meta: 0.16, google: 0.10, amazon_amc: 0.06, klaviyo: 0.04, app_push: 0.04, tiktok: 0.02 },
  cosori:   { amazon_sp: 0.30, amazon_dsp: 0.22, meta: 0.18, tiktok: 0.12, google: 0.08, klaviyo: 0.05, app_push: 0.05 },
  etekcity: { amazon_sp: 0.40, amazon_dsp: 0.20, google: 0.15, meta: 0.15, klaviyo: 0.10 },
  pawsync:  { meta: 0.30, amazon_sp: 0.25, tiktok: 0.20, amazon_dsp: 0.15, klaviyo: 0.10 }
}

// ---------- money rules ----------
const MONEY = {
  dailyCapUsd: 120000,           // across all live plans
  eventCapUsd: 80000,            // a single plan may not exceed this without a person raising it
  singleWriteHoldUsd: 25000,     // any single write above this waits for a person
  undoWindowSeconds: 90,         // kill switch window after launch
  budgetPerForecastRevenue: 0.20 // proposed media = 20% of forecast incremental revenue
}

// ---------- privacy floor for first-party data ----------
const PRIVACY = { minDevicesPerCell: 1000 }

// ---------- holdout ----------
const HOLDOUT = { targetCells: 22, minCells: 20, maxCells: 25 }

module.exports = { SHAPES, shape, BRANDS, HORIZONS, FRESHNESS, DETECT, CHANNELS, ROUTING, MONEY, PRIVACY, HOLDOUT }
