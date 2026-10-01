/**
 * Desk stuff: a plant, a mug, a photo frame, a desk lamp or a rubber duck on any desk. Aim at the mat
 * at a desk's front left (or at what stands on it) and press E to pick; aim at the lamp and press E
 * to switch it. What stands on which desk is yours alone: it is kept in this browser, per floor.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { toast } from '../../ui/dom';
import { setLamp, withDesk, type FloorDesks } from './model';
import { loadDesks, saveDesks } from './store';
import { openDeskStuff } from './ui';
import { LAMP_SPOT } from './world';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    deskstuff: true;
  }
}

export function installDeskStuff(ctx: Ctx) {
  const stuff = () => ctx.office.deskStuff;
  /** What's on the desks of the floor you're on. */
  let desks: FloorDesks = {};
  const labelOf = (deskId: string) => ctx.plan().byId.get(deskId)?.label ?? 'desk';

  /** The floor changed (or arrived): its things on the desks. */
  function enterFloor() {
    desks = store.floor ? loadDesks(store.floor, (id) => !!ctx.office.desks.get(id)) : {};
    stuff().apply(desks);
  }
  store.on('floor', enterFloor);
  enterFloor();

  function change(deskId: string, config: Parameters<typeof withDesk>[2]) {
    desks = withDesk(desks, deskId, config);
    stuff().set(deskId, config);
    if (store.floor) saveDesks(store.floor, desks);
  }

  ctx.interactions.define('deskstuff', {
    reach: 3.5,
    hint: (it) => {
      const id = it.deskId ?? '';
      if (it.decorId === LAMP_SPOT) {
        const on = stuff().get(id).lampOn;
        return { k: `lamp${on}`, parts: [hintTitle('💡 Desk lamp'), aside(labelOf(id)), key('E', on ? 'Switch off' : 'Switch on')] };
      }
      return { k: id, parts: [hintTitle('🧸 Desk stuff'), aside(labelOf(id)), key('E', 'Arrange your desk')] };
    },
    use: onE((it) => {
      const id = it.deskId;
      if (!id) return;
      if (it.decorId === LAMP_SPOT) return change(id, setLamp(stuff().get(id), !stuff().get(id).lampOn));
      if (!store.floor) return toast('Take the elevator to a floor first');
      openDeskStuff({ desk: labelOf(id), config: stuff().get(id), onChange: (c) => change(id, c) });
    }),
  });
}
