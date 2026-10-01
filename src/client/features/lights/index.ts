/**
 * Light switches: E at a switch on the wall turns the lamps over the lounge (east wall) or the desks
 * (west wall) off and on, for you alone. Which are off is kept in this browser, per floor.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { AREA_INFO, allOn, flip, isArea, type LightsState } from './model';
import { loadLights, saveLights } from './store';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    lightswitch: true;
  }
}

export function installLights(ctx: Ctx) {
  let state: LightsState = allOn();
  const switches = () => ctx.office.lightSwitches;

  function enterFloor() {
    state = store.floor ? loadLights(store.floor) : allOn();
    switches().apply(state, true);
  }
  store.on('floor', enterFloor);
  enterFloor();

  ctx.interactions.define('lightswitch', {
    reach: 3.5,
    hint: (it) => {
      const id = it.decorId;
      if (!isArea(id)) return { k: '', parts: [] };
      const on = state[id];
      return { k: `${id}${on}`, parts: [hintTitle('💡 Light switch'), aside(`lights over ${AREA_INFO[id].label}`), key('E', on ? 'Turn off' : 'Turn on')] };
    },
    use: onE((it) => {
      if (!isArea(it.decorId)) return;
      state = flip(state, it.decorId);
      switches().apply(state);
      if (store.floor) saveLights(store.floor, state);
    }),
  });
}
