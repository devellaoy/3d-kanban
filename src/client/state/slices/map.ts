import type { MapState } from '../../../shared/protocol';
import { arrangedPlan } from '../../../shared/arrange';
import { OFFICE_MAP, planOf, type MapPlan } from '../../../shared/maps';
import { ROOF } from '../../../shared/rooftop';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** What the building looks like inside (see shared/maps): the same on every floor. */
    map: MapState;
    /** Where everything is on the building's map, with the office's furniture where this floor has put it. */
    plan(): MapPlan;
  }
  interface Topics {
    map: true;
  }
}

export const map: Slice = {
  init(s) {
    s.map = { pick: OFFICE_MAP, custom: [] };
  },
  methods: {
    plan() {
      const plan = planOf(this.map.pick, this.map.custom);
      return this.floor === ROOF ? plan : arrangedPlan(plan, this.floorPlan.furniture);
    },
  },
  // The map first, so the floor's workers sit down in its seats and not the last one's.
  beforeFloor: true,
  on: {
    welcome(s, m) {
      s.map = m.map ?? { pick: OFFICE_MAP, custom: [] };
      return ['map'];
    },
    map(s, m) {
      // Onto another map: nobody's on a seat of the last one any more (the office forgot them too).
      const moved = m.state.pick !== s.map.pick;
      s.map = m.state;
      if (moved) for (const p of s.peers.values()) delete p.seat;
      return moved ? ['map', 'peers'] : ['map'];
    },
  },
};
