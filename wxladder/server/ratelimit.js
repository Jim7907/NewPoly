// Shared token-bucket limiter + a retry that understands rate limiting.
//
// Every upstream here is a free public service (Open-Meteo, Iowa State's IEM archive,
// aviationweather.gov). At 32 stations x 2 kinds a seeding pass fires ~128 requests, which
// is enough to draw a 429 if they go out back-to-back — and a 429 during seeding is silent
// data loss: that station simply ends up with no bias pairs and is then refused for trading.
class RateLimiter {
  constructor(ratePerSec, burst) { this.rate = ratePerSec; this.tokens = burst; this.burst = burst; this.last = Date.now(); }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / 1000 * this.rate);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await new Promise(r => setTimeout(r, Math.ceil((1 - this.tokens) / this.rate * 1000)));
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry transient failures with exponential backoff. A 429 is honoured via Retry-After when
// the server sends one; 4xx other than 429 is a real error and fails fast rather than
// hammering an endpoint that is telling us the request is wrong.
async function withRetry(fn, { tries = 3, baseMs = 1500, label = "" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const status = e && e.response && e.response.status;
      const retriable = status == null || status === 429 || status >= 500;
      if (!retriable || i === tries - 1) break;
      const retryAfter = Number(e?.response?.headers?.["retry-after"]);
      const waitMs = isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : baseMs * Math.pow(2, i);
      if (label) console.error(`[retry] ${label}: ${status || e.message}, waiting ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// Bounded-concurrency map. The token bucket already protects the upstream, so the only
// thing serial iteration buys is latency: at 33 cities x 2 kinds a single slow station
// blocks all 65 behind it, and one scan can outlive the interval that triggers the next.
// Results keep input order; a rejected item resolves to null rather than sinking the batch.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

module.exports = { RateLimiter, withRetry, sleep, mapLimit };
