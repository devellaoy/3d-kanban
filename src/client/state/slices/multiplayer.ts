import type { MpState } from '../../../shared/multiplayer/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The link to the multiplayer relay, as the office reports it (🌐 Settings, the player list). */
    mp: MpState;
    /** The floors other players showed this viewer, by login (answers to `mp.probe`). */
    mpFloors: Record<string, { key: string; name: string }[]>;
    /** Why the last visit ended, until the page goes home. */
    mpEnded: string | null;
  }
  interface Topics {
    mp: true;
  }
}

export const multiplayer: Slice = {
  init(s) {
    s.mp = { status: 'off', url: '', configured: false, offline: false, passwordSet: false, players: [], floors: [] };
    s.mpFloors = {};
    s.mpEnded = null;
  },
  on: {
    'mp.state'(s, m) {
      s.mp = m.state;
      return ['mp'];
    },
    'mp.probe.res'(s, m) {
      s.mpFloors = { ...s.mpFloors, [m.to.toLowerCase()]: m.floors };
      return ['mp'];
    },
    'mp.ended'(s, m) {
      s.mpEnded = m.reason;
      return ['mp'];
    },
  },
};
