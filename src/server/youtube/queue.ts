// The TV's queue and history as plain lists: pure functions, so the TV (tv.ts) stays about the playing.
import { QUEUE_MAX, type YoutubeQueueItem } from '../../shared/youtube/queue.js';

/** How many played items are remembered for ⏮️. */
export const HISTORY_MAX = 20;

type Items = readonly YoutubeQueueItem[];

/** `item` at the end (or the front, `next`) of the queue; null when it's full. */
export function add(q: Items, item: YoutubeQueueItem, where: 'end' | 'next'): YoutubeQueueItem[] | null {
  if (q.length >= QUEUE_MAX) return null;
  return where === 'next' ? [item, ...q] : [...q, item];
}

/** As many of `items` as fit in front of the queue, in order. */
export function addFront(q: Items, items: Items): YoutubeQueueItem[] {
  return [...items, ...q].slice(0, QUEUE_MAX);
}

/** `qid` moved to place `to` (clamped to the queue); null if it isn't queued. */
export function move(q: Items, qid: string, to: number): YoutubeQueueItem[] | null {
  const from = q.findIndex((i) => i.qid === qid);
  if (from < 0 || !Number.isFinite(to)) return null;
  const rest = q.filter((_, i) => i !== from);
  rest.splice(Math.max(0, Math.min(rest.length, Math.trunc(to))), 0, q[from]);
  return rest;
}

export const remove = (q: Items, qid: string): YoutubeQueueItem[] | null => (q.some((i) => i.qid === qid) ? q.filter((i) => i.qid !== qid) : null);

/** `qid` taken out of the queue, and what's left; null if it isn't queued. */
export function take(q: Items, qid: string): { item: YoutubeQueueItem; rest: YoutubeQueueItem[] } | null {
  const item = q.find((i) => i.qid === qid);
  return item ? { item, rest: q.filter((i) => i !== item) } : null;
}

/** `item` as the newest of what was played, the oldest forgotten past HISTORY_MAX. */
export const remember = (h: Items, item: YoutubeQueueItem): YoutubeQueueItem[] => [...h, item].slice(-HISTORY_MAX);
