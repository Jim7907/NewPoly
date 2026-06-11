export interface Friend {
  id: string;
  name: string;
  avatar: string; // emoji
  /** how trigger-happy this friend is with sparks, 0..1 */
  generosity: number;
  streak: number;
  xp: number;
}

export interface Spark {
  id: string;
  userId: string;
  at: number; // sim time
  minutesAdded: number;
  golden: boolean;
  surge: boolean;
  rescue: boolean;
  /** curiosity gap: identity hidden behind the premium paywall stub */
  anonymous: boolean;
}

export type PostStatus = 'alive' | 'dead' | 'famous';

export interface Post {
  id: string;
  authorId: string;
  caption: string;
  /** uri of a user-picked photo, or undefined for a generated placeholder */
  imageUri?: string;
  /** placeholder look for bot posts / camera-less demo posts */
  placeholder: { emoji: string; bg: string };
  bornAt: number;
  expiresAt: number;
  status: PostStatus;
  sparks: Spark[];
  views: number;
  milestones: { h24: boolean; h48: boolean; h72: boolean };
  diedAt?: number;
  epitaph?: string;
  phoenixed: boolean;
}

export type FeedEventKind =
  | 'reciprocity'
  | 'golden'
  | 'surge_start'
  | 'streak_died'
  | 'milestone'
  | 'death'
  | 'phoenix';

export interface FeedEvent {
  id: string;
  kind: FeedEventKind;
  at: number;
  text: string;
}

export interface Badge {
  id: string;
  label: string;
  emoji: string;
}
