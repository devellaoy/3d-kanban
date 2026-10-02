// What the TV's handlers (handlers.ts, controls.ts, queue-handlers.ts) share: a floor's TV, telling the
// floor about it, and the one way anything starts playing.
import path from 'node:path';
import type { Floor } from '../floor.js';
import type { Ctx } from '../office/context.js';
import type { ViewPieces } from '../ws/handlers/types.js';
import { youtubeTitle, type YoutubeTvState } from '../../shared/youtube/link.js';
import { YoutubeTv } from './tv.js';
import { youtubeTitles } from './titles.js';

const tvs = new WeakMap<Floor, YoutubeTv>();

/** The floor's TV, made the first time it's asked for (kept beside the floor's other things in .agent-office). */
export function youtubeTvOf(floor: Floor): YoutubeTv {
  let tv = tvs.get(floor);
  if (!tv) tvs.set(floor, (tv = new YoutubeTv(path.join(floor.dir, '.agent-office'))));
  return tv;
}

export const youtubeView: ViewPieces['youtube'] = (_ctx, floor) => (floor ? youtubeTvOf(floor).state() : null);
export const youtubeListView: ViewPieces['youtubeList'] = (_ctx, floor) => (floor ? youtubeTvOf(floor).list() : { queue: [], back: false, sameVolume: false });

/** Tells the floor what's on, and the queue and settings too when `withList` (they went along with what changed). */
export const changed = (ctx: Ctx, floor: Floor, withList = false) => {
  const tv = youtubeTvOf(floor);
  ctx.toFloor(floor, { t: 'tv.youtube', state: tv.state(), ...(withList ? { list: tv.list() } : {}) });
};

/** Asks YouTube for the title of `s` (what just went on), and tells the floor once it's known; then `done` with the title, or what it shows without one. */
export function lookUpTitle(ctx: Ctx, floor: Floor, s: YoutubeTvState, done?: (title: string) => void) {
  void youtubeTitles.fetch(s.url).then((title) => {
    if (title && youtubeTvOf(floor).titled(s.id, title)) changed(ctx, floor);
    done?.(title ?? youtubeTitle(s));
  });
}

/**
 * Whatever just started playing on the TV, however it got there (put on, queued on an empty TV, jumped to, skipped
 * to, the queue going on by itself): the jukebox goes quiet, so two songs never play at once, the floor is told (the
 * queue with it), and the title is looked up. `say` makes the toast from the title and whether the jukebox was
 * stopped; nothing is said if it was changed again meanwhile.
 */
export function startNow(ctx: Ctx, floor: Floor, who: string, say?: (title: string, quiet: boolean) => string | undefined) {
  const quiet = floor.jukebox.stop(who);
  if (quiet) ctx.toFloor(floor, { t: 'jukebox', state: floor.jukebox.state() });
  changed(ctx, floor, true);
  const s = youtubeTvOf(floor).state();
  if (!s) return;
  const known = s.title;
  const tell = (title: string) => {
    const text = youtubeTvOf(floor).state()?.id === s.id && say?.(title, !!quiet);
    if (text) ctx.toastFloor(floor, text);
  };
  if (known) tell(known);
  lookUpTitle(ctx, floor, s, known ? undefined : tell);
}

/** The titles of queued items, looked up (a few at a time) and told to the floor with the queue, bunched into one message per half second. */
export function titleQueued(ctx: Ctx, floor: Floor, items: { qid: string; url: string; title?: string }[]) {
  const todo = items.filter((i) => !i.title);
  let timer: NodeJS.Timeout | undefined;
  const tell = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      changed(ctx, floor, true);
    }, 500);
    timer.unref?.();
  };
  const worker = async () => {
    for (let i = todo.shift(); i; i = todo.shift()) {
      const title = await youtubeTitles.fetch(i.url);
      if (title && youtubeTvOf(floor).titledQueued(i.qid, title)) tell();
    }
  };
  for (let n = 0; n < Math.min(4, todo.length); n++) void worker();
}
