// YouTube on the Office TV, on every floor. Joins upstream's handler map and floor view
// with one line each (ws/handlers/index.ts), and the jukebox's handlers with two (see docs/fork.md).
import path from 'node:path';
import type { Floor } from '../floor.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { here } from '../ws/handlers/common.js';
import type { HandlerMap, ViewPieces } from '../ws/handlers/types.js';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol.js';
import { isYoutubeUrl, youtubeTitle, type YoutubeTvState } from '../../shared/youtube/link.js';
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

const changed = (ctx: Ctx, floor: Floor) => ctx.toFloor(floor, { t: 'tv.youtube', state: youtubeTvOf(floor).state() });

/** Asks YouTube for the title of what just went on, and tells the floor once it's known; then `done` with the title, or what it shows without one. */
function lookUpTitle(ctx: Ctx, floor: Floor, s: YoutubeTvState, done?: (title: string) => void) {
  void youtubeTitles.fetch(s.url).then((title) => {
    const tv = youtubeTvOf(floor);
    if (title && tv.titled(s.id, title)) changed(ctx, floor);
    done?.(title ?? youtubeTitle(s));
  });
}

/** Puts `url` on the floor's TV for `who`: the jukebox goes quiet, so two songs never play at once. */
function play(ctx: Ctx, floor: Floor, url: unknown, who: string): string | undefined {
  const r = youtubeTvOf(floor).play(url, who);
  if ('error' in r) return r.error;
  const quiet = floor.jukebox.stop(who);
  if (quiet) ctx.toFloor(floor, { t: 'jukebox', state: floor.jukebox.state() });
  changed(ctx, floor);
  lookUpTitle(ctx, floor, r.state, (title) => {
    // Only if it's still on: nobody changed it while YouTube was asked.
    if (youtubeTvOf(floor).state()?.id === r.state.id) ctx.toastFloor(floor, `📺 ${who} put “${title}” on the TV${quiet ? ' (the jukebox is off meanwhile)' : ''}`);
  });
  return undefined;
}

/**
 * Called in `jukebox.play`: a YouTube link pasted into the jukebox goes on the TV instead
 * (the jukebox can't play YouTube). Says whether it took the message.
 */
export function youtubeFromJukebox(ctx: Ctx, c: Client, floor: Floor, url: unknown): boolean {
  if (!isYoutubeUrl(url)) return false;
  const error = play(ctx, floor, url, c.peer.name);
  if (error) ctx.warn(c, error);
  return true;
}

/** Called after the jukebox comes on: the TV's YouTube makes way for it, so two songs never play at once. */
export function youtubeMakesWay(ctx: Ctx, floor: Floor) {
  if (!floor.jukebox.state().on || !youtubeTvOf(floor).stop()) return;
  changed(ctx, floor);
  ctx.toastFloor(floor, '📺 YouTube is off the TV while the jukebox plays');
}

export const youtubeHandlers = {
  'tv.youtube.play'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const error = play(ctx, floor, msg.url, c.peer.name);
    if (error) ctx.warn(c, error);
  },
  'tv.youtube.stop'(ctx, c) {
    const floor = here(ctx, c);
    if (!floor) return;
    const was = youtubeTvOf(floor).state();
    if (!was || !youtubeTvOf(floor).stop()) return;
    changed(ctx, floor);
    ctx.toastFloor(floor, `📺 ${c.peer.name} took “${youtubeTitle(was)}” off the TV`);
  },
  'tv.youtube.ended'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor) return;
    const tv = youtubeTvOf(floor);
    const was = tv.state();
    const blocked = typeof msg.blocked === 'number' ? msg.blocked : undefined;
    const r = tv.ended(msg.id, msg.next === true);
    if (!r || !was) return;
    changed(ctx, floor);
    const next = r === 'next' ? ': on to the next one' : '';
    // 100 is a video that's private or gone; the others, one whose owner keeps it on youtube.com.
    if (blocked === 100) ctx.toastFloor(floor, `🚫 “${youtubeTitle(was)}” is private, or was taken down${next}`, 'warn');
    else if (blocked !== undefined) ctx.toastFloor(floor, `🚫 YouTube won't let “${youtubeTitle(was)}” play outside youtube.com${next}`, 'warn');
    if (r === 'next') lookUpTitle(ctx, floor, tv.state()!);
  },
} satisfies HandlerMap<YoutubeClientMsg>;
