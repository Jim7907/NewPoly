/**
 * Creative engine: a brief from the opportunity, then assets per format, then the claim check.
 *
 * Generation uses the Anthropic SDK when ANTHROPIC_API_KEY is set. Without it, template
 * creatives are produced and flagged generated_by='template' so nobody mistakes them for
 * finished copy. The claim check runs on both paths and is the thing that cannot be skipped.
 */
const Anthropic = require('@anthropic-ai/sdk')
const db = require('./db')
const { BRANDS, CHANNELS } = require('./config')
const { TITLES, STATE_NAMES } = require('./score')
const log = require('./log')

const MODEL = process.env.BAROMETER_MODEL || 'claude-opus-5'
const FORMATS = [
  { format: 'meta_feed', channel: 'meta', label: 'Meta feed 1:1', headlineMax: 40, bodyMax: 125 },
  { format: 'meta_story', channel: 'meta', label: 'Meta / Instagram story 9:16', headlineMax: 30, bodyMax: 60 },
  { format: 'tiktok', channel: 'tiktok', label: 'TikTok in-feed 9:16', headlineMax: 30, bodyMax: 100 },
  { format: 'amazon_banner', channel: 'amazon_dsp', label: 'Amazon DSP banner', headlineMax: 50, bodyMax: 90 },
  { format: 'amazon_headline', channel: 'amazon_sp', label: 'Amazon Sponsored Brands headline', headlineMax: 50, bodyMax: 0 },
  { format: 'google_rsa', channel: 'google', label: 'Google responsive search ad', headlineMax: 30, bodyMax: 90 },
  { format: 'app_push', channel: 'app_push', label: 'VeSync app push', headlineMax: 40, bodyMax: 110 },
  { format: 'email', channel: 'klaviyo', label: 'Klaviyo email', headlineMax: 60, bodyMax: 300 }
]

const client = () => (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null)
const fam = (key) => { const [b, f] = key.split(':'); return { brand: b, family: f, b: BRANDS[b], f: BRANDS[b].families[f] } }
const rid = (p) => p + '_' + Math.random().toString(36).slice(2, 10)

// ---------- claim check ----------
const ABSOLUTE = /\b(guarantee\w*|always|never|completely|totally)\b|100\s?%/i
function checkClaims(text, key) {
  const { f } = fam(key)
  const lower = (text || '').toLowerCase()
  const hits = f.claims.deny.filter(w => lower.includes(w.toLowerCase()))
  const checks = [
    { rule: 'no denied phrases', pass: hits.length === 0, detail: hits.length ? `found: ${hits.join(', ')}` : 'clean' },
    { rule: 'no absolute promises', pass: !ABSOLUTE.test(text || ''), detail: ABSOLUTE.test(text || '') ? 'absolute wording' : 'clean' },
    { rule: 'no fear language', pass: !/\b(danger|deadly|toxic|poison|scared|panic)\b/i.test(text || ''), detail: 'checked' }
  ]
  if (key.startsWith('cosori')) {
    const mentionsSaving = /\b(cheaper|save|saving|less to run|cost)\b/i.test(text || '')
    const showsWorking = /\d+\s?(w|watt)/i.test(text || '') && /\d+\s?(min|minute)/i.test(text || '')
    checks.push({ rule: 'energy claims show the arithmetic', pass: !mentionsSaving || showsWorking, detail: mentionsSaving && !showsWorking ? 'cost claim without watts and minutes' : 'ok' })
    checks.push({ rule: 'no savings percentage without working', pass: !/\d+\s?%/.test(text || '') || showsWorking, detail: 'ok' })
  }
  return { pass: checks.every(c => c.pass), checks }
}

// ---------- brief ----------
function driverLine(d) {
  const name = TITLES[d.metric] || d.metric
  const unit = { aqi: 'AQI', pm25_fc: 'µg/m³ forecast', temp_max_f: '°F', dew_point_f: '°F dew point', power_price_c: '¢/kWh', power_yoy: '% yoy', ili: '% ILI', pollen: 'UPI', fires: 'weighted detections', alert_heat: 'severity', alert_air: 'severity' }[d.metric] || ''
  return `${name}: ${d.value} ${unit} (${d.share}% of the score, from ${d.feed})`
}
function buildBrief(opp) {
  const { b, f } = fam(opp.brand)
  const drivers = opp.drivers.slice(0, 4)
  const angle = angleFor(opp)
  return {
    brand: b.name, family: f.name, title: opp.title, where: opp.where_text, index: opp.idx, horizon: opp.horizon,
    signal: drivers.map(driverLine),
    evidence: evidenceFor(opp),
    angle,
    products: f.skus,
    offLimits: f.claims.note + ' Do not use: ' + f.claims.deny.join(', ') + '.',
    mayUse: f.claims.allow,
    tone: 'plain, specific, calm. Say what is happening and what the product measurably does. No exclamation marks.'
  }
}
function angleFor(opp) {
  const top = opp.drivers[0] ? opp.drivers[0].metric : ''
  const A = {
    aqi: 'The public AQI reading in their area is the message. Quote it, then say what the purifier removes and for what room size.',
    pm25_fc: 'Smoke is forecast to arrive. Lead with when, then coverage and CADR.',
    fires: 'Fires nearby, smoke likely. Practical: close windows, run filtration, room coverage.',
    alert_air: 'An official air quality alert is in effect. Cite it. State what the product does, nothing about health.',
    pollen: 'Pollen is peaking over the next few days. Particle removal and filter status; never "allergy relief".',
    dew_point_f: 'Indoor air is dry. Talk about humidity numbers and comfort, tank size and run time.',
    temp_max_f: 'It is too hot to run the oven. Lead with the energy arithmetic: watts × minutes × price.',
    alert_heat: 'Heat advisory in effect. Cooking without heating the house. Show the arithmetic.',
    power_price_c: 'Electricity is expensive here. Cost per cook, with the numbers.',
    power_yoy: 'Electricity prices are up on last year. Cost per cook, with the numbers.',
    ili: 'Flu activity is rising in the region. Thermometers: accuracy and speed. Humidifiers: humidity numbers. No health outcomes.',
    fp_filter: 'Their filter is near the end of its life. Replacement, plainly.',
    cal_shedding: 'Shedding season. Grooming convenience.'
  }
  return A[top] || 'State the condition, then what the product measurably does.'
}
function evidenceFor(opp) {
  const top = opp.drivers[0] ? opp.drivers[0].metric : ''
  if (['aqi', 'pm25_fc', 'fires', 'alert_air'].includes(top)) return 'Purchase response to smoke persists into the week after exposure (scanner data, Environmental and Resource Economics 2024). Spending jumps when readings cross official AQI boundaries (Zhang & Mu 2018).'
  if (top === 'pollen') return 'Allergy product sales peak two days after the pollen count peaks and stay elevated for a week (Ito et al. 2015).'
  if (['temp_max_f', 'alert_heat', 'power_price_c', 'power_yoy'].includes(top)) return 'Households respond to visible energy prices; a full oven at 3,000 W for 45 min is 2.25 kWh, an air fryer at 1,700 W for 18 min is 0.51 kWh.'
  if (top === 'ili') return 'Absolute humidity leads influenza onset by days to weeks (Shaman 2010); ILI is confirmation, humidity is the leading signal.'
  return 'See docs/research for the evidence base.'
}

// ---------- generation ----------
function templateCreatives(opp, brief) {
  const { f } = fam(opp.brand)
  const top = opp.drivers[0] || { metric: '', value: '' }
  const place = (opp.states || [])[0] ? (STATE_NAMES[opp.states[0]] || opp.states[0]) : 'your area'
  const sku = f.skus[0].replace(/^[A-Z]+-/, '').replace(/-/g, ' ')
  const H = {
    aqi: [`Air quality in ${place} is ${Math.round(top.value)} AQI today`, `${sku}: HEPA filtration for rooms up to 1,980 sq ft`],
    pm25_fc: [`Smoke is forecast for ${place} this week`, `${sku}: rated for smoke, sized by room`],
    alert_air: [`Air quality alert in effect for ${place}`, `${sku}: measured particle removal, by room size`],
    pollen: [`Pollen is peaking in ${place} this week`, `${sku}: captures airborne particles down to 0.3 microns`],
    dew_point_f: [`Indoor air in ${place} is dry this week`, `${sku}: holds 40–60% humidity, 50-hour tank`],
    temp_max_f: [`${Math.round(top.value)}°F in ${place}. Skip the oven.`, `1,700 W for 18 minutes: 0.5 kWh per cook`],
    alert_heat: [`Heat advisory in ${place}. Cook without heating the house.`, `1,700 W for 18 minutes: 0.5 kWh, versus 2.25 kWh for a 3,000 W oven`],
    power_price_c: [`Electricity in ${place} is ${top.value}¢/kWh`, `Air fryer: 1,700 W × 18 min ≈ ${(1.7 * 0.3 * top.value).toFixed(0)}¢ a cook`],
    ili: [`Flu activity is rising across ${place}`, `${sku}: readings in 8 seconds, accurate to 0.1°`]
  }[top.metric] || [`${opp.title} in ${place}`, `${sku}`]
  const short = {
    aqi: [`${Math.round(top.value)} AQI in ${place} today`, `HEPA for 1,980 sq ft`], pm25_fc: [`Smoke forecast, ${place}`, `Rated for smoke`], alert_air: [`Air alert: ${place}`, `Measured particle removal`],
    pollen: [`Pollen peak, ${place}`, `Captures 0.3 micron`], dew_point_f: [`Dry air in ${place}`, `40–60% humidity, 50 h`], temp_max_f: [`${Math.round(top.value)}°F. Skip the oven.`, `0.5 kWh a cook`],
    alert_heat: [`Heat advisory, ${place}`, `18 min, 0.5 kWh`], power_price_c: [`${top.value}¢/kWh in ${place}`, `About ${(1.7 * 0.3 * top.value).toFixed(0)}¢ a cook`], ili: [`Flu rising, ${place}`, `8-second readings`]
  }[top.metric] || [opp.title.slice(0, 30), sku.slice(0, 30)]
  return FORMATS.map((fmt, i) => {
    const pair = H[i % 2].length <= fmt.headlineMax ? H : short
    return { format: fmt.format, channel: fmt.channel, headline: pair[i % 2].slice(0, fmt.headlineMax), body: fmt.bodyMax ? `${H[1]}. ${brief.mayUse.slice(0, 2).join(', ')} on the listing.`.slice(0, fmt.bodyMax) : '', cta: 'Shop now', predictedCtr: null }
  })
}

async function generateWithClaude(opp, brief) {
  const c = client(); if (!c) return null
  const { f } = fam(opp.brand)
  const system = `You write advertising copy for VeSync's ${brief.brand} ${brief.family}. Plain, specific, calm English. No exclamation marks, no hype words. Every line must be true from the brief alone. Hard rules: ${brief.offLimits} You may use: ${brief.mayUse.join(', ')}. ${opp.brand.startsWith('cosori') ? 'Any cost or savings claim must show watts and minutes in the same line.' : ''}
Return only JSON: {"creatives":[{"format":"...","headline":"...","body":"...","cta":"...","predictedCtr":0.0}], "headlinePool":[{"headline":"...","predictedCtr":0.0,"tone":"..."}]}. predictedCtr is your estimate as a fraction (e.g. 0.018) and is labelled as an estimate downstream.`
  const user = `Brief:\n${JSON.stringify(brief, null, 2)}\n\nFormats (respect the character limits):\n${FORMATS.map(x => `- ${x.format} (${x.label}): headline ≤ ${x.headlineMax} chars, body ≤ ${x.bodyMax} chars`).join('\n')}\n\nProduce one creative per format and a pool of 6 alternative headlines with different tones.`
  const resp = await c.messages.create({ model: MODEL, max_tokens: 4000, output_config: { effort: 'medium' }, system, messages: [{ role: 'user', content: user }] })
  if (resp.stop_reason === 'refusal') { log.warn('creative', 'model declined; using templates'); return null }
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('')
  const json = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()
  const start = json.indexOf('{'); const parsed = JSON.parse(json.slice(start))
  return parsed
}

async function generate(oppId, actor) {
  const o = db.get('SELECT * FROM opportunities WHERE id=?', [oppId]); if (!o) throw new Error('opportunity not found')
  const opp = { ...o, zip3s: db.parse(o.zip3s, []), states: db.parse(o.states, []), drivers: db.parse(o.drivers, []), forecast: db.parse(o.forecast, {}) }
  const brief = buildBrief(opp)
  const now = new Date().toISOString()
  let generatedBy = 'template'; let creatives; let pool = []
  try {
    const out = await generateWithClaude(opp, brief)
    if (out && Array.isArray(out.creatives) && out.creatives.length) {
      generatedBy = MODEL
      creatives = FORMATS.map(fmt => { const g = out.creatives.find(x => x.format === fmt.format) || {}; return { format: fmt.format, channel: fmt.channel, headline: String(g.headline || '').slice(0, fmt.headlineMax), body: String(g.body || '').slice(0, fmt.bodyMax), cta: g.cta || 'Shop now', predictedCtr: Number.isFinite(g.predictedCtr) ? g.predictedCtr : null } })
      pool = Array.isArray(out.headlinePool) ? out.headlinePool : []
    }
  } catch (e) { log.warn('creative', `generation failed (${e.message}); using templates`) }
  if (!creatives) creatives = templateCreatives(opp, brief)
  db.tx(() => {
    db.run('INSERT INTO briefs(opportunity_id,brief,generated_by,created_at) VALUES(?,?,?,?) ON CONFLICT(opportunity_id) DO UPDATE SET brief=excluded.brief, generated_by=excluded.generated_by, created_at=excluded.created_at', [oppId, JSON.stringify({ ...brief, headlinePool: pool }), generatedBy, now])
    db.run('DELETE FROM creatives WHERE opportunity_id=?', [oppId])
    for (const cr of creatives) {
      const check = checkClaims(`${cr.headline} ${cr.body}`, opp.brand)
      db.run('INSERT INTO creatives(id,opportunity_id,brand,format,channel,headline,body,cta,claims,checks,status,generated_by,predicted_ctr,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [rid('cr'), oppId, opp.brand, cr.format, cr.channel, cr.headline, cr.body, cr.cta, JSON.stringify(fam(opp.brand).f.claims.allow), JSON.stringify(check.checks), check.pass ? 'draft' : 'blocked', generatedBy, cr.predictedCtr, now])
    }
    db.run("UPDATE opportunities SET status=CASE WHEN status='detected' THEN 'drafting' ELSE status END, updated_at=? WHERE id=?", [now, oppId])
  })
  db.audit(actor, 'creative.generated', { oppId, generatedBy, count: creatives.length })
  return forOpportunity(oppId)
}

function forOpportunity(oppId) {
  const brief = db.get('SELECT * FROM briefs WHERE opportunity_id=?', [oppId])
  const creatives = db.all('SELECT * FROM creatives WHERE opportunity_id=? ORDER BY created_at', [oppId]).map(c => ({ ...c, claims: db.parse(c.claims, []), checks: db.parse(c.checks, []), label: (FORMATS.find(f => f.format === c.format) || {}).label }))
  return { brief: brief ? { ...db.parse(brief.brief, {}), generatedBy: brief.generated_by, createdAt: brief.created_at } : null, creatives, generationEnabled: !!process.env.ANTHROPIC_API_KEY, model: MODEL }
}

function setStatus(id, status, actor) {
  if (!['draft', 'approved', 'blocked'].includes(status)) throw new Error('bad status')
  const c = db.get('SELECT * FROM creatives WHERE id=?', [id]); if (!c) throw new Error('creative not found')
  if (status === 'approved') { const check = checkClaims(`${c.headline} ${c.body}`, c.brand); if (!check.pass) throw new Error('claim check fails: ' + check.checks.filter(x => !x.pass).map(x => x.detail).join('; ')) }
  db.run('UPDATE creatives SET status=? WHERE id=?', [status, id]); db.audit(actor, 'creative.' + status, { id })
  return db.get('SELECT * FROM creatives WHERE id=?', [id])
}

function update(id, fields, actor) {
  const c = db.get('SELECT * FROM creatives WHERE id=?', [id]); if (!c) throw new Error('creative not found')
  const headline = fields.headline ?? c.headline, body = fields.body ?? c.body, cta = fields.cta ?? c.cta
  const check = checkClaims(`${headline} ${body}`, c.brand)
  db.run('UPDATE creatives SET headline=?, body=?, cta=?, checks=?, status=? WHERE id=?', [headline, body, cta, JSON.stringify(check.checks), check.pass ? 'draft' : 'blocked', id])
  db.audit(actor, 'creative.edited', { id })
  return { ...db.get('SELECT * FROM creatives WHERE id=?', [id]), checks: check.checks }
}

module.exports = { generate, forOpportunity, checkClaims, setStatus, update, buildBrief, FORMATS, MODEL }
