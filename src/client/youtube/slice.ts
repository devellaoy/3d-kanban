// 3d-kanban: the store's slice for YouTube on the Office TV, last in SLICES (state/slices/index.ts), so
// the office's clock from 'pong' (the jukebox's slice) is up to date when it's read here.
import type { YoutubeTvState } from '../../shared/youtube/link';
import type { Slice, Store } from '../state/store';

/** What's on the TV, and when it was at its `start` on performance.now()'s clock. */
export type YoutubeOnTv = YoutubeTvState & { since: number };

declare module '../state/store' {
  interface Store {
    /** The YouTube video on your floor's TV, if any; `since` is when it was at `start`, on performance.now()'s clock. */
    youtube: YoutubeOnTv | null;
  }
  interface Topics {
    youtube: true;
  }
}

/** When it was at `start` on this page's clock: from the office's clock once it's known, else from `elapsed`. */
function setYoutube(s: Store, y: YoutubeTvState | null | undefined) {
  s.youtube = y ? { ...y, since: s.clock ? y.startedAt - s.clock.offset : performance.now() - y.elapsed } : null;
}

/** Seconds into the video it should be now, by the office's clock. */
export function youtubeAt(y: YoutubeOnTv, now = performance.now()): number {
  return Math.max(0, y.start + (now - y.since) / 1000);
}

export const youtube: Slice = {
  init(s) {
    s.youtube = null;
  },
  on: {
    'tv.youtube'(s, m) {
      setYoutube(s, m.state);
      return ['youtube'];
    },
    pong(s) {
      if (!s.youtube) return;
      const was = s.youtube.since;
      setYoutube(s, s.youtube);
      if (Math.abs(s.youtube.since - was) > 20) return ['youtube'];
    },
  },
  enter(s, v) {
    setYoutube(s, v.youtube);
    return ['youtube'];
  },
};
