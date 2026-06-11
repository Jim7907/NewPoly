// Engine smoke test: drives the store through a multi-day warp and asserts
// the core loop works. Run: node --experimental-strip-types scripts/smoke.ts

import { useEmbers } from '../src/state/store.ts';
import { ME } from '../src/engine/seed.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

const s = () => useEmbers.getState();

assert(s().posts.some((p) => p.status === 'alive'), 'world starts with alive posts');
assert(s().sparksLeft === 7, 'starts with 7 sparks');

// Post something.
s().createPost('smoke test ember');
const mine = s().posts.find((p) => p.caption === 'smoke test ember');
assert(!!mine && mine.status === 'alive', 'created post is alive');

// Spark it: lifetime must extend, budget must drop.
const before = mine!.expiresAt;
s().sparkPost(mine!.id);
const after = s().posts.find((p) => p.id === mine!.id)!;
assert(after.expiresAt > before, 'spark extends lifetime');
assert(after.sparks.length === 1, 'spark recorded in history');
assert(s().sparksLeft === 6, 'spark budget decremented');

// Diminishing returns.
s().sparkPost(mine!.id);
const after2 = s().posts.find((p) => p.id === mine!.id)!;
const v1 = after2.sparks[0]!.minutesAdded;
const v2 = after2.sparks[1]!.minutesAdded;
assert(v2 <= v1, `diminishing returns (${v1}m then ${v2}m)`);

// Warp a day: deaths, refills, bot activity.
s().warp(24);
assert(s().sparksLeft === 10, 'spark budget refilled at midnight');
assert(s().posts.some((p) => p.status === 'dead' && p.epitaph), 'posts die with epitaphs');

// Warp three more days: nothing alive can outlive the 72h cap unless famous.
s().warp(72);
for (const p of s().posts) {
  if (p.status === 'alive') {
    assert(s().simNow - p.bornAt < 72 * 3600_000, `alive post within cap (${p.caption})`);
  }
}
assert(s().posts.length > 10, 'bots posted new content during warp');

// Phoenix a dead post of mine.
const deadMine = s().posts.find((p) => p.authorId === ME && p.status === 'dead' && !p.phoenixed);
if (deadMine && s().phoenixAvailable) {
  s().phoenixPost(deadMine.id);
  assert(s().posts.find((p) => p.id === deadMine.id)!.status === 'alive', 'phoenix revives a dead post');
  assert(!s().phoenixAvailable, 'phoenix consumed');
}

console.log('\nAll smoke checks passed. Final world:', {
  simDaysElapsed: s().daysElapsed,
  posts: s().posts.length,
  alive: s().posts.filter((p) => p.status === 'alive').length,
  dead: s().posts.filter((p) => p.status === 'dead').length,
  famous: s().posts.filter((p) => p.status === 'famous').length,
  events: s().events.length,
  xp: s().xp,
});
