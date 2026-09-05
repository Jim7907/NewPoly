const axios = require('axios')
const http = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': 'Barometer/0.1 (VeSync internal; contact via repo)' }
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
/** GET with backoff on 429/5xx — public APIs throttle bursts and the scheduler must survive that. */
async function getWithRetry(url, opts = {}, tries = 4) {
  let wait = 2000
  for (let i = 0; i < tries; i++) {
    try { return await http.get(url, opts) } catch (e) {
      const s = e.response && e.response.status
      if (i === tries - 1 || !(s === 429 || (s >= 500 && s < 600))) throw e
      await sleep(wait); wait *= 2
    }
  }
}
async function getJson(url, opts = {}) { const r = await getWithRetry(url, opts); return r.data }
async function getText(url, opts = {}) { const r = await getWithRetry(url, { ...opts, responseType: 'text' }); return r.data }
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
module.exports = { http, getJson, getText, chunk, sleep }
