// YouTube on the Office TV, on every floor. Joins upstream's handler map and floor view
// with one line each (ws/handlers/index.ts: `youtubeHandlers`, `youtubeView` and `youtubeListView`), and the
// jukebox's handlers with two (see docs/fork.md). The controls are in controls.ts, the queue's in queue-handlers.ts.
import type { Floor } from '../floor.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { here } from '../ws/handlers/common.js';
import type { HandlerMap } from '../ws/handlers/types.js';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol.js';
import { isYoutubeUrl, youtubeTitle } from '../../shared/youtube/link.js';
import { changed, lookUpTitle, startNow, titleQueued, youtubeListView, youtubeTvOf, youtubeView } from './floor-tv.js';
import { controlHandlers } from './controls.js';
import { queueHandlers } from './queue-handlers.js';

export { youtubeListView, youtubeTvOf, youtubeView };

/** Puts `url` on the floor's TV for `who` (now, or into the queue with `queue`). Gives what went wrong, if anything. */
function play(ctx: Ctx, floor: Floor, url: unknown, who: string, queue?: 'end' | 'next'): string | undefined {
  const r = youtubeTvOf(floor).play(url, who, queue);
  if ('error' in r) return r.error;
  if (!r.queued) {
    startNow(ctx, floor, who, (title, quiet) => `📺 ${who} put “${title}” on the TV${quiet ? ' (the jukebox is off meanwhile)' : ''}`);
    return undefined;
  }
  changed(ctx, floor, true);
  ctx.toastFloor(floor, `📺 ${who} added “${youtubeTitle(r.queued)}” to the TV queue`);
  titleQueued(ctx, floor, [r.queued]);
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

/** Called after the jukebox comes on: the TV's YouTube makes way for it (the queue stays), so two songs never play at once. */
export function youtubeMakesWay(ctx: Ctx, floor: Floor) {
  if (!floor.jukebox.state().on || !youtubeTvOf(floor).stop()) return;
  changed(ctx, floor);
  ctx.toastFloor(floor, '📺 YouTube is off the TV while the jukebox plays');
}

export const youtubeHandlers = {
  'tv.youtube.play'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const error = play(ctx, floor, msg.url, c.peer.name, msg.queue === 'end' || msg.queue === 'next' ? msg.queue : undefined);
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
    const r = tv.ended(msg.id, msg.next === true, blocked !== undefined);
    if (!r || !was) return;
    const next = r === 'stopped' ? '' : ': on to the next one';
    // 100 is a video that's private or gone; the others, one whose owner keeps it on youtube.com.
    if (r === 'queue') startNow(ctx, floor, c.peer.name);
    else {
      changed(ctx, floor, true);
      if (r === 'next') lookUpTitle(ctx, floor, tv.state()!);
    }
    if (blocked === 100) ctx.toastFloor(floor, `🚫 “${youtubeTitle(was)}” is private, or was taken down${next}`, 'warn');
    else if (blocked !== undefined) ctx.toastFloor(floor, `🚫 YouTube won't let “${youtubeTitle(was)}” play outside youtube.com${next}`, 'warn');
  },
  ...controlHandlers,
  ...queueHandlers,
} satisfies HandlerMap<YoutubeClientMsg>;
