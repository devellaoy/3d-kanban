// The store's slice for YouTube on the Office TV, last in SLICES (state/slices/index.ts), so
// the office's clock from 'pong' (the jukebox's slice) is up to date when it's read here.
import type { YoutubeTvState } from '../../shared/youtube/link';
import type { YoutubeTvList } from '../../shared/youtube/queue';
import type { Slice, Store } from '../state/store';

/** What's on the TV, and when it was at its `position` on performance.now()'s clock. */
export type YoutubeOnTv = YoutubeTvState & { since: number };

declare module '../state/store' {
  interface Store {
    /** The YouTube video on your floor's TV, if any; `since` is when it was at `position`, on performance.now()'s clock. */
    youtube: YoutubeOnTv | null;
    /** The TV's queue and settings (sameVolume), sent along only when they change. */
    youtubeList: YoutubeTvList;
  }
  interface Topics {
    youtube: true;
    youtubeList: true;
  }
}

/** When it was at `start` on this page's clock: from the office's clock once it's known, else from `elapsed`. */
export function onThisClock(s: Store, y: YoutubeTvState | null | undefined): YoutubeOnTv | null {
  return y ? { ...y, since: s.clock ? y.at - s.clock.offset : performance.now() - y.elapsed } : null;
}

function setYoutube(s: Store, y: YoutubeTvState | null | undefined) {
  s.youtube = onThisClock(s, y);
}

/** Seconds into the video it should be now, by the office's clock. */
export function youtubeAt(y: YoutubeOnTv, now = performance.now()): number {
  return y.paused ? Math.max(0, y.position) : Math.max(0, y.position + (y.rate * (now - y.since)) / 1000);
}

export const youtube: Slice = {
  init(s) {
    s.youtube = null;
    s.youtubeList = { queue: [], back: false, sameVolume: false };
  },
  on: {
    'tv.youtube'(s, m) {
      setYoutube(s, m.state);
      if (!m.list) return ['youtube'];
      s.youtubeList = m.list;
      return ['youtube', 'youtubeList'];
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
    s.youtubeList = v.youtubeList ?? { queue: [], back: false, sameVolume: false };
    return ['youtube', 'youtubeList'];
  },
};
