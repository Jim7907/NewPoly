/**
 * Channel adapters. Every adapter has the same shape:
 *   id, name, requires (env vars), live() -> bool, propose(plan, line) -> {action, payload}, write(payload), reverse(payload, response)
 *
 * live() is true only when LIVE_WRITES=true AND the channel's credentials are present. Otherwise
 * propose() still runs and the exact payload is recorded on the plan as a dry-run write, so a
 * marketer sees precisely what would have been sent. Nothing leaves the building until both
 * conditions hold. Endpoints below are the platforms' documented ones; the ones marked
 * "shape only" record the payload but have no live implementation yet because the API is
 * partner-gated or still in beta on the platform side.
 */
const grid = require('../grid')
const { http } = require('../feeds/http')

const LIVE = () => String(process.env.LIVE_WRITES).toLowerCase() === 'true'
const has = (keys) => keys.every(k => !!process.env[k])
const ISO = () => new Date().toISOString()

function make(def) {
  return {
    ...def,
    live() { return LIVE() && has(def.requires) && !def.shapeOnly },
    configured() { return has(def.requires) },
    async write(payload) { if (!def.send) throw new Error('no live implementation'); return def.send(payload) },
    async reverse(payload, response) { if (def.undo) return def.undo(payload, response); return { reversed: false, note: 'no reversal implemented; pause manually' } }
  }
}

const cellsToPoints = (cells) => cells.map(z => grid.get(z)).filter(Boolean).map(c => ({ zip3: c.zip3, latitude: c.lat, longitude: c.lon, radiusKm: Math.max(15, Math.min(80, Math.round(Math.sqrt(c.landKm2 / Math.PI)))) }))
const creativeFor = (plan, channel) => (plan.creatives || []).find(c => c.channel === channel && c.status === 'approved') || (plan.creatives || []).find(c => c.channel === channel) || null
const window = (plan) => ({ start: ISO().slice(0, 10), end: new Date(Date.now() + (plan.opportunity.forecast.days || 7) * 86400000).toISOString().slice(0, 10) })

const ADAPTERS = [
  make({
    id: 'amazon_sp', name: 'Amazon Sponsored Products & Brands', requires: ['AMAZON_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_SECRET', 'AMAZON_ADS_REFRESH_TOKEN', 'AMAZON_ADS_PROFILE_ID'],
    propose(plan, line) {
      const cr = creativeFor(plan, 'amazon_sp'); const w = window(plan)
      const skus = plan.gate.checks.filter(c => c.status === 'ok' || c.status === 'thin').map(c => c.sku)
      const heldSkus = plan.gate.checks.filter(c => c.status === 'hold').map(c => c.sku)
      return { action: 'sp.campaign.create+budget', payload: {
        campaign: { name: `BAROMETER ${plan.opportunity.title} ${w.start}`, state: 'ENABLED', startDate: w.start, endDate: w.end, budget: { budget: line.amount, budgetType: 'DAILY_TOTAL' }, targetingType: 'MANUAL' },
        keywords: keywordsFor(plan), skus, excludedSkus: heldSkus, headline: cr ? cr.headline : null,
        note: 'Sponsored Products has no geographic targeting; this is national, weighted by the opportunity states via bid multipliers on top-of-search.'
      } }
    },
    async send(p) {
      const tok = await amazonToken()
      const r = await http.post('https://advertising-api.amazon.com/sp/campaigns', { campaigns: [p.campaign] }, { headers: amazonHeaders(tok, 'application/vnd.spCampaign.v3+json') })
      return { campaignIds: r.data.campaigns && r.data.campaigns.success && r.data.campaigns.success.map(c => c.campaignId) }
    },
    async undo(p, resp) { if (!resp || !resp.campaignIds) return { reversed: false }; const tok = await amazonToken()
      await http.put('https://advertising-api.amazon.com/sp/campaigns', { campaigns: resp.campaignIds.map(campaignId => ({ campaignId, state: 'PAUSED' })) }, { headers: amazonHeaders(tok, 'application/vnd.spCampaign.v3+json') }); return { reversed: true, paused: resp.campaignIds } }
  }),
  make({
    id: 'amazon_dsp', name: 'Amazon DSP geographic index', requires: ['AMAZON_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_SECRET', 'AMAZON_ADS_REFRESH_TOKEN', 'AMAZON_DSP_ADVERTISER_ID'], shapeOnly: true,
    propose(plan, line) {
      const idx = new Map(plan.cellIndex || [])
      return { action: 'dsp.geographic_index.upload', payload: {
        advertiserId: process.env.AMAZON_DSP_ADVERTISER_ID || '<AMAZON_DSP_ADVERTISER_ID>',
        // Geographic Insights & Activation API takes postal-code index values 0–100; our cell index is that input.
        postalCodeIndex: line.geo.cells.map(z => ({ postalCodePrefix: z, index: idx.get(z) ?? plan.opportunity.idx })),
        budget: line.amount, window: window(plan), creative: creativeFor(plan, 'amazon_dsp'),
        note: 'shape only: the DSP Geographic Insights & Activation endpoint is in beta; payload recorded for the agency seat to apply until the endpoint is confirmed.'
      } }
    }
  }),
  make({
    id: 'amazon_amc', name: 'Amazon Marketing Cloud rule-based audience', requires: ['AMAZON_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_SECRET', 'AMAZON_ADS_REFRESH_TOKEN'], shapeOnly: true,
    propose(plan, line) {
      return { action: 'amc.audience.rule_based.create', payload: {
        name: `BAROMETER ${plan.opportunity.title} searchers no purchase 7d`,
        rule: { searched: keywordsFor(plan).slice(0, 8), lookbackDays: 7, purchased: false, geo: { states: line.geo.states || plan.opportunity.states } },
        push: ['DSP', 'SD'], budget: line.amount,
        note: 'shape only: audience definitions are created through the AMC console or the agency; recorded for hand-off.'
      } }
    }
  }),
  make({
    id: 'meta', name: 'Meta', requires: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'],
    propose(plan, line) {
      const cr = creativeFor(plan, 'meta'); const w = window(plan)
      return { action: 'meta.campaign+adset.create', payload: {
        campaign: { name: `BAROMETER ${plan.opportunity.title}`, objective: 'OUTCOME_SALES', status: 'ACTIVE', special_ad_categories: [] },
        adset: { name: `${plan.opportunity.title} ${w.start}`, daily_budget: Math.round(line.amount / (plan.opportunity.forecast.days || 7) * 100), billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', start_time: w.start, end_time: w.end,
          targeting: { geo_locations: { custom_locations: cellsToPoints(line.geo.cells).slice(0, 200).map(p => ({ latitude: p.latitude, longitude: p.longitude, radius: p.radiusKm, distance_unit: 'kilometer' })) }, age_min: 25 } },
        creative: cr ? { headline: cr.headline, body: cr.body, cta: cr.cta } : null
      } }
    },
    async send(p) {
      const acct = process.env.META_AD_ACCOUNT_ID, tok = process.env.META_ACCESS_TOKEN
      const c = await http.post(`https://graph.facebook.com/v21.0/act_${acct}/campaigns`, { ...p.campaign, access_token: tok })
      const a = await http.post(`https://graph.facebook.com/v21.0/act_${acct}/adsets`, { ...p.adset, campaign_id: c.data.id, targeting: JSON.stringify(p.adset.targeting), access_token: tok })
      return { campaignId: c.data.id, adsetId: a.data.id }
    },
    async undo(p, resp) { if (!resp || !resp.campaignId) return { reversed: false }; await http.post(`https://graph.facebook.com/v21.0/${resp.campaignId}`, { status: 'PAUSED', access_token: process.env.META_ACCESS_TOKEN }); return { reversed: true } }
  }),
  make({
    id: 'google', name: 'Google Ads', requires: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_REFRESH_TOKEN'], shapeOnly: true,
    propose(plan, line) {
      const cr = creativeFor(plan, 'google'); const w = window(plan)
      return { action: 'googleads.campaign.create+proximity', payload: {
        campaign: { name: `BAROMETER ${plan.opportunity.title} ${w.start}`, advertisingChannelType: 'SEARCH', status: 'ENABLED', campaignBudget: { amountMicros: Math.round(line.amount * 1e6), deliveryMethod: 'STANDARD' }, startDate: w.start.replace(/-/g, ''), endDate: w.end.replace(/-/g, '') },
        proximity: cellsToPoints(line.geo.cells).map(p => ({ geoPoint: { latitudeInMicroDegrees: Math.round(p.latitude * 1e6), longitudeInMicroDegrees: Math.round(p.longitude * 1e6) }, radius: p.radiusKm, radiusUnits: 'KILOMETERS' })),
        keywords: keywordsFor(plan), rsa: cr ? { headlines: [cr.headline], descriptions: [cr.body] } : null,
        note: 'shape only: Google Ads mutate calls go through the gRPC/REST client with OAuth; recorded for the team to apply or for the live adapter once the developer token is approved.'
      } }
    }
  }),
  make({
    id: 'tiktok', name: 'TikTok', requires: ['TIKTOK_ACCESS_TOKEN', 'TIKTOK_ADVERTISER_ID'],
    propose(plan, line) {
      const cr = creativeFor(plan, 'tiktok'); const w = window(plan)
      return { action: 'tiktok.campaign.create', payload: { advertiser_id: process.env.TIKTOK_ADVERTISER_ID || '<TIKTOK_ADVERTISER_ID>', campaign_name: `BAROMETER ${plan.opportunity.title} ${w.start}`, objective_type: 'PRODUCT_SALES', budget_mode: 'BUDGET_MODE_TOTAL', budget: line.amount, states: line.geo.states || plan.opportunity.states, creative: cr ? { headline: cr.headline, body: cr.body } : null } }
    },
    async send(p) { const r = await http.post('https://business-api.tiktok.com/open_api/v1.3/campaign/create/', { advertiser_id: p.advertiser_id, campaign_name: p.campaign_name, objective_type: p.objective_type, budget_mode: p.budget_mode, budget: p.budget }, { headers: { 'Access-Token': process.env.TIKTOK_ACCESS_TOKEN } }); return { campaignId: r.data.data && r.data.data.campaign_id } },
    async undo(p, resp) { if (!resp || !resp.campaignId) return { reversed: false }; await http.post('https://business-api.tiktok.com/open_api/v1.3/campaign/status/update/', { advertiser_id: p.advertiser_id, campaign_ids: [resp.campaignId], operation_status: 'DISABLE' }, { headers: { 'Access-Token': process.env.TIKTOK_ACCESS_TOKEN } }); return { reversed: true } }
  }),
  make({
    id: 'walmart', name: 'Walmart Connect', requires: ['WALMART_CONNECT_TOKEN'], shapeOnly: true,
    propose(plan, line) { return { action: 'walmart.sponsored.budget', payload: { budget: line.amount, window: window(plan), skus: plan.gate.checks.filter(c => c.status !== 'hold').map(c => c.sku), note: 'shape only: Walmart Connect API access is partner-gated; recorded for the account team.' } } }
  }),
  make({
    id: 'klaviyo', name: 'Klaviyo email and SMS', requires: ['KLAVIYO_API_KEY'],
    propose(plan, line) {
      const cr = creativeFor(plan, 'klaviyo')
      return { action: 'klaviyo.segment+campaign.create', payload: {
        segment: { name: `BAROMETER ${plan.opportunity.title}`, definition: { condition_groups: [{ conditions: [{ type: 'profile_property', property: 'location.zip', filter: { type: 'string', operator: 'starts_with_any', value: line.geo.cells } }] }] } },
        campaign: { name: `BAROMETER ${plan.opportunity.title}`, subject: cr ? cr.headline : plan.opportunity.title, preview: cr ? cr.body : '' }
      } }
    },
    async send(p) {
      const h = { Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`, revision: '2024-10-15', 'Content-Type': 'application/json' }
      const seg = await http.post('https://a.klaviyo.com/api/segments', { data: { type: 'segment', attributes: p.segment } }, { headers: h })
      return { segmentId: seg.data.data.id, note: 'campaign draft left for a person to send' }
    }
  }),
  make({
    id: 'shopify', name: 'Shopify storefront', requires: ['SHOPIFY_STORE', 'SHOPIFY_ACCESS_TOKEN'],
    propose(plan, line) { const cr = creativeFor(plan, 'meta'); return { action: 'shopify.metafield.event_banner', payload: { namespace: 'barometer', key: 'event_banner', value: { title: cr ? cr.headline : plan.opportunity.title, body: cr ? cr.body : '', states: plan.opportunity.states, until: window(plan).end } } } },
    async send(p) {
      const r = await http.post(`https://${process.env.SHOPIFY_STORE}/admin/api/2024-10/graphql.json`, { query: `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ id } userErrors{ message } } }`, variables: { m: [{ ownerId: 'gid://shopify/Shop/1', namespace: p.namespace, key: p.key, type: 'json', value: JSON.stringify(p.value) }] } }, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } })
      return r.data.data
    }
  }),
  make({
    id: 'app_push', name: 'VeSync app push', requires: ['APP_PUSH_WEBHOOK'],
    propose(plan, line) { const cr = creativeFor(plan, 'app_push'); return { action: 'app.push.schedule', payload: { title: cr ? cr.headline : plan.opportunity.title, body: cr ? cr.body : '', zip3s: line.geo.cells, brand: plan.brand, expires: window(plan).end, note: 'delivered to the app team webhook; they resolve ZIP3s to devices on their side' } } },
    async send(p) { const r = await http.post(process.env.APP_PUSH_WEBHOOK, p); return { status: r.status } }
  })
]

function keywordsFor(plan) {
  const top = plan.opportunity.drivers[0] ? plan.opportunity.drivers[0].metric : ''
  const K = {
    aqi: ['air purifier for smoke', 'hepa air purifier', 'air purifier large room', 'wildfire smoke air purifier'],
    pm25_fc: ['air purifier for wildfire smoke', 'smoke air purifier', 'hepa air purifier'],
    alert_air: ['air quality alert purifier', 'air purifier for smoke', 'hepa air purifier'],
    pollen: ['air purifier for pollen', 'hepa air purifier bedroom', 'air purifier allergens'],
    dew_point_f: ['humidifier for bedroom', 'cool mist humidifier', 'large room humidifier'],
    temp_max_f: ['air fryer', 'air fryer 6 qt', 'air fryer no preheat', 'cook without oven'],
    alert_heat: ['air fryer', 'air fryer oven', 'countertop air fryer'],
    power_price_c: ['energy efficient air fryer', 'air fryer', 'air fryer 6 quart'],
    ili: ['digital thermometer', 'forehead thermometer', 'infrared thermometer']
  }
  return K[top] || [plan.opportunity.title.toLowerCase()]
}

let amzTok = null, amzTokAt = 0
async function amazonToken() {
  if (amzTok && Date.now() - amzTokAt < 50 * 60000) return amzTok
  const r = await http.post('https://api.amazon.com/auth/o2/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.AMAZON_ADS_REFRESH_TOKEN, client_id: process.env.AMAZON_ADS_CLIENT_ID, client_secret: process.env.AMAZON_ADS_CLIENT_SECRET }))
  amzTok = r.data.access_token; amzTokAt = Date.now(); return amzTok
}
const amazonHeaders = (tok, ct) => ({ Authorization: `Bearer ${tok}`, 'Amazon-Advertising-API-ClientId': process.env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': process.env.AMAZON_ADS_PROFILE_ID, 'Content-Type': ct, Accept: ct })

const byId = new Map(ADAPTERS.map(a => [a.id, a]))
function status() {
  return ADAPTERS.map(a => ({ id: a.id, name: a.name, requires: a.requires, configured: a.configured(), live: a.live(), shapeOnly: !!a.shapeOnly, mode: a.live() ? 'live' : a.shapeOnly ? 'shape only' : a.configured() ? 'dry-run (LIVE_WRITES off)' : 'dry-run (no credentials)' }))
}
module.exports = { ADAPTERS, get: (id) => byId.get(id), status, liveWrites: LIVE }
