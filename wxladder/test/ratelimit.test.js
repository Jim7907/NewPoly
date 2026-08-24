const test = require("node:test");
const assert = require("node:assert");
const { RateLimiter, withRetry } = require("../server/ratelimit");

const err = (status, headers) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers: headers || {} } });

test("RateLimiter spends its burst immediately then throttles", async () => {
  const rl = new RateLimiter(50, 3);
  const t0 = Date.now();
  await rl.acquire(); await rl.acquire(); await rl.acquire();
  assert.ok(Date.now() - t0 < 30, "the burst is free");
  await rl.acquire();
  assert.ok(Date.now() - t0 >= 15, "the fourth call waits for a refill");
});

test("withRetry retries a 429 and eventually succeeds", async () => {
  let calls = 0;
  const r = await withRetry(async () => { if (++calls < 3) throw err(429); return "ok"; }, { baseMs: 1 });
  assert.equal(r, "ok");
  assert.equal(calls, 3);
});

test("withRetry retries 5xx and network errors but fails fast on a real 4xx", async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw err(404); }, { baseMs: 1 }));
  assert.equal(calls, 1, "a 404 is not transient — do not hammer it");

  calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw err(503); }, { tries: 3, baseMs: 1 }));
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw new Error("ECONNRESET"); }, { tries: 2, baseMs: 1 }));
  assert.equal(calls, 2, "a bare network error is retried");
});

test("withRetry honours Retry-After when the server sends one", async () => {
  let calls = 0;
  const t0 = Date.now();
  await withRetry(async () => { if (++calls < 2) throw err(429, { "retry-after": "0.05" }); return "ok"; }, { baseMs: 10000 });
  assert.ok(Date.now() - t0 < 5000, "waits the server's interval, not the default backoff");
});

test("withRetry surfaces the last error after exhausting its tries", async () => {
  await assert.rejects(() => withRetry(async () => { throw err(429); }, { tries: 2, baseMs: 1 }), /429/);
});

test("mapLimit preserves order, caps concurrency, and isolates failures", async () => {
  const { mapLimit } = require("../server/ratelimit");
  let inFlight = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    if (x === 4) throw new Error("boom");
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, null, 50, 60, 70, 80], "order kept, failure isolated to its slot");
  assert.ok(peak <= 3, `concurrency capped, saw ${peak}`);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});
