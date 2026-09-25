const test = require("node:test");
const assert = require("node:assert");
const { scoreText, newsSignals, socialSignals, fearGreedSignal, _lexiconSize } = require("../server/analysis/sentiment");

const H = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 25, 12);

test("lexicon has several hundred entries", () => {
  assert.ok(_lexiconSize() >= 400, `size ${_lexiconSize()}`);
});

test("scoreText: empty / non-string -> 0 hits", () => {
  for (const t of ["", null, undefined, 42, "the company held its annual meeting"]) {
    const r = scoreText(t);
    assert.equal(r.hits, 0);
    assert.equal(r.score, 0);
  }
});

test("scoreText: negation flips positives", () => {
  assert.ok(scoreText("good").score > 0);
  assert.ok(scoreText("not good").score < 0);
  assert.ok(scoreText("results were not very strong").score < 0);
  assert.ok(scoreText("Nvidia fails to beat estimates").score < 0);
  // negated negative is only weakly positive
  const nb = scoreText("not bad").score;
  assert.ok(nb > 0 && nb < scoreText("good").score);
  // negation does not cross clause boundaries
  assert.ok(scoreText("no surprise. Revenue surged").score > 0);
});

test("scoreText: domain phrases", () => {
  assert.ok(scoreText("Apple beats estimates").score > 0.5);
  assert.ok(scoreText("Tesla faces SEC probe").score < -0.5);
  assert.ok(scoreText("Company slashes guidance").score < -0.5);
  assert.ok(scoreText("Microsoft raises guidance after record revenue").score > 0.7);
  assert.ok(scoreText("Exchange hacked, withdrawals halted").score < -0.8);
  assert.ok(scoreText("SEC approves spot bitcoin ETF approval").score > 0.5);
  assert.ok(scoreText("Crypto firm files for bankruptcy").severe);
  assert.ok(scoreText("Coin faces delisting").score < -0.5);
  assert.ok(scoreText("DeFi protocol exploit drains $100M").score < -0.5);
  // LM: finance-neutral words are not negative
  assert.equal(scoreText("tax liabilities and capital costs").hits, 0);
});

test("scoreText: intensifiers and diminishers scale", () => {
  const base = scoreText("shares rise").score;
  assert.ok(scoreText("shares rise sharply").score >= base);
  assert.ok(scoreText("shares sharply rise").score > base);
  assert.ok(scoreText("shares slightly rise").score < base);
});

test("newsSignals: recency decay favours fresh headlines", () => {
  const fresh = { title: "Bitcoin rallies to record high", ts: NOW - 1 * H };
  const old = { title: "Bitcoin crashes as panic spreads", ts: NOW - 96 * H };
  const s1 = newsSignals([fresh, old], { now: NOW }).find((s) => s.id === "sent.news.aggregate");
  assert.ok(s1.score > 0, `score ${s1.score}`);
  const s2 = newsSignals([{ ...fresh, ts: NOW - 96 * H }, { ...old, ts: NOW - 1 * H }], { now: NOW }).find((s) => s.id === "sent.news.aggregate");
  assert.ok(s2.score < 0);
});

test("newsSignals: confidence grows with count and agreement; dedupes", () => {
  const pos = (i) => ({ title: `Stock surges on strong demand ${i}`, ts: NOW - i * H });
  const one = newsSignals([pos(1)], { now: NOW })[0];
  const many = newsSignals(Array.from({ length: 12 }, (_, i) => pos(i + 1)), { now: NOW }).find((s) => s.id === "sent.news.aggregate");
  assert.ok(many.confidence > one.confidence);
  const mixed = newsSignals([...Array.from({ length: 6 }, (_, i) => pos(i + 1)),
    ...Array.from({ length: 6 }, (_, i) => ({ title: `Stock plunges on weak demand ${i}`, ts: NOW - (i + 1) * H }))], { now: NOW })
    .find((s) => s.id === "sent.news.aggregate");
  assert.ok(mixed.confidence < many.confidence);
  const dup = newsSignals([pos(1), pos(1), pos(1)], { now: NOW })[0];
  assert.equal(dup.value.n, 1);
  assert.deepEqual(newsSignals([], { now: NOW }), []);
  assert.deepEqual(newsSignals(null), []);
});

test("newsSignals: event risk and volume spike", () => {
  const hs = [{ title: "Major exchange hacked, $200M stolen - CoinDesk", ts: NOW - 2 * H }];
  for (let i = 0; i < 10; i++) hs.push({ title: `Bitcoin price falls amid concern number ${i}`, ts: NOW - (i + 1) * 2 * H });
  for (let i = 0; i < 6; i++) hs.push({ title: `Weekly crypto recap edition ${i}`, ts: NOW - (30 + i * 24) * H });
  const sigs = newsSignals(hs, { now: NOW });
  const ev = sigs.find((s) => s.id === "sent.news.event_risk");
  assert.ok(ev && ev.score < -0.5);
  const spike = sigs.find((s) => s.id === "sent.news.volume_spike");
  assert.ok(spike && spike.value.ratio > 2 && spike.score < 0);
  for (const s of sigs) assert.ok(Number.isFinite(s.score) && Number.isFinite(s.confidence));
});

test("socialSignals: contrarian at extremes", () => {
  const euphoric = socialSignals({ bullish: 97, bearish: 3, total: 120 })[0];
  assert.ok(euphoric.score < 0, `euphoric ${euphoric.score}`);
  const normal = socialSignals({ bullish: 78, bearish: 22, total: 120 })[0];
  assert.ok(normal.score > 0);
  const despair = socialSignals({ bullish: 15, bearish: 85, total: 120 })[0];
  assert.ok(despair.score > 0);
  assert.deepEqual(socialSignals({ bullish: 0, bearish: 0, total: 0 }), []);
  assert.deepEqual(socialSignals(null), []);
  const small = socialSignals({ bullish: 3, bearish: 1 })[0];
  assert.ok(small.confidence < normal.confidence);
});

test("fearGreedSignal: contrarian at 10 and 90, flat mid", () => {
  const fear = fearGreedSignal({ value: 10, classification: "Extreme Fear" });
  const greed = fearGreedSignal({ value: 90, classification: "Extreme Greed" });
  const mid = fearGreedSignal({ value: 50 });
  assert.equal(fear.id, "sent.feargreed.contrarian");
  assert.ok(fear.score > 0.5);
  assert.ok(greed.score < -0.5);
  assert.ok(Math.abs(mid.score) < 0.01);
  assert.ok(fear.confidence > mid.confidence);
  assert.ok(Math.abs(fearGreedSignal({ value: 42 }).score) < 0.1);
  const none = fearGreedSignal(null);
  assert.equal(none.score, 0);
  assert.equal(none.confidence, 0);
  assert.equal(fearGreedSignal({ value: "12" }).value.value, 12);
});
