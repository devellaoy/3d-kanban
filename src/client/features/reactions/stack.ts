// Reactions that stack: pressing the same one again within a short window adds to the badge that is
// already floating up instead of starting another one. Pure logic, no DOM or three.js, so it tests
// without a browser and could be fed by other people's reactions later.

/** The quick reactions, in the order of their keys (7, 8, 9, 0). */
export const REACTIONS: readonly { emoji: string; code: string; label: string }[] = [
  { emoji: '👏', code: 'Digit7', label: 'Applause' },
  { emoji: '🎉', code: 'Digit8', label: 'Party' },
  { emoji: '❤️', code: 'Digit9', label: 'Love' },
  { emoji: '😂', code: 'Digit0', label: 'Laugh' },
];

/** The same reaction within this long (ms) of the last one joins the badge that's up. */
export const STACK_WINDOW_MS = 1500;
/** How long a badge floats before it's gone (ms), counted from the latest reaction added to it. */
export const BADGE_LIFE_MS = 2400;
/** At most this many badges at once; the oldest goes when a new one needs room. */
export const MAX_BADGES = 4;

export interface Badge {
  id: number;
  emoji: string;
  count: number;
  /** When it first appeared and when it last got a reaction added (ms, any clock as long as it's the same one). */
  bornAt: number;
  lastAt: number;
}

/** What a badge says: the emoji, with its count once there is more than one. */
export function badgeText(b: Pick<Badge, 'emoji' | 'count'>): string {
  return b.count > 1 ? `${b.emoji} ×${b.count}` : b.emoji;
}

export class ReactionStack {
  private list: Badge[] = [];
  private nextId = 1;

  /** Adds a reaction at `now`. Returns the badge it landed on and whether that badge is new. */
  add(emoji: string, now: number): { badge: Badge; fresh: boolean } {
    this.prune(now);
    const open = this.list.find((b) => b.emoji === emoji && now - b.lastAt <= STACK_WINDOW_MS);
    if (open) {
      open.count++;
      open.lastAt = now;
      return { badge: open, fresh: false };
    }
    const badge: Badge = { id: this.nextId++, emoji, count: 1, bornAt: now, lastAt: now };
    this.list.push(badge);
    while (this.list.length > MAX_BADGES) this.list.shift();
    return { badge, fresh: true };
  }

  /** Drops the badges that have floated away. */
  prune(now: number): void {
    this.list = this.list.filter((b) => now - b.lastAt < BADGE_LIFE_MS);
  }

  /** The badges still up at `now`. */
  active(now: number): readonly Badge[] {
    this.prune(now);
    return this.list;
  }

  /** How far through its float a badge is, 0 to 1 (counted from its latest reaction). */
  static progress(b: Badge, now: number): number {
    return Math.min(1, Math.max(0, (now - b.lastAt) / BADGE_LIFE_MS));
  }

  clear(): void {
    this.list = [];
  }
}
