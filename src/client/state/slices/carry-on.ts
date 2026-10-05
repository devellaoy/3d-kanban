import type { CarryOnState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Whether workers mid-turn when the office stopped carry on by themselves when it starts again (⚙️ Settings). */
    carryOn: CarryOnState;
  }
  interface Topics {
    carryOn: true;
  }
}

export const carryOn: Slice = {
  init(s) {
    s.carryOn = { on: true };
  },
  on: {
    welcome(s, m) {
      s.carryOn = m.carryOn ?? { on: true };
      return ['carryOn'];
    },
    carryOn(s, m) {
      s.carryOn = m.state;
      return ['carryOn'];
    },
  },
};
