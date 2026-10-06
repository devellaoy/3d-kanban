// What the hosting providers share for asking many things at once: a small pool of requests, and a
// cache of what's asked per open pull request (its checks, its participants) between the board's looks.

/** Runs `fn` over `items`, `limit` at a time, keeping their order. */
export async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** How long a pull request's details are kept while it doesn't change, and while its checks run. */
export const DETAIL_MS = 30 * 60_000;
export const PENDING_MS = 5 * 60_000;
const DETAILS_KEPT = 2000;

/**
 * Details per pull request, each kept with a stamp of the pull request as the list showed it (its
 * head commit, its update time): asked again when the stamp changes, or after DETAIL_MS (PENDING_MS
 * while `pending` says its checks still run). The oldest go first past DETAILS_KEPT.
 */
export class DetailCache<T> {
  private kept = new Map<string, { at: number; stamp: string; value: T }>();
  /** The clock (tests set it). */
  now = () => Date.now();
  constructor(private pending: (value: T) => boolean) {}

  /** `fresh` while the stamp is the same and it isn't too old; `last` whatever was kept, for when asking again fails. */
  get(key: string, stamp: string): { fresh?: T; last?: T } {
    const had = this.kept.get(key);
    if (!had) return {};
    const fresh = had.stamp === stamp && this.now() - had.at < (this.pending(had.value) ? PENDING_MS : DETAIL_MS);
    return fresh ? { fresh: had.value, last: had.value } : { last: had.value };
  }

  set(key: string, stamp: string, value: T): void {
    this.kept.delete(key);
    this.kept.set(key, { at: this.now(), stamp, value });
    if (this.kept.size > DETAILS_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }

  clear(): void {
    this.kept.clear();
  }
}
