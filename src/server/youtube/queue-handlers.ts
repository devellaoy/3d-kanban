// The Office TV's queue: reorder, remove, play now, clear, and unpacking a playlist into it.
import type { HandlerMap } from '../ws/handlers/types.js';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol.js';
import { youtubeTitle } from '../../shared/youtube/link.js';
import { changed, lookUpTitle, startNow, titleQueued, youtubeTvOf } from './floor-tv.js';

type Queue = Extract<YoutubeClientMsg, { t: `tv.youtube.queue.${string}` | 'tv.youtube.unpack' }>;

export const queueHandlers = {
  'tv.youtube.queue.move'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (floor && youtubeTvOf(floor).move(msg.qid, msg.to)) changed(ctx, floor, true);
  },
  'tv.youtube.queue.remove'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor) return;
    const item = youtubeTvOf(floor).remove(msg.qid);
    if (!item) return;
    changed(ctx, floor, true);
    ctx.toastFloor(floor, `📺 ${c.peer.name} took “${youtubeTitle(item)}” off the TV queue`);
  },
  'tv.youtube.queue.jump'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor || !youtubeTvOf(floor).jump(msg.qid)) return;
    const who = c.peer.name;
    startNow(ctx, floor, who, (title) => `📺 ${who} put “${title}” on the TV`);
  },
  'tv.youtube.queue.clear'(ctx, c) {
    const floor = ctx.floorOf(c);
    if (!floor || !youtubeTvOf(floor).clear()) return;
    changed(ctx, floor, true);
    ctx.toastFloor(floor, `📺 ${c.peer.name} cleared the TV queue`);
  },
  'tv.youtube.unpack'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor) return;
    const added = youtubeTvOf(floor).unpack(msg.id, msg.videoIds, msg.at, msg.current);
    if ('error' in added) return ctx.warn(c, added.error);
    changed(ctx, floor, true);
    ctx.toastFloor(floor, `📺 ${c.peer.name} unpacked the playlist into the TV queue (${added.length} video${added.length === 1 ? '' : 's'})`);
    titleQueued(ctx, floor, added);
    lookUpTitle(ctx, floor, youtubeTvOf(floor).state()!); // it was the playlist's title until now
  },
} satisfies HandlerMap<Queue>;
