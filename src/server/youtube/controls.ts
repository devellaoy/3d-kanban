// The Office TV's playback controls: pause, seek, speed, skip, what a player knows, the floor's volume setting.
// Anyone on the floor can use them. Each names the play it means; a late one for an older play does nothing.
import type { HandlerMap } from '../ws/handlers/types.js';
import type { YoutubeClientMsg } from '../../shared/youtube/protocol.js';
import { youtubeTitle } from '../../shared/youtube/link.js';
import { changed, startNow, youtubeTvOf } from './floor-tv.js';

type Controls = Extract<YoutubeClientMsg, { t: 'tv.youtube.pause' | 'tv.youtube.seek' | 'tv.youtube.rate' | 'tv.youtube.skip' | 'tv.youtube.info' | 'tv.youtube.settings' }>;

export const controlHandlers = {
  'tv.youtube.pause'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    const tv = floor && youtubeTvOf(floor);
    if (!floor || !tv || !tv.pause(msg.id, msg.paused, c.peer.name)) return;
    changed(ctx, floor);
    ctx.toastFloor(floor, `📺 ${c.peer.name} ${msg.paused ? 'paused' : 'resumed'} “${youtubeTitle(tv.state()!)}”`);
  },
  'tv.youtube.seek'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (floor && youtubeTvOf(floor).seek(msg.id, msg.to, msg.by)) changed(ctx, floor);
  },
  'tv.youtube.rate'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (floor && youtubeTvOf(floor).rate(msg.id, msg.rate)) changed(ctx, floor);
  },
  'tv.youtube.skip'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor) return;
    const tv = youtubeTvOf(floor);
    const was = tv.state();
    const r = tv.skip(msg.id, msg.dir);
    if (!r || !was) return;
    const who = c.peer.name;
    if (r === 'restart') {
      changed(ctx, floor);
      ctx.toastFloor(floor, `📺 ${who} took “${youtubeTitle(was)}” back to the start`);
    } else if (r === 'stopped') {
      changed(ctx, floor, true);
      ctx.toastFloor(floor, `📺 ${who} skipped “${youtubeTitle(was)}”, the TV is off`);
    } else {
      startNow(ctx, floor, who, (title) => `📺 ${who} ${msg.dir === 1 ? 'skipped to' : 'went back to'} “${title}”`);
    }
  },
  'tv.youtube.info'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (floor && youtubeTvOf(floor).info(msg.id, msg.duration, msg.listLength)) changed(ctx, floor);
  },
  'tv.youtube.settings'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor || !youtubeTvOf(floor).setSameVolume(msg.sameVolume)) return;
    changed(ctx, floor, true);
    ctx.toastFloor(floor, msg.sameVolume ? `📺 ${c.peer.name} set the TV to the same volume across the floor` : `📺 ${c.peer.name} set the TV's volume to fade with distance again`);
  },
} satisfies HandlerMap<Controls>;
