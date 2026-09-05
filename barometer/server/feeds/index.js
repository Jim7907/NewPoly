/**
 * Feed registry and scheduler.
 *
 * A feed is { id, family, cadence (cron), requires (env var or null), fetch() -> Observation[] }.
 * An Observation is { metric, geo:{kind:'point'|'zip3'|'state'|'national', key?, lat?, lon?},
 *                     value, unit?, horizonHours? (0 = now), observedAt, meta? }.
 * Feeds never touch the score directly: normalise.js resolves observations onto the grid.
 */
const cron = require('node-cron')
const db = require('../db')
const log = require('../log')

const FEEDS = [
  require('./openmeteo').airQuality,
  require('./openmeteo').weather,
  require('./nws'),
  require('./fluview'),
  require('./bls'),
  require('./eia'),
  require('./airnow'),
  require('./purpleair'),
  require('./firms'),
  require('./googlepollen'),
  require('./calendar'),
  require('./firstparty'),
  require('./manual')
]

function enabled(feed) { return !feed.requires || !!process.env[feed.requires] }

async function runFeed(feed) {
  const t0 = Date.now()
  const now = new Date().toISOString()
  if (!enabled(feed)) {
    db.run(`INSERT INTO feed_status(feed,family,enabled,last_error) VALUES(?,?,0,?)
            ON CONFLICT(feed) DO UPDATE SET enabled=0, family=excluded.family, last_error=excluded.last_error`,
      [feed.id, feed.family, `waiting for ${feed.requires}`])
    return { feed: feed.id, skipped: true }
  }
  try {
    const obs = await feed.fetch()
    db.tx(() => {
      // keep the table bounded: each poll replaces the feed's previous batch
      db.run('DELETE FROM observations WHERE feed=?', [feed.id])
      const stmt = `INSERT INTO observations(feed,family,metric,geo_kind,geo_key,lat,lon,value,unit,horizon_hours,observed_at,fetched_at,meta)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      for (const o of obs) {
        if (o.value == null || Number.isNaN(o.value)) continue
        db.run(stmt, [feed.id, feed.family, o.metric, o.geo.kind, o.geo.key || null, o.geo.lat ?? null, o.geo.lon ?? null,
          o.value, o.unit || null, o.horizonHours || 0, o.observedAt || now, now, db.json(o.meta)])
      }
      db.run(`INSERT INTO feed_status(feed,family,enabled,last_ok,last_error,last_count,last_ms) VALUES(?,?,1,?,NULL,?,?)
              ON CONFLICT(feed) DO UPDATE SET enabled=1, family=excluded.family, last_ok=excluded.last_ok, last_error=NULL,
              last_count=excluded.last_count, last_ms=excluded.last_ms`,
        [feed.id, feed.family, now, obs.length, Date.now() - t0])
    })
    log.info('feed', `${feed.id}: ${obs.length} observations in ${Date.now() - t0}ms`)
    return { feed: feed.id, count: obs.length }
  } catch (e) {
    const msg = (e && e.message) ? e.message.slice(0, 300) : String(e)
    db.run(`INSERT INTO feed_status(feed,family,enabled,last_error,last_ms) VALUES(?,?,1,?,?)
            ON CONFLICT(feed) DO UPDATE SET enabled=1, last_error=excluded.last_error, last_ms=excluded.last_ms`,
      [feed.id, feed.family, msg, Date.now() - t0])
    log.warn('feed', `${feed.id} failed: ${msg}`)
    return { feed: feed.id, error: msg }
  }
}

async function runAll() {
  const out = []
  for (const f of FEEDS) out.push(await runFeed(f))
  return out
}

function schedule(onAfter) {
  for (const f of FEEDS) {
    cron.schedule(f.cadence, async () => { await runFeed(f); if (onAfter) onAfter(f.id) })
  }
}

function status() {
  const rows = db.all('SELECT * FROM feed_status')
  const byId = new Map(rows.map(r => [r.feed, r]))
  return FEEDS.map(f => {
    const r = byId.get(f.id) || {}
    return {
      id: f.id, family: f.family, name: f.name, cadence: f.cadence, requires: f.requires || null,
      enabled: enabled(f), lastOk: r.last_ok || null, lastError: r.last_error || null,
      lastCount: r.last_count || 0, lastMs: r.last_ms || 0
    }
  })
}

/** Metrics the score should expect: every metric an enabled feed produces, plus metrics from
 *  present-only feeds (first-party, manual) when they actually have data. A feed that is enabled
 *  but failed this cycle still counts — its absence is 'no evidence', not 'not measured'. */
function expectedMetrics(measured, byFeed) {
  const out = new Set()
  for (const f of FEEDS) {
    if (!enabled(f)) continue
    if (f.presentOnly) { for (const m of (byFeed && byFeed.get(f.id)) || []) out.add(m) }   // whatever it actually carries right now
    else for (const m of f.metrics || []) out.add(m)
  }
  return out
}

module.exports = { FEEDS, runFeed, runAll, schedule, status, enabled, expectedMetrics }
