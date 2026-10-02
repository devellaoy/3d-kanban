// The store's slice for the phone's music: the session you're in (phone.music), with its play timed on this
// page's clock like the TV's (youtube/slice.ts). Last in SLICES (state/slices/index.ts), after the youtube
// slice, so the office's clock from 'pong' is up to date when it's read here.
import type { PhoneMusicState } from '../../shared/phone/music';
import { onThisClock, type YoutubeOnTv } from '../youtube/slice';
import type { Slice, Store } from '../state/store';

/** The session you're listening to; `on` is its play with when it was at its `position` on performance.now()'s clock. */
export type PhoneMusicOn = PhoneMusicState & { on: YoutubeOnTv | null };

declare module '../state/store' {
  interface Store {
    /** The music session your phone is in, null when none. */
    phoneMusic: PhoneMusicOn | null;
  }
  interface Topics {
    phoneMusic: true;
  }
}

const timed = (s: Store, m: PhoneMusicState): PhoneMusicOn => ({ ...m, on: onThisClock(s, m.state) });

export const phoneMusic: Slice = {
  init(s) {
    s.phoneMusic = null;
  },
  on: {
    'phone.music'(s, m) {
      s.phoneMusic = m.music ? timed(s, m.music) : null;
      return ['phoneMusic'];
    },
    welcome(s) {
      s.phoneMusic = null; // the office keeps sessions per connection: a new one has none (the topic lets the player and the ducking go)
      return ['phoneMusic'];
    },
    pong(s) {
      const m = s.phoneMusic;
      if (!m?.on) return;
      const was = m.on.since;
      s.phoneMusic = timed(s, m);
      if (Math.abs((s.phoneMusic.on?.since ?? was) - was) > 20) return ['phoneMusic'];
    },
  },
};
