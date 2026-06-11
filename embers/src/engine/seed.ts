import { BASE_LIFETIME_MS, HOUR, MIN } from './lifetime';
import type { Friend, Post, Spark } from './types';

export const ME = 'me';

/** Fixed start time so demo runs are reproducible. */
export const SIM_START = new Date(2026, 5, 11, 18, 0, 0).getTime();

export const FRIENDS: Friend[] = [
  { id: 'anna_v', name: 'anna_v', avatar: '🦊', generosity: 0.9, streak: 12, xp: 2100 },
  { id: 'mike_k', name: 'mike_k', avatar: '🐻', generosity: 0.5, streak: 4, xp: 1450 },
  { id: 'jules', name: 'jules', avatar: '🐸', generosity: 0.7, streak: 31, xp: 3900 },
  { id: 'sam_o', name: 'sam_o', avatar: '🦉', generosity: 0.4, streak: 0, xp: 800 },
  { id: 'leila', name: 'leila', avatar: '🐙', generosity: 0.8, streak: 9, xp: 2600 },
  { id: 'tom_b', name: 'tom_b', avatar: '🐺', generosity: 0.3, streak: 2, xp: 600 },
  { id: 'nia', name: 'nia', avatar: '🦋', generosity: 0.6, streak: 17, xp: 3100 },
  { id: 'dre', name: 'dre', avatar: '🐯', generosity: 0.55, streak: 6, xp: 1900 },
];

export const PLACEHOLDERS: { emoji: string; bg: string }[] = [
  { emoji: '🌅', bg: '#7a3b2e' },
  { emoji: '🎸', bg: '#3b2e7a' },
  { emoji: '🍜', bg: '#7a5e2e' },
  { emoji: '🛹', bg: '#2e5e7a' },
  { emoji: '🐕', bg: '#2e7a4d' },
  { emoji: '🎡', bg: '#7a2e62' },
  { emoji: '☕️', bg: '#5c4632' },
  { emoji: '🌊', bg: '#1f4e6e' },
  { emoji: '🏀', bg: '#6e3a1f' },
  { emoji: '🎂', bg: '#6e1f4e' },
];

export const BOT_CAPTIONS = [
  'sunset from the roof',
  'first try!!',
  'this place is unreal',
  'no context',
  'POV: tuesday',
  'we move',
  'tiny victory',
  'should I be worried',
  'main character moment',
  'real ones know',
  '3am thoughts',
  'art? art.',
];

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function mkSpark(userId: string, at: number, minutesAdded: number, anonymous = false): Spark {
  return {
    id: nextId('spk'),
    userId,
    at,
    minutesAdded,
    golden: false,
    surge: false,
    rescue: false,
    anonymous,
  };
}

function mkPost(p: Partial<Post> & Pick<Post, 'authorId' | 'caption' | 'bornAt' | 'expiresAt'>): Post {
  return {
    id: nextId('post'),
    placeholder: PLACEHOLDERS[idCounter % PLACEHOLDERS.length]!,
    status: 'alive',
    sparks: [],
    views: 0,
    milestones: { h24: false, h48: false, h72: false },
    phoenixed: false,
    ...p,
  };
}

/**
 * Pre-populated world so the app feels alive on first open:
 * a mix of healthy, critical, dead and famous posts.
 */
export function seedPosts(): Post[] {
  const t = SIM_START;
  const posts: Post[] = [];

  // Your own post, doing OK — 3 sparks, ~4h left.
  const mine = mkPost({
    authorId: ME,
    caption: 'first ember 🔥',
    bornAt: t - 5 * HOUR,
    expiresAt: t + 4 * HOUR,
  });
  mine.views = 14;
  mine.sparks = [
    mkSpark('anna_v', t - 4 * HOUR, 90),
    mkSpark('jules', t - 3 * HOUR, 76, true),
    mkSpark('leila', t - 1 * HOUR, 65),
  ];
  posts.push(mine);

  // A friend's healthy post.
  const healthy = mkPost({
    authorId: 'mike_k',
    caption: 'sunset over the bay',
    bornAt: t - 9 * HOUR,
    expiresAt: t + 14 * HOUR + 22 * MIN,
  });
  healthy.views = 31;
  healthy.sparks = [
    mkSpark('anna_v', t - 8 * HOUR, 90),
    mkSpark('jules', t - 7 * HOUR, 76),
    mkSpark('sam_o', t - 5 * HOUR, 65, true),
    mkSpark('nia', t - 2 * HOUR, 55),
  ];
  posts.push(healthy);

  // CRITICAL — dies in 24 minutes unless someone acts.
  const dying = mkPost({
    authorId: 'leila',
    caption: 'last night 🎶',
    bornAt: t - 6 * HOUR + 24 * MIN,
    expiresAt: t + 24 * MIN,
  });
  dying.views = 8;
  posts.push(dying);

  // A second friend post mid-life.
  const mid = mkPost({
    authorId: 'nia',
    caption: 'study cave, day 4',
    bornAt: t - 2 * HOUR,
    expiresAt: t + 5 * HOUR,
  });
  mid.views = 6;
  mid.sparks = [mkSpark('dre', t - 1 * HOUR, 90)];
  posts.push(mid);

  // Your dead post — a near miss for maximum sting.
  const myDead = mkPost({
    authorId: ME,
    caption: 'my latte art',
    bornAt: t - 30 * HOUR,
    expiresAt: t - 6 * HOUR - 22 * MIN,
  });
  myDead.status = 'dead';
  myDead.diedAt = t - 6 * HOUR - 22 * MIN;
  myDead.views = 19;
  myDead.sparks = [
    mkSpark('mike_k', t - 28 * HOUR, 90),
    mkSpark('anna_v', t - 26 * HOUR, 76),
    mkSpark('tom_b', t - 20 * HOUR, 65),
    mkSpark('jules', t - 12 * HOUR, 55),
  ];
  myDead.milestones.h24 = false;
  myDead.epitaph = 'died 22m short of the 24h badge · 4 people tried to save it';
  posts.push(myDead);

  // A friend's dead post that nobody saw.
  const unseen = mkPost({
    authorId: 'tom_b',
    caption: 'cloud that looks like a duck',
    bornAt: t - 20 * HOUR,
    expiresAt: t - 14 * HOUR,
  });
  unseen.status = 'dead';
  unseen.diedAt = t - 14 * HOUR;
  unseen.epitaph = 'died unseen';
  posts.push(unseen);

  // A famous post — survived the full 72h, now immortal.
  const famous = mkPost({
    authorId: 'jules',
    caption: 'the proposal 💍',
    bornAt: t - 80 * HOUR,
    expiresAt: t - 8 * HOUR,
  });
  famous.status = 'famous';
  famous.views = 212;
  famous.milestones = { h24: true, h48: true, h72: true };
  famous.sparks = FRIENDS.map((f, i) => mkSpark(f.id, t - 70 * HOUR + i * HOUR, 90 - i * 8));
  posts.push(famous);

  return posts;
}
