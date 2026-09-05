/**
 * Manual / partner-gated signals. Pinterest Trends and Google Trends have no open API for
 * commercial use, so their numbers arrive by POST /api/feeds/manual as observations
 * (metric e.g. recipe_velocity, geo state or national). Stored in settings and re-emitted
 * each cycle until they expire (72h).
 */
const db = require('../db')
module.exports = {
  id: 'manual', name: 'Manual and partner signals (Pinterest, Google Trends)', family: 'cultural', cadence: '*/30 * * * *', requires: null, metrics: ['recipe_velocity'], presentOnly: true,
  async fetch() {
    const items = db.setting('manual_observations', [])
    const cutoff = Date.now() - 72 * 3600000
    const live = items.filter(o => Date.parse(o.observedAt) >= cutoff)
    if (live.length !== items.length) db.setSetting('manual_observations', live)
    return live
  }
}
