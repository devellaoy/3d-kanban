// What youtube-tv.json holds, and reading it back: everything is checked, whatever wrote the file.
import { RATES, parseYoutubeLink, youtubeUrl, type YoutubeTvState } from '../../shared/youtube/link.js';
import { QUEUE_MAX, type YoutubeQueueItem } from '../../shared/youtube/queue.js';
import { HISTORY_MAX } from './queue.js';

/** What's on, as kept: the state without `elapsed`, which is worked out as it's sent. */
export type Play = Omit<YoutubeTvState, 'elapsed'>;

/** The file (version 2). */
export interface Saved {
  version: 2;
  now: Play | null;
  queue: YoutubeQueueItem[];
  history: YoutubeQueueItem[];
  sameVolume: boolean;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A number that's really one (not NaN, not infinite). */
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' && v ? v.slice(0, max) : fallback);

/** The link fields of a saved entry, from its url; the saved `start` is where it was put on from. */
function link(r: Record<string, unknown>) {
  const l = parseYoutubeLink(r.url);
  if ('error' in l) return null;
  return { ...l, start: finite(r.start) && r.start >= 0 ? r.start : l.start, url: youtubeUrl(l) };
}

function item(raw: unknown, newId: () => string): YoutubeQueueItem | null {
  const r = rec(raw);
  const l = r && link(r);
  if (!r || !l) return null;
  return { ...l, qid: text(r.qid, 64, newId()), by: text(r.by, 24, 'Someone'), ...(text(r.title, 200) ? { title: text(r.title, 200) } : {}) };
}

const items = (raw: unknown, max: number, newId: () => string): YoutubeQueueItem[] =>
  (Array.isArray(raw) ? raw : []).map((i) => item(i, newId)).filter((i): i is YoutubeQueueItem => !!i).slice(0, max);

/** A saved play. The old format (version 1) had `startedAt` for the moment it was at `start`; that's `position` and `at` now. */
function play(raw: unknown, newId: () => string): Play | null {
  const r = rec(raw);
  const l = r && link(r);
  if (!r || !l) return null;
  const legacy = r.position === undefined && finite(r.startedAt);
  const at = legacy ? (r.startedAt as number) : r.at;
  if (!finite(at)) return null;
  const paused = r.paused === true;
  return {
    ...l,
    id: text(r.id, 64, newId()),
    by: text(r.by, 24, 'Someone'),
    position: legacy ? l.start : finite(r.position) && r.position >= 0 ? r.position : l.start,
    at,
    rate: RATES.find((x) => x === r.rate) ?? 1,
    paused,
    ...(paused && text(r.pausedBy, 24) ? { pausedBy: text(r.pausedBy, 24) } : {}),
    ...(finite(r.duration) && r.duration > 0 ? { duration: r.duration } : {}),
    ...(finite(r.listLength) && Number.isInteger(r.listLength) && r.listLength > 0 ? { listLength: r.listLength } : {}),
    ...(text(r.title, 200) ? { title: text(r.title, 200) } : {}),
  };
}

/** The file's contents as what the TV keeps; anything unreadable is dropped, so the worst case is a dark TV. */
export function parseSaved(raw: unknown, newId: () => string): Omit<Saved, 'version'> | null {
  const r = rec(raw);
  if (!r) return null;
  if (r.version === 2) {
    return { now: play(r.now, newId), queue: items(r.queue, QUEUE_MAX, newId), history: items(r.history, HISTORY_MAX, newId), sameVolume: r.sameVolume === true };
  }
  return { now: play(r, newId), queue: [], history: [], sameVolume: false };
}
