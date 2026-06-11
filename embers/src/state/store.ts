import { create } from 'zustand';

import {
  BASE_LIFETIME_MS,
  CRITICAL_WINDOW_MS,
  DAILY_SPARKS,
  DAY,
  GOLDEN_CHANCE,
  HARD_CAP_MS,
  HOUR,
  MIN,
  extendedExpiry,
  fmtClock,
  fmtDuration,
  isCritical,
  sparkMinutes,
} from '../engine/lifetime';
import { chance, makeRng, pick } from '../engine/rng';
import {
  BOT_CAPTIONS,
  FRIENDS,
  ME,
  PLACEHOLDERS,
  SIM_START,
  nextId,
  seedPosts,
} from '../engine/seed';
import type { Badge, FeedEvent, Friend, Post, Spark } from '../engine/types';

const rng = makeRng(20260611);

/** Simulation advances in 5-minute slices so warps replay every event. */
const CHUNK_MS = 5 * MIN;
/** Per-chunk probability that some friend sparks something (~40 sparks/day). */
const BOT_SPARK_P = 0.14;
/** Per-chunk probability that some friend posts (~8 posts/day). */
const BOT_POST_P = 0.03;

export type Tab = 'feed' | 'capture' | 'graveyard' | 'profile';

export const LEVEL_TITLES = [
  'Cold Ash',
  'Match',
  'Candle',
  'Torch',
  'Bonfire',
  'Firekeeper',
  'Wildfire',
  'Inferno',
  'Eternal Flame',
] as const;

export function levelFromXp(xp: number): { level: number; title: string; into: number; needed: number } {
  const level = Math.floor(Math.sqrt(xp / 100)) + 1;
  const floor = (level - 1) ** 2 * 100;
  const ceil = level ** 2 * 100;
  const title = LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)]!;
  return { level, title, into: xp - floor, needed: ceil - floor };
}

interface EmbersState {
  simNow: number;
  friends: Friend[];
  posts: Post[];
  events: FeedEvent[];

  sparksLeft: number;
  xp: number;
  streak: number;
  activeToday: boolean;
  lifesaves: number;
  goldenGiven: number;
  badges: Badge[];
  phoenixAvailable: boolean;

  surgeStart: number; // sim ms; surge runs [surgeStart, surgeStart + 1h)
  dayKey: string;
  daysElapsed: number;

  tab: Tab;
  selectedPostId: string | null;
  paywallOpen: boolean;
  celebration: string | null; // golden spark toast text

  tick: (realDeltaMs: number) => void;
  warp: (hours: number) => void;
  sparkPost: (postId: string) => void;
  createPost: (caption: string, imageUri?: string) => void;
  phoenixPost: (postId: string) => void;
  setTab: (tab: Tab) => void;
  selectPost: (id: string | null) => void;
  setPaywallOpen: (open: boolean) => void;
  dismissCelebration: () => void;
}

function dayKeyOf(t: number): string {
  return new Date(t).toDateString();
}

function pickSurgeStart(dayStart: number): number {
  // Surge Hour lands somewhere between 09:00 and 21:00.
  const hour = 9 + Math.floor(rng() * 13);
  return dayStart + hour * HOUR;
}

function inSurge(simNow: number, surgeStart: number): boolean {
  return simNow >= surgeStart && simNow < surgeStart + HOUR;
}

function pushEvent(events: FeedEvent[], kind: FeedEvent['kind'], at: number, text: string): void {
  events.unshift({ id: nextId('evt'), kind, at, text });
  if (events.length > 25) events.length = 25;
}

function epitaphFor(post: Post): string {
  const lived = (post.diedAt ?? post.expiresAt) - post.bornAt;
  const tried = post.sparks.length;
  if (tried === 0) return 'died unseen';
  for (const h of [72, 48, 24]) {
    const short = h * HOUR - lived;
    if (short > 0 && short <= 2 * HOUR) {
      return `died ${fmtDuration(short)} short of the ${h}h badge · ${tried} tried to save it`;
    }
  }
  return `died at ${fmtClock(post.diedAt ?? post.expiresAt)} · ${tried} ${tried === 1 ? 'person' : 'people'} tried to save it`;
}

function awardBadge(badges: Badge[], id: string, emoji: string, label: string): void {
  if (!badges.some((b) => b.id === id)) badges.push({ id, emoji, label });
}

function makeSpark(
  userId: string,
  post: Post,
  simNow: number,
  surge: boolean,
  forceNotGolden = false
): Spark {
  const golden = !forceNotGolden && chance(rng, GOLDEN_CHANCE);
  const rescue = isCritical(post.expiresAt, simNow);
  const minutesAdded = sparkMinutes(post.sparks.length + 1, { golden, surge, rescue });
  return {
    id: nextId('spk'),
    userId,
    at: simNow,
    minutesAdded,
    golden,
    surge,
    rescue,
    // Curiosity gap: some friend sparks are anonymous until "premium" reveals them.
    anonymous: userId !== ME && chance(rng, 0.25),
  };
}

function applySparkToPost(post: Post, spark: Spark): void {
  post.sparks = [...post.sparks, spark];
  post.expiresAt = extendedExpiry(post.bornAt, post.expiresAt, spark.minutesAdded);
  post.views += 1;
}

/** Everything that happens to the world between two sim times. Mutates the draft. */
function simulate(draft: EmbersState, from: number, to: number): void {
  let t = from;
  while (t < to) {
    const step = Math.min(CHUNK_MS, to - t);
    t += step;
    draft.simNow = t;

    // --- Day rollover: refill sparks, judge streaks, schedule Surge Hour ---
    const dk = dayKeyOf(t);
    if (dk !== draft.dayKey) {
      draft.dayKey = dk;
      draft.daysElapsed += 1;
      draft.sparksLeft = DAILY_SPARKS;
      const dayStart = new Date(t).setHours(0, 0, 0, 0);
      draft.surgeStart = pickSurgeStart(dayStart);
      if (draft.activeToday) {
        draft.streak += 1;
      } else if (draft.streak > 0) {
        pushEvent(
          draft.events,
          'streak_died',
          t,
          `💀 Your ${draft.streak}-day flame went out. Everyone saw.`
        );
        draft.streak = 0;
      }
      draft.activeToday = false;
      if (draft.daysElapsed % 7 === 0) draft.phoenixAvailable = true;
      // Friends keep (or lose) their own streaks.
      draft.friends = draft.friends.map((f) =>
        chance(rng, 0.85) ? { ...f, streak: f.streak + 1 } : { ...f, streak: 0 }
      );
    }

    const surge = inSurge(t, draft.surgeStart);
    if (surge && t - step < draft.surgeStart && t >= draft.surgeStart) {
      pushEvent(draft.events, 'surge_start', t, '⚡⚡ SURGE HOUR — every spark counts DOUBLE for 60 minutes!');
    }

    // --- Friends act ---
    if (chance(rng, BOT_SPARK_P)) {
      const bot = pick(rng, draft.friends);
      const targets = draft.posts.filter((p) => p.status === 'alive' && p.authorId !== bot.id);
      if (targets.length > 0 && chance(rng, 0.3 + bot.generosity * 0.7)) {
        // Friends gravitate to dying posts and to yours.
        const weighted = targets.flatMap((p) => {
          let w = 1;
          if (isCritical(p.expiresAt, t)) w += 3;
          if (p.authorId === ME) w += 2;
          return Array<Post>(w).fill(p);
        });
        const target = pick(rng, weighted);
        const spark = makeSpark(bot.id, target, t, surge);
        applySparkToPost(target, spark);
        if (target.authorId === ME) {
          if (spark.golden) {
            pushEvent(
              draft.events,
              'golden',
              t,
              `🌟 GOLDEN SPARK! ${bot.name} hit a golden spark on "${target.caption}" — +${spark.minutesAdded}m!`
            );
          } else if (chance(rng, 0.35)) {
            const theirPost = draft.posts.find((p) => p.authorId === bot.id && p.status === 'alive');
            pushEvent(
              draft.events,
              'reciprocity',
              t,
              theirPost
                ? `${bot.avatar} ${bot.name} spent a spark saving "${target.caption}". Their ember "${theirPost.caption}" dies in ${fmtDuration(theirPost.expiresAt - t)}…`
                : `${bot.avatar} ${bot.name} spent a spark saving "${target.caption}".`
            );
          }
        }
      }
    }
    if (chance(rng, BOT_POST_P)) {
      const bot = pick(rng, draft.friends);
      draft.posts = [
        {
          id: nextId('post'),
          authorId: bot.id,
          caption: pick(rng, BOT_CAPTIONS),
          placeholder: pick(rng, PLACEHOLDERS),
          bornAt: t,
          expiresAt: t + BASE_LIFETIME_MS,
          status: 'alive',
          sparks: [],
          views: 0,
          milestones: { h24: false, h48: false, h72: false },
          phoenixed: false,
        },
        ...draft.posts,
      ];
    }

    // --- Deaths, fame, milestones ---
    for (const post of draft.posts) {
      if (post.status !== 'alive') continue;
      const age = t - post.bornAt;
      if (age >= 24 * HOUR && !post.milestones.h24) {
        post.milestones.h24 = true;
        if (post.authorId === ME) {
          draft.xp += 50;
          awardBadge(draft.badges, 'club24', '🕐', '24h Club');
          pushEvent(draft.events, 'milestone', t, `🕐 "${post.caption}" joined the 24h Club! +50 XP`);
        }
      }
      if (age >= 48 * HOUR && !post.milestones.h48) {
        post.milestones.h48 = true;
        if (post.authorId === ME) {
          draft.xp += 100;
          awardBadge(draft.badges, 'club48', '🕑', '48h Club');
          pushEvent(draft.events, 'milestone', t, `🕑 "${post.caption}" hit 48 hours! +100 XP`);
        }
      }
      if (age >= HARD_CAP_MS) {
        // Burned for three full days: the ember becomes eternal.
        post.status = 'famous';
        post.milestones.h72 = true;
        if (post.authorId === ME) {
          draft.xp += 250;
          awardBadge(draft.badges, 'immortal', '🏆', 'Immortal');
          pushEvent(draft.events, 'milestone', t, `🏆 "${post.caption}" survived 72h — it is now IMMORTAL. +250 XP`);
        }
        continue;
      }
      if (post.expiresAt <= t) {
        post.status = 'dead';
        post.diedAt = post.expiresAt;
        post.epitaph = epitaphFor(post);
        if (post.authorId === ME) {
          pushEvent(draft.events, 'death', t, `🪦 Your ember "${post.caption}" ${post.epitaph}.`);
        }
      }
    }
  }
}

function buildInitialState(): Omit<
  EmbersState,
  | 'tick'
  | 'warp'
  | 'sparkPost'
  | 'createPost'
  | 'phoenixPost'
  | 'setTab'
  | 'selectPost'
  | 'setPaywallOpen'
  | 'dismissCelebration'
> {
  const dayStart = new Date(SIM_START).setHours(0, 0, 0, 0);
  return {
    simNow: SIM_START,
    friends: FRIENDS.map((f) => ({ ...f })),
    posts: seedPosts(),
    events: [
      {
        id: nextId('evt'),
        kind: 'reciprocity',
        at: SIM_START - 40 * MIN,
        text: '🦊 anna_v spent her LAST spark saving "first ember 🔥". Her feed is counting on you…',
      },
    ],
    sparksLeft: 7,
    xp: 1840,
    streak: 3,
    activeToday: true,
    lifesaves: 23,
    goldenGiven: 1,
    badges: [
      { id: 'lifesaver', emoji: '🚑', label: 'Lifesaver ×23' },
      { id: 'streak7', emoji: '🔥', label: '7-day flame' },
    ],
    phoenixAvailable: true,
    surgeStart: dayStart + 20 * HOUR, // tonight at 20:00 — visible soon in the demo
    dayKey: dayKeyOf(SIM_START),
    daysElapsed: 0,
    tab: 'feed',
    selectedPostId: null,
    paywallOpen: false,
    celebration: null,
  };
}

function cloneWorld(s: EmbersState): EmbersState {
  return {
    ...s,
    friends: s.friends.map((f) => ({ ...f })),
    posts: s.posts.map((p) => ({ ...p, sparks: [...p.sparks], milestones: { ...p.milestones } })),
    events: [...s.events],
    badges: s.badges.map((b) => ({ ...b })),
  };
}

export const useEmbers = create<EmbersState>((set, get) => ({
  ...buildInitialState(),

  tick: (realDeltaMs) => {
    const s = get();
    const draft = cloneWorld(s);
    simulate(draft, s.simNow, s.simNow + realDeltaMs);
    set(draft);
  },

  warp: (hours) => {
    const s = get();
    const draft = cloneWorld(s);
    simulate(draft, s.simNow, s.simNow + hours * HOUR);
    set(draft);
  },

  sparkPost: (postId) => {
    const s = get();
    if (s.sparksLeft <= 0) return;
    const draft = cloneWorld(s);
    const post = draft.posts.find((p) => p.id === postId);
    if (!post || post.status !== 'alive') return;
    const surge = inSurge(draft.simNow, draft.surgeStart);
    const spark = makeSpark(ME, post, draft.simNow, surge);
    spark.anonymous = false;
    applySparkToPost(post, spark);
    draft.sparksLeft -= 1;
    draft.activeToday = true;
    draft.xp += 5;
    if (spark.rescue) {
      draft.xp += 20;
      draft.lifesaves += 1;
      awardBadge(draft.badges, 'lifesaver', '🚑', `Lifesaver ×${draft.lifesaves}`);
      draft.badges = draft.badges.map((b) =>
        b.id === 'lifesaver' ? { ...b, label: `Lifesaver ×${draft.lifesaves}` } : b
      );
    }
    if (spark.golden) {
      draft.goldenGiven += 1;
      draft.xp += 25;
      draft.celebration = `🌟 GOLDEN SPARK! You gave "${post.caption}" +${spark.minutesAdded} minutes!`;
      pushEvent(draft.events, 'golden', draft.simNow, `🌟 You rolled a GOLDEN SPARK on "${post.caption}" — +${spark.minutesAdded}m!`);
    }
    set(draft);
  },

  createPost: (caption, imageUri) => {
    const s = get();
    const draft = cloneWorld(s);
    draft.posts = [
      {
        id: nextId('post'),
        authorId: ME,
        caption: caption.trim() || 'untitled ember',
        imageUri,
        placeholder: PLACEHOLDERS[Math.floor(rng() * PLACEHOLDERS.length)]!,
        bornAt: draft.simNow,
        expiresAt: draft.simNow + BASE_LIFETIME_MS,
        status: 'alive',
        sparks: [],
        views: 0,
        milestones: { h24: false, h48: false, h72: false },
        phoenixed: false,
      },
      ...draft.posts,
    ];
    draft.activeToday = true;
    draft.xp += 15;
    draft.tab = 'feed';
    set(draft);
  },

  phoenixPost: (postId) => {
    const s = get();
    if (!s.phoenixAvailable) return;
    const draft = cloneWorld(s);
    const post = draft.posts.find((p) => p.id === postId);
    if (!post || post.status !== 'dead' || post.phoenixed) return;
    post.status = 'alive';
    post.phoenixed = true;
    post.bornAt = draft.simNow;
    post.expiresAt = draft.simNow + BASE_LIFETIME_MS;
    post.diedAt = undefined;
    post.epitaph = undefined;
    post.milestones = { h24: false, h48: false, h72: false };
    draft.phoenixAvailable = false;
    draft.activeToday = true;
    draft.xp += 10;
    pushEvent(draft.events, 'phoenix', draft.simNow, `🕊 "${post.caption}" rose from the Graveyard. Second life: 6 hours.`);
    draft.tab = 'feed';
    set(draft);
  },

  setTab: (tab) => set({ tab, selectedPostId: null }),
  selectPost: (id) => set({ selectedPostId: id }),
  setPaywallOpen: (open) => set({ paywallOpen: open }),
  dismissCelebration: () => set({ celebration: null }),
}));

export { inSurge };
