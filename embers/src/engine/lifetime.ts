// Core survival math. All tunables live here so the game feel can be
// adjusted without touching UI or simulation code.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** A fresh ember is born with 6 hours to live. */
export const BASE_LIFETIME_MS = 6 * HOUR;
/** No ember may live longer than 72h after birth. Reaching the cap alive = Hall of Fame. */
export const HARD_CAP_MS = 72 * HOUR;
/** Time the first spark adds. */
export const FIRST_SPARK_MIN = 90;
/** Each subsequent spark is worth 15% less than the previous one. */
export const SPARK_DECAY = 0.85;
/** Floor so late sparks still feel like they do something. */
export const MIN_SPARK_MIN = 8;
/** ~1 in 20 sparks is golden. */
export const GOLDEN_CHANCE = 0.05;
export const GOLDEN_MULT = 5;
/** During the daily Surge Hour every spark is doubled. */
export const SURGE_MULT = 2;
/** Sparking a post that is about to die earns a rescue bonus. */
export const RESCUE_MULT = 1.6;
/** A post with less than this left is "critical" (red, pulsing, rescuable). */
export const CRITICAL_WINDOW_MS = 30 * MIN;
/** Daily spark budget, refilled at sim-midnight. */
export const DAILY_SPARKS = 10;

export const MILESTONES_H = [24, 48, 72] as const;

export interface SparkValueOpts {
  golden: boolean;
  surge: boolean;
  rescue: boolean;
}

/** Minutes added by the nth spark (1-based) on a post. */
export function sparkMinutes(nthSpark: number, opts: SparkValueOpts): number {
  let mins = FIRST_SPARK_MIN * Math.pow(SPARK_DECAY, Math.max(0, nthSpark - 1));
  mins = Math.max(mins, MIN_SPARK_MIN);
  if (opts.golden) mins *= GOLDEN_MULT;
  if (opts.surge) mins *= SURGE_MULT;
  if (opts.rescue) mins *= RESCUE_MULT;
  return Math.round(mins);
}

/** New expiry after adding `minutes`, clamped to the 72h hard cap. */
export function extendedExpiry(bornAt: number, expiresAt: number, minutes: number): number {
  return Math.min(expiresAt + minutes * MIN, bornAt + HARD_CAP_MS);
}

export function isCritical(expiresAt: number, simNow: number): boolean {
  const left = expiresAt - simNow;
  return left > 0 && left <= CRITICAL_WINDOW_MS;
}

/**
 * 0..1 fraction of remaining life, relative to the total lifetime the post
 * has earned so far. Full at birth, drains to zero at death, jumps when sparked.
 */
export function lifeFraction(bornAt: number, expiresAt: number, simNow: number): number {
  const total = expiresAt - bornAt;
  if (total <= 0) return 0;
  const left = Math.max(0, expiresAt - simNow);
  return Math.min(1, left / total);
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m}m`;
}

export function fmtClock(simTime: number): string {
  const d = new Date(simTime);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
