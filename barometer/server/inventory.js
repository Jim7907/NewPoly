/**
 * Inventory sources. The gate needs fulfillable + inbound units and a daily sell rate per SKU.
 * Two sources ship:
 *   manual  — POST /api/inventory (or a CSV) — usable on day one
 *   amazon  — SP-API FBA Inventory (getInventorySummaries) — active when AMAZON_SP_* credentials exist
 * Both write the same table; the most recent update per SKU wins.
 */
const db = require('./db')
const { BRANDS } = require('./config')
const { http } = require('./feeds/http')

function seedCatalog() {
  // Every configured SKU exists in the table even before any inventory source reports, so the gate
  // can say "unknown cover" rather than silently passing.
  const now = new Date().toISOString()
  for (const [brand, b] of Object.entries(BRANDS)) for (const [family, f] of Object.entries(b.families)) {
    for (const sku of f.skus) {
      const siblings = f.skus.filter(s => s !== sku)
      db.run(`INSERT INTO inventory(sku,brand,name,family,fulfillable,inbound,daily_rate,siblings,source,updated_at)
              VALUES(?,?,?,?,0,0,0,?,'catalog',?) ON CONFLICT(sku) DO UPDATE SET siblings=excluded.siblings, family=excluded.family`,
        [sku, brand, sku.replace(/^[A-Z]+-/, '').replace(/-/g, ' '), family, JSON.stringify(siblings), now])
    }
  }
}

function upsert(rows, source) {
  const now = new Date().toISOString(); let n = 0
  db.tx(() => {
    for (const r of rows) {
      if (!r.sku) continue
      const ex = db.get('SELECT brand, family, siblings, name FROM inventory WHERE sku=?', [r.sku])
      const name = r.name || (ex && ex.name) || String(r.sku).replace(/^[A-Z]+-/, '').replace(/-/g, ' ')
      db.run(`INSERT INTO inventory(sku,brand,name,family,fulfillable,inbound,daily_rate,siblings,marketplace,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(sku) DO UPDATE SET name=COALESCE(excluded.name,inventory.name), fulfillable=excluded.fulfillable, inbound=excluded.inbound,
              daily_rate=CASE WHEN excluded.daily_rate>0 THEN excluded.daily_rate ELSE inventory.daily_rate END, source=excluded.source, updated_at=excluded.updated_at`,
        [r.sku, r.brand || (ex && ex.brand) || 'unknown', name, r.family || (ex && ex.family) || null,
          Number(r.fulfillable) || 0, Number(r.inbound) || 0, Number(r.dailyRate) || 0, (ex && ex.siblings) || '[]', r.marketplace || 'amazon', source, now])
      n++
    }
  })
  return n
}

function list(brand) {
  const rows = brand ? db.all('SELECT * FROM inventory WHERE brand=? ORDER BY sku', [brand]) : db.all('SELECT * FROM inventory ORDER BY brand, sku')
  return rows.map(r => ({ ...r, siblings: db.parse(r.siblings, []), coverDays: r.daily_rate > 0 ? +((r.fulfillable + 0.5 * r.inbound) / r.daily_rate).toFixed(1) : null }))
}

// ---- Amazon SP-API FBA Inventory adapter (live when credentials exist) ----
const amazon = {
  id: 'amazon_sp_inventory', requires: ['AMAZON_SP_CLIENT_ID', 'AMAZON_SP_CLIENT_SECRET', 'AMAZON_SP_REFRESH_TOKEN'],
  enabled() { return this.requires.every(k => !!process.env[k]) },
  async token() {
    const r = await http.post('https://api.amazon.com/auth/o2/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.AMAZON_SP_REFRESH_TOKEN, client_id: process.env.AMAZON_SP_CLIENT_ID, client_secret: process.env.AMAZON_SP_CLIENT_SECRET }))
    return r.data.access_token
  },
  async sync() {
    if (!this.enabled()) return { skipped: true, reason: 'AMAZON_SP_* credentials not set' }
    const tok = await this.token()
    const r = await http.get('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries', { headers: { 'x-amz-access-token': tok }, params: { details: true, granularityType: 'Marketplace', granularityId: 'ATVPDKIKX0DER', marketplaceIds: 'ATVPDKIKX0DER' } })
    const rows = (r.data.payload && r.data.payload.inventorySummaries || []).map(s => ({
      sku: s.sellerSku, name: s.productName, fulfillable: s.inventoryDetails && s.inventoryDetails.fulfillableQuantity, inbound: s.inventoryDetails && (s.inventoryDetails.inboundWorkingQuantity + s.inventoryDetails.inboundShippedQuantity + s.inventoryDetails.inboundReceivingQuantity)
    }))
    return { updated: upsert(rows, 'amazon_sp_api') }
  }
}

module.exports = { seedCatalog, upsert, list, amazon }
